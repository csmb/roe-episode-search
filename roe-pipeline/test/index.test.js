import { describe, it, expect } from 'vitest';
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

  it('passes the right token through to the Durable Object', async () => {
    const { env, calls } = envWith('s3cret');
    const res = await worker.fetch(req('/status?key=a.mp3', 's3cret'), env);
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ id: 'a.mp3', url: 'http://internal/status' }]);
  });

  it('leaves the health check open', async () => {
    const { env } = envWith(undefined);
    const res = await worker.fetch(req('/'), env);
    expect(await res.json()).toEqual({ service: 'roe-pipeline', status: 'ok' });
  });
});
