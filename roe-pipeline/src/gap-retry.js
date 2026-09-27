/**
 * Recover transcript holes Whisper leaves in a chunk.
 *
 * Whisper sometimes returns nothing for many minutes after a song, then
 * resumes (2026-09-24: 1:17:39→1:31:14 missing, hiding the interview start).
 * Re-sending the silent stretch usually transcribes fine, especially in short
 * clips that each start fresh instead of on the song that stalled it. If a
 * retry also comes back empty, the stretch is real music or dead air and is
 * left alone; a failed retry request is logged and skipped, never fatal.
 */

import { parseFrameHeader, findFrameStart } from './mp3-frames.js';

export const MIN_GAP_MS = 5 * 60 * 1000;
export const RETRY_CLIP_SEC = 180; // long holes are re-sent as 3-minute clips

/**
 * Stretches of at least `minGapMs` inside [spanStartMs, spanEndMs) with no
 * transcript, including the leading and trailing edges of the span.
 */
export function findGaps(segments, spanStartMs, spanEndMs, minGapMs) {
  const sorted = [...segments].sort((a, b) => a.start_ms - b.start_ms);
  const gaps = [];
  let coveredTo = spanStartMs;
  for (const s of sorted) {
    if (s.start_ms - coveredTo >= minGapMs) gaps.push({ startMs: coveredTo, endMs: s.start_ms });
    coveredTo = Math.max(coveredTo, s.end_ms);
  }
  if (spanEndMs - coveredTo >= minGapMs) gaps.push({ startMs: coveredTo, endMs: spanEndMs });
  return gaps;
}

// Samples per frame by header layer (1=III, 2=II, 3=I); MPEG-2/2.5 Layer III halves it.
function samplesPerFrame({ version, layer }) {
  if (layer === 3) return 384;
  if (layer === 1 && version !== 3) return 576;
  return 1152;
}

/**
 * Frame-aligned byte range of `bytes` covering [fromSec, toSec), by walking
 * frame headers and counting samples — exact even for VBR. `startSec` is the
 * time of the first frame in the range, relative to the first frame in `bytes`.
 */
export function sliceByTime(bytes, fromSec, toSec) {
  let offset = findFrameStart(bytes, 0);
  if (offset < 0) throw new Error('No MPEG frame found');

  let t = 0;
  let start = -1, startSec = 0;
  while (offset < bytes.length) {
    const h = parseFrameHeader(bytes, offset);
    if (!h || h.frameSize <= 0) {
      const next = findFrameStart(bytes, offset + 1);
      if (next < 0) break;
      offset = next;
      continue;
    }
    if (start < 0 && t >= fromSec) { start = offset; startSec = t; }
    if (t >= toSec) return { start, end: offset, startSec };
    t += samplesPerFrame(h) / h.sampleRate;
    offset += h.frameSize;
  }
  if (start < 0) throw new Error(`No frame at or after ${fromSec}s`);
  return { start, end: Math.min(offset, bytes.length), startSec };
}

/**
 * Re-transcribe one hole of `bytes` in clips of at most `clipSec`, keeping
 * only segments that land inside the hole. `bytesStartSec` is the absolute
 * time of the first frame in `bytes`.
 */
export async function retryHole(bytes, bytesStartSec, gap, transcribe, { clipSec = RETRY_CLIP_SEC } = {}) {
  const recovered = [];
  const endSec = gap.endMs / 1000;
  for (let from = gap.startMs / 1000; from < endSec; from += clipSec) {
    const to = Math.min(from + clipSec, endSec);
    let slice;
    try {
      slice = sliceByTime(bytes, from - bytesStartSec, to - bytesStartSec);
    } catch {
      continue;
    }
    if (slice.end <= slice.start) continue;
    try {
      const { segments: retry } = await transcribe(bytes.subarray(slice.start, slice.end), bytesStartSec + slice.startSec);
      recovered.push(...retry.filter(s => s.start_ms >= gap.startMs && s.start_ms < gap.endMs));
    } catch (err) {
      console.warn(`  Gap retry ${from.toFixed(0)}s–${to.toFixed(0)}s failed, keeping what we have: ${err.message}`);
    }
  }
  return recovered;
}

const byStart = (a, b) => a.start_ms - b.start_ms;

/**
 * Re-transcribe each gap in a chunk's segments and merge what comes back.
 *
 * @param {Uint8Array} chunkBytes - the mp3 bytes that were sent to Whisper
 * @param {Array} segments - that chunk's segments, in absolute ms
 * @param {number} chunkStartSec - absolute time of the chunk's first frame
 * @param {number} chunkDurationSec - duration Whisper reported for the chunk
 * @param {(bytes: Uint8Array, offsetSec: number) => Promise<{segments: Array}>} transcribe
 * @returns {Promise<{segments: Array, unfilled: Array<{startMs: number, endMs: number}>}>}
 */
export async function fillGaps(chunkBytes, segments, chunkStartSec, chunkDurationSec, transcribe, { minGapMs = MIN_GAP_MS, clipSec = RETRY_CLIP_SEC } = {}) {
  const chunkStartMs = Math.round(chunkStartSec * 1000);
  const chunkEndMs = chunkStartMs + Math.round(chunkDurationSec * 1000);
  const gaps = findGaps(segments, chunkStartMs, chunkEndMs, minGapMs);
  if (gaps.length === 0) return { segments, unfilled: [] };

  const recovered = [];
  for (const gap of gaps) {
    const got = await retryHole(chunkBytes, chunkStartSec, gap, transcribe, { clipSec });
    const label = `${(gap.startMs / 1000).toFixed(0)}s–${(gap.endMs / 1000).toFixed(0)}s`;
    console.log(got.length
      ? `  Gap ${label}: recovered ${got.length} segments on retry`
      : `  Gap ${label}: still empty on retry (music or silence), keeping as-is`);
    recovered.push(...got);
  }

  const merged = recovered.length ? [...segments, ...recovered].sort(byStart) : segments;
  return { segments: merged, unfilled: findGaps(merged, chunkStartMs, chunkEndMs, minGapMs) };
}

/**
 * A hole that straddles the boundary between two chunks: too short on each
 * side for either chunk's own check, but at least `minGapMs` in total.
 * Returns the two halves to retry, or null.
 */
export function findBoundaryHole(prevSegments, prevEndMs, curSegments, curStartMs, minGapMs = MIN_GAP_MS) {
  const lastEnd = prevSegments.reduce((max, s) => Math.max(max, s.end_ms), -Infinity);
  const firstStart = curSegments.reduce((min, s) => Math.min(min, s.start_ms), Infinity);
  if (!Number.isFinite(lastEnd) || !Number.isFinite(firstStart)) return null;
  const tail = prevEndMs - lastEnd, head = firstStart - curStartMs;
  if (tail <= 0 || head <= 0 || tail >= minGapMs || head >= minGapMs || tail + head < minGapMs) return null;
  return { prev: { startMs: lastEnd, endMs: prevEndMs }, cur: { startMs: curStartMs, endMs: firstStart } };
}
