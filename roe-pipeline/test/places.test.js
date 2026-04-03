import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sampleTranscript, extractAndSeedPlaces } from '../src/places.js';

describe('sampleTranscript', () => {
  it('joins all text for short episodes (< 50 segments)', () => {
    const segments = Array.from({ length: 10 }, (_, i) => ({ text: `word${i}` }));
    expect(sampleTranscript(segments)).toBe('word0 word1 word2 word3 word4 word5 word6 word7 word8 word9');
  });

  it('skips first ~5% of segments for long episodes', () => {
    const segments = Array.from({ length: 200 }, (_, i) => ({ text: `seg${i}` }));
    const result = sampleTranscript(segments);
    expect(result.startsWith('seg0')).toBe(false);
    expect(result.length).toBeGreaterThan(0);
  });

  it('caps output at 12000 characters', () => {
    const segments = Array.from({ length: 200 }, () => ({ text: 'a'.repeat(200) }));
    expect(sampleTranscript(segments).length).toBeLessThanOrEqual(12000);
  });
});

describe('extractAndSeedPlaces', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function makeMockDb(initialPlaces = []) {
    const inserted = [...initialPlaces];
    const runs = [];
    return {
      runs,
      prepare: (sql) => ({
        bind: (...args) => ({
          run: async () => {
            runs.push({ sql, args });
            if (sql.includes('INSERT OR IGNORE INTO places')) {
              inserted.push({ id: inserted.length + 1, name: args[0] });
            }
          },
          all: async () => ({ results: [] }),
        }),
        all: async () => ({ results: inserted }),
      }),
    };
  }

  it('skips all work when openaiApiKey is falsy', async () => {
    const db = makeMockDb();
    await extractAndSeedPlaces(db, 'ep-1', [], null);
    expect(db.runs).toHaveLength(0);
  });

  it('skips D1 writes when OpenAI returns empty array', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '[]' } }] }),
    });
    const db = makeMockDb();
    await extractAndSeedPlaces(db, 'ep-1', [{ text: 'no places here' }], 'sk-test');
    expect(db.runs).toHaveLength(0);
  });

  it('inserts geocoded place into D1', async () => {
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '["Dolores Park"]' } }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ lat: '37.7596', lon: '-122.4269' }],
      });

    const db = makeMockDb();
    const p = extractAndSeedPlaces(db, 'ep-1', [{ text: 'We went to Dolores Park' }], 'sk-test');
    await vi.runAllTimersAsync();
    await p;

    const insertPlace = db.runs.find(r => r.sql.includes('INSERT OR IGNORE INTO places'));
    expect(insertPlace).toBeDefined();
    expect(insertPlace.args[0]).toBe('Dolores Park');
    expect(insertPlace.args[1]).toBeCloseTo(37.7596);
    expect(insertPlace.args[2]).toBeCloseTo(-122.4269);
  });

  it('skips places that fail all geocoding strategies', async () => {
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '["Fake Nonexistent Place"]' } }] }),
      })
      .mockResolvedValue({ ok: true, json: async () => [] });

    const db = makeMockDb();
    const p = extractAndSeedPlaces(db, 'ep-1', [{ text: 'some text' }], 'sk-test');
    await vi.runAllTimersAsync();
    await p;

    expect(db.runs.find(r => r.sql.includes('INSERT OR IGNORE INTO places'))).toBeUndefined();
  });

  it('skips geocoding for already-known places', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '["Golden Gate Park"]' } }] }),
    });

    const db = makeMockDb([{ id: 1, name: 'Golden Gate Park' }]);
    const p = extractAndSeedPlaces(db, 'ep-1', [{ text: 'Golden Gate Park today' }], 'sk-test');
    await vi.runAllTimersAsync();
    await p;

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0]).toContain('openai.com');
  });
});
