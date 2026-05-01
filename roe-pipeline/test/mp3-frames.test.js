import { describe, it, expect } from 'vitest';
import { parseFrameHeader } from '../src/mp3-frames.js';

// --- Header builder helpers --------------------------------------------------

// Build a 4-byte MPEG audio frame header. Defaults: MPEG-1 Layer III, 128 kbps,
// 44.1 kHz, no padding, mono. Pass overrides as needed.
function buildHeader({
  version = 3,        // 0=2.5, 1=reserved, 2=2, 3=1
  layer = 1,          // 0=reserved, 1=III, 2=II, 3=I
  bitrateIdx = 9,     // MPEG-1 L3 idx 9 = 128 kbps
  sampleRateIdx = 0,  // MPEG-1 idx 0 = 44.1 kHz
  padding = 0,
  protection = 1,
} = {}) {
  const b0 = 0xFF;
  const b1 = 0xE0 | ((version & 0x3) << 3) | ((layer & 0x3) << 1) | (protection & 0x1);
  const b2 = ((bitrateIdx & 0xF) << 4) | ((sampleRateIdx & 0x3) << 2) | ((padding & 0x1) << 1);
  const b3 = 0x00;
  return new Uint8Array([b0, b1, b2, b3]);
}

// --- parseFrameHeader --------------------------------------------------------

describe('parseFrameHeader', () => {
  it('parses MPEG-1 Layer III, 128 kbps, 44.1 kHz, no padding (frameSize=417)', () => {
    const h = buildHeader();
    const result = parseFrameHeader(h, 0);
    expect(result).toEqual({ frameSize: 417, version: 3, layer: 1, sampleRate: 44100 });
  });

  it('adds 1 to frameSize when padding bit is set', () => {
    const h = buildHeader({ padding: 1 });
    expect(parseFrameHeader(h, 0).frameSize).toBe(418);
  });

  it('parses MPEG-2 Layer III, 64 kbps, 22.05 kHz (frameSize=208)', () => {
    // MPEG-2 L3 bitrate idx 8 = 64 kbps; sampleRateIdx 0 = 22050 Hz
    // floor(72 * 64000 / 22050) = 208
    const h = buildHeader({ version: 2, bitrateIdx: 8, sampleRateIdx: 0 });
    const result = parseFrameHeader(h, 0);
    expect(result).toEqual({ frameSize: 208, version: 2, layer: 1, sampleRate: 22050 });
  });

  it('parses MPEG-1 Layer II, 128 kbps, 44.1 kHz (frameSize=417)', () => {
    // MPEG-1 L2 bitrate idx 8 = 128 kbps; sampleRateIdx 0 = 44100 Hz
    // floor(144 * 128000 / 44100) = 417
    const h = buildHeader({ layer: 2, bitrateIdx: 8, sampleRateIdx: 0 });
    const result = parseFrameHeader(h, 0);
    expect(result).toEqual({ frameSize: 417, version: 3, layer: 2, sampleRate: 44100 });
  });

  it('parses MPEG-1 Layer I, 128 kbps, 44.1 kHz (frameSize=136)', () => {
    // MPEG-1 L1 bitrate idx 4 = 128 kbps; sampleRateIdx 0 = 44100 Hz
    // (floor(12 * 128000 / 44100) + 0) * 4 = 34 * 4 = 136
    const h = buildHeader({ layer: 3, bitrateIdx: 4, sampleRateIdx: 0 });
    const result = parseFrameHeader(h, 0);
    expect(result).toEqual({ frameSize: 136, version: 3, layer: 3, sampleRate: 44100 });
  });

  it('returns null for reserved MPEG version (01)', () => {
    const h = buildHeader({ version: 1 });
    expect(parseFrameHeader(h, 0)).toBeNull();
  });

  it('returns null for reserved layer (00)', () => {
    const h = buildHeader({ layer: 0 });
    expect(parseFrameHeader(h, 0)).toBeNull();
  });

  it('returns null for free-format bitrate index (0)', () => {
    const h = buildHeader({ bitrateIdx: 0 });
    expect(parseFrameHeader(h, 0)).toBeNull();
  });

  it('returns null for reserved bitrate index (15)', () => {
    const h = buildHeader({ bitrateIdx: 15 });
    expect(parseFrameHeader(h, 0)).toBeNull();
  });

  it('returns null for reserved sample rate index (3)', () => {
    const h = buildHeader({ sampleRateIdx: 3 });
    expect(parseFrameHeader(h, 0)).toBeNull();
  });

  it('returns null when sync is incomplete (0xFF 0xC0)', () => {
    const bytes = new Uint8Array([0xFF, 0xC0, 0x90, 0x00]);
    expect(parseFrameHeader(bytes, 0)).toBeNull();
  });

  it('returns null when fewer than 4 bytes remain', () => {
    const h = buildHeader();
    expect(parseFrameHeader(h, 1)).toBeNull(); // only 3 bytes left from offset 1
  });

  it('parses at non-zero offset', () => {
    const h = buildHeader();
    const buf = new Uint8Array(10);
    buf.set(h, 4);
    expect(parseFrameHeader(buf, 4).frameSize).toBe(417);
  });
});

