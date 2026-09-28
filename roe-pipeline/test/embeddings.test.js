import { describe, it, expect } from 'vitest';
import { chunkSegments, generateEmbeddings, isEpisodeVectorId, deleteEpisodeVectors, replaceEmbeddings } from '../src/embeddings.js';
import { makeAI, makeVectorize } from './helpers/fakes.js';

const line = (startSec, endSec, text = `words spoken from ${startSec} to ${endSec} seconds`) => ({ start_ms: startSec * 1000, end_ms: endSec * 1000, text });
const SHOW = [line(0, 10), line(10, 30), line(30, 50), line(50, 70), line(70, 90)];

describe('chunkSegments', () => {
  it('makes 45-second windows every 35 seconds, named after the episode and the first line\'s start', () => {
    const chunks = chunkSegments('ep', SHOW);
    expect(chunks.map(c => c.id)).toEqual(['ep:0', 'ep:30000', 'ep:70000']);
    expect(chunks[1]).toMatchObject({ start_ms: 30000, end_ms: 90000, text: expect.stringMatching(/^words spoken from 30 .* 90 seconds$/) });
  });

  it('keeps the first of two windows a long line would give the same ID', () => {
    // A 100-second line starts three windows in a row; Vectorize would keep whichever came last
    const chunks = chunkSegments('ep', [line(0, 100, 'one long line the whole song long'), line(100, 110)]);
    expect(chunks.map(c => c.id)).toEqual(['ep:0', 'ep:100000']);
    expect(chunks[0].text).toBe('one long line the whole song long');
  });

  it('skips windows that are too short to search or not plain ASCII', () => {
    expect(chunkSegments('ep', [line(0, 5, 'mm-hmm'), line(100, 110, 'Nos vemos mañana en el café, amigos')])).toEqual([]);
  });
});

describe('generateEmbeddings', () => {
  it('embeds each window once and upserts it with its times', async () => {
    const ai = makeAI();
    const vectorize = makeVectorize();
    expect(await generateEmbeddings(ai, vectorize, 'ep', SHOW, 90000)).toBe(3);
    expect(vectorize.upserted.map(v => v.id)).toEqual(['ep:0', 'ep:30000', 'ep:70000']);
    expect(vectorize.upserted[2]).toMatchObject({ values: [0.1, 0.2, 0.3], metadata: { episode_id: 'ep', start_ms: 70000, end_ms: 90000 } });
  });

  it('writes nothing when Workers AI returns the wrong number of vectors for any batch', async () => {
    // 150 windows: two batches, and only the second comes back one short
    const show = Array.from({ length: 150 }, (_, i) => line(i * 35, i * 35 + 30));
    const ai = { runs: 0, async run(_model, { text }) { this.runs++; return { data: text.slice(this.runs === 2 ? 1 : 0).map(() => [0.1]) }; } };
    const vectorize = makeVectorize();
    await expect(generateEmbeddings(ai, vectorize, 'ep', show, 0)).rejects.toThrow('Workers AI returned 49 vectors for 50 texts');
    expect(ai.runs).toBe(2);
    expect(vectorize.upserted).toEqual([]);
  });
});

// The real same-date pair: the 3/24/2016 merge left 118 vectors under B
const A = 'roll-over-easy_2016-03-24_07-30-00';
const B = 'roll-over-easy_2016-03-24_07-56-07';

describe('isEpisodeVectorId', () => {
  const ids = [
    `${A}:0`, `${A}:35000`, `${B}:0`, `${B}:120000`,
    `${A}0:5`, `${A}-2:0`, `${A}:`, `${A}:12x`, A, `${A}:1:2`, 'roll-over-easy_2016-03-24_07-30:0',
    ` ${A}:5`, `${A}:-5`, `${A}:+5`, `${A}:1.5`, `${A}:1e3`, `${A}: 5`, `${A}:5\n`,
  ];

  it('takes exactly "<episode>:<digits>", never a same-date neighbour, a longer ID or a malformed suffix', () => {
    expect(ids.filter(id => isEpisodeVectorId(A, id))).toEqual([`${A}:0`, `${A}:35000`]);
    expect(ids.filter(id => isEpisodeVectorId(B, id))).toEqual([`${B}:0`, `${B}:120000`]);
    expect(ids.filter(id => isEpisodeVectorId('roll-over-easy_2016-03-24', id))).toEqual([]);
  });

  it('takes nothing for an empty or missing episode, or an ID that is not a string', () => {
    expect(isEpisodeVectorId('', ':5')).toBe(false);
    expect(isEpisodeVectorId(undefined, 'undefined:5')).toBe(false);
    expect(isEpisodeVectorId(A, null)).toBe(false);
    expect(isEpisodeVectorId(A, 5)).toBe(false);
  });
});

