import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EpisodePipeline, MAX_ATTEMPTS, RETRY_DELAYS_MS, STALE_MS } from '../src/pipeline.js';
import { FakeStorage, makeD1, makeR2, makeAI, makeVectorize, whisperAudio, fakeFetch } from './helpers/fakes.js';

const KEY = 'Roll Over Easy 2026-10-01.mp3';
const ID = 'roll-over-easy_2026-10-01_07-30-00';
const AUDIO_URL = 'https://audio.example/Roll%20Over%20Easy%202026-10-01.mp3';
// Chunks are cut at the first frame at or past six minutes of audio.
const CHUNK_FRAMES = Math.ceil(360 / (576 / 22050));
const CHUNK_SEC = CHUNK_FRAMES * (576 / 22050);
const CHUNK_BYTES = CHUNK_FRAMES * 26;
const T0 = Date.UTC(2026, 9, 1, 17, 0);

// Speech everywhere, naming the guest and a place so the summary and places steps keep them
const speech = sec => (sec === 605 ? 'Heather Knight joins us this morning.'
  : sec === 1205 ? 'Then we walked over to Dolores Park.'
  : `Line at ${Math.round(sec)} seconds.`);

function setup({ seconds = 50 * 60, fetch: fetchOpts = {}, env: envOver = {} } = {}) {
  const storage = new FakeStorage();
  const env = {
    DB: makeD1(),
    AUDIO_BUCKET: makeR2({ [KEY]: whisperAudio(seconds) }),
    AI: makeAI(),
    VECTORIZE: makeVectorize(),
    OPENAI_API_KEY: 'sk-test',
    R2_PUBLIC_URL: 'https://audio.example',
    ...envOver,
  };
  const fetch = fakeFetch({ speech, ...fetchOpts });
  vi.stubGlobal('fetch', fetch);
  const t = { storage, env, fetch, pipeline: new EpisodePipeline({ storage }, env) };
  t.process = async (opts = {}) => {
    const res = await t.pipeline.fetch(new Request('http://internal/process', { method: 'POST', body: JSON.stringify({ key: KEY, ...opts }) }));
    return { status: res.status, body: await res.json() };
  };
  t.status = async () => (await t.pipeline.fetch(new Request('http://internal/status'))).json();
  t.whisperCalls = () => fetch.calls.filter(c => c.kind === 'whisper');
  return t;
}

