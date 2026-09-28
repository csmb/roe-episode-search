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

export { EpisodePipeline } from './pipeline.js';

/** The Durable Object for the episode `upload` belongs to. */
function pipelineFor(env, upload) {
  return env.EPISODE_PIPELINE.get(env.EPISODE_PIPELINE.idFromName(upload.episodeId));
}

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

      // The pipeline's own joined shows, other files, copies and names that
      // aren't a show date
      if (key.startsWith(JOINED_PREFIX)) {
        console.log(`Skipping ${key}: a show the pipeline joined`);
        message.ack();
        continue;
      }
      const upload = parseUpload(key);
      if (upload.error) {
        console.log(`Skipping ${key}: ${upload.error}`);
        message.ack();
        continue;
      }

      console.log(`Processing R2 event: ${key} (${event.object?.size ?? 'unknown'} bytes)`);

      try {
        const res = await pipelineFor(env, upload).fetch('http://internal/process', {
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