describe('deleteEpisodeVectors', () => {
  it('deletes 100 at a time, each ID once', async () => {
    const old = Array.from({ length: 250 }, (_, i) => `${A}:${i * 1000}`);
    const vectorize = makeVectorize(old);
    expect(await deleteEpisodeVectors(vectorize, A, [...old, old[0]])).toBe(250);
    expect(vectorize.calls.map(([kind, batch]) => [kind, batch.length])).toEqual([['delete', 100], ['delete', 100], ['delete', 50]]);
    expect(vectorize.store.size).toBe(0);
  });

  it('refuses before the first call when any ID is not the episode\'s', async () => {
    const vectorize = makeVectorize([`${A}:0`, `${B}:0`]);
    const ids = [...Array.from({ length: 150 }, (_, i) => `${A}:${i}`), `${B}:0`];
    await expect(deleteEpisodeVectors(vectorize, A, ids)).rejects.toMatchObject({ permanent: true, message: expect.stringContaining(`${B}:0`) });
    expect(vectorize.calls).toEqual([]);
  });
});

describe('replaceEmbeddings', () => {
  const NEW = [`${A}:0`, `${A}:30000`, `${A}:70000`]; // what chunkSegments makes of SHOW

  it('upserts every window first, then deletes exactly the old IDs the new ones don\'t have', async () => {
    const old = [`${A}:0`, `${A}:5000`, `${A}:40000`];
    const vectorize = makeVectorize([...old, `${B}:0`, `${B}:5000`]);
    const result = await replaceEmbeddings(makeAI(), vectorize, A, SHOW, 90000, [...old, `${A}:5000`, `${B}:0`, `${A}0:5`]);
    expect(result).toEqual({ upserted: 3, deleted: 2, ids: NEW });
    expect(vectorize.calls).toEqual([['upsert', NEW], ['delete', [`${A}:5000`, `${A}:40000`]]]);
    // The neighbour's vectors survive even though one was passed in; A:0 was re-upserted, not deleted
    expect([...vectorize.store.keys()].sort()).toEqual([...NEW, `${B}:0`, `${B}:5000`].sort());
  });

  it('deletes 250 old IDs in 3 calls, all after the last upsert', async () => {
    const old = Array.from({ length: 250 }, (_, i) => `${A}:${1_000_000 + i}`);
    const vectorize = makeVectorize(old);
    const show = Array.from({ length: 150 }, (_, i) => line(i * 35, i * 35 + 30)); // 150 windows: 2 embedding batches
    const result = await replaceEmbeddings(makeAI(), vectorize, A, show, 0, old);
    expect(result).toMatchObject({ upserted: 150, deleted: 250 });
    expect(vectorize.calls.map(([kind, batch]) => [kind, batch.length])).toEqual([['upsert', 150], ['delete', 100], ['delete', 100], ['delete', 50]]);
    expect(vectorize.store.size).toBe(150);
  });

  it('writes and deletes nothing when Workers AI answers short', async () => {
    const vectorize = makeVectorize([`${A}:5000`]);
    const ai = { async run(_model, { text }) { return { data: text.slice(1).map(() => [0.1]) }; } };
    await expect(replaceEmbeddings(ai, vectorize, A, SHOW, 90000, [`${A}:5000`])).rejects.toThrow('Workers AI returned 2 vectors for 3 texts');
    expect(vectorize.calls).toEqual([]);
    expect([...vectorize.store.keys()]).toEqual([`${A}:5000`]);
  });

  it('refuses to empty an episode: no lines (or none that make a window) with old IDs throws, and nothing is sent', async () => {
    for (const lines of [[], [line(0, 5, 'mm-hmm')]]) {
      const ai = makeAI();
      const vectorize = makeVectorize([`${A}:0`, `${A}:35000`]);
      await expect(replaceEmbeddings(ai, vectorize, A, lines, 90000, [`${A}:0`, `${A}:35000`]))
        .rejects.toMatchObject({ permanent: true, message: `${A} has nothing to embed: refusing to delete its 2 vectors` });
      expect(ai.runs).toBe(0);
      expect(vectorize.calls).toEqual([]);
    }
  });

  it('with no old IDs it does what generateEmbeddings does (the Worker\'s case)', async () => {
    const before = makeVectorize();
    const after = makeVectorize();
    const count = await generateEmbeddings(makeAI(), before, A, SHOW, 90000);
    expect(await replaceEmbeddings(makeAI(), after, A, SHOW, 90000)).toEqual({ upserted: count, deleted: 0, ids: NEW });
    expect(after.upserted).toEqual(before.upserted);
    expect(after.calls).toEqual(before.calls);
    expect(await replaceEmbeddings(makeAI(), makeVectorize(), A, [], 0, [])).toEqual({ upserted: 0, deleted: 0, ids: [] });
  });
});
