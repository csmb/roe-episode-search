# MP3 Frame-Aware Chunker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the byte-aligned chunker in `roe-pipeline/src/transcribe.js` with frame-aware chunking so each chunk sent to OpenAI Whisper is a sequence of complete MPEG audio frames. This unblocks `Roll Over Easy 2026-04-30.mp3` (currently in `failed` state) and prevents the same failure mode on future episodes.

**Architecture:** A new pure module `mp3-frames.js` provides `parseFrameHeader`, `findFrameStart` (with two-frame validation), and `findChunkEnd`. The transcribe loop range-reads a sliding window from R2, snaps chunk start to a validated frame boundary, walks the frame chain to snap chunk end at-or-before the 20 MB target, and advances the file offset. The last chunk takes everything to EOF.

**Tech Stack:** Cloudflare Workers (Durable Object), Vitest for unit tests, Wrangler for deploy. Pure ES modules, no transpilation.

**Spec:** `docs/superpowers/specs/2026-04-30-mp3-frame-aware-chunker-design.md`

---

## File Structure

| File | Status | Responsibility |
| --- | --- | --- |
| `roe-pipeline/src/mp3-frames.js` | new | Pure MPEG audio frame parser + chunk-boundary helpers. No I/O. |
| `roe-pipeline/test/mp3-frames.test.js` | new | Unit tests (synthetic byte sequences only — no fixtures). |
| `roe-pipeline/src/transcribe.js` | modified | Replace byte-slice chunk loop with frame-aware loop. Refactor `transcribeChunk` to accept a `Uint8Array`. |

---

## Task 1: Frame parser scaffolding + `parseFrameHeader`

**Files:**
- Create: `roe-pipeline/src/mp3-frames.js`
- Create: `roe-pipeline/test/mp3-frames.test.js`

The MPEG audio frame header is 4 bytes (`AAAAAAAA AAABBCCD EEEEFFGH IIJJKLMM`):
- `A` (11 bits): sync, all 1s
- `B` (2): version — `00`=2.5, `01`=reserved, `10`=2, `11`=1
- `C` (2): layer — `00`=reserved, `01`=III, `10`=II, `11`=I
- `D` (1): protection bit (no impact on size)
- `E` (4): bitrate index (0=free, 15=reserved, 1–14 valid; table varies by version+layer)
- `F` (2): sample rate index (3=reserved)
- `G` (1): padding

Frame size formula:
- Layer III, MPEG-1: `floor(144 * br / sr) + padding`
- Layer III, MPEG-2/2.5: `floor(72 * br / sr) + padding`
- Layer II: `floor(144 * br / sr) + padding`
- Layer I: `(floor(12 * br / sr) + padding) * 4`

Where `br` is bitrate in bps and `sr` is sample rate in Hz.

- [ ] **Step 1: Write the failing tests for `parseFrameHeader`**

Create `roe-pipeline/test/mp3-frames.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd "/Users/christopherbunting/Library/Mobile Documents/com~apple~CloudDocs/code/roe-episode-search/roe-pipeline" && npx vitest run test/mp3-frames.test.js
```

