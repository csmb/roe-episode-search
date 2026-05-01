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
