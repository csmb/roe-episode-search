import { describe, it, expect } from 'vitest';
import { joinParts, PIECE_BYTES } from '../src/mp3-join.js';
import { parseFrameHeader, readXing, buildXingFrame, samplesPerFrame } from '../src/mp3-frames.js';
import { makeR2, whisperAudio, id3Tag, concat, FRAME_SEC, FRAME_BYTES } from './helpers/fakes.js';

const DEST = 'joined/Roll Over Easy 2026-10-01.mp3';
const v1Tag = () => concat(new TextEncoder().encode('TAG'), new Uint8Array(125));
const partsOf = (bucket, keys) => keys.map(key => ({ key, size: bucket.objects.get(key).bytes.length, etag: bucket.objects.get(key).etag }));

/** Walk every frame of an MP3 stream; returns their offsets. */
function frameOffsets(bytes) {
  const out = [];
  for (let at = 0; at + 4 <= bytes.length;) {
    const h = parseFrameHeader(bytes, at);
    if (!h) throw new Error(`no frame at ${at}`);
    out.push(at);
    at += h.frameSize;
  }
  return out;
}

// MPEG-2 layer III frames at 22.05 kHz of a given bitrate index (1 = 8 kbps, 26 bytes; 4 = 32 kbps, 104 bytes)
function frames(n, bitrateIdx = 1) {
  const h = parseFrameHeader(new Uint8Array([0xFF, 0xF3, bitrateIdx << 4, 0x00]), 0);
  const out = new Uint8Array(n * h.frameSize);
  for (let i = 0; i < n; i++) out.set([0xFF, 0xF3, bitrateIdx << 4, 0x00, 0xAA, 0xBB], i * h.frameSize);
  return out;
}

