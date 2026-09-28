/**
 * Shows recorded as several files: "Roll Over Easy 2024-08-08 1.mp3",
 * "… 2.mp3" and so on, which together are one episode.
 *
 * Every upload for a date goes to that episode's Durable Object. Once no new
 * file has come for SETTLE_MS, planParts() looks at all of the date's files and
 * says what to run: one file as it is, several joined (mp3-join.js), or
 * nothing yet, with the reason shown on /status:
 * - a file identical to another is a copy, and is left out;
 * - two different files for one part, a missing part, parts in different
 *   formats, or parts adding up to more than one show wait for the owner.
 *   (The archive has all of these: many "parts" are copies, and some dates
 *   hold the parts and a copy of the whole show.)
 */

import { parseEpisodeId, decodeName } from './parse-episode-id.js';
import { parseFrameHeader, findFrameStart, id3v2Size, readXing, samplesPerFrame } from './mp3-frames.js';
import { describeFormat } from './mp3-join.js';

export const SETTLE_MS = 10 * 60_000;     // wait this long after the last upload
export const JOINED_PREFIX = 'joined/';   // where joined shows go; the queue ignores it
export const MAX_JOINED_SEC = 3.5 * 3600; // a show is two hours; more is probably a copy
const PROBE_BYTES = 64 * 1024;
const SAMPLE_BYTES = 64 * 1024;
const FORCE = 'POST /process?key=<any part>&force=1';

// " 2", "_2", " part 2", " pt 2" after the date at the end of the name
const PART_SUFFIX = /^(.*\d{4}-\d{2}-\d{2})[ _]+(?:(?:part|pt)[ _]*)?([1-9]\d?)$/i;
const COPY_SUFFIX = /\s\(\d+\)$/; // "… (1).mp3", a second download of a file

/**
 * Which episode and part a file is. A name without a part number is part 1.
 *
 * @returns {{episodeId: string, part: number, prefix: string|null} | {error: string, copy?: boolean}}
 *   prefix is the start of the raw key up to the date, to list the other parts by.
 */
export function parseUpload(key) {
  const name = decodeName(key.split('/').pop());
  if (!/\.mp3$/i.test(name)) return { error: `"${name}" is not an MP3 file` };
  const stem = name.slice(0, -'.mp3'.length);
  if (COPY_SUFFIX.test(stem)) return { error: `"${name}" looks like a second copy of a file (it ends in "(n)")`, copy: true };

  const m = PART_SUFFIX.exec(stem);
  const episodeId = parseEpisodeId(`${m ? m[1] : stem}.mp3`);
  if (!episodeId) {
    return { error: `Can't tell which show "${name}" is; name it like "Roll Over Easy 2026-10-01.mp3"` };
  }
  const date = /\d{4}-\d{2}-\d{2}/.exec(key);
  return { episodeId, part: m ? Number(m[2]) : 1, prefix: date ? key.slice(0, date.index + 10) : null };
}

/** Where a joined show goes: "joined/Roll Over Easy 2026-10-01.mp3" for part 1 "Roll Over Easy 2026-10-01 1.mp3". */
export function joinedKey(firstKey) {
  const stem = decodeName(firstKey.split('/').pop()).replace(/\.mp3$/i, '');
  return `${JOINED_PREFIX}${PART_SUFFIX.exec(stem)?.[1] ?? stem}.mp3`;
}

/**
 * Every file for the episode: the ones uploaded (`seen`), and any others R2
 * lists under the same name, such as parts uploaded before this code ran.
 *
 * @returns {Promise<{files: Array<{key, part, size, etag}>, ignored: Array<{key, reason}>}>}
 */