/** Fire alarms the way Cloudflare would, jumping the clock to each one. */
async function drain(t, max = 60) {
  let n = 0;
  while (t.storage.alarm != null && n < max) {
    const due = t.storage.alarm;
    t.storage.alarm = null;
    if (due > Date.now()) vi.setSystemTime(due);
    await t.pipeline.alarm();
    n++;
  }
  return n;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a whole run', () => {
  it('transcribes one chunk per alarm, then publishes the episode complete in one write', async () => {
    const t = setup({ fetch: { places: () => ['Dolores Park'] } });
    expect((await t.process()).body).toEqual({ status: 'started', episodeId: ID });

    // The first three alarms are the three chunks, one Whisper call each
    for (let i = 1; i <= 3; i++) {
      t.storage.alarm = null;
      await t.pipeline.alarm();
      expect(t.whisperCalls()).toHaveLength(i);
      expect((await t.status()).progress.chunks).toBe(i);
      expect(t.env.DB.rows('SELECT id FROM episodes')).toEqual([]);
    }
    await t.storage.setAlarm(Date.now());
    await drain(t);

    const status = await t.status();
    expect(status.status).toBe('completed');
    expect(status.warnings).toBeUndefined();
    expect(t.storage.alarm).toBeNull();

    const [ep] = t.env.DB.rows('SELECT * FROM episodes');
    expect(ep).toMatchObject({ id: ID, title: 'Stairway Streets!', summary: 'A foggy morning on the stairs.', audio_file: AUDIO_URL, published_at: '2026-10-01' });
    expect(ep.duration_ms).toBeGreaterThan(49 * 60_000);
    const lines = t.env.DB.rows('SELECT COUNT(*) AS n FROM transcript_segments')[0].n;
    expect(lines).toBe(300);
    expect(t.env.DB.rows('SELECT COUNT(*) AS n FROM transcript_fts')[0].n).toBe(300);
    expect(t.env.DB.rows('SELECT guest_name FROM episode_guests')).toEqual([{ guest_name: 'Heather Knight' }]);
    expect(t.env.DB.rows('SELECT COUNT(*) AS n FROM place_mentions')[0].n).toBe(1);
    expect(t.env.VECTORIZE.upserted.length).toBeGreaterThan(0);

    // Every outside request had a time limit
    expect(t.fetch.calls.filter(c => !c.hasTimeout)).toEqual([]);
    // All the transcription scratch space is gone; /status keeps its summary
    expect([...t.storage.data.keys()].sort()).toEqual(['completedAt', 'episodeId', 'key', 'startedAt', 'status']);
  });

  it('never shows the episode before its summary exists', async () => {
    const t = setup({ fetch: { summaryReply: () => new Response('overloaded', { status: 503 }) } });
    await t.process();
    await drain(t);
    const status = await t.status();
    expect(status).toMatchObject({ status: 'failed', step: 'summary' });
    expect(status.error).toContain('OpenAI API error 503');
    expect(t.fetch.calls.filter(c => c.kind === 'summary')).toHaveLength(MAX_ATTEMPTS);
    expect(t.env.DB.rows('SELECT id FROM episodes')).toEqual([]);
  });

  it('retries a cut-off summary instead of publishing half of it', async () => {
    let n = 0;
    const t = setup({
      fetch: {
        summaryReply: () => (++n === 1
          ? Response.json({ choices: [{ message: { content: '{"title": "Half' }, finish_reason: 'length' }] })
          : Response.json({ choices: [{ message: { content: JSON.stringify({ title: 'Whole!', summary: 'All of it.', guests: [] }) }, finish_reason: 'stop' }] })),
      },
    });
    await t.process();
    await drain(t);
    expect(t.env.DB.rows('SELECT title, summary FROM episodes')).toEqual([{ title: 'Whole!', summary: 'All of it.' }]);
  });

  it('carries on past a soft step that keeps failing, and says so', async () => {
    const t = setup();
    t.env.VECTORIZE.upsert = async () => { throw new Error('Vectorize is down'); };
    await t.process();
    await drain(t);
    const status = await t.status();
    expect(status.status).toBe('completed');
    expect(status.warnings).toEqual([expect.objectContaining({ step: 'embeddings', message: expect.stringContaining('Vectorize is down') })]);
    expect(t.env.DB.rows('SELECT COUNT(*) AS n FROM episodes')[0].n).toBe(1);
  });

  it('refuses an empty transcript without writing anything, and a resume sends nothing again', async () => {
    const t = setup({ fetch: { speech: () => null } });
    await t.process();
    await drain(t);
    expect(await t.status()).toMatchObject({ status: 'failed', step: 'transcribe', error: expect.stringContaining('empty') });
    expect(t.env.DB.rows('SELECT id FROM episodes')).toEqual([]);

    const sent = t.whisperCalls().length;
    expect((await t.process()).body).toMatchObject({ status: 'resumed' });
    await drain(t);
    expect(t.whisperCalls()).toHaveLength(sent);
    expect((await t.status()).status).toBe('failed');
  });
});

