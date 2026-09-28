/**
 * Pure MPEG audio frame parsing helpers, used by transcribe.js to slice mp3
 * files on frame boundaries before sending chunks to OpenAI Whisper, and by
 * mp3-join.js to join a split show's parts.
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
 * @returns {{frameSize:number, version:number, layer:number, sampleRate:number,
 *   bitrateKbps:number, bitrateIdx:number, channels:number, crc:boolean}|null}
 */
export function parseFrameHeader(bytes, offset) {
  if (offset < 0 || offset + 4 > bytes.length) return null;

  const b0 = bytes[offset];
  const b1 = bytes[offset + 1];
  const b2 = bytes[offset + 2];
  const b3 = bytes[offset + 3];

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

  return {
    frameSize, version, layer, sampleRate, bitrateKbps, bitrateIdx,
    channels: (b3 >> 6) === 3 ? 1 : 2,
    crc: (b1 & 0x1) === 0, // a 16-bit CRC follows the header
  };
}

// Samples per frame by header layer (1=III, 2=II, 3=I); MPEG-2/2.5 Layer III halves it.
export function samplesPerFrame({ version, layer }) {
  if (layer === LAYER_I) return 384;
  if (layer === LAYER_III && version !== 3) return 576;
  return 1152;
}

// Bytes of Layer III side information between the header (and CRC) and the audio data.
function sideInfoBytes({ version, channels }) {
  if (version === 3) return channels === 1 ? 17 : 32;
  return channels === 1 ? 9 : 17;
}

/** Length of the ID3v2 tag at the start of `bytes`, or 0 if there is none. */
export function id3v2Size(bytes) {
  if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return 0;
  const size = ((bytes[6] & 0x7F) << 21) | ((bytes[7] & 0x7F) << 14) | ((bytes[8] & 0x7F) << 7) | (bytes[9] & 0x7F);
  return 10 + size + ((bytes[5] & 0x10) ? 10 : 0); // a footer repeats the header
}

const ascii = (bytes, at) => String.fromCharCode(...bytes.subarray(at, at + 4));

/**
 * Read the Xing/Info (LAME, ffmpeg) or VBRI header in the frame at `offset`:
 * the first frame of most MP3s, which counts the audio frames after it and
 * holds a seek table. Returns null for an ordinary audio frame.
 *
 * @returns {{tag: string, frames?: number, bytes?: number, toc?: Uint8Array}|null}
 */
export function readXing(bytes, offset = 0) {
  const h = parseFrameHeader(bytes, offset);
  if (!h || h.layer !== LAYER_III) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = offset + h.frameSize;

  const at = offset + 4 + (h.crc ? 2 : 0) + sideInfoBytes(h);
  if (at + 8 <= end && at + 8 <= bytes.length && ['Xing', 'Info'].includes(ascii(bytes, at))) {
    const out = { tag: ascii(bytes, at) };
    const flags = view.getUint32(at + 4);
    let p = at + 8;
    const need = n => p + n <= end && p + n <= bytes.length;
    if (flags & 0x1) { if (!need(4)) return out; out.frames = view.getUint32(p); p += 4; }
    if (flags & 0x2) { if (!need(4)) return out; out.bytes = view.getUint32(p); p += 4; }
    if (flags & 0x4) { if (!need(100)) return out; out.toc = bytes.slice(p, p + 100); }
    return out;
  }

  // Fraunhofer's VBRI header sits 32 bytes after the frame header
  const v = offset + 36;
  if (v + 18 <= end && v + 18 <= bytes.length && ascii(bytes, v) === 'VBRI') {
    return { tag: 'VBRI', bytes: view.getUint32(v + 10), frames: view.getUint32(v + 14) };
  }
  return null;
}

// The Xing/Info frame header for a stream whose first audio frame has
// `header`: same format, no CRC, no padding, and the stream's own bitrate if
// the tag fits in a frame that size, else the smallest bitrate it fits in.
function xingHeader(header) {
  const h = parseFrameHeader(header, 0);
  if (!h || h.layer !== LAYER_III) throw new Error('A Xing frame needs a Layer III stream');
  const need = 4 + sideInfoBytes(h) + 120; // tag, flags, frames, bytes, 100-byte TOC
  for (const idx of [h.bitrateIdx, ...Array.from({ length: 14 }, (_, i) => i + 1)]) {
    const candidate = new Uint8Array([0xFF, header[1] | 0x01, (idx << 4) | (header[2] & 0x0C), header[3]]);
    const size = parseFrameHeader(candidate, 0)?.frameSize ?? 0;
    if (size >= need) return { bytes: candidate, size, at: 4 + sideInfoBytes(h) };
  }
  throw new Error('No bitrate is big enough for a Xing frame');
}

