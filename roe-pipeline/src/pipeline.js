/**
 * EpisodePipeline Durable Object, one per episode (show date).
 * Runs an uploaded show through every step, one alarm at a time.
 *
 * An upload first waits: every file for the date is noted, and ten minutes
 * after the last one arrives the pipeline decides what to run (parts.js): the
 * file as it is, or a show that came in parts ("… 1.mp3", "… 2.mp3"), joined
 * into one file first. Copies are left out. Anything unclear, such as a missing
 * part or two different files for one part, waits for the owner with the
 * reason on /status.
 *
 * Steps: [join →] transcribe → summary → seed-db → embeddings → guest-start →
 * extract-places → score-places → finalize.
 *
 * - Transcription sends one six-minute chunk per alarm and saves it, so a long
 *   show never has to fit in one alarm's 15 minutes, and a crash or restart
 *   costs one chunk, never the whole show.
 * - The summary is made before anything reaches D1. seed-db then writes the
 *   episode row (title, summary, audio link), every transcript line and the
 *   guests in one transaction, so the site never shows a half-made episode.
 * - Steps after seed-db only enrich a published episode. If one keeps failing,
 *   the run notes a warning and carries on.
 * - A failed step is retried after 1, 5 and 15 minutes, unless retrying can't
 *   help (a 4xx answer, an empty transcript, a missing file).
 * - A run that failed, or has been silent for an hour, picks up where it
 *   stopped when the file is uploaded again or POST /process is called.
 *
 * Stored keys: status (waiting | processing | failed | completed), step,
 * episodeId, seen (the uploads so far), settleAt (end of the wait), force,
 * problem and missing (why it's still waiting), parts and ignored (the files
 * run, and those left out), key (the file transcribed: the upload, or the
 * joined show), etag and size of that file, startedAt/updatedAt (ms; updatedAt
 * is the heartbeat), attempt, lastError, error/failedAt, warnings, tx and tx:*
 * (the transcription so far), segments:* / segmentChunks, durationMs, holes,
 * summaryResult, completedAt.
 */

import { parseUpload, findParts, planParts, joinedKey, JOINED_PREFIX, SETTLE_MS } from './parts.js';
import { joinParts } from './mp3-join.js';
import { newTranscription, transcriptionDone, transcribeNextChunk, finishTranscription } from './transcribe.js';
import { seedEpisode } from './seed-db.js';
import { generateEmbeddings } from './embeddings.js';
import { composeSummary } from './summary.js';
import { seedGuestStart } from './guest-start.js';
import { extractAndSeedPlaces } from './places.js';
import { scoreAndSeedSentiment } from './sentiment.js';
import { PermanentError, isPermanent } from './limits.js';
import { pageEntries, readPages } from './stored-lists.js';

const NEXT_STEP = {
  'join': 'transcribe',
  'transcribe': 'summary',
  'summary': 'seed-db',
  'seed-db': 'embeddings',
  'embeddings': 'guest-start',
  'guest-start': 'extract-places',
  'extract-places': 'score-places',
  'score-places': 'finalize',
};
const SOFT_STEPS = new Set(['embeddings', 'guest-start', 'extract-places', 'score-places']);

export const MAX_ATTEMPTS = 4;
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];
export const STALE_MS = 60 * 60_000;      // a processing run this quiet is stuck
const STEP_BUDGET_MS = 10 * 60_000;       // stop starting slow extras well before the 15-minute alarm limit
const SETTLE_RETRY_MS = 5 * 60_000;       // checking the files failed: try again this much later

