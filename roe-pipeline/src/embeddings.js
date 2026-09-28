/**
 * Generate windowed embeddings and upsert to Vectorize.
 * Vector IDs come from the episode and each window's start, so running this
 * again for the same transcript overwrites the same vectors.
 */

import { PermanentError, TIMEOUT_MS, withTimeout } from './limits.js';

// The site embeds search queries with the same model, and the local scripts
// import it from here, so every vector in the index is comparable.
export const EMBED_MODEL = '@cf/baai/bge-base-en-v1.5';

const WINDOW_SEC = 45;
const STEP_SEC = 35;
const EMBED_BATCH_SIZE = 100;
const UPSERT_BATCH_SIZE = 1000;

function isAscii(text) {
  return /^[\x00-\x7F]*$/.test(text);
}

/**
 * The windows an episode is embedded in: 45 seconds every 35, each holding the
 * text of the lines it overlaps. A window's ID is the episode plus the start of
 * its first line, so the same transcript always gives the same IDs. The local
 * scripts use this too, to work out an episode's vector IDs from its lines.
 *
 * @param {string} episodeId
 * @param {Array<{start_ms: number, end_ms: number, text: string}>} segments - in time order
 * @param {number} [durationMs] - the audio's length (the last line's end is used if longer)
 * @returns {Array<{id: string, start_ms: number, end_ms: number, text: string}>}
 */
export function chunkSegments(episodeId, segments, durationMs = 0) {
  const windowMs = WINDOW_SEC * 1000;
  const stepMs = STEP_SEC * 1000;
  const endMs = segments.reduce((max, s) => Math.max(max, s.end_ms), durationMs || 0);
  const chunks = [];

  for (let windowStart = 0; windowStart < endMs; windowStart += stepMs) {
    const windowEnd = windowStart + windowMs;
    const windowSegments = segments.filter(s => s.end_ms > windowStart && s.start_ms < windowEnd);
    if (windowSegments.length === 0) continue;

    const text = windowSegments.map(s => s.text).join(' ').trim();
    if (!isAscii(text)) continue;
    if (text.length < 20) continue;

    const id = `${episodeId}:${windowSegments[0].start_ms}`;
    // A long line can start two neighbouring windows, which would give both the
    // same ID, and Vectorize keeps whichever is written last. Keep the first.
    if (chunks.at(-1)?.id === id) continue;
    chunks.push({ id, start_ms: windowSegments[0].start_ms, end_ms: windowSegments.at(-1).end_ms, text });
  }
  return chunks;
}

/**
 * @param {Ai} ai - Workers AI binding
 * @param {VectorizeIndex} vectorize - Vectorize binding
 * @param {string} episodeId
 * @param {Array<{start_ms: number, end_ms: number, text: string}>} segments
 * @param {number} durationMs
 * @returns {number} Number of vectors upserted
 */
export async function generateEmbeddings(ai, vectorize, episodeId, segments, durationMs) {
  if (!ai || !vectorize) throw new PermanentError('The AI or VECTORIZE binding is missing');
  if (segments.length === 0) return 0;

  const chunks = chunkSegments(episodeId, segments, durationMs).map(c => ({
    id: c.id,
    text: c.text,
    metadata: { episode_id: episodeId, title: episodeId, start_ms: c.start_ms, end_ms: c.end_ms, text: c.text },
  }));

  console.log(`  ${chunks.length} chunks to embed`);

  // Generate embeddings in batches via Workers AI
  const vectors = [];
  for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
    const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
    const texts = batch.map(c => c.text);

    const result = await withTimeout(ai.run(EMBED_MODEL, { text: texts }), TIMEOUT_MS.ai, 'Workers AI');
    if (!Array.isArray(result?.data) || result.data.length !== batch.length) {
      throw new Error(`Workers AI returned ${result?.data?.length ?? 0} vectors for ${batch.length} texts`);
    }

    for (let j = 0; j < batch.length; j++) {
      vectors.push({
        id: batch[j].id,
        values: result.data[j],
        metadata: batch[j].metadata,
      });
    }

    console.log(`  Embedded ${Math.min(i + EMBED_BATCH_SIZE, chunks.length)}/${chunks.length}`);
  }

  // Upsert to Vectorize in batches
  for (let i = 0; i < vectors.length; i += UPSERT_BATCH_SIZE) {
    const batch = vectors.slice(i, i + UPSERT_BATCH_SIZE);
    await withTimeout(vectorize.upsert(batch), TIMEOUT_MS.ai, 'Vectorize upsert');
    console.log(`  Upserted ${Math.min(i + UPSERT_BATCH_SIZE, vectors.length)}/${vectors.length}`);
  }

  return vectors.length;
}
