/**
 * Transcribe an MP3 from R2 using OpenAI Whisper API.
 * Handles files >25MB by chunking and stitching timestamps.
 */

import { cleanSegments } from './clean-segments.js';

const CHUNK_SIZE = 20 * 1024 * 1024; // 20MB per chunk (under 25MB API limit)

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
 * Transcribe a full MP3 from R2, handling chunking for large files.
 *
 * @param {R2Bucket} bucket - R2 bucket binding
 * @param {string} key - R2 object key
 * @param {string} openaiApiKey - OpenAI API key
 * @param {object} [resume] - Resume state: { chunksCompleted, segments, timeOffset }
 * @returns {{ segments: Array, durationMs: number }}
 */
export async function transcribeFromR2(bucket, key, openaiApiKey, resume) {
  const head = await bucket.head(key);
  if (!head) throw new Error(`R2 object not found: ${key}`);

  const fileSize = head.size;
  const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);

  let allSegments = resume?.segments || [];
  let timeOffset = resume?.timeOffset || 0;
  const startChunk = resume?.chunksCompleted || 0;

  for (let i = startChunk; i < totalChunks; i++) {
    const offset = i * CHUNK_SIZE;
    const length = Math.min(CHUNK_SIZE, fileSize - offset);

    const obj = await bucket.get(key, { range: { offset, length } });
    if (!obj) throw new Error(`Failed to read R2 range: offset=${offset}, length=${length}`);

    const buffer = await obj.arrayBuffer();
    const { segments, duration } = await transcribeChunk(buffer, openaiApiKey, timeOffset);

    allSegments.push(...segments);
    timeOffset += duration;

    console.log(`  Chunk ${i + 1}/${totalChunks}: ${segments.length} segments, +${duration.toFixed(1)}s`);
  }

  const cleaned = cleanSegments(allSegments);
  const durationMs = Math.round(timeOffset * 1000);

  console.log(`  Total: ${cleaned.length} segments (${allSegments.length - cleaned.length} removed by cleaning), ${durationMs}ms`);

  return { segments: cleaned, durationMs, totalChunks };
}

/**
 * Send a single audio chunk to OpenAI Whisper API.
 */
async function transcribeChunk(buffer, apiKey, timeOffsetSec) {
  const blob = new Blob([buffer], { type: 'audio/mpeg' });
  const formData = new FormData();
  formData.append('file', blob, 'chunk.mp3');
  formData.append('model', 'whisper-1');
  formData.append('response_format', 'verbose_json');
  formData.append('timestamp_granularities[]', 'segment');
  formData.append('prompt', SF_VOCAB_PROMPT);

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Whisper API error ${res.status}: ${body}`);
  }

  const data = await res.json();

  const segments = (data.segments || []).map(seg => ({
    start_ms: Math.round((seg.start + timeOffsetSec) * 1000),
    end_ms: Math.round((seg.end + timeOffsetSec) * 1000),
    text: seg.text.trim(),
  })).filter(seg => seg.text.length > 0);

  return { segments, duration: data.duration || 0 };
}
