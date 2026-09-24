import { describe, it, expect } from 'vitest';
import { findGaps, sliceByTime, fillGaps } from '../src/gap-retry.js';

// MPEG-1 Layer III, 128 kbps, 44.1 kHz, no padding: 417-byte frames of
// 1152 samples, i.e. 1152 / 44100 s ≈ 26.12 ms per frame.
const FRAME_SIZE = 417;
const FRAME_SEC = 1152 / 44100;

function buildFrames(count, preamble = 0) {
  const bytes = new Uint8Array(preamble + count * FRAME_SIZE);
  for (let i = 0; i < count; i++) {
    const off = preamble + i * FRAME_SIZE;
    bytes.set([0xFF, 0xFB, 0x90, 0x00], off);
  }
  return bytes;
}

const seg = (startMs, endMs, text = 'words') => ({ start_ms: startMs, end_ms: endMs, text });

// --- findGaps -----------------------------------------------------------------

describe('findGaps', () => {
  it('finds an internal gap at least minGapMs long', () => {
    const segs = [seg(0, 1000), seg(1000, 2000), seg(9000, 10000)];
    expect(findGaps(segs, 0, 10000, 5000)).toEqual([{ startMs: 2000, endMs: 9000 }]);
  });

  it('ignores gaps shorter than minGapMs', () => {
    const segs = [seg(0, 1000), seg(4000, 5000)];
    expect(findGaps(segs, 0, 5000, 5000)).toEqual([]);
  });

  it('finds leading and trailing gaps at the span edges', () => {
    const segs = [seg(8000, 9000)];
    expect(findGaps(segs, 0, 20000, 5000)).toEqual([
      { startMs: 0, endMs: 8000 },
      { startMs: 9000, endMs: 20000 },
    ]);
  });

  it('treats a span with no segments as one gap', () => {
    expect(findGaps([], 1000, 9000, 5000)).toEqual([{ startMs: 1000, endMs: 9000 }]);
  });

  it('measures from the latest end so far, not the previous segment', () => {
    // A long segment covering later short ones must not open a false gap.
    const segs = [seg(0, 8000), seg(1000, 2000), seg(8500, 9000)];
    expect(findGaps(segs, 0, 9000, 5000)).toEqual([]);
  });
});

// --- sliceByTime --------------------------------------------------------------

describe('sliceByTime', () => {
  it('returns frame-aligned offsets and the exact start time of the first frame', () => {
    const bytes = buildFrames(1000);
    const { start, end, startSec } = sliceByTime(bytes, 5, 10);
    const firstFrame = Math.ceil(5 / FRAME_SEC);
    const endFrame = Math.ceil(10 / FRAME_SEC);
    expect(start).toBe(firstFrame * FRAME_SIZE);
    expect(end).toBe(endFrame * FRAME_SIZE);
    expect(startSec).toBeCloseTo(firstFrame * FRAME_SEC, 6);
  });

  it('skips a non-audio preamble (ID3 tag) before counting time', () => {
    const bytes = buildFrames(1000, 300);
    const { start, startSec } = sliceByTime(bytes, 0, 1);
    expect(start).toBe(300);
    expect(startSec).toBe(0);
  });

  it('clamps the end to the buffer when toSec is past the last frame', () => {
    const bytes = buildFrames(100);
    const { end } = sliceByTime(bytes, 1, 999);
    expect(end).toBe(bytes.length);
  });
});

// --- fillGaps -----------------------------------------------------------------

describe('fillGaps', () => {
  const bytes = buildFrames(1000); // ≈ 26.1 s
  const durationSec = 1000 * FRAME_SEC;

  it('re-transcribes a gap and merges the new segments in order, offset to chunk time', async () => {
    const calls = [];
    const transcribe = async (clip, offsetSec) => {
      calls.push({ len: clip.length, offsetSec });
      // Whisper-style: times relative to the clip, shifted by offsetSec.
      return { segments: [seg(Math.round((offsetSec + 1) * 1000), Math.round((offsetSec + 2) * 1000), 'recovered')] };
    };
    const segs = [seg(100_000, 102_000, 'before'), seg(120_000, 121_000, 'after')];

    const out = await fillGaps(bytes, segs, 100, durationSec, transcribe, { minGapMs: 10_000 });

    expect(calls).toHaveLength(1);
    const { startSec } = sliceByTime(bytes, 2, 20);
    expect(calls[0].offsetSec).toBeCloseTo(100 + startSec, 6);
    expect(out.map(s => s.text)).toEqual(['before', 'recovered', 'after']);
  });

  it('keeps the original segments when the retry finds nothing (music or silence)', async () => {
    const transcribe = async () => ({ segments: [] });
    const segs = [seg(0, 1000), seg(20_000, 21_000)];
    const out = await fillGaps(bytes, segs, 0, durationSec, transcribe, { minGapMs: 10_000 });
    expect(out).toEqual(segs);
  });

  it('drops retry segments that fall outside the gap', async () => {
    const transcribe = async () => ({ segments: [seg(500, 900, 'dup of before'), seg(5000, 6000, 'new'), seg(20_500, 20_900, 'dup of after')] });
    const segs = [seg(0, 1000, 'before'), seg(20_000, 21_000, 'after')];
    const out = await fillGaps(bytes, segs, 0, durationSec, transcribe, { minGapMs: 10_000 });
    expect(out.map(s => s.text)).toEqual(['before', 'new', 'after']);
  });

  it('does not call Whisper when there are no gaps', async () => {
    let called = false;
    const transcribe = async () => { called = true; return { segments: [] }; };
    const segs = [seg(0, 13_000), seg(13_000, 26_000)];
    await fillGaps(bytes, segs, 0, durationSec, transcribe, { minGapMs: 10_000 });
    expect(called).toBe(false);
  });
});
