/**
 * Join a split show's parts, in order, into one MP3 in R2.
 *
 * Only whole MPEG audio frames are copied. Tags (ID3, APE) and each part's own
 * Xing/Info frame are left out, and a new Xing/Info frame at the start gives
 * the joined file's length and seek table. Without it a player would take the
 * length of part 1 from its old header, and in a variable-bitrate file (every
 * recent show) seek to the wrong place when a transcript link asks for 1:23:00.
 *
 * The file is written as an R2 multipart upload, so a two-hour show never has
 * to fit in memory. R2 wants every piece but the last to be the same size.
 * The first piece starts with the new header, which can only be written once
 * every frame has been counted, so that piece is uploaded last.
 */

import {
  parseFrameHeader, findFrameStart, samplesPerFrame, id3v2Size, readXing,
  xingFrameSize, buildXingFrame,
} from './mp3-frames.js';
import { PermanentError } from './limits.js';

export const PIECE_BYTES = 8 * 1024 * 1024; // R2 allows 5 MiB up
const WINDOW_BYTES = 4 * 1024 * 1024;       // read from each part this much at a time
const RESYNC_OVERLAP = 8 * 1024;            // more than the largest frame
const MARK_SEC = 1;                         // seek-table resolution

const sameFormat = (a, b) => a.version === b.version && a.layer === b.layer
  && a.sampleRate === b.sampleRate && a.channels === b.channels;

export function describeFormat(h) {
  const version = { 3: '1', 2: '2', 0: '2.5' }[h.version];
  const layer = { 3: 'I', 2: 'II', 1: 'III' }[h.layer];
  return `MPEG-${version} layer ${layer}, ${h.sampleRate / 1000} kHz ${h.channels === 1 ? 'mono' : 'stereo'}`;
}

/**
 * @param {R2Bucket} bucket
 * @param {Array<{key: string, size: number, etag: string}>} parts - in order
 * @param {string} destKey - where the joined file goes
 * @returns {Promise<{key: string, size: number, frames: number, sec: number, vbr: boolean}>}
 */
export async function joinParts(bucket, parts, destKey, { pieceBytes = PIECE_BYTES, windowBytes = WINDOW_BYTES } = {}) {
  // A part replaced since it was checked would be read with the wrong size
  for (const part of parts) {
    const head = await bucket.head(part.key);
    if (!head) throw new PermanentError(`${part.key} is no longer in R2`);
    if (head.etag !== part.etag || head.size !== part.size) {
      throw new PermanentError(`${part.key} changed after the parts were checked; upload it again to start over`);
    }
  }

  const upload = await bucket.createMultipartUpload(destKey, { httpMetadata: { contentType: 'audio/mpeg' } });
  try {
    let header = null; // the first audio frame's 4 header bytes, which set the format
    let format = null;
    let out = null;    // created once the new header's size is known
    let xingSize = 0;
    let frames = 0;
    let sec = 0;
    const bitrates = new Set();
    const marks = [];  // marks[k]: where the first frame at or after k seconds lands

    for (const [n, part] of parts.entries()) {
      let pos = Math.min(await tagEnd(bucket, part), part.size);
      let started = false; // found this part's first frame yet
      while (pos < part.size) {
        const win = await readRange(bucket, part.key, pos, Math.min(windowBytes, part.size - pos));
        const last = pos + win.length >= part.size;
        let i = 0;
        let run = 0; // start of the frames not yet written
        let next = null;

        if (!started) {
          i = findFrameStart(win, 0);
          if (i < 0) {
            if (last) break;
            pos += Math.max(1, win.length - RESYNC_OVERLAP);
            continue;
          }
          const h = parseFrameHeader(win, i);
          if (!format) {
            format = h;
            header = win.slice(i, i + 4);
            xingSize = xingFrameSize(header);
            out = new Pieces(upload, pieceBytes, xingSize);
          } else if (!sameFormat(h, format)) {
            throw new PermanentError(`Part ${n + 1} (${part.key}) is ${describeFormat(h)}, part 1 is ${describeFormat(format)}; they can't be joined as they are`);
          }
          started = true;
          // The part's own length-and-seek header describes the part alone
          if (readXing(win, i)) i += h.frameSize;
          run = i;
        }

        while (i + 4 <= win.length) {
          const h = parseFrameHeader(win, i);
          if (h && sameFormat(h, format)) {
            if (i + h.frameSize > win.length) break; // finishes in the next window (or was cut off)
            while (marks.length * MARK_SEC <= sec) marks.push(xingSize + out.bytes + (i - run));
            sec += samplesPerFrame(h) / h.sampleRate;
            frames++;
            bitrates.add(h.bitrateIdx);
            i += h.frameSize;
            continue;
          }
          // Not a frame (a tag, or damage): write what came before, then skip to the next real frame
          await out.write(win.subarray(run, i));
          const j = findFrameStart(win, i + 1);
          if (j < 0) {
            next = last ? part.size : pos + Math.max(i + 1, win.length - RESYNC_OVERLAP);
            break;
          }
          i = j;
          run = j;
        }

        if (next === null) {
          await out.write(win.subarray(run, i));
          next = last ? part.size : pos + i;
        }
        pos = next;
      }
    }

    if (frames === 0) throw new PermanentError('No MP3 audio found in the parts');
    const total = xingSize + out.bytes;
    const vbr = bitrates.size > 1;
    const xing = buildXingFrame(header, { frames, bytes: total, toc: seekTable(marks, sec, total), vbr });
    const object = await out.finish(xing);
    return { key: destKey, size: object?.size ?? total, frames, sec, vbr };
  } catch (err) {
    await upload.abort().catch(() => {});
    throw err;
  }
}