describe('joinParts', () => {
  it('copies only the audio frames, and gives the whole a new length-and-seek header', async () => {
    const a = whisperAudio(20 * 60);
    const b = whisperAudio(15 * 60, { firstFrame: 50_000 });
    const oldXing = buildXingFrame(a.subarray(0, 4), { frames: 1, bytes: 2, toc: new Uint8Array(100), vbr: false });
    const bucket = makeR2({ p1: concat(id3Tag(), oldXing, a, v1Tag()), p2: concat(id3Tag(500), b) });

    const out = await joinParts(bucket, partsOf(bucket, ['p1', 'p2']), DEST, { pieceBytes: 64 * 1024, windowBytes: 10_000 });
    const joined = bucket.objects.get(DEST).bytes;
    const xingSize = parseFrameHeader(joined, 0).frameSize;
    // Exactly: the new header, part 1's frames, part 2's frames
    expect(Buffer.compare(joined.subarray(xingSize), concat(a, b))).toBe(0);
    expect(out).toMatchObject({ key: DEST, size: joined.length, frames: (a.length + b.length) / FRAME_BYTES, vbr: false });
    expect(out.sec).toBeCloseTo(35 * 60, 0);

    const xing = readXing(joined);
    expect(xing).toMatchObject({ tag: 'Info', frames: (a.length + b.length) / FRAME_BYTES, bytes: joined.length });
    expect(xing.toc[0]).toBe(0);
    expect(xing.toc[50]).toBe(128); // constant bitrate: halfway through the time is halfway through the bytes
    expect([...xing.toc].every((v, i, t) => i === 0 || v >= t[i - 1])).toBe(true);

    // Uploaded as equal pieces (the fake R2 refuses anything else), header piece last
    const [upload] = bucket.uploads;
    expect(upload.state).toBe('completed');
    expect(upload.options.httpMetadata.contentType).toBe('audio/mpeg');
    expect(upload.pieces.size).toBe(Math.ceil(joined.length / (64 * 1024)));
  });

  it('seeks by time in a variable-bitrate show', async () => {
    // First half quiet (8 kbps frames), second half busy (32 kbps): the time midpoint is a fifth of the way in
    const bucket = makeR2({ p1: frames(3000, 1), p2: frames(3000, 4) });
    await joinParts(bucket, partsOf(bucket, ['p1', 'p2']), DEST, { pieceBytes: 64 * 1024 });
    const joined = bucket.objects.get(DEST).bytes;
    const xing = readXing(joined);
    expect(xing.tag).toBe('Xing');
    expect(xing.toc[50]).toBeGreaterThanOrEqual(50);
    expect(xing.toc[50]).toBeLessThanOrEqual(52); // 256 × 26 / (26 + 104) ≈ 51
    // …and the frame it points to is where part 2 starts, give or take a second
    const offsets = frameOffsets(joined);
    const target = Math.round((xing.toc[50] / 256) * joined.length);
    const frameAt = offsets.findIndex(o => o >= target);
    expect(Math.abs(frameAt - 1 - 3000) * FRAME_SEC).toBeLessThan(1.5);
  });

  it('skips damage in the middle of a part and a cut-off frame at its end', async () => {
    const a = whisperAudio(60);
    const junk = new Uint8Array(700).fill(0x55);
    const bucket = makeR2({ p1: concat(a.subarray(0, 26 * 100), junk, a.subarray(26 * 100), a.subarray(0, 10)) });
    await joinParts(bucket, partsOf(bucket, ['p1']), DEST, { pieceBytes: 64 * 1024, windowBytes: 1000 });
    const joined = bucket.objects.get(DEST).bytes;
    const xingSize = parseFrameHeader(joined, 0).frameSize;
    expect(Buffer.compare(joined.subarray(xingSize), a)).toBe(0);
    expect(frameOffsets(joined)).toHaveLength(a.length / FRAME_BYTES + 1);
  });

  it('writes an MPEG-1 header in the stream\'s own bitrate, as LAME does', async () => {
    const frame = new Uint8Array(417);
    frame.set([0xFF, 0xFB, 0x90, 0x44]); // 128 kbps, 44.1 kHz, joint stereo
    const part = new Uint8Array(417 * 500);
    for (let i = 0; i < 500; i++) part.set(frame, i * 417);
    const bucket = makeR2({ p1: part, p2: part.slice(0, 417 * 200) });
    await joinParts(bucket, partsOf(bucket, ['p1', 'p2']), DEST, { pieceBytes: 64 * 1024 });
    const joined = bucket.objects.get(DEST).bytes;
    const h = parseFrameHeader(joined, 0);
    expect(h).toMatchObject({ frameSize: 417, bitrateKbps: 128, sampleRate: 44100, channels: 2, crc: false });
    expect(readXing(joined)).toMatchObject({ tag: 'Info', frames: 700, bytes: 417 * 701 });
    expect(frameOffsets(joined)).toHaveLength(701);
    expect(samplesPerFrame(h)).toBe(1152);
  });

  it('refuses parts in different formats, and parts changed since they were checked', async () => {
    const mpeg1 = new Uint8Array(417 * 10);
    for (let i = 0; i < 10; i++) mpeg1.set([0xFF, 0xFB, 0x90, 0x44], i * 417);
    const bucket = makeR2({ p1: whisperAudio(60), p2: mpeg1 });
    await expect(joinParts(bucket, partsOf(bucket, ['p1', 'p2']), DEST)).rejects.toMatchObject({
      permanent: true, message: expect.stringContaining("can't be joined"),
    });
    expect(bucket.uploads[0].state).toBe('aborted');
    expect(bucket.objects.has(DEST)).toBe(false);

    const parts = partsOf(bucket, ['p1']);
    bucket.replace('p1', whisperAudio(30), 'etag-new');
    await expect(joinParts(bucket, parts, DEST)).rejects.toMatchObject({ permanent: true, message: expect.stringContaining('changed') });
    expect(bucket.uploads).toHaveLength(1);
  });

  it('keeps R2\'s rules with the real piece size', () => {
    expect(PIECE_BYTES).toBeGreaterThanOrEqual(5 * 1024 * 1024);
  });
});