describe('when something goes wrong mid-transcription', () => {
  it('a crash mid-chunk costs only that chunk', async () => {
    let hang = true;
    const t = setup({
      fetch: { whisper: call => (hang && call.startSec > CHUNK_SEC - 1 ? new Promise(() => {}) : null) },
    });
    await t.process();
    t.storage.alarm = null;
    await t.pipeline.alarm();              // chunk 1
    t.storage.alarm = null;
    t.pipeline.alarm();                    // chunk 2 hangs until the alarm is killed…
    await vi.waitFor(() => expect(t.whisperCalls()).toHaveLength(2));

    // …and Cloudflare re-runs it in a fresh instance
    hang = false;
    t.pipeline = new EpisodePipeline({ storage: t.storage }, t.env);
    await t.pipeline.alarm();
    await drain(t);

    expect((await t.status()).status).toBe('completed');
    const starts = t.whisperCalls().map(c => Math.round(c.startSec));
    expect(starts.filter(s => s === 0)).toHaveLength(1);   // chunk 1 was never sent again
    expect(t.env.DB.rows('SELECT COUNT(*) AS n FROM transcript_segments')[0].n).toBe(300);
  });

  it('retries a failed request a minute later, then carries on', async () => {
    let failures = 1;
    const t = setup({
      fetch: { whisper: call => (call.startSec > CHUNK_SEC - 1 && failures-- > 0 ? new Response('busy', { status: 500 }) : null) },
    });
    await t.process();
    t.storage.alarm = null;
    await t.pipeline.alarm();              // chunk 1
    t.storage.alarm = null;
    await t.pipeline.alarm();              // chunk 2 fails
    expect(t.storage.alarm - Date.now()).toBe(RETRY_DELAYS_MS[0]);
    expect(await t.status()).toMatchObject({ status: 'processing', attempt: 1, lastError: expect.stringContaining('500') });
    await drain(t);
    expect((await t.status()).status).toBe('completed');
  });

  it('gives up after four failures, then resumes from the same chunk when asked', async () => {
    let broken = true;
    const t = setup({
      fetch: { whisper: call => (broken && call.startSec > CHUNK_SEC - 1 ? new Response('busy', { status: 500 }) : null) },
    });
    await t.process();
    await drain(t);
    expect(await t.status()).toMatchObject({ status: 'failed', step: 'transcribe', error: expect.stringContaining('Whisper API error 500') });
    expect(t.whisperCalls().filter(c => c.startSec > CHUNK_SEC - 1)).toHaveLength(MAX_ATTEMPTS);
    expect(Date.now() - T0).toBe(RETRY_DELAYS_MS.reduce((a, b) => a + b, 0));

    broken = false;
    expect((await t.process()).body).toEqual({ status: 'resumed', episodeId: ID, step: 'transcribe' });
    await drain(t);
    expect((await t.status()).status).toBe('completed');
    expect(t.whisperCalls().filter(c => c.startSec === 0)).toHaveLength(1);
  });

  it('fails at once on an error a retry cannot fix', async () => {
    const t = setup({ fetch: { whisper: () => new Response('bad key', { status: 401 }) } });
    await t.process();
    await drain(t);
    expect(await t.status()).toMatchObject({ status: 'failed', error: expect.stringContaining('401') });
    expect(t.whisperCalls()).toHaveLength(1);
  });

  it('stops after four alarms that each got killed', async () => {
    const t = setup();
    await t.process();
    await t.storage.put({ attempt: MAX_ATTEMPTS, lastError: 'killed' });
    await t.pipeline.alarm();
    expect(await t.status()).toMatchObject({ status: 'failed', error: expect.stringContaining('Gave up after 4 attempts') });
    expect(t.whisperCalls()).toHaveLength(0);
  });

  it('starts the transcript over if the file is replaced mid-run', async () => {
    const t = setup();
    await t.process();
    t.storage.alarm = null;
    await t.pipeline.alarm();              // chunk 1 of the old file
    t.env.AUDIO_BUCKET.replace(KEY, whisperAudio(40 * 60), 'etag-2');
    await drain(t);
    expect(t.whisperCalls().filter(c => c.startSec === 0)).toHaveLength(2);
    expect(t.env.DB.rows('SELECT COUNT(*) AS n FROM transcript_segments')[0].n).toBe(240);
  });

  it('retries a hole across a chunk boundary using the previous chunk read again from R2', async () => {
    // Silence from 150 s before the chunk-1/2 boundary to 200 s after it: too
    // short on either side for that chunk's own check, 5+ minutes in total.
    const quiet = sec => sec > CHUNK_SEC - 150 && sec < CHUNK_SEC + 200;
    const t = setup({ fetch: { speech: (sec, { retry }) => (quiet(sec) && !retry ? null : `Line at ${Math.round(sec)} seconds.`) } });
    await t.process();
    await drain(t);

    expect(t.env.AUDIO_BUCKET.reads).toContainEqual({ key: KEY, offset: 0, length: CHUNK_BYTES });
    const recovered = t.env.DB.rows('SELECT COUNT(*) AS n FROM transcript_segments WHERE start_ms BETWEEN ? AND ?',
      Math.round((CHUNK_SEC - 150) * 1000), Math.round((CHUNK_SEC + 200) * 1000))[0].n;
    expect(recovered).toBeGreaterThan(30);
    expect((await t.status()).holes).toBeUndefined();
  });

  it('stops sending retry clips once the alarm has used its time budget', async () => {
    // Five silent minutes inside chunk 2; the first retry clip uses up the budget
    const quiet = sec => sec >= 400 && sec < 700;
    const t = setup({
      seconds: 52 * 60,   // so the last chunk is longer than a retry clip
      fetch: {
        speech: (sec, { retry }) => (quiet(sec) && !retry ? null : `Line at ${Math.round(sec)} seconds.`),
        whisper: call => { if (call.retry) vi.setSystemTime(Date.now() + 11 * 60_000); return null; },
      },
    });
    await t.process();
    await drain(t);
    expect((await t.status()).status).toBe('completed');
    expect(t.whisperCalls().filter(c => c.retry)).toHaveLength(1);   // the second clip was never sent
    // The first clip covered 405-585 s; the rest of the hole stays empty
    const late = t.env.DB.rows('SELECT COUNT(*) AS n FROM transcript_segments WHERE start_ms >= 590000 AND start_ms < 700000')[0].n;
    expect(late).toBe(0);
  });
});

