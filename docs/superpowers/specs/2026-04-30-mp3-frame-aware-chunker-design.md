# MP3 Frame-Aware Chunker for Whisper Transcription

**Date:** 2026-04-30
**Component:** `roe-pipeline` (Cloudflare Worker / Durable Object)
**Scope:** A — chunker fix only. No changes to resume state or retry behavior.

## Problem

`Roll Over Easy 2026-04-30.mp3` was uploaded to R2 today and the pipeline failed at the `transcribe` step with:

```
Whisper API error 400: Invalid file format.
"usage":{"type":"duration","seconds":0}
```

The current chunker (`roe-pipeline/src/transcribe.js`) range-reads the R2 object on raw byte boundaries (`evenChunkSize` per chunk). Chunks 2..N start mid-mp3-frame, which OpenAI Whisper rejects on some files because it cannot resync. The 2026-04-24 fix (`06db948`) made chunks more uniformly sized and bypassed `FormData`/`Blob` multipart serialization, but did not address the underlying mid-frame slicing.

## Goal

Each chunk sent to Whisper is a sequence of complete MPEG audio frames, so Whisper can decode any chunk in isolation regardless of its position in the file.

## Non-goals

- Wiring up resume state (the `transcribeResume` parameter is currently read but never written; out of scope here).
- Retry-on-Whisper-failure backoff in the Durable Object.
- Re-encoding files to a different container.
- Supporting free-format mp3 (bitrate index 0).

## Approach

Streaming snap-to-frame. For each chunk:

1. Range-read a window of `TARGET_CHUNK + TAIL_MARGIN` bytes from R2 starting at the current file offset.
2. Snap chunk start forward to the first validated frame sync in the window (chunk 1 keeps offset 0 so the ID3v2 tag rides along — Whisper accepts ID3 tags).
3. Snap chunk end back to the next frame boundary at-or-before `TARGET_CHUNK`. The last chunk takes everything to EOF.
4. Slice the window between the snapped offsets and POST to Whisper via the existing multipart sender.
5. Advance the file offset by `chunkEndInWindow`. Repeat until the file is exhausted.

### Why streaming snap (vs pre-scan or transcode)

Pre-scanning the entire file to build a frame index doubles R2 reads and adds significant memory/IO cost for no functional benefit — we don't need random access. Re-encoding via ffmpeg or media transformations is a much larger architectural change. Streaming snap keeps memory bounded (~22 MB peak per chunk) and adds one well-tested helper module.

### Why two-frame validation

At 11 bits of sync, a random byte sequence has a candidate sync roughly every 2 KB. For a 167 MB file that is ~80,000 false candidates inside audio data. We validate by parsing the candidate header to compute its frame size, then checking that another valid header exists at `offset + frameSize`. Two consecutive valid headers reduce false positives to a negligible level without requiring a full mp3 parser.

## Module structure

| File | Status | Purpose |
| --- | --- | --- |
| `roe-pipeline/src/mp3-frames.js` | new | Pure frame parsing (no I/O, no Worker globals) |
| `roe-pipeline/src/transcribe.js` | modified | Replaces byte-slice loop with frame-aware chunk loop |
| `roe-pipeline/test/mp3-frames.test.js` | new | Unit tests against synthetic frame headers |

## Frame parser API (`mp3-frames.js`)

```js
parseFrameHeader(bytes, offset) → { frameSize, version, layer, sampleRate } | null
findFrameStart(bytes, fromOffset) → offset | -1
findChunkEnd(bytes, fromOffset, softLimit) → offset
```

### `parseFrameHeader(bytes, offset)`

Decodes the 4-byte MPEG audio header at `offset`. Returns `null` if invalid; otherwise returns `{ frameSize, version, layer, sampleRate }`.

Validation:
- 11-bit frame sync: `bytes[offset] === 0xFF && (bytes[offset+1] & 0xE0) === 0xE0`
- MPEG version index ≠ `01` (reserved)
- Layer index ≠ `00` (reserved)
- Bitrate index ∈ [1, 14] (rejects `0` = free-format and `15` = reserved)
- Sample rate index ∈ [0, 2] (rejects `3` = reserved)

Frame size formulas (Layer III):
- MPEG-1: `frameSize = floor(144 * bitrate / sampleRate) + padding`
- MPEG-2 / 2.5: `frameSize = floor(72 * bitrate / sampleRate) + padding`

Layer I / II formulas are included for completeness but Roll Over Easy episodes are uniformly Layer III; non-Layer-III headers will parse correctly if encountered.

### `findFrameStart(bytes, fromOffset)`

Scans forward from `fromOffset` looking for `0xFF` followed by an `0xE0`-mask byte. For each candidate, calls `parseFrameHeader`; if valid, calls `parseFrameHeader` again at `offset + frameSize`. Returns the first offset where both validations pass, or `-1`.

### `findChunkEnd(bytes, fromOffset, softLimit)`

