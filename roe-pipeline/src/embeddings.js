/**
 * Generate windowed embeddings and upsert to Vectorize.
 */

const WINDOW_SEC = 45;
const STEP_SEC = 35;
const EMBED_BATCH_SIZE = 100;
const UPSERT_BATCH_SIZE = 1000;

function isAscii(text) {
  return /^[\x00-\x7F]*$/.test(text);
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
  if (segments.length === 0) return 0;

  // Build windowed chunks
  const windowMs = WINDOW_SEC * 1000;
  const stepMs = STEP_SEC * 1000;
  const chunks = [];

  for (let windowStart = 0; windowStart < durationMs; windowStart += stepMs) {
    const windowEnd = windowStart + windowMs;
    const windowSegments = segments.filter(s => s.end_ms > windowStart && s.start_ms < windowEnd);
    if (windowSegments.length === 0) continue;

    const text = windowSegments.map(s => s.text).join(' ');
    if (!isAscii(text)) continue;
    if (text.trim().length < 20) continue;

    const chunkStartMs = windowSegments[0].start_ms;
    const chunkEndMs = windowSegments[windowSegments.length - 1].end_ms;

    chunks.push({
      id: `${episodeId}:${chunkStartMs}`,
      metadata: {
        episode_id: episodeId,
        title: episodeId,
        start_ms: chunkStartMs,
        end_ms: chunkEndMs,
        text: text.trim(),
      },
      text: text.trim(),
    });
  }

  console.log(`  ${chunks.length} chunks to embed`);

  // Generate embeddings in batches via Workers AI
  const vectors = [];
  for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
    const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
    const texts = batch.map(c => c.text);

    const result = await ai.run('@cf/baai/bge-base-en-v1.5', { text: texts });

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
    await vectorize.upsert(batch);
    console.log(`  Upserted ${Math.min(i + UPSERT_BATCH_SIZE, vectors.length)}/${vectors.length}`);
  }

  return vectors.length;
}
