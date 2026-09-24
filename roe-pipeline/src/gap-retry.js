/**
 * Recover transcript holes Whisper leaves in a chunk.
 *
 * Whisper sometimes returns nothing for many minutes after a song, then
 * resumes (2026-09-24: 1:17:39→1:31:14 missing, hiding the interview start).
 * Re-sending just the silent stretch usually transcribes fine. If the retry
 * also comes back empty, the stretch is real music or dead air and is left
 * alone — the check never fails the pipeline.
 */

import { parseFrameHeader, findFrameStart } from './mp3-frames.js';

export const MIN_GAP_MS = 5 * 60 * 1000;

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
 * Re-transcribe each gap in a chunk's segments and merge what comes back.
 *
 * @param {Uint8Array} chunkBytes - the mp3 bytes that were sent to Whisper
 * @param {Array} segments - that chunk's segments, in absolute ms
 * @param {number} chunkStartSec - absolute time of the chunk's first frame
 * @param {number} chunkDurationSec - duration Whisper reported for the chunk
 * @param {(bytes: Uint8Array, offsetSec: number) => Promise<{segments: Array}>} transcribe
 */
export async function fillGaps(chunkBytes, segments, chunkStartSec, chunkDurationSec, transcribe, { minGapMs = MIN_GAP_MS } = {}) {
  const chunkStartMs = Math.round(chunkStartSec * 1000);
  const gaps = findGaps(segments, chunkStartMs, chunkStartMs + Math.round(chunkDurationSec * 1000), minGapMs);
  if (gaps.length === 0) return segments;

  const recovered = [];
  for (const gap of gaps) {
    const { start, end, startSec } = sliceByTime(
      chunkBytes, gap.startMs / 1000 - chunkStartSec, gap.endMs / 1000 - chunkStartSec
    );
    const label = `${(gap.startMs / 1000).toFixed(0)}s–${(gap.endMs / 1000).toFixed(0)}s`;
    if (end <= start) continue;

    const { segments: retry } = await transcribe(chunkBytes.subarray(start, end), chunkStartSec + startSec);
    const inGap = retry.filter(s => s.start_ms >= gap.startMs && s.start_ms < gap.endMs);
    console.log(inGap.length
      ? `  Gap ${label}: recovered ${inGap.length} segments on retry`
      : `  Gap ${label}: still empty on retry (music or silence), keeping as-is`);
    recovered.push(...inGap);
  }

  if (recovered.length === 0) return segments;
  return [...segments, ...recovered].sort((a, b) => a.start_ms - b.start_ms);
}
