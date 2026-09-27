import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { seedEpisode, seedStatements } from '../src/seed-db.js';
import { makeD1 } from './helpers/fakes.js';

const EP = 'roll-over-easy_2026-10-01_07-30-00';
const lines = n => Array.from({ length: n }, (_, i) => ({ start_ms: i * 3000, end_ms: i * 3000 + 2500, text: `Line number ${i} of the show.` }));
const episode = (over = {}) => ({
  episodeId: EP, title: 'Stairway Streets!', summary: 'Foggy on the stairs.', guests: ['Heather Knight'],
  audioUrl: 'https://audio.example/Roll%20Over%20Easy%202026-10-01.mp3', durationMs: 7_200_000, segments: lines(100),
  ...over,
});

let db;
beforeEach(() => {
  db = makeD1();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

const count = table => db.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0].n;

describe('seedEpisode', () => {
  it('writes the row, every line and the guests in one batch', async () => {
    await seedEpisode(db, episode());
    expect(db.batches).toHaveLength(1);
    expect(db.rows('SELECT id, title, summary, audio_file, duration_ms, published_at FROM episodes')).toEqual([{
      id: EP, title: 'Stairway Streets!', summary: 'Foggy on the stairs.',
      audio_file: 'https://audio.example/Roll%20Over%20Easy%202026-10-01.mp3', duration_ms: 7_200_000, published_at: '2026-10-01',
    }]);
    expect(count('transcript_segments')).toBe(100);
    expect(count('transcript_fts')).toBe(100);
    expect(db.rows('SELECT guest_name FROM episode_guests')).toEqual([{ guest_name: 'Heather Knight' }]);
  });

  it('can run twice without doubling anything', async () => {
    await seedEpisode(db, episode());
    await seedEpisode(db, episode());
    expect(count('episodes')).toBe(1);
    expect(count('transcript_segments')).toBe(100);
    expect(count('transcript_fts')).toBe(100);
    expect(count('episode_guests')).toBe(1);
  });

  it('cleans up a half-written row from an earlier run, keeping its interview time', async () => {
    db.sqlite.prepare('INSERT INTO episodes (id, title, duration_ms, guest_start_ms) VALUES (?, ?, ?, ?)').run(EP, EP, 1000, 5_400_000);
    const add = db.sqlite.prepare('INSERT INTO transcript_segments (episode_id, start_ms, end_ms, text) VALUES (?, ?, ?, ?)');
    for (let i = 0; i < 37; i++) add.run(EP, i, i + 1, `old ${i}`);

    await seedEpisode(db, episode());
    expect(db.rows('SELECT title, audio_file, guest_start_ms FROM episodes')).toEqual([{
      title: 'Stairway Streets!', audio_file: 'https://audio.example/Roll%20Over%20Easy%202026-10-01.mp3', guest_start_ms: 5_400_000,
    }]);
    expect(count('transcript_segments')).toBe(100);
    expect(db.rows("SELECT COUNT(*) AS n FROM transcript_fts WHERE transcript_fts MATCH 'old'")[0].n).toBe(0);
  });

  it('keeps an .m4a link already on the row, and reviewed guests', async () => {
    db.sqlite.prepare('INSERT INTO episodes (id, title, audio_file, guests_reviewed) VALUES (?, ?, ?, 1)').run(EP, 'Old', 'https://audio.example/x.m4a');
    db.sqlite.prepare('INSERT INTO episode_guests (episode_id, guest_name) VALUES (?, ?)').run(EP, 'Curated Name');

    await seedEpisode(db, episode());
    expect(db.rows('SELECT audio_file, guests_reviewed FROM episodes')).toEqual([{ audio_file: 'https://audio.example/x.m4a', guests_reviewed: 1 }]);
    expect(db.rows('SELECT guest_name FROM episode_guests')).toEqual([{ guest_name: 'Curated Name' }]);
  });

  it('keeps the title and summary of a reviewed episode, or one written by hand', async () => {
    db.sqlite.prepare('INSERT INTO episodes (id, title, summary, guests_reviewed) VALUES (?, ?, ?, 1)').run(EP, 'Edited Title', 'Edited summary.');
    await seedEpisode(db, episode());
    expect(db.rows('SELECT title, summary, duration_ms FROM episodes')).toEqual([{ title: 'Edited Title', summary: 'Edited summary.', duration_ms: 7_200_000 }]);
    expect(count('transcript_segments')).toBe(100);

    db.sqlite.exec('DELETE FROM transcript_segments; DELETE FROM episodes;');
    db.sqlite.prepare('INSERT INTO episodes (id, title, summary) VALUES (?, ?, ?)').run(EP, 'Guac-Off Week (Recording Lost)', 'Only the opening song survived.');
    await seedEpisode(db, episode());
    expect(db.rows('SELECT title, summary FROM episodes')).toEqual([{ title: 'Guac-Off Week (Recording Lost)', summary: 'Only the opening song survived.' }]);
  });

  it('changes nothing when any statement in the batch fails', async () => {
    await seedEpisode(db, episode({ segments: lines(40) }));
    const before = db.rows('SELECT * FROM transcript_segments');

    db.failBatchAt = 3;
    await expect(seedEpisode(db, episode({ title: 'New title', segments: lines(100) }))).rejects.toThrow('injected');
    expect(db.rows('SELECT title FROM episodes')).toEqual([{ title: 'Stairway Streets!' }]);
    expect(db.rows('SELECT * FROM transcript_segments')).toEqual(before);
  });

  it('fits the longest show in the archive inside D1\'s limits', () => {
    // 5,913 lines, the most any episode has; the fake D1 also rejects >100 parameters
    const stmts = seedStatements(db, episode({ segments: lines(5913), guests: ['A', 'B', 'C'] }));
    expect(stmts.length).toBeLessThan(1000);
    expect(Math.max(...stmts.map(s => s.args.length))).toBeLessThanOrEqual(100);
  });

  it('stores a thin episode with its neutral title and no summary', async () => {
    await seedEpisode(db, episode({ title: 'Roll Over Easy · October 1, 2026', summary: null, guests: [] }));
    expect(db.rows('SELECT title, summary FROM episodes')).toEqual([{ title: 'Roll Over Easy · October 1, 2026', summary: null }]);
  });
});
