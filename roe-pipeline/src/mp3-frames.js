/**
 * Pure MPEG audio frame parsing helpers used by transcribe.js to slice mp3
 * files on frame boundaries before sending chunks to OpenAI Whisper.
 *
 * No I/O. No Worker globals. Operates only on Uint8Array.
 */

const VERSION_RESERVED = 1;
const LAYER_RESERVED = 0;
const LAYER_III = 1;
const LAYER_II  = 2;
const LAYER_I   = 3;

// Bitrate (kbps) lookup tables. null = free-format (idx 0) or reserved (idx 15).
const MPEG1_L1 = [null, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, null];
const MPEG1_L2 = [null, 32, 48, 56,  64,  80,  96, 112, 128, 160, 192, 224, 256, 320, 384, null];
const MPEG1_L3 = [null, 32, 40, 48,  56,  64,  80,  96, 112, 128, 160, 192, 224, 256, 320, null];
const MPEG2_L1 = [null, 32, 48, 56,  64,  80,  96, 112, 128, 144, 160, 176, 192, 224, 256, null];
const MPEG2_L23 = [null, 8, 16, 24,  32,  40,  48,  56,  64,  80,  96, 112, 128, 144, 160, null];

function bitrateTableFor(version, layer) {
  if (version === 3) {
    if (layer === LAYER_I)   return MPEG1_L1;
    if (layer === LAYER_II)  return MPEG1_L2;
    if (layer === LAYER_III) return MPEG1_L3;
  } else { // MPEG-2 or 2.5 (version codes 2 and 0)
    if (layer === LAYER_I)              return MPEG2_L1;
    if (layer === LAYER_II || layer === LAYER_III) return MPEG2_L23;
  }
  return null;
}

const SAMPLE_RATE = {
  3: [44100, 48000, 32000], // MPEG-1
  2: [22050, 24000, 16000], // MPEG-2
  0: [11025, 12000,  8000], // MPEG-2.5
};

/**
 * Parse a 4-byte MPEG audio frame header at `offset` in `bytes`.
 * @returns {{frameSize:number, version:number, layer:number, sampleRate:number}|null}
 */
export function parseFrameHeader(bytes, offset) {
  if (offset < 0 || offset + 4 > bytes.length) return null;

  const b0 = bytes[offset];
  const b1 = bytes[offset + 1];
  const b2 = bytes[offset + 2];

  // 11-bit frame sync
  if (b0 !== 0xFF) return null;
  if ((b1 & 0xE0) !== 0xE0) return null;

  const version = (b1 >> 3) & 0x3;
  const layer   = (b1 >> 1) & 0x3;
  if (version === VERSION_RESERVED) return null;
  if (layer === LAYER_RESERVED) return null;

  const bitrateIdx = (b2 >> 4) & 0xF;
  const sampleIdx  = (b2 >> 2) & 0x3;
  const padding    = (b2 >> 1) & 0x1;

  if (sampleIdx === 3) return null;

  const bitrateTable = bitrateTableFor(version, layer);
  if (!bitrateTable) return null;
  const bitrateKbps = bitrateTable[bitrateIdx];
  if (bitrateKbps == null) return null;

  const sampleRate = SAMPLE_RATE[version][sampleIdx];

  let frameSize;
  if (layer === LAYER_I) {
    frameSize = (Math.floor(12 * bitrateKbps * 1000 / sampleRate) + padding) * 4;
  } else if (layer === LAYER_III && version !== 3) {
    // MPEG-2/2.5 Layer III uses 72-byte slot
    frameSize = Math.floor(72 * bitrateKbps * 1000 / sampleRate) + padding;
  } else {
    // MPEG-1 Layer III, or any Layer II
    frameSize = Math.floor(144 * bitrateKbps * 1000 / sampleRate) + padding;
  }

  return { frameSize, version, layer, sampleRate };
}

/**
 * Find the offset of the first valid MPEG audio frame at-or-after `fromOffset`.
 *
 * Validates each candidate sync by parsing the header, then peeking at the
 * computed next-frame offset for a second valid header. This eliminates false
 * positives from random `0xFF` bytes in audio data.
 *
 * @returns offset (>= fromOffset) of the first validated frame, or -1.
 */
export function findFrameStart(bytes, fromOffset) {
  for (let i = fromOffset; i + 4 <= bytes.length; i++) {
    if (bytes[i] !== 0xFF) continue;
    if ((bytes[i + 1] & 0xE0) !== 0xE0) continue;

    const h1 = parseFrameHeader(bytes, i);
    if (!h1) continue;

    const next = i + h1.frameSize;
    if (next + 4 > bytes.length) continue; // not enough bytes to validate
    const h2 = parseFrameHeader(bytes, next);
    if (!h2) continue;

    return i;
  }
  return -1;
}
