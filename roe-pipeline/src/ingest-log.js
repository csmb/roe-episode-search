/**
 * The ingest log (N5): one D1 row for each upload the queue sees, saying what
 * became of it, so an upload that is skipped (a name the pipeline can't read,
 * a second copy) or that never starts shows on the admin page's Uploads tab
 * instead of vanishing into a short-lived log line.
 *
 * Outcomes: "started" (handed to its show's pipeline), "skipped" (with why),
 * "retrying" (the hand-over failed; the queue tries again) and "gave up" (the
 * queue's last try failed and the message reached the dead-letter queue).
 * The pipeline's own files are not logged: its joined shows and the .m4a
 * audio it writes for the site.
 *
 * Writing the log never stops an upload: a failed insert is only reported.
 */

export const OWN_FILE = /^(joined\/|roll-over-easy_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.m4a$)/;
export const DEAD_LETTER_QUEUE = 'roe-pipeline-dlq';
const DETAIL_CHARS = 500;

/**
 * Record what became of one upload.
 * @param {D1Database|undefined} db
 * @param {{key: string, size?: number|null, outcome: 'started'|'skipped'|'retrying'|'gave up', detail?: string|null}} entry
 */
export async function logIngest(db, { key, size = null, outcome, detail = null }, now = new Date()) {
  if (!db) return;
  try {
    await db.prepare('INSERT INTO ingest_log (at, key, size, outcome, detail) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(now.toISOString(), String(key), Number.isFinite(size) ? size : null, outcome, detail == null ? null : String(detail).slice(0, DETAIL_CHARS))
      .run();
  } catch (err) {
    console.error(`ingest_log: could not record "${outcome}" for ${key}: ${err.message}`);
  }
}
