/**
 * Transcribe an MP3 from R2 using OpenAI Whisper API.
 * Handles files >25MB by chunking and stitching timestamps.
 */

import { cleanSegments } from './clean-segments.js';
import { findFrameStart, findChunkEnd } from './mp3-frames.js';

const TARGET_CHUNK = 20 * 1024 * 1024; // ~20MB, under the 25MB Whisper limit
const TAIL_MARGIN  = 64 * 1024;        // extra bytes read past TARGET_CHUNK so
                                       // findChunkEnd can always find the next
                                       // frame boundary just past the limit.

// Whisper prompt for SF proper nouns — same as scripts/process-episode.js
const SF_VOCAB_PROMPT = [
  'Roll Over Easy, BFF.fm, Stroll Over Easy,',
  'SoMa, the Tenderloin, Dogpatch, Bernal Heights, Japantown, Visitacion Valley,',
  'Haight-Ashbury, Pac Heights, Noe Valley, Potrero Hill, the Fillmore, Bayview,',
  'the Ferry Building, Golden Gate Park, Sutro Baths, Lands End, McLaren Park,',
  'JFK Promenade, Crosstown Trail, Pier 70, Wave Organ, Transamerica Pyramid,',
  'Conservatory of Flowers, the Botanical Garden, Salesforce Park,',
  'Hamburger Haven, Club Fugazi, Manny\'s, The Lab, Spin City, Parklab,',
  'La Cocina, Bi-Rite, Tartine, Humphry Slocombe, Lazy Bear, Toronado,',
  'Wesburger, The New Wheel, Laughing Monk,',
  'Sequoia, The Early Bird,',
  'Emperor Norton, Herb Caen, Cosmic Amanda, Dr. Guacamole,',
  'Muni Diaries, Noise Pop, Litquake, Litcrawl, KQED, KALW, Hoodline,',
  'Mission Local, SFGate, Tablehopper, Total SF, Bay City Beacon,',
  'BAYCAT, ODC, YBCA, Gray Area, SFMOMA, the Exploratorium,',
  'Sisters of Perpetual Indulgence, Cacophony Society,',
  'Muni, BART, Caltrain, the N-Judah, the F-Market,',
  'Eichler Homes, Compton\'s Cafeteria, Critical Mass, Sketch Fest, Karl the Fog,',
  'NIMBYism, YIMBYism, Dungeness crab, cioppino, dim sum, sourdough,',
].join(' ');

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
    if (!obj) throw new Error(`Failed to read R2 range: offset=${fileOffset}, length=${windowLen} (key: ${key})`);
    const window = new Uint8Array(await obj.arrayBuffer());

    // Chunk 1 keeps offset 0 so the ID3v2 tag (if present) rides along.
    // Subsequent chunks start at the first validated frame in the window.
    const chunkStart = (fileOffset === 0) ? 0 : findFrameStart(window, 0);
    if (chunkStart < 0) {
      throw new Error(`No frame sync in window at file offset ${fileOffset} (key: ${key})`);
    }

    const isLastChunk = (fileOffset + windowLen) >= fileSize;
    const chunkEnd = isLastChunk
      ? window.length
      : findChunkEnd(window, chunkStart, TARGET_CHUNK);

    if (chunkEnd <= chunkStart) {
      throw new Error(
        `Could not assemble chunk at file offset ${fileOffset}: ` +
        `chunkStart=${chunkStart}, chunkEnd=${chunkEnd} (key: ${key})`
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