describe('POST /process', () => {
  it('ignores a repeated upload while the run is alive', async () => {
    const t = setup();
    await t.process();
    expect((await t.process()).body).toEqual({ status: 'already_processing', episodeId: ID });
    expect((await t.process({ restart: true })).body).toEqual({ status: 'already_processing', episodeId: ID });
  });

  it('wakes a live run with force, and resumes one silent for an hour', async () => {
    const t = setup();
    await t.process();
    await t.storage.setAlarm(Date.now() + RETRY_DELAYS_MS[2]);
    expect((await t.process({ force: true })).body).toMatchObject({ status: 'resumed' });
    expect(t.storage.alarm).toBe(Date.now());

    vi.setSystemTime(Date.now() + STALE_MS);
    expect((await t.process()).body).toMatchObject({ status: 'resumed', step: 'transcribe' });
  });

  it('starts over on a new file for a failed, unpublished run, and refuses once published', async () => {
    const t = setup({ fetch: { whisper: () => new Response('bad audio', { status: 400 }) } });
    await t.process();
    await drain(t);
    expect((await t.status()).status).toBe('failed');

    t.env.AUDIO_BUCKET.replace(KEY, whisperAudio(30 * 60), 'etag-2');
    expect((await t.process()).body).toEqual({ status: 'started', episodeId: ID });

    await t.storage.put('status', 'failed');
    t.env.DB.sqlite.prepare('INSERT INTO episodes (id, title) VALUES (?, ?)').run(ID, 'Published');
    t.env.AUDIO_BUCKET.replace(KEY, whisperAudio(30 * 60), 'etag-3');
    const res = await t.process();
    expect(res.status).toBe(409);
    expect(res.body.status).toBe('different_file');
  });

  it('says already_exists for a published episode, and restart only works before that', async () => {
    const t = setup();
    t.env.DB.sqlite.prepare('INSERT INTO episodes (id, title) VALUES (?, ?)').run(ID, 'Published');
    expect((await t.process()).body).toEqual({ status: 'already_exists', episodeId: ID });
    expect((await t.process({ restart: true })).status).toBe(409);

    t.env.DB.sqlite.prepare('DELETE FROM episodes').run();
    expect((await t.process({ restart: true })).body).toEqual({ status: 'started', episodeId: ID });
  });

  it('re-runs a completed episode that was deleted from D1', async () => {
    const t = setup();
    await t.process();
    await drain(t);
    t.env.DB.sqlite.exec('DELETE FROM episode_guests; DELETE FROM place_mentions; DELETE FROM transcript_segments; DELETE FROM episodes;');
    expect((await t.process()).body).toEqual({ status: 'started', episodeId: ID });
  });

  it('answers 404 for a file that is not in R2 and 400 for a name it cannot read', async () => {
    const t = setup();
    t.env.AUDIO_BUCKET.objects.delete(KEY);
    expect((await t.process()).status).toBe(404);
    const res = await t.pipeline.fetch(new Request('http://internal/process', { method: 'POST', body: JSON.stringify({ key: 'mystery.mp3' }) }));
    expect(res.status).toBe(400);
  });
});