/** Size of the Xing/Info frame buildXingFrame() makes for a stream starting with `header`. */
export function xingFrameSize(header) {
  return xingHeader(header).size;
}

/**
 * A Xing/Info frame to put at the start of an MP3 stream: an otherwise silent
 * frame (players that don't know the tag play 26 ms of nothing) saying how
 * many audio frames follow, the stream's size in bytes (this frame included),
 * and where each 1% of the duration starts. "Info" marks a constant bitrate.
 *
 * @param {Uint8Array} header - the first audio frame's 4 header bytes
 * @param {{frames: number, bytes: number, toc: Uint8Array, vbr: boolean}} info
 */
export function buildXingFrame(header, { frames, bytes, toc, vbr }) {
  const { bytes: hdr, size, at } = xingHeader(header);
  const frame = new Uint8Array(size);
  frame.set(hdr);
  frame.set([...(vbr ? 'Xing' : 'Info')].map(c => c.charCodeAt(0)), at);
  const view = new DataView(frame.buffer);
  view.setUint32(at + 4, 0x7); // frames, bytes and TOC present
  view.setUint32(at + 8, frames);
  view.setUint32(at + 12, bytes);
  frame.set(toc, at + 16);
  return frame;
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

/**
 * Walk consecutive frames from a known-good `fromOffset` and return the offset
 * of the first frame that does not fully fit within `softLimit`, or that
 * starts once `maxSec` of audio has been walked, whichever comes first. The
 * caller slices [fromOffset, returnedOffset) as the chunk and uses the
 * returned offset as the next chunk's start. Time comes from counting samples
 * frame by frame, so it is exact even for variable-bitrate files.
 *
 * If the first frame at `fromOffset` already exceeds softLimit, returns
 * `fromOffset` (caller treats this as an error). If a corrupt header is hit
 * mid-walk, returns the current offset so the caller's next-chunk
 * `findFrameStart` can resync.
 */
export function findChunkEnd(bytes, fromOffset, softLimit, maxSec = Infinity) {
  let offset = fromOffset;
  let sec = 0;
  while (offset < softLimit) {
    if (sec >= maxSec) return offset;
    const h = parseFrameHeader(bytes, offset);
    if (!h) return offset;
    if (offset + h.frameSize > softLimit) return offset;
    sec += samplesPerFrame(h) / h.sampleRate;
    offset += h.frameSize;
  }
  return offset;
}

/**
 * Decide which slice of a window should be sent to Whisper for the chunk
 * starting at `fileOffset` in the file. Returns window-relative offsets
 * `{ sliceStart, sliceEnd }` so the caller does `window.subarray(sliceStart, sliceEnd)`.
 *
 * For chunk 1 (fileOffset === 0), `sliceStart` is 0 — the bytes before the first
 * audio frame (typically an ID3v2 tag) ride along with the first chunk so the
 * mp3 stream remains structurally identical. For chunks 2..N, `sliceStart`
 * equals the first validated frame offset in the window, since there is no
 * preamble to preserve.
 *
 * `sliceEnd` is the frame boundary where the chunk reaches `targetSec` of
 * audio or would pass `targetChunk` bytes, walking from the first frame. The
 * last chunk otherwise runs to `window.length`, keeping any trailing tag.
 *
 * Throws if no validated frame can be found in the window, or if even the
 * first frame in the window cannot fit within `targetChunk`.
 */
export function pickChunkSlice(window, fileOffset, isLastChunk, targetChunk, targetSec = Infinity) {
  const firstFrame = findFrameStart(window, 0);
  if (firstFrame < 0) {
    throw new Error('pickChunkSlice: no frame sync in window');
  }

  let sliceEnd;
  if (!isLastChunk) {
    sliceEnd = findChunkEnd(window, firstFrame, targetChunk, targetSec);
  } else {
    // The rest of the file is in this window. Cut it at targetSec if there's
    // more audio than that; otherwise take it all.
    const byTime = findChunkEnd(window, firstFrame, window.length, targetSec);
    sliceEnd = byTime < findChunkEnd(window, firstFrame, window.length) ? byTime : window.length;
  }

  if (sliceEnd <= firstFrame) {
    throw new Error(
      `pickChunkSlice: could not advance past first frame ` +
      `(firstFrame=${firstFrame}, sliceEnd=${sliceEnd}, targetChunk=${targetChunk})`
    );
  }

  const sliceStart = (fileOffset === 0) ? 0 : firstFrame;
  return { sliceStart, sliceEnd };
}
