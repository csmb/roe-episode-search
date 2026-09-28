import { describe, it, expect, vi } from 'vitest';
import worker from '../src/index.js';

function envWith(token) {
  const calls = [];
  return {
    calls,
    env: {
      PIPELINE_TOKEN: token,
      EPISODE_PIPELINE: {
        idFromName: name => name,
        get: id => ({ fetch: async (url) => { calls.push({ id, url }); return Response.json({ status: 'idle' }); } }),
      },
    },
  };
}
const req = (path, token, method = 'GET') => new Request(`https://roe-pipeline.example${path}`, {
  method, headers: token ? { Authorization: `Bearer ${token}` } : {},
});

describe('pipeline fetch handler', () => {
  it('keeps /process and /status closed when no token is configured', async () => {
    const { env, calls } = envWith(undefined);
    expect((await worker.fetch(req('/status?key=a.mp3', 'x'), env)).status).toBe(503);
    expect((await worker.fetch(req('/process?key=a.mp3', 'x', 'POST'), env)).status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it('rejects a missing or wrong token', async () => {
    const { env, calls } = envWith('s3cret');
    expect((await worker.fetch(req('/status?key=a.mp3'), env)).status).toBe(401);
    expect((await worker.fetch(req('/process?key=a.mp3', 'nope', 'POST'), env)).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('sends every file of a show to that episode\'s Durable Object', async () => {
    const { env, calls } = envWith('s3cret');
    for (const key of ['Roll Over Easy 2026-10-01 2.mp3', 'joined/Roll Over Easy 2026-10-01.mp3']) {
      const res = await worker.fetch(req(`/status?key=${encodeURIComponent(key)}`, 's3cret'), env);
      expect(res.status).toBe(200);
    }
    await worker.fetch(req('/process?key=Roll%20Over%20Easy%202026-10-01%201.mp3&force=1', 's3cret', 'POST'), env);
    expect(calls.map(c => c.id)).toEqual(Array(3).fill('roll-over-easy_2026-10-01_07-30-00'));
    expect(calls.map(c => c.url)).toEqual(['http://internal/status', 'http://internal/status', 'http://internal/process']);
  });

  it('says why it refuses a copy, a joined file or a name it cannot read', async () => {
    const { env, calls } = envWith('s3cret');
    const copy = 'Roll%20Over%20Easy%202026-10-01%20(1).mp3';
    expect(await (await worker.fetch(req(`/status?key=${copy}`, 's3cret'), env)).json()).toMatchObject({ status: 'refused' });
    expect((await worker.fetch(req(`/process?key=${copy}`, 's3cret', 'POST'), env)).status).toBe(422);
    expect((await worker.fetch(req('/process?key=joined%2FRoll%20Over%20Easy%202026-10-01.mp3', 's3cret', 'POST'), env)).status).toBe(400);
    const unreadable = await worker.fetch(req('/status?key=mystery.mp3', 's3cret'), env);
    expect(unreadable.status).toBe(400);
    expect((await unreadable.json()).error).toContain('Roll Over Easy 2026-10-01.mp3');
    expect(calls).toHaveLength(0);
  });

  it('leaves the health check open', async () => {
    const { env } = envWith(undefined);
    const res = await worker.fetch(req('/'), env);
    expect(await res.json()).toEqual({ service: 'roe-pipeline', status: 'ok' });
  });
});

describe('queue consumer', () => {
  const message = key => {
    const m = { body: { object: { key, size: 1 } }, acked: false, retried: false };
    m.ack = () => { m.acked = true; };
    m.retry = () => { m.retried = true; };
    return m;
  };

  it('routes uploads by episode and skips what is not a show', async () => {
    const { env, calls } = envWith('s3cret');
    const messages = [
      'Roll Over Easy 2026-10-01 1.mp3', 'Roll Over Easy 2026-10-01 2.mp3',
      'joined/Roll Over Easy 2026-10-01.mp3', 'Roll Over Easy 2026-10-01 (1).mp3',
      'roll-over-easy_2026-10-01_07-30-00.m4a', 'notes.mp3',
    ].map(message);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await worker.queue({ messages }, env);
    expect(messages.every(m => m.acked)).toBe(true);
    expect(calls).toEqual([
      { id: 'roll-over-easy_2026-10-01_07-30-00', url: 'http://internal/process' },
      { id: 'roll-over-easy_2026-10-01_07-30-00', url: 'http://internal/process' },
    ]);
    vi.restoreAllMocks();
  });

  it('asks the queue to retry when the Durable Object can\'t be reached', async () => {
    const env = { EPISODE_PIPELINE: { idFromName: n => n, get: () => ({ fetch: async () => { throw new Error('overloaded'); } }) } };
    const m = message('Roll Over Easy 2026-10-01.mp3');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await worker.queue({ messages: [m] }, env);
    expect(m.retried).toBe(true);
    vi.restoreAllMocks();
  });
});