// --- findFrameStart ----------------------------------------------------------

import { findFrameStart } from '../src/mp3-frames.js';

// Build a sequence of `count` identical frames (zeroed audio payload).
function buildFrames(count, headerOpts = {}) {
  const header = buildHeader(headerOpts);
  // For default args (MPEG-1 L3 128k 44.1k no padding) the frame size is 417.
  // For other configurations callers should pass frameSize explicitly.
  const frameSize = headerOpts.frameSize || 417;
  const buf = new Uint8Array(frameSize * count);
  for (let i = 0; i < count; i++) {
    buf.set(header, i * frameSize);
  }
  return { buf, frameSize };
}

describe('findFrameStart', () => {
  it('returns 0 when a valid frame starts at offset 0 (with a second frame following)', () => {
    const { buf } = buildFrames(2);
    expect(findFrameStart(buf, 0)).toBe(0);
  });

  it('finds frame after a 1024-byte preamble (simulating ID3v2 tag)', () => {
    const { buf: frames } = buildFrames(2);
    const buf = new Uint8Array(1024 + frames.length);
    // Preamble: deterministic non-sync bytes, but include one stray 0xFF to make
    // sure we don't false-positive on it.
    for (let i = 0; i < 1024; i++) buf[i] = (i * 17) & 0xFF;
    buf[500] = 0xFF; // lone stray sync byte
    buf[501] = 0x00; // ...followed by a non-sync byte
    buf.set(frames, 1024);
    expect(findFrameStart(buf, 0)).toBe(1024);
  });

  it('rejects a lone 0xFF/0xE0-mask candidate that is not followed by a real second frame', () => {
    const { buf: frames } = buildFrames(2);
    const buf = new Uint8Array(2048 + frames.length);
    // Place a single fake header at offset 100 that LOOKS valid in isolation
    // but has zeroed audio payload (so the next "frame" at 100+417 is all zeros, not a sync).
    const fake = buildHeader();
    buf.set(fake, 100);
    // No matching second frame at offset 517.
    buf.set(frames, 2048);
    expect(findFrameStart(buf, 0)).toBe(2048);
  });

  it('returns -1 when no validated frame is present', () => {
    const buf = new Uint8Array(4096);
    for (let i = 0; i < buf.length; i++) buf[i] = (i * 13) & 0xFF;
    expect(findFrameStart(buf, 0)).toBe(-1);
  });

  it('respects fromOffset (skips earlier frames)', () => {
    const { buf } = buildFrames(3); // 3 frames at 0, 417, 834
    expect(findFrameStart(buf, 100)).toBe(417);
  });
});