describe('runs started by the old code', () => {
  it('finishes a run parked at set-audio-url and gives the episode its audio link', async () => {
    const t = setup();
    t.env.DB.sqlite.prepare('INSERT INTO episodes (id, title, summary) VALUES (?, ?, ?)').run(ID, 'Old run', 'Done except audio.');
    await t.storage.put({ status: 'processing', step: 'set-audio-url', key: KEY, episodeId: ID, updatedAt: Date.now() });
    await t.storage.setAlarm(Date.now());
    await drain(t);
    expect((await t.status()).status).toBe('completed');
    expect(t.env.DB.rows('SELECT audio_file FROM episodes')).toEqual([{ audio_file: AUDIO_URL }]);
  });

  it('makes the missing summary for a run that stopped at embeddings, over its half-written row', async () => {
    const t = setup();
    // The old order seeded first: row titled with the raw ID, no summary, no audio
    t.env.DB.sqlite.prepare('INSERT INTO episodes (id, title, duration_ms) VALUES (?, ?, ?)').run(ID, ID, 1000);
    t.env.DB.sqlite.prepare('INSERT INTO transcript_segments (episode_id, start_ms, end_ms, text) VALUES (?, 0, 1000, ?)').run(ID, 'Old line.');
    const segments = Array.from({ length: 300 }, (_, i) => ({ start_ms: i * 10_000, end_ms: i * 10_000 + 9000, text: i === 60 ? 'Heather Knight joins us this morning.' : `Line ${i}.` }));
    await t.storage.put({ status: 'processing', step: 'embeddings', key: KEY, episodeId: ID, updatedAt: Date.now(), 'segments:0': segments, segmentChunks: 1, durationMs: 3_000_000 });
    await t.storage.setAlarm(Date.now());
    await drain(t);
    expect((await t.status()).status).toBe('completed');
    expect(t.env.DB.rows('SELECT title, summary, audio_file FROM episodes')).toEqual([{ title: 'Stairway Streets!', summary: 'A foggy morning on the stairs.', audio_file: AUDIO_URL }]);
    expect(t.env.DB.rows('SELECT COUNT(*) AS n FROM transcript_segments')[0].n).toBe(300);
  });
});

describe('storing segments', () => {
  it('keeps every stored value under the 128 KiB limit, however long the lines', async () => {
    const t = setup();
    const long = Array.from({ length: 6000 }, (_, i) => ({ start_ms: i * 1000, end_ms: i * 1000 + 900, text: `${i} ` + 'x'.repeat(400) }));
    await t.pipeline.storeSegments(long);   // FakeStorage throws on an oversized value
    expect(await t.pipeline.loadSegments()).toEqual(long);

    await t.pipeline.storeSegments(long.slice(0, 10));
    expect(await t.pipeline.loadSegments()).toHaveLength(10);
    expect([...t.storage.data.keys()].filter(k => k.startsWith('segments:'))).toEqual(['segments:0']);
  });
});

describe('embeddings', () => {
  it('fails for good, not four times, when a binding is missing', async () => {
    const { generateEmbeddings } = await import('../src/embeddings.js');
    await expect(generateEmbeddings(undefined, makeVectorize(), 'ep', [], 0)).rejects.toMatchObject({ permanent: true });
  });
});
