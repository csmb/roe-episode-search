/**
 * Transcribe an MP3 from R2 using OpenAI Whisper API, six minutes at a time.
 *
 * Chunks are cut on MP3 frame boundaries, so each is a self-contained stream
 * Whisper can decode alone. The pipeline sends
 * one chunk per alarm and stores the result before the next, so a long show
 * never has to fit in one alarm's 15 minutes, and a crash costs one chunk.
 */

import { cleanSegments, dropRepeatedLines, isMostlyNonLatin, isPromptEcho } from './clean-segments.js';
import { pickChunkSlice } from './mp3-frames.js';
import { fillGaps, retryHole, findBoundaryHole, findGaps, MIN_GAP_MS } from './gap-retry.js';
import { SF_VOCAB_PROMPT } from './whisper-prompt.js';
import { apiError, PermanentError, TIMEOUT_MS } from './limits.js';

export const TARGET_CHUNK = 20 * 1024 * 1024; // ~20MB, under the 25MB Whisper limit
// Whisper returns longer lines for longer audio: 16-minute chunks came back as
// ~20-second lines, the same stretch sent alone as ~5-second ones. Six minutes
// also keeps every chunk but the last over the 5-minute hole size, so a hole
// always shows up inside one chunk or across two neighbours.
export const TARGET_CHUNK_SEC = 6 * 60;
const TAIL_MARGIN  = 64 * 1024;        // extra bytes read past TARGET_CHUNK so
                                       // findChunkEnd can always find the next
                                       // frame boundary just past the limit.
const COMPRESSION_RATIO_MAX = 2.4;     // Whisper's own "this segment is looping" threshold

/**
 * Progress of a new transcription of the R2 object `head` describes. The size
 * and etag let a later alarm notice that the file was replaced mid-run.
 */
export function newTranscription(head) {
  return { size: head.size, etag: head.etag, fileOffset: 0, timeOffset: 0, chunks: 0, prev: null };
}

/** True once every byte of the file has been sent to Whisper. */
export function transcriptionDone(tx) {
  return tx.fileOffset >= tx.size;
}

/**
 * Transcribe the chunk at `tx.fileOffset`, retrying holes Whisper left in it.
 *
 * @param {R2Bucket} bucket - R2 bucket binding
 * @param {string} key - R2 object key
 * @param {string} openaiApiKey - OpenAI API key
 * @param {object} tx - progress from newTranscription() or the previous call
 * @param {object} [opts]
 * @param {Array} [opts.prevSegments] - the previous chunk's own segments, for a
 *   hole that straddles the boundary between the two chunks
 * @param {number} [opts.deadline] - epoch ms after which no more retry clips are
 *   sent, so the alarm finishes in time; those stretches stay holes
 * @returns {{ tx: object, segments: Array, boundary: Array }} the advanced
 *   progress, this chunk's segments, and any recovered across the boundary
 */
