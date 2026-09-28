import { describe, it, expect } from 'vitest';
import { parseUpload, joinedKey, findParts, planParts, probeMp3 } from '../src/parts.js';
import { buildXingFrame } from '../src/mp3-frames.js';
import { makeR2, whisperAudio, id3Tag, concat, FRAME_SEC } from './helpers/fakes.js';

const ID = 'roll-over-easy_2026-10-01_07-30-00';

describe('parseUpload', () => {
  it.each([
    ['Roll Over Easy 2026-10-01.mp3', 1],
    ['Roll Over Easy 2024-08-08 4.mp3', 4],
    ['Roll Over Easy 2024-08-08_2.mp3', 2],
    ['Roll Over Easy 2026-10-01-2.mp3', 2],
    ['Roll Over Easy 2024-08-08 Part 3.mp3', 3],
    ['Roll Over Easy 2022-08-19 16.mp3', 16],
    ['Roll%20Over%20Easy%202026-10-01%202.mp3', 2],
    ['Roll Over Easy 2026-10-01 0730.mp3', 1], // a time, not a part
  ])('%s is part %i', (key, part) => {
    expect(parseUpload(key)).toMatchObject({ part });
  });

  it('reads the episode, and the name to list the other parts by', () => {
    expect(parseUpload('Roll Over Easy 2026-10-01 2.mp3')).toEqual({ episodeId: ID, part: 2, prefix: 'Roll Over Easy 2026-10-01' });
    expect(parseUpload('roll-over-easy_2026-02-16_07-30-00.mp3')).toMatchObject({ episodeId: 'roll-over-easy_2026-02-16_07-30-00', part: 1 });
    expect(parseUpload('joined/Roll Over Easy 2026-10-01.mp3')).toMatchObject({ episodeId: ID });
  });

  it('refuses a "(1)" copy, other files, and names that are not a show', () => {
    expect(parseUpload('Roll Over Easy 2026-10-01 (1).mp3')).toMatchObject({ copy: true, error: expect.stringContaining('copy') });
    expect(parseUpload('roll-over-easy_2026-10-01_07-30-00.m4a').error).toContain('not an MP3');
    expect(parseUpload('mystery.mp3').error).toContain('Roll Over Easy 2026-10-01.mp3');
  });

  it('names the joined file after the show', () => {
    expect(joinedKey('Roll Over Easy 2026-10-01 1.mp3')).toBe('joined/Roll Over Easy 2026-10-01.mp3');
    expect(joinedKey('Roll Over Easy 2026-10-01.mp3')).toBe('joined/Roll Over Easy 2026-10-01.mp3');
  });
});

describe('findParts', () => {
  it('finds the parts uploaded and any others under the same name, and nothing else', async () => {
    const bucket = makeR2({
      'Roll Over Easy 2026-10-01 1.mp3': whisperAudio(60),
      'Roll Over Easy 2026-10-01 2.mp3': whisperAudio(60),
      'Roll Over Easy 2026-10-01 3.mp3': whisperAudio(60),
      'Roll Over Easy 2026-10-01 (1).mp3': whisperAudio(60),
      'Roll Over Easy 2026-10-08.mp3': whisperAudio(60),
      'joined/Roll Over Easy 2026-10-01.mp3': whisperAudio(60),
    });
    const { files, ignored } = await findParts(bucket, ['Roll Over Easy 2026-10-01 2.mp3', 'Roll Over Easy 2026-10-01 4.mp3'], ID);
    // Part 4's upload was deleted since; R2 lists two keys per page here
    expect(files.map(f => [f.part, f.key])).toEqual([
      [1, 'Roll Over Easy 2026-10-01 1.mp3'], [2, 'Roll Over Easy 2026-10-01 2.mp3'], [3, 'Roll Over Easy 2026-10-01 3.mp3'],
    ]);
    expect(files[0]).toMatchObject({ size: whisperAudio(60).length, etag: expect.any(String) });
    expect(ignored).toEqual([{ key: 'Roll Over Easy 2026-10-01 (1).mp3', reason: expect.stringContaining('copy') }]);
  });
});

