import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { transcriptForPlaces, cleanPlaceNames, placesInTranscript, extractAndSeedPlaces } from '../src/places.js';
import { makeD1 } from './helpers/fakes.js';

describe('transcriptForPlaces', () => {
  it('joins all text for short episodes (< 50 segments)', () => {
    const segments = Array.from({ length: 10 }, (_, i) => ({ text: `word${i}` }));
    expect(transcriptForPlaces(segments)).toBe('word0 word1 word2 word3 word4 word5 word6 word7 word8 word9');
  });

  it('sends the whole show after the intro: 5% of lines, at most 40', () => {
    const segments = Array.from({ length: 2000 }, (_, i) => ({ text: `seg${i}` }));
    const text = transcriptForPlaces(segments);
    expect(text.startsWith('seg40 ')).toBe(true);
    expect(text.endsWith(' seg1999')).toBe(true);   // the interview near the end is included
    expect(transcriptForPlaces(segments.slice(0, 200)).startsWith('seg10 ')).toBe(true);
  });

  it('stops at a ceiling well inside the model\'s context', () => {
    const segments = Array.from({ length: 3000 }, () => ({ text: 'a'.repeat(200) }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(transcriptForPlaces(segments).length).toBe(400_000);
  });
});

describe('cleanPlaceNames', () => {
  it('keeps unique, trimmed strings, at most 150', () => {
    expect(cleanPlaceNames([' Dolores Park ', 'Dolores Park', '', 42, null, 'Ferry Building'])).toEqual(['Dolores Park', 'Ferry Building']);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(cleanPlaceNames(Array.from({ length: 200 }, (_, i) => `Place ${i}`))).toHaveLength(150);
  });
});

describe('placesInTranscript', () => {
  it('drops names the show never mentions, like the prompt\'s own examples', () => {
    const text = 'We walked through Dolores this morning, then up 17th and Valencia to the Mission.';
    expect(placesInTranscript(['Dolores Park', 'Ocean Beach', '17th Street & Valencia Street', 'Mission District', 'Coit Tower'], text))
      .toEqual(['Dolores Park', '17th Street & Valencia Street', 'Mission District']);
  });

  it('keeps an intersection only when both streets are mentioned', () => {
    expect(placesInTranscript(['24th & Mission'], 'Tacos in the Mission.')).toEqual([]);
    expect(placesInTranscript(['24th Street & Mission Street'], 'Meet me at 24th and Mission.')).toEqual(['24th Street & Mission Street']);
  });
});

describe('extractAndSeedPlaces', () => {
  const EP = 'roll-over-easy_2026-10-01_07-30-00';
  let db;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    db = makeD1();
    db.sqlite.prepare('INSERT INTO episodes (id, title) VALUES (?, ?)').run(EP, 'Test');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const gpt = (content, finish_reason = 'stop') => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content }, finish_reason }] }),
  });
  const linked = () => db.rows('SELECT p.name FROM place_mentions pm JOIN places p ON p.id = pm.place_id ORDER BY p.name').map(r => r.name);

  it('skips all work when openaiApiKey is falsy', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    await extractAndSeedPlaces(db, EP, [], null);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('writes nothing when OpenAI returns an empty list', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(gpt('[]'));
    await extractAndSeedPlaces(db, EP, [{ text: 'no places here' }], 'sk-test');
    expect(db.rows('SELECT * FROM places')).toEqual([]);
  });

  it('asks for up to 4,000 tokens, with a time limit', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(gpt('[]'));
    await extractAndSeedPlaces(db, EP, [{ text: 'hi' }], 'sk-test');
    const [, init] = fetchSpy.mock.calls[0];
    expect(JSON.parse(init.body).max_tokens).toBe(4000);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('geocodes a new place and links it to the episode', async () => {
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(gpt('["Dolores Park"]'))
      .mockResolvedValueOnce({ ok: true, json: async () => [{ lat: '37.7596', lon: '-122.4269' }] });

    const p = extractAndSeedPlaces(db, EP, [{ text: 'We went to Dolores Park' }], 'sk-test');
    await vi.runAllTimersAsync();
    await p;

    expect(db.rows('SELECT name, lat, lng FROM places')).toEqual([{ name: 'Dolores Park', lat: 37.7596, lng: -122.4269 }]);
    expect(linked()).toEqual(['Dolores Park']);
  });

  it('skips places that fail all geocoding strategies', async () => {
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(gpt('["Fake Nonexistent Place"]'))
      .mockResolvedValue({ ok: true, json: async () => [] });

    const p = extractAndSeedPlaces(db, EP, [{ text: 'We love the Fake Nonexistent Place' }], 'sk-test');
    await vi.runAllTimersAsync();
    await p;

    expect(db.rows('SELECT * FROM places')).toEqual([]);
  });

  it('skips geocoding for already-known places', async () => {
    db.sqlite.prepare('INSERT INTO places (name, lat, lng) VALUES (?, ?, ?)').run('Golden Gate Park', 37.77, -122.48);
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(gpt('["Golden Gate Park"]'));

    const p = extractAndSeedPlaces(db, EP, [{ text: 'Golden Gate Park today' }], 'sk-test');
    await vi.runAllTimersAsync();
    await p;

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0]).toContain('openai.com');
    expect(linked()).toEqual(['Golden Gate Park']);
  });

  it('never links a place the transcript does not mention', async () => {
    db.sqlite.prepare('INSERT INTO places (name, lat, lng) VALUES (?, ?, ?)').run('Ocean Beach', 37.76, -122.51);
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(gpt('["Ocean Beach"]'));
    await extractAndSeedPlaces(db, EP, [{ text: 'A quiet morning at the Ferry Building.' }], 'sk-test');
    expect(linked()).toEqual([]);
  });

  it('replaces an earlier run\'s links instead of adding to them', async () => {
    const add = db.sqlite.prepare('INSERT INTO places (name, lat, lng) VALUES (?, 37.7, -122.4)');
    add.run('Old Spot');
    add.run('Ferry Building');
    db.sqlite.prepare('INSERT INTO place_mentions (place_id, episode_id) VALUES (1, ?)').run(EP);
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(gpt('["Ferry Building"]'));

    await extractAndSeedPlaces(db, EP, [{ text: 'At the Ferry Building' }], 'sk-test');
    expect(linked()).toEqual(['Ferry Building']);
  });

  it('handles 150 names without going over D1\'s parameter limit', async () => {
    const names = Array.from({ length: 150 }, (_, i) => `Place ${i}`);
    const add = db.sqlite.prepare('INSERT INTO places (name, lat, lng) VALUES (?, 37.7, -122.4)');
    for (const n of names) add.run(n);
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(gpt(JSON.stringify(names)));

    await extractAndSeedPlaces(db, EP, [{ text: names.join(', ') }], 'sk-test');   // the fake D1 throws past 100 parameters
    expect(linked()).toHaveLength(150);
  });

  it('treats a cut-off reply as an error and writes nothing', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(gpt('["Dolores Park", "Ferr', 'length'));
    await expect(extractAndSeedPlaces(db, EP, [{ text: 'x' }], 'sk-test')).rejects.toMatchObject({ permanent: true, message: expect.stringContaining('cut off') });
    expect(db.rows('SELECT * FROM place_mentions')).toEqual([]);
  });

  it('treats an unreadable reply as an error', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(gpt('Here are the places: Dolores Park'));
    await expect(extractAndSeedPlaces(db, EP, [{ text: 'x' }], 'sk-test')).rejects.toMatchObject({ permanent: true });
  });

  it('stops geocoding when out of time, still links known places, and says so', async () => {
    db.sqlite.prepare('INSERT INTO places (name, lat, lng) VALUES (?, ?, ?)').run('Golden Gate Park', 37.77, -122.48);
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(gpt('["Golden Gate Park", "Brand New Cafe"]'));
    const warn = vi.fn();

    await extractAndSeedPlaces(db, EP, [{ text: 'Golden Gate Park, then the Brand New Cafe' }], 'sk-test', { deadline: Date.now() - 1, warn });
    expect(global.fetch).toHaveBeenCalledTimes(1);   // no geocoding requests
    expect(linked()).toEqual(['Golden Gate Park']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('1 new place name'));
  });
});