export async function transcribeNextChunk(bucket, key, openaiApiKey, tx, { prevSegments = [], deadline = Infinity, targetChunk = TARGET_CHUNK, targetSec = TARGET_CHUNK_SEC } = {}) {
  const windowLen = Math.min(targetChunk + TAIL_MARGIN, tx.size - tx.fileOffset);
  const window = await readRange(bucket, key, tx.fileOffset, windowLen);

  const isLastChunk = (tx.fileOffset + windowLen) >= tx.size;
  let sliceStart, sliceEnd;
  try {
    ({ sliceStart, sliceEnd } = pickChunkSlice(window, tx.fileOffset, isLastChunk, targetChunk, targetSec));
  } catch (err) {
    throw new PermanentError(`Chunker failed at file offset ${tx.fileOffset} (key: ${key}): ${err.message}`);
  }

  const chunkBytes = window.subarray(sliceStart, sliceEnd);
  const timeOffset = tx.timeOffset;
  const first = await transcribeChunk(chunkBytes, openaiApiKey, timeOffset);
  const duration = first.duration;
  const whisper = retryWhisper(openaiApiKey, deadline);
  const { segments } = await fillGaps(chunkBytes, first.segments, timeOffset, duration, whisper);

  // A hole that ends one chunk and starts the next is too short for either
  // chunk's own check; retry both halves. The previous chunk's bytes went with
  // the alarm that sent them, so read them from R2 again.
  const chunkStartMs = Math.round(timeOffset * 1000);
  let boundary = [];
  if (tx.prev) {
    const hole = findBoundaryHole(prevSegments, tx.prev.endMs, segments, chunkStartMs);
    if (hole) {
      const prevBytes = await readRange(bucket, key, tx.prev.byteStart, tx.prev.byteEnd - tx.prev.byteStart);
      boundary = [
        ...await retryHole(prevBytes, tx.prev.startSec, hole.prev, whisper),
        ...await retryHole(chunkBytes, timeOffset, hole.cur, whisper),
      ];
      console.log(`  Boundary gap ${(hole.prev.startMs / 1000).toFixed(0)}s–${(hole.cur.endMs / 1000).toFixed(0)}s: recovered ${boundary.length} segments`);
    }
  }

  const next = {
    ...tx,
    fileOffset: tx.fileOffset + sliceEnd,
    timeOffset: timeOffset + duration,
    chunks: tx.chunks + 1,
    prev: {
      byteStart: tx.fileOffset + sliceStart,
      byteEnd: tx.fileOffset + sliceEnd,
      startSec: timeOffset,
      endMs: chunkStartMs + Math.round(duration * 1000),
    },
  };
  console.log(`  Chunk ${next.chunks}: ${chunkBytes.length} bytes, ${segments.length} segments, +${duration.toFixed(1)}s`);
  return { tx: next, segments, boundary };
}

/**
 * Put the stored chunks together: sort, clean, and list the stretches of 5+
 * minutes still without transcript after every retry (long music, dead air,
 * or audio Whisper couldn't recover).
 *
 * @param {Array} segments - every chunk's segments plus the boundary recoveries
 * @param {number} durationMs - length of the audio
 * @returns {{ segments: Array, holes: Array<{startMs: number, endMs: number}> }}
 */
export function finishTranscription(segments, durationMs) {
  const sorted = [...segments].sort((a, b) => a.start_ms - b.start_ms);
  const cleaned = dropRepeatedLines(cleanSegments(sorted));
  console.log(`  Total: ${cleaned.length} segments (${sorted.length - cleaned.length} removed by cleaning), ${durationMs}ms`);

  const holes = findGaps(cleaned, 0, durationMs, MIN_GAP_MS);
  if (holes.length > 0) {
    console.warn(`  ${holes.length} hole(s) of 5+ min left: ${holes.map(h => `${Math.round(h.startMs / 60000)}–${Math.round(h.endMs / 60000)} min`).join(', ')}`);
  }
  return { segments: cleaned, holes };
}

async function readRange(bucket, key, offset, length) {
  const obj = await bucket.get(key, { range: { offset, length } });
  if (!obj) throw new Error(`Failed to read R2 range: offset=${offset}, length=${length} (key: ${key})`);
  return new Uint8Array(await obj.arrayBuffer());
}

// Retry clips get a shorter time limit, and stop once the alarm's time budget is
// spent. retryHole logs and skips a clip that throws, so the rest stays a hole.
function retryWhisper(apiKey, deadline) {
  return (clip, offsetSec) => {
    if (Date.now() > deadline) return Promise.reject(new Error('no time left in this alarm for retries'));
    return transcribeChunk(clip, apiKey, offsetSec, { timeoutMs: TIMEOUT_MS.whisperRetry });
  };
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
export async function transcribeChunk(chunkBytes, apiKey, timeOffsetSec, { timeoutMs = TIMEOUT_MS.whisper } = {}) {
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
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    throw apiError('Whisper API', res.status, await res.text());
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
