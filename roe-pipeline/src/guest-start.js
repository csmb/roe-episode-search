/**
 * Guest-interview start detection for the Cloudflare ingest pipeline.
 *
 * NOTE: the pure detectGuestStart() below is kept identical to
 * scripts/guest-start.js (the local pipeline / backfill copy). roe-pipeline
 * deploys independently as a Worker, so it carries its own self-contained copy
 * rather than importing across the package boundary. If you change the
 * algorithm, change both — roe-pipeline/test/guest-start.test.js asserts they
 * stay in sync.
 *
 * Algorithm:
 *   1. Only look at segments after 50 minutes (3,000,000ms)
 *   2. Find the last "song break" — a segment >=180s or a gap >=60s between segments
 *   3. After that break, find the first mention of any guest name
 *   4. Fallback A: first guest name mention after 50min (no song break found)
 *   5. Fallback B: first speech segment after the last song break
 *   6. Fallback C: 3,600,000ms (1 hour)
 */

export const MIN_START_MS = 3_000_000; // 50 minutes
export const SONG_DURATION_MS = 180_000; // 3 minutes — segments this long are songs
export const GAP_THRESHOLD_MS = 60_000; // 1 minute gap between segments
export const FALLBACK_MS = 3_600_000; // 1 hour

/**
 * Detect the guest interview start timestamp from transcript segments.
 * @param {Array<{start_ms:number,end_ms:number,text:string}>} segments
 * @param {string[]} guestNames
 * @returns {number|null} start_ms, or null if detection fails
 */
export function detectGuestStart(segments, guestNames) {
  if (guestNames.length === 0) return null;

  const late = segments.filter(s => s.start_ms >= MIN_START_MS);
  if (late.length === 0) return null;

  const breaks = [];
  for (let i = 0; i < late.length; i++) {
    const seg = late[i];
    const duration = seg.end_ms - seg.start_ms;
    if (duration >= SONG_DURATION_MS) {
      breaks.push({ type: 'song', index: i, end_ms: seg.end_ms });
    }
    if (i > 0) {
      const gap = seg.start_ms - late[i - 1].end_ms;
      if (gap >= GAP_THRESHOLD_MS) {
        breaks.push({ type: 'gap', index: i, end_ms: late[i - 1].end_ms });
      }
    }
  }

  const lowerNames = guestNames.map(n => n.toLowerCase());
  const segmentMentionsGuest = (seg) => {
    const text = seg.text.toLowerCase();
    return lowerNames.some(name => text.includes(name));
  };

  // Strategy 1: after the last song break, first guest mention
  if (breaks.length > 0) {
    breaks.sort((a, b) => a.end_ms - b.end_ms);
    const lastBreak = breaks[breaks.length - 1];
    const afterBreak = late.filter(s => s.start_ms >= lastBreak.end_ms);

    for (const seg of afterBreak) {
      if (segmentMentionsGuest(seg)) return seg.start_ms;
    }
    // Fallback B: first speech segment after the last song break
    if (afterBreak.length > 0) return afterBreak[0].start_ms;
  }

  // Fallback A: first guest mention after 50 minutes (no song break)
  for (const seg of late) {
    if (segmentMentionsGuest(seg)) return seg.start_ms;
  }

  // Fallback C: 1 hour
  return FALLBACK_MS;
}

/**
 * Pipeline step: detect and persist guest_start_ms for an episode.
 * Reads the guest list from D1 (populated by the summary step) and writes
 * episodes.guest_start_ms — the field that gates the "Skip to interview" button.
 *
 * @param {D1Database} db
 * @param {string} episodeId
 * @param {Array<{start_ms:number,end_ms:number,text:string}>} segments
 * @param {number} durationMs
 * @returns {Promise<number|null>} the start_ms written, or null if skipped
 */
export async function seedGuestStart(db, episodeId, segments, durationMs) {
  const { results } = await db.prepare(
    'SELECT guest_name FROM episode_guests WHERE episode_id = ?'
  ).bind(episodeId).all();
  const guests = (results || []).map(r => r.guest_name);

  if (guests.length === 0) {
    console.log(`  [${episodeId}] no guests — skipping guest_start_ms`);
    return null;
  }
  if (durationMs && durationMs < MIN_START_MS) {
    console.log(`  [${episodeId}] shorter than 50min — skipping guest_start_ms`);
    return null;
  }

  const startMs = detectGuestStart(segments, guests);
  if (startMs == null) {
    console.log(`  [${episodeId}] no guest start detected — skipping`);
    return null;
  }
  if (durationMs && startMs > durationMs) {
    console.log(`  [${episodeId}] detected ${startMs}ms exceeds duration ${durationMs}ms — skipping`);
    return null;
  }

  await db.prepare('UPDATE episodes SET guest_start_ms = ? WHERE id = ?')
    .bind(startMs, episodeId).run();

  const minutes = Math.floor(startMs / 60000);
  const seconds = Math.floor((startMs % 60000) / 1000);
  console.log(`  [${episodeId}] guest_start_ms=${startMs} (${minutes}:${String(seconds).padStart(2, '0')})`);
  return startMs;
}
