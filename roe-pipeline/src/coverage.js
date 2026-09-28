/**
 * Does a transcript cover its recording? Used before a transcript is accepted
 * or seeded, so a show that stops at 45 minutes, or a units mistake like the
 * old ×10 timestamps, can't be published as if it were complete.
 *
 * - A transcript that ends past the audio has the wrong times: refused.
 * - One that stops before 90% of the audio is missing its end: refused.
 * - Holes of 5+ minutes (long music, or audio Whisper skipped) are reported, so
 *   the episode can go on the re-transcribe list, but don't refuse it: 81 of
 *   the 530 transcripts on disk have one, most of them songs.
 */

import { findGaps, MIN_GAP_MS } from './gap-retry.js';

export const MIN_COVERAGE = 0.9;
const OVERRUN_MS = 30_000; // the last line may run a little past the audio

const minutes = ms => `${(ms / 60_000).toFixed(1)} min`;

/**
 * @param {Array<{start_ms: number, end_ms: number}>} segments
 * @param {number} audioMs - the recording's real length (ffprobe, or the chunks' durations)
 * @returns {{ok: boolean, problems: string[], holes: Array<{startMs: number, endMs: number}>, endMs: number}}
 */
export function checkCoverage(segments, audioMs) {
  const endMs = segments.reduce((max, s) => Math.max(max, s.end_ms), 0);
  const problems = [];
  if (segments.length === 0) {
    problems.push('it has no lines');
  } else if (!(audioMs > 0)) {
    problems.push("the recording's length is unknown");
  } else if (endMs > audioMs + OVERRUN_MS) {
    problems.push(`it ends at ${minutes(endMs)}, after the ${minutes(audioMs)} recording: the times are wrong`);
  } else if (endMs < audioMs * MIN_COVERAGE) {
    problems.push(`it stops at ${minutes(endMs)} of the ${minutes(audioMs)} recording (${Math.round((100 * endMs) / audioMs)}%)`);
  }
  const holes = audioMs > 0 ? findGaps(segments, 0, audioMs, MIN_GAP_MS) : [];
  return { ok: problems.length === 0, problems, holes, endMs };
}
