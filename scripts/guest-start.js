/**
 * Guest-interview start detection.
 *
 * Shared by the ingest pipeline (process-episode.js) and the catch-up
 * backfill (backfill-guest-start.js) so both agree on how guest_start_ms
 * is computed.
 *
 * Detection algorithm:
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

	// Only consider segments after 50 minutes
	const late = segments.filter(s => s.start_ms >= MIN_START_MS);
	if (late.length === 0) return null;

	// Find song breaks: segments with duration >= 180s, or gaps >= 60s
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

	// Build lowercase guest name list for matching
	const lowerNames = guestNames.map(n => n.toLowerCase());

	function segmentMentionsGuest(seg) {
		const text = seg.text.toLowerCase();
		return lowerNames.some(name => text.includes(name));
	}

	// Strategy 1: After the last song break, find first guest name mention
	if (breaks.length > 0) {
		// Sort breaks by position, take the last one
		breaks.sort((a, b) => a.end_ms - b.end_ms);
		const lastBreak = breaks[breaks.length - 1];
		const afterBreak = late.filter(s => s.start_ms >= lastBreak.end_ms);

		for (const seg of afterBreak) {
			if (segmentMentionsGuest(seg)) {
				return seg.start_ms;
			}
		}

		// Fallback B: first speech segment after the last song break
		if (afterBreak.length > 0) {
			return afterBreak[0].start_ms;
		}
	}

	// Fallback A: first guest name mention after 50 minutes (no song break)
	for (const seg of late) {
		if (segmentMentionsGuest(seg)) {
			return seg.start_ms;
		}
	}

	// Fallback C: 1 hour
	return FALLBACK_MS;
}
