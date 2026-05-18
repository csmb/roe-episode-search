import { describe, it, expect } from 'vitest';
import {
  placeMatchVariants,
  findPlacePassages,
  buildScorePrompt,
  parseScoreResponse,
} from '../src/sentiment.js';

describe('placeMatchVariants', () => {
  it('lowercases and includes the base name', () => {
    expect(placeMatchVariants('Dolores Park')).toContain('dolores park');
  });
  it('splits intersections on &', () => {
    const v = placeMatchVariants('16th Street & Valencia Street');
    expect(v.some(x => x.includes('16th'))).toBe(true);
    expect(v.some(x => x.includes('valencia'))).toBe(true);
  });
  it('drops variants shorter than 3 chars', () => {
    expect(placeMatchVariants('Q').length).toBe(0);
  });
  it('does not mangle "St." name prefixes into junk variants', () => {
    const v = placeMatchVariants('St. Francis Fountain');
    expect(v).toContain('st. francis fountain');
    expect(v.every(x => !x.startsWith('.'))).toBe(true);
  });
});

describe('findPlacePassages', () => {
  const segs = [
    { start_ms: 0, text: 'intro music' },
    { start_ms: 1000, text: 'we went to Dolores Park yesterday' },
    { start_ms: 2000, text: 'it was sunny and packed' },
    { start_ms: 3000, text: 'unrelated chatter' },
    { start_ms: 4000, text: 'totally different topic' },
    { start_ms: 5000, text: 'back to Dolores Park again' },
    { start_ms: 6000, text: 'loved the vibe' },
  ];
  it('returns empty when the place is absent', () => {
    expect(findPlacePassages(segs, 'Ferry Building')).toEqual([]);
  });
  it('returns a context window with start_ms of the first segment in the window', () => {
    const p = findPlacePassages(segs, 'Dolores Park');
    expect(p.length).toBeGreaterThan(0);
    expect(p[0].start_ms).toBe(0); // hit at idx 1, CONTEXT_BEFORE=2 -> clamps to idx 0
    expect(p[0].text).toContain('Dolores Park');
  });
  it('merges overlapping windows', () => {
    const close = [
      { start_ms: 0, text: 'Dolores Park is great' },
      { start_ms: 1000, text: 'and also' },
      { start_ms: 2000, text: 'Dolores Park again' },
    ];
    expect(findPlacePassages(close, 'Dolores Park')).toHaveLength(1);
  });
});

describe('parseScoreResponse', () => {
  it('parses and clamps score, strips code fences', () => {
    const r = parseScoreResponse('```json\n{"score": 2, "label":"positive","quote":"great spot"}\n```');
    expect(r.score).toBe(1);
    expect(r.label).toBe('positive');
    expect(r.quote).toBe('great spot');
  });
  it('falls back to neutral on unknown label', () => {
    expect(parseScoreResponse('{"score":0,"label":"weird","quote":"x"}').label).toBe('neutral');
  });
  it('throws on non-finite score', () => {
    expect(() => parseScoreResponse('{"score":"NaN","label":"positive","quote":"x"}')).toThrow();
  });
});

describe('buildScorePrompt', () => {
  it('embeds the place name and numbers the passages', () => {
    const { system, user } = buildScorePrompt('Tartine', [{ text: 'a' }, { text: 'b' }]);
    expect(system).toContain('Tartine');
    expect(user).toContain('[1] a');
    expect(user).toContain('[2] b');
  });
});

import {
  episodeYear,
  meetsNarrativeThreshold,
  buildNarrativePrompt,
  parseNarrativeResponse,
} from '../src/sentiment.js';

describe('episodeYear', () => {
  it('extracts the year from an episode id', () => {
    expect(episodeYear('roll-over-easy_2019-03-14_07-30-00')).toBe(2019);
  });
  it('returns null when no date present', () => {
    expect(episodeYear('garbage')).toBeNull();
  });
});

describe('meetsNarrativeThreshold', () => {
  const mk = (id, score) => ({ episode_id: id, score });
  it('false when fewer than 3 scored episodes', () => {
    expect(meetsNarrativeThreshold([
      mk('x_2019-01-01_0', 0.2), mk('x_2020-01-01_0', 0.1),
    ])).toBe(false);
  });
  it('false when 3 episodes but only one calendar year', () => {
    expect(meetsNarrativeThreshold([
      mk('x_2019-01-01_0', 0.2), mk('x_2019-06-01_0', 0.1), mk('x_2019-09-01_0', -0.1),
    ])).toBe(false);
  });
  it('true with >=3 scored episodes spanning >=2 years', () => {
    expect(meetsNarrativeThreshold([
      mk('x_2019-01-01_0', 0.2), mk('x_2020-06-01_0', 0.1), mk('x_2021-09-01_0', -0.1),
    ])).toBe(true);
  });
  it('ignores entries with null score', () => {
    expect(meetsNarrativeThreshold([
      mk('x_2019-01-01_0', 0.2), mk('x_2020-06-01_0', null),
      mk('x_2021-09-01_0', null), mk('x_2022-09-01_0', null),
    ])).toBe(false);
  });
});

