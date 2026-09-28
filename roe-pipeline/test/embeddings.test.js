import { describe, it, expect } from 'vitest';
import { chunkSegments, generateEmbeddings } from '../src/embeddings.js';
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