describe('planParts', () => {
  const file = (bucket, key, part) => ({ key, part, size: bucket.objects.get(key).bytes.length, etag: bucket.objects.get(key).etag });

  it('runs a single whole show without reading it', async () => {
    const bucket = makeR2({ 'Roll Over Easy 2026-10-01.mp3': whisperAudio(60) });
    const plan = await planParts(bucket, [file(bucket, 'Roll Over Easy 2026-10-01.mp3', 1)]);
    expect(plan).toEqual({ parts: [expect.objectContaining({ part: 1 })], ignored: [] });
    expect(bucket.reads).toEqual([]);
  });

  it('tells a copy by its bytes, and joins two different parts of the same size', async () => {
    const a = whisperAudio(60);
    const b = whisperAudio(60, { firstFrame: 5000 }); // same length, different audio
    const bucket = makeR2({ 'x 2026-10-01 1.mp3': a, 'x 2026-10-01 2.mp3': a.slice(), 'x 2026-10-01 3.mp3': b });
    const files = [1, 2, 3].map(n => file(bucket, `x 2026-10-01 ${n}.mp3`, n));
    const plan = await planParts(bucket, files);
    // Part 2 is part 1 again, so part 2 is missing
    expect(plan.ignored).toEqual([{ key: 'x 2026-10-01 2.mp3', reason: 'the same file as x 2026-10-01 1.mp3' }]);
    expect(plan).toMatchObject({ missing: [2], problem: expect.stringContaining('Waiting for part 2') });

    const forced = await planParts(bucket, files, { force: true });
    expect(forced.parts.map(p => p.part)).toEqual([1, 3]);
    expect(forced.problem).toBeUndefined();
  });

  it('leaves out a part with no audio, which still counts as uploaded', async () => {
    const bucket = makeR2({ 'x 2026-10-01 1.mp3': new Uint8Array(4000), 'x 2026-10-01 2.mp3': whisperAudio(600) });
    const plan = await planParts(bucket, [1, 2].map(n => file(bucket, `x 2026-10-01 ${n}.mp3`, n)));
    expect(plan).toEqual({ parts: [expect.objectContaining({ part: 2 })], ignored: [{ key: 'x 2026-10-01 1.mp3', reason: 'no MP3 audio in it' }] });
  });

  it('refuses to join parts in different formats', async () => {
    const mpeg1 = new Uint8Array(417 * 40);
    for (let i = 0; i < 40; i++) mpeg1.set([0xFF, 0xFB, 0x90, 0x44], i * 417);
    const bucket = makeR2({ 'x 2026-10-01 1.mp3': whisperAudio(60), 'x 2026-10-01 2.mp3': mpeg1 });
    const plan = await planParts(bucket, [1, 2].map(n => file(bucket, `x 2026-10-01 ${n}.mp3`, n)));
    expect(plan.problem).toContain('different formats (MPEG-2 layer III, 22.05 kHz stereo; MPEG-1 layer III, 44.1 kHz stereo)');
  });
});

describe('probeMp3', () => {
  it('takes the length from a Xing header when there is one, after an ID3 tag', async () => {
    const audio = whisperAudio(90);
    const frames = Math.round(90 / FRAME_SEC);
    const xing = buildXingFrame(audio.subarray(0, 4), { frames: frames * 2, bytes: 1, toc: new Uint8Array(100), vbr: false });
    const bytes = concat(id3Tag(3000), xing, audio);
    const bucket = makeR2({ a: bytes });
    // The header claims twice the frames there are: it wins over the size
    expect((await probeMp3(bucket, { key: 'a', size: bytes.length })).sec).toBeCloseTo(frames * 2 * FRAME_SEC, 3);
    expect(await probeMp3(bucket, { key: 'a', size: 5 })).toBeNull();
  });
});