export class EpisodePipeline {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.running = false;
  }

  async fetch(request) {
    const url = new URL(request.url);

    // Status check
    if (url.pathname === '/status') {
      return Response.json(await this.status());
    }

    const { key, force = false, restart = false } = await request.json();

    const upload = parseUpload(key);
    if (upload.copy) return Response.json({ status: 'refused', error: upload.error }, { status: 422 });
    if (upload.error) return Response.json({ error: upload.error }, { status: 400 });
    if (key.startsWith(JOINED_PREFIX)) {
      return Response.json({ error: 'The pipeline made that file by joining a show\'s parts; send one of the parts instead' }, { status: 400 });
    }

    const [body, init] = await this.start(key, upload.episodeId, { force, restart });
    return Response.json(body, init);
  }

  /**
   * Note an upload, then wait, resume or refuse:
   * - processing, heard from in the last hour: already_processing (force=1
   *   wakes it). A new file is noted as a warning; it isn't added to the run.
   * - processing but silent for an hour, or failed on one of its own files: resume
   * - failed, and this is a new or changed file: start over, unless the episode
   *   is published
   * - otherwise: already_exists if the episode is in D1, else wait ten minutes
   *   for more parts (force=1 decides at once, and goes ahead without a missing
   *   part or despite a long total)
   * - restart=1 starts over from scratch, only before the episode is published
   *   and never while a run is live
   */
  async start(key, episodeId, { force, restart }) {
    const storage = this.state.storage;
    const head = await this.env.AUDIO_BUCKET.head(key);
    if (!head) return [{ error: `Not in R2: ${key}` }, { status: 404 }];

    const saved = await storage.get(['status', 'updatedAt', 'parts']);
    const status = saved.get('status');
    const quiet = Date.now() - (saved.get('updatedAt') || 0) >= STALE_MS;
    // One of this run's own files, unchanged: a repeated upload, or a resume
    const known = (saved.get('parts') || []).some(p => p.key === key && p.etag === head.etag);
    const published = () => this.isPublished(episodeId);
    const now = force || restart;

    // A live run is only ever woken (force), never wiped (restart) under its feet.
    if (status === 'processing' && !quiet && (!force || restart)) {
      if (!known) await this.addWarnings('upload', [`${key} came after this run started, so it isn't part of it`]);
      return [{ status: 'already_processing', episodeId }];
    }
    if (restart) {
      if (await published()) {
        return [{ status: 'already_exists', episodeId, error: 'restart only works before the episode is published' }, { status: 409 }];
      }
      return this.collect(key, episodeId, { fresh: true, now, force });
    }
    if (status === 'processing') return this.resume(episodeId);
    if (status === 'failed') {
      if (known) return this.resume(episodeId);
      if (await published()) {
        return [{ status: 'different_file', episodeId, error: 'The file changed after the episode was published; delete the episode to redo it' }, { status: 409 }];
      }
      return this.collect(key, episodeId, { fresh: true, now, force });
    }
    if (status === 'waiting') return this.collect(key, episodeId, { now, force });
    if (await published()) {
      return [{ status: 'already_exists', episodeId }];
    }
    return this.collect(key, episodeId, { fresh: true, now, force });
  }

  /** Note an upload and (re)start the wait before deciding what to run. */
  async collect(key, episodeId, { fresh = false, now = false, force = false } = {}) {
    const storage = this.state.storage;
    const seen = (await storage.get('seen')) || [];
    if (!seen.includes(key)) seen.push(key);
    if (fresh) await storage.deleteAll();
    else await storage.delete(['problem', 'missing']);
    const settleAt = Date.now() + (now ? 0 : SETTLE_MS);
    await storage.put({ status: 'waiting', episodeId, seen, settleAt, force, updatedAt: Date.now() });
    await storage.setAlarm(settleAt);
    console.log(`[${episodeId}] ${key} noted; deciding what to run at ${new Date(settleAt).toISOString()}`);
    return [{ status: 'waiting', episodeId, until: new Date(settleAt).toISOString() }];
  }

  /** The wait is over: from all of the episode's files, decide what to run. */
  async settle() {
    const storage = this.state.storage;
    const s = await storage.get(['episodeId', 'seen', 'force', 'settleAt']);
    const episodeId = s.get('episodeId');
    const settleAt = s.get('settleAt');
    try {
      if (await this.isPublished(episodeId)) {
        return this.hold('The episode is already on the site, so nothing was run. Delete it first to redo it.');
      }
      const found = await findParts(this.env.AUDIO_BUCKET, s.get('seen') || [], episodeId);
      const plan = await planParts(this.env.AUDIO_BUCKET, found.files, { force: s.get('force') });
      // Another upload came in meanwhile, and its own wait decides instead
      if ((await storage.get('settleAt')) !== settleAt) return;

      const ignored = [...found.ignored, ...plan.ignored];
      if (plan.problem) return this.hold(plan.problem, { parts: plan.parts, ignored, missing: plan.missing });

      const single = plan.parts.length === 1;
      const now = Date.now();
      await storage.put({
        status: 'processing', step: single ? 'transcribe' : 'join',
        key: single ? plan.parts[0].key : joinedKey(plan.parts[0].key),
        parts: plan.parts, ignored, startedAt: now, updatedAt: now, attempt: 0,
      });
      await storage.delete(['settleAt', 'force', 'problem', 'missing']);
      await storage.setAlarm(now);
      console.log(`Pipeline started for ${episodeId}: ${plan.parts.map(p => p.key).join(' + ')}`);
    } catch (err) {
      await storage.put('problem', `Couldn't check the files (${err?.message || err}); trying again in 5 minutes.`);
      await storage.setAlarm(Date.now() + SETTLE_RETRY_MS);
    }
  }

  /** Keep waiting, for the owner: /status shows why. */
  async hold(problem, { parts, ignored, missing } = {}) {
    const storage = this.state.storage;
    await storage.delete(['parts', 'ignored', 'missing']);
    await storage.put({ problem, ...(parts && { parts }), ...(ignored && { ignored }), ...(missing && { missing }) });
    console.warn(`[${await storage.get('episodeId')}] Waiting: ${problem}`);
  }

  async isPublished(episodeId) {
    return !!(await this.env.DB.prepare('SELECT id FROM episodes WHERE id = ?').bind(episodeId).first());
  }

  async resume(episodeId) {
    const storage = this.state.storage;
    await storage.put({ status: 'processing', attempt: 0, updatedAt: Date.now() });
    await storage.delete(['error', 'failedAt', 'lastError']);
    await storage.setAlarm(Date.now());
    const step = await storage.get('step');
    console.log(`Pipeline resumed for ${episodeId} at ${step}`);
    return [{ status: 'resumed', episodeId, step }];
  }

  async status() {
    const s = await this.state.storage.get([
      'status', 'step', 'episodeId', 'error', 'failedAt', 'holes', 'attempt', 'lastError',
      'startedAt', 'updatedAt', 'completedAt', 'warnings', 'tx',
      'key', 'parts', 'ignored', 'problem', 'missing', 'settleAt',
    ]);
    const when = ms => (ms ? new Date(ms).toISOString() : undefined);
    const tx = s.get('tx');
    const nextAlarm = await this.state.storage.getAlarm();
    const waiting = s.get('status') === 'waiting';
    return {
      status: s.get('status') || 'idle',
      step: s.get('step'),
      episodeId: s.get('episodeId'),
      problem: s.get('problem'),
      missing: s.get('missing'),
      waitingUntil: waiting && !s.get('problem') ? when(s.get('settleAt')) : undefined,
      file: s.get('key'),
      parts: s.get('parts')?.map(({ part, key, size, sec }) => ({ part, key, size, sec })),
      ignored: s.get('ignored')?.length ? s.get('ignored') : undefined,
      error: s.get('error'),
      failedAt: s.get('failedAt'),
      holes: s.get('holes'),
      attempt: s.get('attempt'),
      lastError: s.get('lastError'),
      startedAt: when(s.get('startedAt')),
      updatedAt: when(s.get('updatedAt')),
      completedAt: when(s.get('completedAt')),
      nextAlarm: when(nextAlarm),
      progress: tx ? { chunks: tx.chunks, bytesDone: tx.fileOffset, bytesTotal: tx.size } : undefined,
      warnings: s.get('warnings'),
    };
  }

  async alarm() {
    // Two alarms never run side by side in one instance; the running one schedules the next.
    if (this.running) return;
    this.running = true;
    try {
      if ((await this.state.storage.get('status')) === 'waiting') await this.settle();
      else await this.runStep();
    } finally {
      this.running = false;
    }
  }

  async runStep() {
    const storage = this.state.storage;
    const s = await storage.get(['status', 'step', 'key', 'episodeId', 'attempt', 'lastError']);
    if (s.get('status') !== 'processing') return;
    const key = s.get('key');
    const episodeId = s.get('episodeId');
    if (!key || !episodeId || !s.get('step')) return;
    const step = await this.currentStep(s.get('step'));

    // Count the attempt before anything is paid for: an alarm killed by the time
    // limit or a deploy is re-run by Cloudflare, and still counts.
    const attempt = (s.get('attempt') || 0) + 1;
    const startedAt = Date.now();
    await storage.put({ attempt, updatedAt: startedAt });
    if (attempt > MAX_ATTEMPTS) {
      return this.giveUp(step, new Error(`Gave up after ${MAX_ATTEMPTS} attempts: ${s.get('lastError') || 'the step never finished'}`));
    }

    console.log(`[${episodeId}] Running step: ${step} (attempt ${attempt})`);
    const warnings = [];
    try {
      const next = await this.runOne(step, {
        key, episodeId,
        deadline: startedAt + STEP_BUDGET_MS,
        warn: message => warnings.push(message),
      });
      if (warnings.length) await this.addWarnings(step, warnings);
      if (next === null) return; // finalize wrote the completed state
      await storage.put({ step: next, attempt: 0, updatedAt: Date.now() });
      await storage.delete('lastError');
      await storage.setAlarm(Date.now());
    } catch (err) {
      const message = err?.message || String(err);
      console.error(`[${episodeId}] Step "${step}" failed (attempt ${attempt}):`, message);
      if (isPermanent(err) || attempt >= MAX_ATTEMPTS) return this.giveUp(step, err);
      await storage.put({ lastError: message });
      await storage.setAlarm(Date.now() + RETRY_DELAYS_MS[attempt - 1]);
    }
  }

  /** Map a stored step onto today's order, for runs started by older code. */
  async currentStep(step) {
    let current = step;
    // The old code ran the audio link as its own last step.
    if (step === 'set-audio-url') current = 'finalize';
    // The old order was transcribe → seed-db → embeddings → summary: a run that
    // stopped before its summary makes one now, then re-seeds with it.
    if ((step === 'seed-db' || step === 'embeddings') && !(await this.state.storage.get('summaryResult'))) current = 'summary';
    if (current !== step) await this.state.storage.put('step', current);
    return current;
  }

  /** Run one step; returns the step to run next (the same one while chunks remain), or null when done. */
  async runOne(step, { key, episodeId, deadline, warn }) {
    const storage = this.state.storage;
    const env = this.env;

    switch (step) {
      case 'join': {
        const parts = await storage.get('parts');
        const joined = await joinParts(env.AUDIO_BUCKET, parts, key);
        console.log(`[${episodeId}] Joined ${parts.length} parts into ${key}: ${(joined.sec / 60).toFixed(1)} min, ${joined.size} bytes`);
        return NEXT_STEP[step];
      }

      case 'transcribe':
        return this.transcribeStep(key, deadline);

      case 'summary': {
        const segments = await this.loadSegments();
        const durationMs = await storage.get('durationMs');
        const result = await composeSummary(episodeId, segments, env.OPENAI_API_KEY, durationMs);
        await storage.put('summaryResult', result);
        return NEXT_STEP[step];
      }

      case 'seed-db': {
        const segments = await this.loadSegments();
        const durationMs = await storage.get('durationMs');
        const { title, summary, guests } = await storage.get('summaryResult');
        await seedEpisode(env.DB, {
          episodeId, title, summary, guests, durationMs, segments,
          audioUrl: this.audioUrl(key),
        });
        return NEXT_STEP[step];
      }

      case 'embeddings': {
        const segments = await this.loadSegments();
        const durationMs = await storage.get('durationMs');
        const vectorCount = await generateEmbeddings(env.AI, env.VECTORIZE, episodeId, segments, durationMs);
        console.log(`[${episodeId}] ${vectorCount} vectors upserted`);
        return NEXT_STEP[step];
      }

      case 'guest-start': {
        const segments = await this.loadSegments();
        const durationMs = await storage.get('durationMs');
        await seedGuestStart(env.DB, episodeId, segments, durationMs);
        return NEXT_STEP[step];
      }

      case 'extract-places': {
        const segments = await this.loadSegments();
        await extractAndSeedPlaces(env.DB, episodeId, segments, env.OPENAI_API_KEY, { deadline, warn });
        return NEXT_STEP[step];
      }

      case 'score-places': {
        const segments = await this.loadSegments();
        await scoreAndSeedSentiment(env.DB, episodeId, segments, env.OPENAI_API_KEY, { deadline, warn });
        return NEXT_STEP[step];
      }

      case 'finalize': {
        // seed-db writes the audio link; this covers runs from the old code, which wrote it here.
        await env.DB.prepare('UPDATE episodes SET audio_file = COALESCE(audio_file, ?) WHERE id = ?')
          .bind(this.audioUrl(key), episodeId).run();
        // Keep only what /status reports afterwards, including any unfilled holes
        const keep = await storage.get(['episodeId', 'key', 'startedAt', 'holes', 'warnings', 'parts', 'ignored']);
        const kept = Object.fromEntries([...keep].filter(([, v]) => !(Array.isArray(v) && v.length === 0)));
        await storage.deleteAll();
        await storage.put({ ...kept, status: 'completed', completedAt: Date.now() });
        await storage.deleteAlarm();
        console.log(`[${episodeId}] Pipeline completed successfully`);
        return null;
      }

      default:
        throw new PermanentError(`Unknown step: ${step}`);
    }
  }

  /** One chunk per alarm; once every chunk is in, assemble the transcript. */
  async transcribeStep(key, deadline) {
    const storage = this.state.storage;
    if (!this.env.OPENAI_API_KEY) throw new PermanentError('OPENAI_API_KEY is not set');
    const head = await this.env.AUDIO_BUCKET.head(key);
    if (!head) throw new PermanentError(`The file is no longer in R2: ${key}`);

    let tx = await storage.get('tx');
    if (!tx || tx.etag !== head.etag || tx.size !== head.size) {
      // First chunk, or the file was replaced mid-run: never stitch two files together.
      if (tx) console.warn(`  ${key} changed since chunk ${tx.chunks}; starting the transcript over`);
      await this.clearTranscription();
      tx = newTranscription(head);
      await storage.put({ tx, etag: head.etag, size: head.size });
    }

    if (!transcriptionDone(tx)) {
      const i = tx.chunks;
      const prevSegments = i > 0 ? await readPages(storage, `tx:seg:${i - 1}`, tx.pages[i - 1]) : [];
      const out = await transcribeNextChunk(this.env.AUDIO_BUCKET, key, this.env.OPENAI_API_KEY, tx, { prevSegments, deadline });
      const own = pageEntries(`tx:seg:${i}`, out.segments);
      const boundary = pageEntries(`tx:boundary:${i}`, out.boundary);
      const next = {
        ...out.tx,
        pages: { ...tx.pages, [i]: own.pages },
        boundaryPages: { ...tx.boundaryPages, [i]: boundary.pages },
      };
      // The chunk and the progress that points past it are saved together.
      await storage.put({ ...own.entries, ...boundary.entries, tx: next });
      return 'transcribe';
    }

    const lists = [];
    for (let i = 0; i < tx.chunks; i++) {
      lists.push(...await readPages(storage, `tx:seg:${i}`, tx.pages?.[i]));
      lists.push(...await readPages(storage, `tx:boundary:${i}`, tx.boundaryPages?.[i]));
    }
    const durationMs = Math.round(tx.timeOffset * 1000);
    const { segments, holes } = finishTranscription(lists, durationMs);
    if (segments.length === 0) {
      // Stop before anything is written: an empty episode would still get an
      // invented AI title and summary.
      throw new PermanentError('Transcription came back empty; nothing was published. Check the audio file.');
    }

    await this.storeSegments(segments);
    // Stretches still missing after every retry, shown by /status
    await storage.put({ durationMs, holes });
    await this.clearTranscription();
    return NEXT_STEP.transcribe;
  }

  async clearTranscription() {
    const storage = this.state.storage;
    const keys = [...(await storage.list({ prefix: 'tx:' })).keys(), 'tx'];
    for (let i = 0; i < keys.length; i += 128) await storage.delete(keys.slice(i, i + 128));
  }

  async addWarnings(step, messages) {
    const storage = this.state.storage;
    const warnings = (await storage.get('warnings')) || [];
    for (const message of messages) warnings.push({ step, message: String(message).slice(0, 500), at: new Date().toISOString() });
    await storage.put('warnings', warnings);
  }

  /** Last attempt failed: fail the run, or for a soft step note it and go on. */
  async giveUp(step, err) {
    const storage = this.state.storage;
    const message = err?.message || String(err);
    if (SOFT_STEPS.has(step)) {
      await this.addWarnings(step, [`Skipped: ${message}`]);
      await storage.put({ step: NEXT_STEP[step], attempt: 0, updatedAt: Date.now() });
      await storage.delete('lastError');
      await storage.setAlarm(Date.now());
      return;
    }
    await storage.put({ status: 'failed', error: message, failedAt: new Date().toISOString() });
    await storage.delete('lastError');
    console.error(`[${await storage.get('episodeId')}] Pipeline failed at step "${step}": ${message}`);
  }

  audioUrl(key) {
    return `${this.env.R2_PUBLIC_URL}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  /** Store segments as pages to stay under DO's 128KB per-value limit. */
  async storeSegments(segments) {
    const { entries, pages } = pageEntries('segments', segments);
    const storage = this.state.storage;
    const old = await storage.get('segmentChunks');
    if (old > pages) await storage.delete(Array.from({ length: old - pages }, (_, i) => `segments:${pages + i}`));
    await storage.put({ ...entries, segmentChunks: pages });
  }

  /** Reassemble segments from their pages. */
  async loadSegments() {
    return readPages(this.state.storage, 'segments', await this.state.storage.get('segmentChunks'));
  }
}