Expected: FAIL with `Cannot find module '../src/mp3-frames.js'` (the source file doesn't exist yet).

- [ ] **Step 3: Create `roe-pipeline/src/mp3-frames.js` with `parseFrameHeader`**

```js
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

  if (frameSize < 4) return null;
  return { frameSize, version, layer, sampleRate };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd "/Users/christopherbunting/Library/Mobile Documents/com~apple~CloudDocs/code/roe-episode-search/roe-pipeline" && npx vitest run test/mp3-frames.test.js
```

Expected: 11 passed.

- [ ] **Step 5: Commit**

```bash
cd "/Users/christopherbunting/Library/Mobile Documents/com~apple~CloudDocs/code/roe-episode-search" && git add roe-pipeline/src/mp3-frames.js roe-pipeline/test/mp3-frames.test.js && git commit -m "feat(pipeline): add parseFrameHeader for mp3 chunking"
```

---

## Task 2: `findFrameStart` with two-frame validation

**Files:**
- Modify: `roe-pipeline/src/mp3-frames.js`
- Modify: `roe-pipeline/test/mp3-frames.test.js`

A naive sync search that just looks for `0xFF` followed by an `0xE0`-mask byte produces ~1 false positive per 2 KB of audio data. Two-frame validation rejects any candidate where the byte at `offset + frameSize` doesn't also parse as a valid header.

- [ ] **Step 1: Append failing tests for `findFrameStart`**

Append to `roe-pipeline/test/mp3-frames.test.js`:

```js
import { findFrameStart } from '../src/mp3-frames.js';

// Build a sequence of `count` identical frames (zeroed audio payload).
function buildFrames(count, headerOpts = {}) {
  const header = buildHeader(headerOpts);
  // Compute frame size by reading our own header back. parseFrameHeader is
  // tested separately, so this dependency is acceptable.
  const peek = new Uint8Array([header[0], header[1], header[2], header[3]]);
  // We avoid importing parseFrameHeader into the helper to keep helpers pure;
  // for default args (MPEG-1 L3 128k 44.1k no padding) the frame size is 417.
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
    // Preamble: random non-sync bytes, but include one stray 0xFF to make
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
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd "/Users/christopherbunting/Library/Mobile Documents/com~apple~CloudDocs/code/roe-episode-search/roe-pipeline" && npx vitest run test/mp3-frames.test.js
```

Expected: 11 passed (previous), 5 failed with `findFrameStart is not a function`.

- [ ] **Step 3: Implement `findFrameStart`**

Append to `roe-pipeline/src/mp3-frames.js`:

```js
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
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd "/Users/christopherbunting/Library/Mobile Documents/com~apple~CloudDocs/code/roe-episode-search/roe-pipeline" && npx vitest run test/mp3-frames.test.js
```

Expected: 16 passed.

- [ ] **Step 5: Commit**

```bash
cd "/Users/christopherbunting/Library/Mobile Documents/com~apple~CloudDocs/code/roe-episode-search" && git add roe-pipeline/src/mp3-frames.js roe-pipeline/test/mp3-frames.test.js && git commit -m "feat(pipeline): add findFrameStart with two-frame validation"
```

---

## Task 3: `findChunkEnd` for snapping chunk tail to a frame boundary

**Files:**
- Modify: `roe-pipeline/src/mp3-frames.js`
- Modify: `roe-pipeline/test/mp3-frames.test.js`

`findChunkEnd` walks the frame chain forward from a known-good offset and returns the offset of the first frame that doesn't fit within `softLimit`. The caller slices `[fromOffset, returnedOffset)` as the chunk and uses the returned offset as the next chunk's start.

- [ ] **Step 1: Append failing tests for `findChunkEnd`**

Append to `roe-pipeline/test/mp3-frames.test.js`:

```js
import { findChunkEnd } from '../src/mp3-frames.js';

describe('findChunkEnd', () => {
  it('snaps back to the last frame fitting within softLimit', () => {
    // 5 frames of 417 bytes = 2085 bytes total.
    // softLimit 1000 should fit 2 full frames (834 bytes); the 3rd would push us to 1251.
    const { buf } = buildFrames(5);
    expect(findChunkEnd(buf, 0, 1000)).toBe(834);
  });

  it('returns the very end when all frames fit within softLimit', () => {
    const { buf } = buildFrames(3); // 1251 bytes
    expect(findChunkEnd(buf, 0, 10_000)).toBe(1251);
  });

  it('returns fromOffset when the very first frame would exceed softLimit', () => {
    const { buf } = buildFrames(2);
    // softLimit 100 < frameSize 417 → first frame doesn't fit
    expect(findChunkEnd(buf, 0, 100)).toBe(0);
  });

  it('respects fromOffset (skips earlier frames)', () => {
    const { buf } = buildFrames(5); // frames at 0, 417, 834, 1251, 1668; total 2085
    // Starting at 417 with softLimit 1500 should fit frames 1 and 2 (417+834=1251);
    // frame 3 would land at 1251 with size 417, ending at 1668 ≤ 1500? No, 1668 > 1500.
    // So we stop at offset 1251 (the start of frame 3).
    expect(findChunkEnd(buf, 417, 1500)).toBe(1251);
  });

  it('returns current offset on encountering corruption mid-walk', () => {
    const { buf: frames } = buildFrames(3); // valid frames at 0, 417, 834
    const buf = new Uint8Array(frames.length);
    buf.set(frames, 0);
    // Corrupt the third frame's header so parseFrameHeader returns null
    buf[834] = 0x00;
    // Walking from 0 with generous softLimit should consume frames 1 and 2,
    // then bail at offset 834 (the corrupt position).
    expect(findChunkEnd(buf, 0, 10_000)).toBe(834);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd "/Users/christopherbunting/Library/Mobile Documents/com~apple~CloudDocs/code/roe-episode-search/roe-pipeline" && npx vitest run test/mp3-frames.test.js
```

Expected: 16 passed (previous), 5 failed with `findChunkEnd is not a function`.

- [ ] **Step 3: Implement `findChunkEnd`**

Append to `roe-pipeline/src/mp3-frames.js`:

```js
/**
 * Walk consecutive frames from a known-good `fromOffset` and return the offset
 * of the first frame that does not fully fit within `softLimit`. The caller
 * slices [fromOffset, returnedOffset) as the chunk and uses the returned
 * offset as the next chunk's start.
 *
 * If the first frame at `fromOffset` already exceeds softLimit, returns
 * `fromOffset` (caller treats this as an error). If a corrupt header is hit
 * mid-walk, returns the current offset so the caller's next-chunk
 * `findFrameStart` can resync.
 */
export function findChunkEnd(bytes, fromOffset, softLimit) {
  let offset = fromOffset;
  while (offset < softLimit) {
    const h = parseFrameHeader(bytes, offset);
    if (!h) return offset;
    if (offset + h.frameSize > softLimit) return offset;
    offset += h.frameSize;
  }
  return offset;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd "/Users/christopherbunting/Library/Mobile Documents/com~apple~CloudDocs/code/roe-episode-search/roe-pipeline" && npx vitest run test/mp3-frames.test.js
```

Expected: 21 passed.

- [ ] **Step 5: Commit**

```bash
cd "/Users/christopherbunting/Library/Mobile Documents/com~apple~CloudDocs/code/roe-episode-search" && git add roe-pipeline/src/mp3-frames.js roe-pipeline/test/mp3-frames.test.js && git commit -m "feat(pipeline): add findChunkEnd for frame-boundary chunk snapping"
```

---

## Task 4: Refactor `transcribeChunk` to accept a `Uint8Array`

**Files:**
- Modify: `roe-pipeline/src/transcribe.js`

Currently `transcribeChunk(buffer, apiKey, timeOffsetSec)` takes an `ArrayBuffer` and immediately wraps it in `new Uint8Array(buffer)`. The new chunker produces a `Uint8Array` view (from `subarray`); passing it directly avoids a copy and keeps the call site clean.

- [ ] **Step 1: Modify `transcribeChunk` signature and body**

In `roe-pipeline/src/transcribe.js`, replace the existing `transcribeChunk` function (currently starts at line 87) with this version. **No other lines in the file change in this task.**

```js
/**
 * Send a single audio chunk to OpenAI Whisper API.
 *
 * Builds the multipart body by hand instead of using FormData/Blob — the
 * Workers runtime serializes those in a way OpenAI's parser rejected with
 * "Invalid file format" for some files (observed 2026-04-24).
 *
 * @param {Uint8Array} chunkBytes - mp3 bytes (caller guarantees frame boundaries).
 */
async function transcribeChunk(chunkBytes, apiKey, timeOffsetSec) {
  const CRLF = '\r\n';
  const boundary = '----roePipeline' + crypto.randomUUID().replace(/-/g, '');
  const enc = new TextEncoder();

  const textPart = (name, value) => enc.encode(
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}` +
    `${value}${CRLF}`
  );

  const fileHeader = enc.encode(
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="file"; filename="chunk.mp3"${CRLF}` +
    `Content-Type: audio/mpeg${CRLF}${CRLF}`
  );
  const fileTrailer = enc.encode(CRLF);
  const fields = [
    textPart('model', 'whisper-1'),
    textPart('response_format', 'verbose_json'),
    textPart('timestamp_granularities[]', 'segment'),
    textPart('prompt', SF_VOCAB_PROMPT),
  ];
  const closing = enc.encode(`--${boundary}--${CRLF}`);

  const total = fileHeader.length + chunkBytes.length + fileTrailer.length
    + fields.reduce((n, f) => n + f.length, 0) + closing.length;
  const body = new Uint8Array(total);
  let off = 0;
  for (const part of [fileHeader, chunkBytes, fileTrailer, ...fields, closing]) {
    body.set(part, off);
    off += part.length;
  }

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Whisper API error ${res.status}: ${errBody}`);
  }

  const data = await res.json();

  const segments = (data.segments || []).map(seg => ({
    start_ms: Math.round((seg.start + timeOffsetSec) * 1000),
    end_ms: Math.round((seg.end + timeOffsetSec) * 1000),
    text: seg.text.trim(),
  })).filter(seg => seg.text.length > 0);

  return { segments, duration: data.duration || 0 };
}
```

- [ ] **Step 2: Update the existing call site to pass a `Uint8Array`**

The current loop in `transcribeFromR2` calls `transcribeChunk(buffer, ...)` where `buffer` is an `ArrayBuffer` from `obj.arrayBuffer()`. Change that single call site (currently around line 64):

Find:

```js
    const buffer = await obj.arrayBuffer();
    const { segments, duration } = await transcribeChunk(buffer, openaiApiKey, timeOffset);
