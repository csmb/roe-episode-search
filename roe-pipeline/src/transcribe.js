/**
 * Transcribe an MP3 from R2 using OpenAI Whisper API.
 * Handles files >25MB by chunking and stitching timestamps.
 */

import { cleanSegments, isMostlyNonLatin, isPromptEcho } from './clean-segments.js';
import { pickChunkSlice } from './mp3-frames.js';
import { fillGaps, retryHole, findBoundaryHole, findGaps, MIN_GAP_MS } from './gap-retry.js';
import { SF_VOCAB_PROMPT } from './whisper-prompt.js';

const TARGET_CHUNK = 20 * 1024 * 1024; // ~20MB, under the 25MB Whisper limit
const TAIL_MARGIN  = 64 * 1024;        // extra bytes read past TARGET_CHUNK so
                                       // findChunkEnd can always find the next
                                       // frame boundary just past the limit.
const COMPRESSION_RATIO_MAX = 2.4;     // Whisper's own "this segment is looping" threshold

/**
 * Transcribe a full MP3 from R2, chunking on frame boundaries so each chunk
 * is a self-contained mp3 stream that Whisper can decode in isolation.
 *
 * @param {R2Bucket} bucket - R2 bucket binding
 * @param {string} key - R2 object key
 * @param {string} openaiApiKey - OpenAI API key
 * @param {object} [_resume] - Reserved for future resume support; unused.
 * @returns {{ segments: Array, durationMs: number, totalChunks: number, holes: Array }}
 *   `holes` are stretches of 5+ minutes still without transcript after every
 *   retry: long music, dead air, or audio Whisper couldn't recover.
 */
export async function transcribeFromR2(bucket, key, openaiApiKey, _resume) {
  const head = await bucket.head(key);
  if (!head) throw new Error(`R2 object not found: ${key}`);
  const fileSize = head.size;

  const allSegments = [];
  let timeOffset = 0;
  let fileOffset = 0;
  let chunkIdx = 0;
  let prev = null; // the previous chunk, for holes that straddle a chunk boundary
  const whisper = (clip, offsetSec) => transcribeChunk(clip, openaiApiKey, offsetSec);

  while (fileOffset < fileSize) {
    const windowLen = Math.min(TARGET_CHUNK + TAIL_MARGIN, fileSize - fileOffset);

    const obj = await bucket.get(key, { range: { offset: fileOffset, length: windowLen } });
    if (!obj) throw new Error(`Failed to read R2 range: offset=${fileOffset}, length=${windowLen} (key: ${key})`);
    const window = new Uint8Array(await obj.arrayBuffer());

    const isLastChunk = (fileOffset + windowLen) >= fileSize;
    let sliceStart, sliceEnd;
    try {
      ({ sliceStart, sliceEnd } = pickChunkSlice(window, fileOffset, isLastChunk, TARGET_CHUNK));
    } catch (err) {
      throw new Error(`Chunker failed at file offset ${fileOffset} (key: ${key}): ${err.message}`);
    }

    const chunkBytes = window.subarray(sliceStart, sliceEnd);
    const first = await transcribeChunk(chunkBytes, openaiApiKey, timeOffset);
    const duration = first.duration;
    const { segments } = await fillGaps(chunkBytes, first.segments, timeOffset, duration, whisper);

    // A hole that ends one chunk and starts the next is too short for either
    // chunk's own check; retry both halves while the previous chunk's bytes
    // are still in memory.
    const chunkStartMs = Math.round(timeOffset * 1000);
    if (prev) {
      const hole = findBoundaryHole(prev.segments, prev.endMs, segments, chunkStartMs);
      if (hole) {
        const got = [
          ...await retryHole(prev.bytes, prev.startSec, hole.prev, whisper),
          ...await retryHole(chunkBytes, timeOffset, hole.cur, whisper),
        ];
        console.log(`  Boundary gap ${(hole.prev.startMs / 1000).toFixed(0)}s–${(hole.cur.endMs / 1000).toFixed(0)}s: recovered ${got.length} segments`);
        allSegments.push(...got);
      }
    }

    allSegments.push(...segments);
    prev = { bytes: chunkBytes, startSec: timeOffset, endMs: chunkStartMs + Math.round(duration * 1000), segments };
    timeOffset += duration;
    fileOffset += sliceEnd;
    chunkIdx++;

    console.log(`  Chunk ${chunkIdx}: ${chunkBytes.length} bytes, ${segments.length} segments, +${duration.toFixed(1)}s`);
  }

  allSegments.sort((a, b) => a.start_ms - b.start_ms);
  const cleaned = cleanSegments(allSegments);
  const durationMs = Math.round(timeOffset * 1000);
  console.log(`  Total: ${cleaned.length} segments (${allSegments.length - cleaned.length} removed by cleaning), ${durationMs}ms`);

  const holes = findGaps(cleaned, 0, durationMs, MIN_GAP_MS);
  if (holes.length > 0) {
    console.warn(`  ${holes.length} hole(s) of 5+ min left: ${holes.map(h => `${Math.round(h.startMs / 60000)}–${Math.round(h.endMs / 60000)} min`).join(', ')}`);
  }

  return { segments: cleaned, durationMs, totalChunks: chunkIdx, holes };
}

/**
 * Send a single audio chunk to OpenAI Whisper API.
 *
 * Builds the multipart body by hand instead of using FormData/Blob — the
 * Workers runtime serializes those in a way OpenAI's parser rejected with
 * "Invalid file format" for some files (observed 2026-04-24).
 *
 * Segments in the wrong script or that read the prompt back are dropped here,
 * so fillGaps sees those stretches as holes and retries them.
 *
 * @param {Uint8Array} chunkBytes - mp3 bytes (caller guarantees frame boundaries).
 */
export async function transcribeChunk(chunkBytes, apiKey, timeOffsetSec) {
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
    // Without this Whisper guesses the language from the first 30 s, which is
    // often music, and sometimes returns a chunk in the wrong language.
    textPart('language', 'en'),
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

  const segments = [];
  for (const seg of data.segments || []) {
    const text = (seg.text || '').trim();
    if (!text || isMostlyNonLatin(text) || isPromptEcho(text)) continue;
    // Whisper's own sign that a segment is looping ("the the the the …")
    if (seg.compression_ratio > COMPRESSION_RATIO_MAX) continue;
    // A line repeating one of the last few (Whisper stuck on a lyric) is dropped
    // here, so fillGaps sees the stretch as a hole and retries it instead of
    // treating the loop as speech.
    if (segments.slice(-4).some(s => s.text === text)) continue;
    segments.push({
      start_ms: Math.round((seg.start + timeOffsetSec) * 1000),
      end_ms: Math.round((seg.end + timeOffsetSec) * 1000),
      text,
    });
  }

  return { segments, duration: data.duration || 0 };
}
