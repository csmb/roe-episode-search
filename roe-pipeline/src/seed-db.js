/**
 * Write an episode to D1: its row, every transcript segment and its guests, in
 * one batch. A D1 batch is a single transaction, so the episode appears on the
 * site complete or not at all, and running it again replaces what an earlier
 * run wrote instead of failing on the existing row.
 *
 * FTS index is updated automatically by database triggers.
 */

const DB_BATCH_SIZE = 20; // D1 has ~100 SQL variable limit; 20 rows × 4 params = 80 vars

/**
 * The statements seedEpisode runs, in order.
 *
 * The row is upserted, never deleted: transcript lines and guests reference it,
 * and D1 enforces those foreign keys. guests_reviewed and guest_start_ms are
 * left as they are, and an audio link already on the row (a repaired .m4a) wins.
 * So do the title and summary of a reviewed episode, or of one that already
 * has a summary: those may have been written by hand (e.g. "Recording Lost").
 *
 * @param {D1Database} db
 * @param {object} ep
 * @param {string} ep.episodeId
 * @param {string} ep.title
 * @param {string|null} ep.summary
 * @param {string[]} ep.guests
 * @param {string} ep.audioUrl
 * @param {number} ep.durationMs
 * @param {Array<{start_ms: number, end_ms: number, text: string}>} ep.segments
 * @param {boolean} [keepGuests] - leave the guest list alone (reviewed in admin)
 */
export function seedStatements(db, { episodeId, title, summary, guests, audioUrl, durationMs, segments }, keepGuests = false) {
  // Extract date from episode ID (format: roll-over-easy_YYYY-MM-DD_HH-MM-SS)
  const dateMatch = episodeId.match(/(\d{4}-\d{2}-\d{2})/);
  const publishedAt = dateMatch ? dateMatch[1] : null;

  const keepText = "episodes.guests_reviewed = 1 OR TRIM(COALESCE(episodes.summary, '')) <> ''";
  const statements = [
    db.prepare(`INSERT INTO episodes (id, title, audio_file, duration_ms, published_at, summary) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      ON CONFLICT(id) DO UPDATE SET
        title = CASE WHEN ${keepText} THEN episodes.title ELSE excluded.title END,
        summary = CASE WHEN ${keepText} THEN episodes.summary ELSE excluded.summary END,
        duration_ms = excluded.duration_ms, published_at = excluded.published_at,
        audio_file = COALESCE(episodes.audio_file, excluded.audio_file)`)
      .bind(episodeId, title, audioUrl, durationMs, publishedAt, summary),
    db.prepare('DELETE FROM transcript_segments WHERE episode_id = ?').bind(episodeId),
  ];

  for (let i = 0; i < segments.length; i += DB_BATCH_SIZE) {
    const batch = segments.slice(i, i + DB_BATCH_SIZE);
    const placeholders = batch.map(() => '(?, ?, ?, ?)').join(', ');
    const values = batch.flatMap(s => [episodeId, s.start_ms, s.end_ms, s.text]);
    statements.push(db.prepare(
      `INSERT INTO transcript_segments (episode_id, start_ms, end_ms, text) VALUES ${placeholders}`
    ).bind(...values));
  }

  if (!keepGuests) {
    statements.push(db.prepare('DELETE FROM episode_guests WHERE episode_id = ?').bind(episodeId));
    for (const name of guests) {
      statements.push(db.prepare('INSERT OR IGNORE INTO episode_guests (episode_id, guest_name) VALUES (?, ?)')
        .bind(episodeId, name));
    }
  }
  return statements;
}

/**
 * Seed one episode (see seedStatements), then check that every transcript
 * segment landed.
 *
 * @returns {Promise<{segments: number, guestsKept: boolean}>}
 */
export async function seedEpisode(db, ep) {
  const existing = await db.prepare('SELECT guests_reviewed FROM episodes WHERE id = ?').bind(ep.episodeId).first();
  const keepGuests = existing?.guests_reviewed === 1;
  if (keepGuests) console.log(`  Guests already reviewed for ${ep.episodeId}; keeping them`);

  await db.batch(seedStatements(db, ep, keepGuests));

  const row = await db.prepare('SELECT COUNT(*) AS n FROM transcript_segments WHERE episode_id = ?').bind(ep.episodeId).first();
  if (row?.n !== ep.segments.length) {
    throw new Error(`Seeded ${row?.n} transcript segments for ${ep.episodeId}, expected ${ep.segments.length}`);
  }
  console.log(`  Seeded ${ep.segments.length} segments for ${ep.episodeId}`);
  return { segments: ep.segments.length, guestsKept: keepGuests };
}
