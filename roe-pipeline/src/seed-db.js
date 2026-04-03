/**
 * Seed episode and transcript segments into D1.
 * FTS index is updated automatically by database triggers.
 */

const DB_BATCH_SIZE = 20; // D1 has ~100 SQL variable limit; 20 rows × 4 params = 80 vars

/**
 * @param {D1Database} db
 * @param {string} episodeId
 * @param {number} durationMs
 * @param {Array<{start_ms: number, end_ms: number, text: string}>} segments
 */
export async function seedDatabase(db, episodeId, durationMs, segments) {
  // Extract date from episode ID (format: roll-over-easy_YYYY-MM-DD_HH-MM-SS)
  const dateMatch = episodeId.match(/(\d{4}-\d{2}-\d{2})/);
  const publishedAt = dateMatch ? dateMatch[1] : null;

  // Insert episode row (title defaults to episodeId, updated later by summary step)
  await db.prepare('INSERT INTO episodes (id, title, duration_ms, published_at) VALUES (?, ?, ?, ?)')
    .bind(episodeId, episodeId, durationMs, publishedAt)
    .run();

  // Insert transcript segments in batches
  for (let i = 0; i < segments.length; i += DB_BATCH_SIZE) {
    const batch = segments.slice(i, i + DB_BATCH_SIZE);
    const placeholders = batch.map(() => '(?, ?, ?, ?)').join(', ');
    const values = batch.flatMap(s => [episodeId, s.start_ms, s.end_ms, s.text]);

    await db.prepare(
      `INSERT INTO transcript_segments (episode_id, start_ms, end_ms, text) VALUES ${placeholders}`
    ).bind(...values).run();
  }

  console.log(`  Seeded ${segments.length} segments for ${episodeId}`);

  // Purge hallucinated phrases that survived cleaning
  await purgeHallucinations(db, episodeId);
}

async function purgeHallucinations(db, episodeId) {
  const { results } = await db.prepare(`
    SELECT text, COUNT(*) as cnt FROM transcript_segments
    WHERE episode_id = ? GROUP BY text HAVING cnt > 20 AND length(text) > 20
  `).bind(episodeId).all();

  if (!results || results.length === 0) return;

  for (const row of results) {
    await db.prepare(
      'DELETE FROM transcript_segments WHERE episode_id = ? AND text = ?'
    ).bind(episodeId, row.text).run();
  }

  const totalDeleted = results.reduce((sum, r) => sum + r.cnt, 0);
  console.log(`  Purged ${totalDeleted} hallucinated segments (${results.length} phrase(s))`);
}
