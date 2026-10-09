/**
 * roe-pipeline Worker
 *
 * Queue consumer: receives R2 event notifications and dispatches each upload
 * to its episode's EpisodePipeline Durable Object, one per show date, so the
 * parts of a show recorded in pieces all reach the same place.
 *
 * Also exposes a fetch handler for manual triggering and status checks.
 */

import { parseUpload, JOINED_PREFIX } from './parts.js';
import { DEAD_LETTER_QUEUE, OWN_FILE, logIngest } from './ingest-log.js';

export { EpisodePipeline } from './pipeline.js';

// Answers from a show's pipeline that mean the upload won't be run
const TURNED_DOWN = new Set(['already_exists', 'different_file', 'refused']);
// The others, in the owner's words on the Uploads tab
const STARTED_HOW = {
  waiting: 'starts in 10 minutes, unless more parts of the show come in',
  resumed: 'picked up where it stopped',
  already_processing: 'its show is already running',
};

/** The Durable Object for the episode `upload` belongs to. */
function pipelineFor(env, upload) {
  return env.EPISODE_PIPELINE.get(env.EPISODE_PIPELINE.idFromName(upload.episodeId));
}

export default {
  /**
   * Queue consumer — handles R2 object-create events.
   * Each message contains an R2 event with the uploaded object key. What
   * becomes of each upload goes in the ingest log (ingest-log.js), which the
   * admin page's Uploads tab lists. A message whose hand-over keeps failing
   * ends up, after the queue's retries, on the dead-letter queue, which this
   * Worker also consumes, to log it as given up.
   */
  async queue(batch, env) {
    for (const message of batch.messages) {
      const event = message.body;
      const key = event.object?.key;
      const size = event.object?.size ?? null;

      if (batch.queue === DEAD_LETTER_QUEUE) {
        console.error(`Gave up on ${key}: every try to start it failed`);
        await logIngest(env.DB, { key: key ?? '(no file name)', size, outcome: 'gave up', detail: 'every try to start it failed, so nothing was processed: upload it again' });
        message.ack();
        continue;
      }

      if (!key) {
        console.warn('Queue message missing object key, acking:', JSON.stringify(event));
        await logIngest(env.DB, { key: '(no file name)', outcome: 'skipped', detail: 'an upload event without a file name' });
        message.ack();
        continue;
      }

      // The pipeline's own files (joined shows, the site's .m4a), unlogged;
      // then other files, copies and names that aren't a show date, logged
      if (key.startsWith(JOINED_PREFIX) || OWN_FILE.test(key)) {
        console.log(`Skipping ${key}: the pipeline's own file`);
        message.ack();
        continue;
      }
      const upload = parseUpload(key);
      if (upload.error) {
        console.log(`Skipping ${key}: ${upload.error}`);
        await logIngest(env.DB, { key, size, outcome: 'skipped', detail: upload.error });
        message.ack();
        continue;
      }

      console.log(`Processing R2 event: ${key} (${size ?? 'unknown'} bytes)`);

      try {
        const res = await pipelineFor(env, upload).fetch('http://internal/process', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key }),
        });

        const result = await res.json();
        console.log(`DO response for ${key}:`, JSON.stringify(result));
        // Turned down (already on the site, a changed file, not in R2…): say why, as nothing will happen
        if (!res.ok || TURNED_DOWN.has(result?.status)) {
          const why = result?.error ?? (result?.status === 'already_exists'
            ? 'that show is already on the site, so nothing was run; delete the episode first to redo it'
            : `its show's pipeline answered ${res.status}`);
          await logIngest(env.DB, { key, size, outcome: 'skipped', detail: why });
        } else {
          const how = STARTED_HOW[result?.status] ?? (result?.status ? `its show's pipeline: ${result.status}` : null);
          await logIngest(env.DB, { key, size, outcome: 'started', detail: how });
        }
        message.ack();
      } catch (err) {
        console.error(`Failed to dispatch ${key} to DO:`, err.message);
        await logIngest(env.DB, { key, size, outcome: 'retrying', detail: `try ${message.attempts ?? '?'}: ${err.message}` });
        // 1, 2, 4… minutes: a short outage (or a deploy) shouldn't use up every try at once
        message.retry({ delaySeconds: Math.min(3600, 60 * 2 ** ((message.attempts ?? 1) - 1)) });
      }
    }
  },

  /**
   * Fetch handler for manual triggering and status checks.
   *
   * POST /process?key=filename.mp3 — note the file (a whole show, or one part
   *      of one) and run the show ten minutes later, or resume a run that failed
   *      or has been silent for an hour (&force=1 decides or wakes it now;
   *      &restart=1 starts over from scratch, only before the episode is published)
   * GET  /status?key=filename.mp3  — check the status of that file's show
   *      (any of its parts, or the joined file, will do)
   * GET  /                         — health check
   *
   * /process and /status need `Authorization: Bearer <PIPELINE_TOKEN>` (a Worker
   * secret; the same value is in the project .env). Without the secret set,
   * they stay closed: /process could otherwise start a paid transcription of
   * any MP3 in the bucket for anyone who finds this URL.
   */
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/process' || url.pathname === '/status') {
      if (!env.PIPELINE_TOKEN) {
        return Response.json({ error: 'PIPELINE_TOKEN is not configured' }, { status: 503 });
      }
      const auth = request.headers.get('Authorization') || '';
      const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
      if (!(await timingSafeEqual(token, env.PIPELINE_TOKEN))) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }

    if (url.pathname === '/process' && request.method === 'POST') {
      const key = url.searchParams.get('key');
      if (!key) return Response.json({ error: 'Missing ?key= parameter' }, { status: 400 });

      if (key.startsWith(JOINED_PREFIX)) {
        return Response.json({ error: 'The pipeline made that file by joining a show\'s parts; send one of the parts instead' }, { status: 400 });
      }
      const upload = parseUpload(key);
      if (upload.copy) return Response.json({ status: 'refused', error: upload.error }, { status: 422 });
      if (upload.error) return Response.json({ error: upload.error }, { status: 400 });

      const force = url.searchParams.get('force') === '1';
      const restart = url.searchParams.get('restart') === '1';
      const res = await pipelineFor(env, upload).fetch('http://internal/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, force, restart }),
      });
      return res;
    }

    if (url.pathname === '/status') {
      const key = url.searchParams.get('key');
      if (!key) return Response.json({ error: 'Missing ?key= parameter' }, { status: 400 });

      const upload = parseUpload(key);
      if (upload.copy) return Response.json({ status: 'refused', error: upload.error });
      if (upload.error) return Response.json({ error: upload.error }, { status: 400 });
      return pipelineFor(env, upload).fetch('http://internal/status', { method: 'GET' });
    }

    return Response.json({ service: 'roe-pipeline', status: 'ok' });
  },
};

// Constant-time string compare (HMAC both with a throwaway key), as in roe-search.
async function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', crypto.getRandomValues(new Uint8Array(32)),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const [macA, macB] = await Promise.all([
    crypto.subtle.sign('HMAC', key, enc.encode(a)),
    crypto.subtle.sign('HMAC', key, enc.encode(b)),
  ]);
  const ua = new Uint8Array(macA), ub = new Uint8Array(macB);
  let diff = 0;
  for (let i = 0; i < ua.length; i++) diff |= ua[i] ^ ub[i];
  return diff === 0;
}
