/**
 * roe-pipeline Worker
 *
 * Queue consumer: receives R2 event notifications and dispatches to
 * EpisodePipeline Durable Object for processing.
 *
 * Also exposes a fetch handler for manual triggering and status checks.
 */

export { EpisodePipeline } from './pipeline.js';

export default {
  /**
   * Queue consumer — handles R2 object-create events.
   * Each message contains an R2 event with the uploaded object key.
   */
  async queue(batch, env) {
    for (const message of batch.messages) {
      const event = message.body;
      const key = event.object?.key;

      if (!key) {
        console.warn('Queue message missing object key, acking:', JSON.stringify(event));
        message.ack();
        continue;
      }

      // Only process MP3 files
      if (!key.toLowerCase().endsWith('.mp3')) {
        console.log(`Skipping non-MP3 file: ${key}`);
        message.ack();
        continue;
      }

      console.log(`Processing R2 event: ${key} (${event.object?.size ?? 'unknown'} bytes)`);

      try {
        // Dispatch to Durable Object keyed by filename (dedup by file)
        const doId = env.EPISODE_PIPELINE.idFromName(key);
        const stub = env.EPISODE_PIPELINE.get(doId);

        const res = await stub.fetch('http://internal/process', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key }),
        });

        const result = await res.json();
        console.log(`DO response for ${key}:`, JSON.stringify(result));
        message.ack();
      } catch (err) {
        console.error(`Failed to dispatch ${key} to DO:`, err.message);
        message.retry();
      }
    }
  },

  /**
   * Fetch handler for manual triggering and status checks.
   *
   * POST /process?key=filename.mp3 — manually trigger pipeline
   * GET  /status?key=filename.mp3  — check pipeline status
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

      const doId = env.EPISODE_PIPELINE.idFromName(key);
      const stub = env.EPISODE_PIPELINE.get(doId);
      const res = await stub.fetch('http://internal/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      return res;
    }

    if (url.pathname === '/status') {
      const key = url.searchParams.get('key');
      if (!key) return Response.json({ error: 'Missing ?key= parameter' }, { status: 400 });

      const doId = env.EPISODE_PIPELINE.idFromName(key);
      const stub = env.EPISODE_PIPELINE.get(doId);
      const res = await stub.fetch('http://internal/status', { method: 'GET' });
      return res;
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