export async function findParts(bucket, seen, episodeId) {
  const keys = new Set(seen);
  for (const prefix of new Set(seen.map(k => parseUpload(k).prefix).filter(Boolean))) {
    let cursor;
    do {
      const page = await bucket.list({ prefix, cursor });
      for (const o of page.objects) keys.add(o.key);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }

  const files = [];
  const ignored = [];
  for (const key of [...keys].sort()) {
    if (key.startsWith(JOINED_PREFIX)) continue;
    const upload = parseUpload(key);
    if (upload.copy) ignored.push({ key, reason: 'a second copy of a file ("(n)" in the name)' });
    if (upload.error || upload.episodeId !== episodeId) continue;
    const head = await bucket.head(key);
    if (!head) continue; // deleted since it was uploaded
    files.push({ key, part: upload.part, size: head.size, etag: head.etag });
  }
  files.sort((a, b) => a.part - b.part || a.key.localeCompare(b.key));
  return { files, ignored };
}

/**
 * Decide what to run from an episode's files (from findParts).
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force] - go ahead despite a missing part or a long total
 * @returns {Promise<{parts: Array, ignored: Array, problem?: string, missing?: number[]}>}
 *   `parts` in order: one to run as it is, or several to join. With `problem`,
 *   nothing runs until the owner acts.
 */
export async function planParts(bucket, files, { force = false } = {}) {
  const ignored = [];
  const kept = [];
  for (const file of files) {
    let twin = null;
    for (const k of kept) if (await sameBytes(bucket, k, file)) { twin = k; break; }
    if (twin) ignored.push({ key: file.key, reason: `the same file as ${twin.key}` });
    else kept.push(file);
  }
  const hold = (problem, extra = {}) => ({ parts: kept, ignored, problem, ...extra });

  if (kept.length === 0) return hold('None of the files is in R2 any more.');
  const numbers = kept.map(f => f.part);
  const doubled = numbers.find((n, i) => numbers.indexOf(n) !== i);
  if (doubled) {
    const names = kept.filter(f => f.part === doubled).map(f => `"${f.key}"`).join(' and ');
    return hold(`Two different files are part ${doubled}: ${names}. Delete the wrong one from R2, then send ${FORCE}.`);
  }
  if (kept.length === 1 && kept[0].part === 1) return { parts: kept, ignored };

  const missing = [];
  for (let n = 1; n < Math.max(...numbers); n++) if (!numbers.includes(n)) missing.push(n);
  if (missing.length && !force) {
    return hold(`Waiting for part ${missing.join(', ')}. Upload it, or send ${FORCE} to go ahead without it.`, { missing });
  }

  // Parts with no audio at all (a false start, an empty file) are left out
  const probed = [];
  for (const file of kept) {
    const probe = await probeMp3(bucket, file);
    if (probe) probed.push({ file, probe });
    else ignored.push({ key: file.key, reason: 'no MP3 audio in it' });
  }
  if (probed.length === 0) return hold('None of the files has any MP3 audio in it.');
  if (probed.length === 1) return { parts: [probed[0].file], ignored };

  const formats = [...new Set(probed.map(p => describeFormat(p.probe)))];
  if (formats.length > 1) {
    return hold(`The parts are in different formats (${formats.join('; ')}), so they can't be joined as they are. Join them with ffmpeg and upload one file instead.`);
  }
  const totalSec = probed.reduce((sum, p) => sum + p.probe.sec, 0);
  if (totalSec > MAX_JOINED_SEC && !force) {
    return hold(`The parts add up to ${(totalSec / 3600).toFixed(1)} hours, more than one show, so one may be a copy of the whole show. Delete the extra file from R2, or send ${FORCE} to join them anyway.`);
  }
  return { parts: probed.map(p => ({ ...p.file, sec: Math.round(p.probe.sec) })), ignored };
}

/** Two files with the same bytes: the same size, and the same etag or the same sample of bytes. */
async function sameBytes(bucket, a, b) {
  if (a.size !== b.size) return false;
  if (a.etag === b.etag || a.size === 0) return true;
  const len = Math.min(SAMPLE_BYTES, a.size);
  for (const at of [0, Math.floor((a.size - len) / 2), a.size - len]) {
    const [x, y] = await Promise.all([readRange(bucket, a.key, at, len), readRange(bucket, b.key, at, len)]);
    for (let i = 0; i < len; i++) if (x[i] !== y[i]) return false;
  }
  return true;
}

/**
 * Format and length of an MP3 from its first frame: the frame count in its
 * Xing/Info header if it has one, else estimated from its size and bitrate.
 * Null if there's no MP3 audio at the start.
 */
export async function probeMp3(bucket, { key, size }) {
  if (size < 10) return null;
  const tag = id3v2Size(await readRange(bucket, key, 0, 10));
  if (tag >= size) return null;
  const bytes = await readRange(bucket, key, tag, Math.min(PROBE_BYTES, size - tag));
  const first = findFrameStart(bytes, 0);
  if (first < 0) return null;
  const h = parseFrameHeader(bytes, first);
  const frames = readXing(bytes, first)?.frames;
  const sec = frames
    ? (frames * samplesPerFrame(h)) / h.sampleRate
    : ((size - tag - first) * 8) / (h.bitrateKbps * 1000);
  return { version: h.version, layer: h.layer, sampleRate: h.sampleRate, channels: h.channels, sec };
}

async function readRange(bucket, key, offset, length) {
  const obj = await bucket.get(key, { range: { offset, length } });
  if (!obj) throw new Error(`Failed to read R2 range: offset=${offset}, length=${length} (key: ${key})`);
  return new Uint8Array(await obj.arrayBuffer());
}