/** Xing TOC: for each 1% of the duration, where it starts, as a fraction of the file ×256. */
function seekTable(marks, totalSec, totalBytes) {
  const toc = new Uint8Array(100);
  for (let i = 0; i < 100; i++) {
    const k = Math.min(marks.length - 1, Math.floor((totalSec * i) / 100 / MARK_SEC));
    toc[i] = Math.min(255, Math.floor((marks[k] / totalBytes) * 256));
  }
  toc[0] = 0;
  return toc;
}

/** Where a part's audio starts: after its ID3v2 tag, if it has one. */
async function tagEnd(bucket, part) {
  if (part.size < 10) return 0;
  return id3v2Size(await readRange(bucket, part.key, 0, 10));
}

async function readRange(bucket, key, offset, length) {
  const obj = await bucket.get(key, { range: { offset, length } });
  if (!obj) throw new Error(`Failed to read R2 range: offset=${offset}, length=${length} (key: ${key})`);
  return new Uint8Array(await obj.arrayBuffer());
}

/**
 * The joined file, cut into equal pieces as it is written. Piece 1 keeps room
 * for the header at its start and is sent by finish(); the others are sent as
 * they fill.
 */
class Pieces {
  constructor(upload, pieceBytes, headerBytes) {
    this.upload = upload;
    this.pieceBytes = pieceBytes;
    this.first = new Uint8Array(pieceBytes - headerBytes);
    this.firstLen = 0;
    this.buf = null;
    this.bufLen = 0;
    this.sent = [];
    this.bytes = 0; // audio bytes written so far
  }

  async write(chunk) {
    this.bytes += chunk.length;
    let at = Math.min(this.first.length - this.firstLen, chunk.length);
    this.first.set(chunk.subarray(0, at), this.firstLen);
    this.firstLen += at;
    while (at < chunk.length) {
      this.buf ??= new Uint8Array(this.pieceBytes);
      const n = Math.min(this.pieceBytes - this.bufLen, chunk.length - at);
      this.buf.set(chunk.subarray(at, at + n), this.bufLen);
      this.bufLen += n;
      at += n;
      if (this.bufLen === this.pieceBytes) await this.send();
    }
  }

  async send() {
    this.sent.push(await this.upload.uploadPart(this.sent.length + 2, this.buf.subarray(0, this.bufLen)));
    this.buf = null;
    this.bufLen = 0;
  }

  async finish(headerFrame) {
    if (this.bufLen > 0) await this.send();
    const piece = new Uint8Array(headerFrame.length + this.firstLen);
    piece.set(headerFrame);
    piece.set(this.first.subarray(0, this.firstLen), headerFrame.length);
    const first = await this.upload.uploadPart(1, piece);
    return this.upload.complete([first, ...this.sent]);
  }
}