Walks consecutive frames starting at the known-good `fromOffset`. Each iteration parses the current frame's header to advance by `frameSize`. Stops when:
- the next frame would extend past `softLimit`, or
- `parseFrameHeader` returns null mid-walk (corruption — caller's next chunk will resync via `findFrameStart`).

Returns the offset of the first frame that does not fit (== the next chunk's start).

## Chunker integration (`transcribe.js`)

```js
const TARGET_CHUNK = 20 * 1024 * 1024;
const TAIL_MARGIN  = 64 * 1024;

let fileOffset = 0;
let timeOffset = 0;
let chunkIdx = 0;

while (fileOffset < fileSize) {
  const windowLen = Math.min(TARGET_CHUNK + TAIL_MARGIN, fileSize - fileOffset);
  const obj = await bucket.get(key, { range: { offset: fileOffset, length: windowLen } });
  if (!obj) throw new Error(`Failed to read R2 range: offset=${fileOffset}, length=${windowLen}`);
  const window = new Uint8Array(await obj.arrayBuffer());

  const chunkStart = (fileOffset === 0) ? 0 : findFrameStart(window, 0);
  if (chunkStart < 0) throw new Error(`No frame sync in window at file offset ${fileOffset}`);

  const isLastChunk = (fileOffset + windowLen) >= fileSize;
  const chunkEnd = isLastChunk
    ? window.length
    : findChunkEnd(window, chunkStart, TARGET_CHUNK);

  if (chunkEnd <= chunkStart) {
    throw new Error(`Could not assemble chunk at offset ${fileOffset}: chunkStart=${chunkStart}, chunkEnd=${chunkEnd}`);
  }

  const chunkBytes = window.subarray(chunkStart, chunkEnd);
  const { segments, duration } = await transcribeChunk(chunkBytes, openaiApiKey, timeOffset);

  allSegments.push(...segments);
  timeOffset += duration;
  fileOffset += chunkEnd;
  chunkIdx++;

  console.log(`  Chunk ${chunkIdx}: ${chunkBytes.length} bytes, ${segments.length} segments, +${duration.toFixed(1)}s`);
}
```

`transcribeChunk` is refactored to accept a `Uint8Array` directly instead of an `ArrayBuffer` (it currently wraps `new Uint8Array(buffer)` internally — same end result with one fewer copy).

## Tests

All tests use synthetic byte sequences built by helpers in the test file. No mp3 fixtures are committed.

Coverage:

**Header parsing**
- Valid MPEG-1 Layer III header → expected frame size with and without padding
- Valid MPEG-2 Layer III header → expected (smaller) frame size
- Reserved version (`01`) → null
- Reserved layer (`00`) → null
- Free-format bitrate (`0`) → null
- Reserved bitrate (`15`) → null
- Reserved sample rate index (`3`) → null
- Sync bits incomplete (e.g. `0xFF 0xC0`) → null

**`findFrameStart`**
- Frame at offset 0 → returns 0
- Frame after a 1024-byte preamble (simulating ID3v2) → returns 1024
- Lone `0xFF` byte mid-frame followed by audio data that doesn't form a real header → still returns the next *real* frame, not the false positive
- Garbage with no valid header → returns -1

**`findChunkEnd`**
- Many small frames totaling more than `softLimit` → snaps back to the last frame fitting within `softLimit`
- All frames fit within `softLimit` → returns end of last frame
- First frame already exceeds `softLimit` → returns `fromOffset` (caller treats as failure)

Run: `cd roe-pipeline && npx vitest run`

## Deployment & verification

1. `cd roe-pipeline && npx wrangler deploy`
2. Trigger the failed episode manually:
   ```
   curl -X POST "https://roe-pipeline.christophersbunting.workers.dev/process?key=Roll%20Over%20Easy%202026-04-30.mp3"
   ```
   The DO's existing logic overwrites the `failed` status with `processing` and restarts at `transcribe`.
3. `npx wrangler tail roe-pipeline` to watch chunk-by-chunk progress.
4. Confirm completion:
   ```sql
   SELECT id, audio_file IS NOT NULL AS has_audio FROM episodes WHERE id = 'roll-over-easy_2026-04-30_07-30-00';
   ```
5. Confirm the episode appears at rollovereasy.org and on `/episodes`.

## Risks

- **VBR Xing/Info header**: the first frame of a VBR mp3 is a metadata-only frame (silent payload + seek table). It still has a valid MPEG header and `parseFrameHeader` accepts it. It rides along in chunk 1, no special handling needed.
- **Layer I/II files**: included in the parser for completeness; would be rejected if formulas turn out incorrect on a real file, which would surface loudly in tail logs rather than silently.
- **Corrupt mid-file frame**: `findChunkEnd` returns early when it hits a bad header. The chunk is still composed of the complete frames seen so far. The next chunk's `findFrameStart` resyncs by scanning ahead.
- **No frame sync within `TAIL_MARGIN` of a chunk boundary**: `findChunkEnd` returns `fromOffset`, which we treat as an error. At 64 KB tail margin and ~600-800 byte typical Layer III frames, this would require ~80 consecutive corrupt frames — extremely unlikely in a normal podcast file.