```

Replace with:

```js
    const buffer = await obj.arrayBuffer();
    const { segments, duration } = await transcribeChunk(new Uint8Array(buffer), openaiApiKey, timeOffset);
```

(This call site is replaced wholesale in Task 5, but we keep the file shippable between tasks.)

- [ ] **Step 3: Run all tests to confirm nothing else broke**

```bash
cd "/Users/christopherbunting/Library/Mobile Documents/com~apple~CloudDocs/code/roe-episode-search/roe-pipeline" && npx vitest run
```

Expected: all existing tests pass (no test directly exercises `transcribeChunk`; this is a no-op refactor).

- [ ] **Step 4: Commit**

```bash
cd "/Users/christopherbunting/Library/Mobile Documents/com~apple~CloudDocs/code/roe-episode-search" && git add roe-pipeline/src/transcribe.js && git commit -m "refactor(pipeline): transcribeChunk accepts Uint8Array directly"
```

---

## Task 5: Replace the chunk loop in `transcribeFromR2` with frame-aware chunking

**Files:**
- Modify: `roe-pipeline/src/transcribe.js`

This task replaces the entire `transcribeFromR2` function body. The new loop range-reads a sliding window from R2, snaps the chunk start to a validated frame boundary, walks the frame chain to snap the chunk end at-or-before the 20 MB target, and advances by the snapped end offset.

- [ ] **Step 1: Add the `mp3-frames.js` import at the top of `transcribe.js`**

Find the existing import block at the top of `roe-pipeline/src/transcribe.js`:

```js
import { cleanSegments } from './clean-segments.js';
```

Replace with:

```js
import { cleanSegments } from './clean-segments.js';
import { findFrameStart, findChunkEnd } from './mp3-frames.js';
```

- [ ] **Step 2: Replace the `CHUNK_SIZE` constant with the two new constants**

Find:

```js
const CHUNK_SIZE = 20 * 1024 * 1024; // 20MB per chunk (under 25MB API limit)
```

Replace with:

```js
const TARGET_CHUNK = 20 * 1024 * 1024; // ~20MB, under the 25MB Whisper limit
const TAIL_MARGIN  = 64 * 1024;        // extra bytes read past TARGET_CHUNK so
                                       // findChunkEnd can always find the next
                                       // frame boundary just past the limit.