describe('parseNarrativeResponse', () => {
  it('parses fields and strips fences', () => {
    const r = parseNarrativeResponse('```json\n{"early":"a","recent":"b","arc":"c"}\n```');
    expect(r).toEqual({ early: 'a', recent: 'b', arc: 'c' });
  });
  it('coerces missing fields to empty strings', () => {
    expect(parseNarrativeResponse('{}')).toEqual({ early: '', recent: '', arc: '' });
  });
});

describe('buildNarrativePrompt', () => {
  it('lists snippets in date order with the place name in the system prompt', () => {
    const { system, user } = buildNarrativePrompt('Tartine', [
      { episode_id: 'x_2021-01-01_0', date: '2021-01-01', score: -0.5, label: 'negative', snippet: 'meh' },
      { episode_id: 'x_2019-01-01_0', date: '2019-01-01', score: 0.4, label: 'positive', snippet: 'great' },
    ]);
    expect(system).toContain('Tartine');
    expect(user.indexOf('2019-01-01')).toBeLessThan(user.indexOf('2021-01-01'));
  });
});

import { vi, beforeEach, afterEach } from 'vitest';
import { scoreAndSeedSentiment } from '../src/sentiment.js';

describe('scoreAndSeedSentiment', () => {
  beforeEach(() => {});
  afterEach(() => { vi.restoreAllMocks(); });

  function makeDb(places, mentions) {
    const runs = [];
    return {
      runs,
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async run() { runs.push({ sql, args }); },
              async first() {
                if (sql.includes('FROM places WHERE id')) {
                  return places.find(p => p.id === args[0]) || null;
                }
                return null;
              },
              async all() {
                if (sql.includes('FROM place_mentions pm') && sql.includes('place_id = ?')) {
                  return { results: mentions.filter(m => m.place_id === args[0]) };
                }
                if (sql.includes('FROM place_mentions pm') && sql.includes('episode_id = ?')) {
                  return { results: mentions.filter(m => m.episode_id === args[0]) };
                }
                return { results: [] };
              },
            };
          },
          async all() {
            if (sql.includes('FROM place_mentions') && sql.includes('episode_id')) {
              return { results: mentions };
            }
            return { results: [] };
          },
        };
      },
    };
  }

  it('no-ops without an API key', async () => {
    const db = makeDb([], []);
    await scoreAndSeedSentiment(db, 'ep_2019-01-01_0', [], null);
    expect(db.runs).toHaveLength(0);
  });

  it('scores a mention and writes sentiment columns', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content:
        '{"score":0.6,"label":"positive","quote":"we love Tartine"}' } }] }),
    });
    const db = makeDb(
      [{ id: 7, name: 'Tartine' }],
      [{ place_id: 7, episode_id: 'ep_2019-01-01_0', name: 'Tartine' }],
    );
    const segs = [
      { start_ms: 0, text: 'intro' },
      { start_ms: 1000, text: 'we love Tartine so much' },
      { start_ms: 2000, text: 'best bread' },
    ];
    await scoreAndSeedSentiment(db, 'ep_2019-01-01_0', segs, 'sk-test');

    const upd = db.runs.find(r => r.sql.includes('UPDATE place_mentions') && r.sql.includes('SET sentiment'));
    expect(upd).toBeDefined();
    expect(upd.args).toContain(0.6);
    expect(upd.args).toContain('positive');
  });

  it('marks analyzed with null sentiment when no passages found', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    const db = makeDb(
      [{ id: 7, name: 'Tartine' }],
      [{ place_id: 7, episode_id: 'ep_2019-01-01_0', name: 'Tartine' }],
    );
    await scoreAndSeedSentiment(db, 'ep_2019-01-01_0',
      [{ start_ms: 0, text: 'no place here' }], 'sk-test');

    expect(fetchSpy).not.toHaveBeenCalled();
    const upd = db.runs.find(r => r.sql.includes('UPDATE place_mentions') && r.sql.includes('SET sentiment'));
    expect(upd).toBeDefined();
    expect(upd.args).toContain('unknown');
  });

  it('regenerateNarrative skips upsert when no episode years parse', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    // 3 mentions, non-null sentiment, but episode ids have NO YYYY-MM-DD pattern
    const db = makeDb(
      [{ id: 9, name: 'Nowhere' }],
      [
        { place_id: 9, episode_id: 'noprefix-a', sentiment: 0.1, sentiment_label: 'neutral', snippet: 'x' },
        { place_id: 9, episode_id: 'noprefix-b', sentiment: 0.2, sentiment_label: 'neutral', snippet: 'y' },
        { place_id: 9, episode_id: 'noprefix-c', sentiment: 0.3, sentiment_label: 'neutral', snippet: 'z' },
      ],
    );
    const { regenerateNarrative } = await import('../src/sentiment.js');
    await regenerateNarrative(db, 9, 'sk-test');
    // meetsNarrativeThreshold fails (no parseable years) -> early return, no OpenAI call,
    // and crucially no INSERT INTO place_narratives with Infinity bounds
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.runs.find(r => r.sql.includes('INSERT INTO place_narratives'))).toBeUndefined();
  });
});
