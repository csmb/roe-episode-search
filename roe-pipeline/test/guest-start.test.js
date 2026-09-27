import { describe, it, expect, vi, afterEach } from 'vitest';
import * as scriptsMod from '../../scripts/guest-start.js';
import * as workerMod from '../src/guest-start.js';
import { makeD1 } from './helpers/fakes.js';

// Two self-contained copies (local pipeline vs. Cloudflare Worker). Run the
// identical suite against each so they can't silently drift.
const IMPLS = [
  ['scripts/guest-start.js', scriptsMod],
  ['roe-pipeline/src/guest-start.js', workerMod],
];

const BASE = 3_000_000; // 50 minutes — earliest a guest interview is considered
const seg = (start_ms, end_ms, text) => ({ start_ms, end_ms, text });

for (const [label, { detectGuestStart, FALLBACK_MS }] of IMPLS) {
  describe(`detectGuestStart — ${label}`, () => {
    it('returns null when there are no guests', () => {
      expect(detectGuestStart([seg(BASE, BASE + 5000, 'welcome back jane')], [])).toBe(null);
    });

    it('returns null when nothing happens after 50 minutes', () => {
      expect(detectGuestStart([seg(0, 1000, 'here is jane early on')], ['Jane'])).toBe(null);
    });

    it('after a song break, returns the first guest mention (Strategy 1)', () => {
      const segments = [
        seg(BASE, BASE + 10_000, 'welcome back everyone'),
        seg(BASE + 10_000, BASE + 200_000, '[music]'), // 190s song → break
        seg(BASE + 200_000, BASE + 210_000, 'please welcome Jane to the show'),
      ];
      expect(detectGuestStart(segments, ['Jane'])).toBe(BASE + 200_000);
    });

    it('matches guest names case-insensitively', () => {
      const segments = [
        seg(BASE, BASE + 10_000, 'welcome back'),
        seg(BASE + 10_000, BASE + 200_000, '[music]'),
        seg(BASE + 200_000, BASE + 210_000, 'say hi to JANE everybody'),
      ];
      expect(detectGuestStart(segments, ['Jane'])).toBe(BASE + 200_000);
    });

    it('with no song break, falls back to first guest mention after 50min (Fallback A)', () => {
      const segments = [
        seg(BASE, BASE + 5_000, 'chatter chatter'),
        seg(BASE + 5_000, BASE + 10_000, "here's Jane now"),
      ];
      expect(detectGuestStart(segments, ['Jane'])).toBe(BASE + 5_000);
    });

    it('after a song break with no guest mention, returns first post-break segment (Fallback B)', () => {
      const segments = [
        seg(BASE, BASE + 10_000, 'welcome back'),
        seg(BASE + 10_000, BASE + 200_000, '[music]'),
        seg(BASE + 200_000, BASE + 210_000, 'some chatter'),
        seg(BASE + 210_000, BASE + 220_000, 'more chatter'),
      ];
      expect(detectGuestStart(segments, ['Zelda'])).toBe(BASE + 200_000);
    });

    it('with no break and no mention, falls back to 1 hour (Fallback C)', () => {
      const segments = [
        seg(BASE, BASE + 5_000, 'a'),
        seg(BASE + 5_000, BASE + 10_000, 'b'),
      ];
      expect(detectGuestStart(segments, ['Nobody'])).toBe(FALLBACK_MS);
    });
  });
}

describe('seedGuestStart', () => {
  const EP = 'roll-over-easy_2026-10-01_07-30-00';
  // A song break at 55 minutes, then the guest is introduced
  const segments = [
    seg(BASE, BASE + 10_000, 'welcome back'),
    seg(BASE + 10_000, BASE + 200_000, '[music]'),
    seg(BASE + 200_000, BASE + 210_000, 'please welcome Heather Knight'),
  ];
  const setup = (row = {}) => {
    const db = makeD1();
    db.sqlite.prepare('INSERT INTO episodes (id, title, guest_start_ms, guests_reviewed) VALUES (?, ?, ?, ?)')
      .run(EP, 'Stairway Streets!', row.guest_start_ms ?? null, row.guests_reviewed ?? 0);
    db.sqlite.prepare('INSERT INTO episode_guests (episode_id, guest_name) VALUES (?, ?)').run(EP, 'Heather Knight');
    return db;
  };
  const startMs = db => db.rows('SELECT guest_start_ms FROM episodes')[0].guest_start_ms;
  afterEach(() => vi.restoreAllMocks());

  it('fills an empty interview time', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const db = setup();
    expect(await workerMod.seedGuestStart(db, EP, segments, 7_200_000)).toBe(BASE + 200_000);
    expect(startMs(db)).toBe(BASE + 200_000);
  });

  it('keeps a time set by hand, and leaves a reviewed episode alone', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const handSet = setup({ guest_start_ms: 4_637_000 });
    expect(await workerMod.seedGuestStart(handSet, EP, segments, 7_200_000)).toBe(null);
    expect(startMs(handSet)).toBe(4_637_000);

    const reviewed = setup({ guests_reviewed: 1 });
    expect(await workerMod.seedGuestStart(reviewed, EP, segments, 7_200_000)).toBe(null);
    expect(startMs(reviewed)).toBe(null);
  });
});