```

- [ ] **Step 3: Replace the entire `transcribeFromR2` function**

Find the existing `export async function transcribeFromR2(...)` (currently lines 41–78) and replace the function in its entirety with:

```js
/**
 * Transcribe a full MP3 from R2, chunking on frame boundaries so each chunk
 * is a self-contained mp3 stream that Whisper can decode in isolation.
 *
 * @param {R2Bucket} bucket - R2 bucket binding
 * @param {string} key - R2 object key
 * @param {string} openaiApiKey - OpenAI API key
 * @param {object} [_resume] - Reserved for future resume support; unused.
 * @returns {{ segments: Array, durationMs: number, totalChunks: number }}
 */
export async function transcribeFromR2(bucket, key, openaiApiKey, _resume) {
  const head = await bucket.head(key);
  if (!head) throw new Error(`R2 object not found: ${key}`);
  const fileSize = head.size;

  const allSegments = [];
  let timeOffset = 0;
  let fileOffset = 0;
  let chunkIdx = 0;

  while (fileOffset < fileSize) {
    const windowLen = Math.min(TARGET_CHUNK + TAIL_MARGIN, fileSize - fileOffset);

    const obj = await bucket.get(key, { range: { offset: fileOffset, length: windowLen } });
    if (!obj) throw new Error(`Failed to read R2 range: offset=${fileOffset}, length=${windowLen}`);
    const window = new Uint8Array(await obj.arrayBuffer());

    // Chunk 1 keeps offset 0 so the ID3v2 tag (if present) rides along.
    // Subsequent chunks start at the first validated frame in the window.
    const chunkStart = (fileOffset === 0) ? 0 : findFrameStart(window, 0);
    if (chunkStart < 0) {
      throw new Error(`No frame sync in window at file offset ${fileOffset}`);
    }

    const isLastChunk = (fileOffset + windowLen) >= fileSize;
    const chunkEnd = isLastChunk
      ? window.length
      : findChunkEnd(window, chunkStart, TARGET_CHUNK);

    if (chunkEnd <= chunkStart) {
      throw new Error(
        `Could not assemble chunk at file offset ${fileOffset}: ` +
        `chunkStart=${chunkStart}, chunkEnd=${chunkEnd}`
      );
    }

    const chunkBytes = window.subarray(chunkStart, chunkEnd);
    const { segments, duration } = await transcribeChunk(chunkBytes, openaiApiKey, timeOffset);

    allSegments.push(...segments);
    timeOffset += duration;
    fileOffset += chunkEnd;
    chunkIdx++;

    console.log(`  Chunk ${chunkIdx}: ${chunkBytes.length} bytes, ${segments.length} segments, +${duration.toFixed(1)}s`);
  }

  const cleaned = cleanSegments(allSegments);
  const durationMs = Math.round(timeOffset * 1000);
  console.log(`  Total: ${cleaned.length} segments (${allSegments.length - cleaned.length} removed by cleaning), ${durationMs}ms`);

  return { segments: cleaned, durationMs, totalChunks: chunkIdx };
}
```

- [ ] **Step 4: Run the full test suite**

```bash
cd "/Users/christopherbunting/Library/Mobile Documents/com~apple~CloudDocs/code/roe-episode-search/roe-pipeline" && npx vitest run
```

Expected: all tests pass (21 in `mp3-frames.test.js`, plus the existing `parse-episode-id`, `clean-segments`, `places` tests).

- [ ] **Step 5: Confirm `transcribe.js` has no remaining references to `CHUNK_SIZE` or `evenChunkSize`**

```bash
cd "/Users/christopherbunting/Library/Mobile Documents/com~apple~CloudDocs/code/roe-episode-search/roe-pipeline" && grep -nE "CHUNK_SIZE|evenChunkSize|totalChunks =" src/transcribe.js
```

Expected: empty output (the only `totalChunks` should be inside the new return statement, which doesn't include `=` after it on the same token).

- [ ] **Step 6: Commit**

```bash
cd "/Users/christopherbunting/Library/Mobile Documents/com~apple~CloudDocs/code/roe-episode-search" && git add roe-pipeline/src/transcribe.js && git commit -m "feat(pipeline): frame-aware chunking for Whisper transcription"
```

---

## Task 6: Deploy, retrigger the failed episode, and verify

**Files:** none (deploy + verification only)

This task uses production credentials; do not run it from a worktree where `wrangler.jsonc` has been modified. The Worker subdomain is `christophersbunting.workers.dev` (confirmed by hitting `/status` earlier).

- [ ] **Step 1: Deploy the updated pipeline Worker**

```bash
cd "/Users/christopherbunting/Library/Mobile Documents/com~apple~CloudDocs/code/roe-episode-search/roe-pipeline" && npx wrangler deploy
```

Expected: deployment success message with a new version ID.

- [ ] **Step 2: Confirm the failed DO is still in the failed state (sanity check)**

```bash
curl -s "https://roe-pipeline.christophersbunting.workers.dev/status?key=Roll%20Over%20Easy%202026-04-30.mp3"
```

Expected JSON like:
```
{"status":"failed","step":"transcribe","episodeId":"roll-over-easy_2026-04-30_07-30-00","error":"Whisper API error 400: ..."}
```

- [ ] **Step 3: Retrigger the pipeline for the failed episode**

```bash
curl -X POST "https://roe-pipeline.christophersbunting.workers.dev/process?key=Roll%20Over%20Easy%202026-04-30.mp3"
```

Expected: `{"status":"started","episodeId":"roll-over-easy_2026-04-30_07-30-00"}`.

If instead you see `{"status":"already_exists",...}`, the previous run actually wrote to D1 — investigate before continuing. If you see `{"status":"already_processing",...}`, wait for the in-flight run to finish or fail before retrying.

- [ ] **Step 4: Tail Worker logs while the pipeline runs**

In a separate shell:

```bash
cd "/Users/christopherbunting/Library/Mobile Documents/com~apple~CloudDocs/code/roe-episode-search/roe-pipeline" && npx wrangler tail
```

Watch for log lines like `Chunk 1: ... bytes, ... segments, +Ns`, one per chunk, ending in `[<episodeId>] Pipeline completed successfully`.

If a chunk fails with `Whisper API error 400: Invalid file format`, stop the tail, capture the offending log line and the file offset, and revisit `findFrameStart` / `findChunkEnd` — do not "just retry."

- [ ] **Step 5: Poll the pipeline status until it reports `completed`**

```bash
curl -s "https://roe-pipeline.christophersbunting.workers.dev/status?key=Roll%20Over%20Easy%202026-04-30.mp3"
```

Re-run periodically. Expected final state: `{"status":"completed","step":null,"episodeId":null,"error":null}` (the DO `deleteAll`s on success and only `status: completed` is left).

- [ ] **Step 6: Confirm the episode landed in D1**

```bash
cd "/Users/christopherbunting/Library/Mobile Documents/com~apple~CloudDocs/code/roe-episode-search/roe-search" && npx wrangler d1 execute roe-episodes --remote --command "SELECT id, title, audio_file IS NOT NULL AS has_audio, (SELECT COUNT(*) FROM transcript_segments WHERE episode_id = e.id) AS segments FROM episodes e WHERE id = 'roll-over-easy_2026-04-30_07-30-00'"
```

Expected: one row with non-null `title`, `has_audio = 1`, and a non-trivial `segments` count (typically several hundred for a 1+ hour episode).

- [ ] **Step 7: Confirm the episode is visible on the public site**

Open https://rollovereasy.org/episodes in a browser and confirm the 2026-04-30 episode appears in the list with audio playback.

- [ ] **Step 8: Update memory**

Add a project memory entry recording the chunker fix so future debugging sessions know what changed and why. Use the auto-memory system.

---

## Self-Review Notes

- Spec covered:
  - Streaming snap algorithm → Tasks 5 (chunker loop) + 1–3 (frame helpers).
  - Two-frame validation → Task 2 (`findFrameStart`).
  - Module structure (mp3-frames.js + transcribe.js + tests) → Tasks 1–5.
  - Test coverage as enumerated in spec → Tasks 1–3.
  - Deployment & verification → Task 6.
  - Out-of-scope items (resume, retry, transcoding) → not implemented; the `_resume` parameter is preserved as a no-op for signature compatibility with the DO call site.
- No placeholders, TODOs, or "implement appropriate X" hand-waves in the implementation steps.
- Names used consistently: `parseFrameHeader`, `findFrameStart`, `findChunkEnd`, `TARGET_CHUNK`, `TAIL_MARGIN`, `transcribeFromR2`, `transcribeChunk`.
