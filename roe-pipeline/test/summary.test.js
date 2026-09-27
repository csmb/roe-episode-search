import { describe, it, expect, vi, afterEach } from 'vitest';
import { isThinTranscript, neutralTitle, guestsInTranscript, generateSummary } from '../src/summary.js';

afterEach(() => { vi.unstubAllGlobals(); });

const segs = (n, stepMs = 3000) => Array.from({ length: n }, (_, i) => ({ start_ms: i * stepMs, end_ms: i * stepMs + stepMs, text: 'words' }));
const TWO_HOURS = 2 * 60 * 60 * 1000;

describe('isThinTranscript', () => {
  it('flags too few lines', () => {
    expect(isThinTranscript(segs(1), TWO_HOURS)).toBe(true); // like 1/1/2015
    expect(isThinTranscript(segs(199), TWO_HOURS)).toBe(true);
  });

  it('flags a transcript that stops early in the recording', () => {
    // 400 lines covering 20 minutes of a 2-hour show
    expect(isThinTranscript(segs(400, 3000), TWO_HOURS)).toBe(true);
  });

  it('passes a normal show', () => {
    expect(isThinTranscript(segs(2000, 3600), TWO_HOURS)).toBe(false);
  });

  it('only counts lines when the audio length is unknown', () => {
    expect(isThinTranscript(segs(400), undefined)).toBe(false);
  });
});

describe('neutralTitle', () => {
  it('uses the show date from the episode ID', () => {
    expect(neutralTitle('roll-over-easy_2026-10-01_07-30-00')).toBe('Roll Over Easy · October 1, 2026');
  });
});

describe('guestsInTranscript', () => {
  const text = 'Joining us today is Heather from the Chronicle. Later, Dr. Rick stopped by with Kat.';

  it('keeps names that appear in the transcript', () => {
    expect(guestsInTranscript(['Heather Knight', 'Dr. Rick', 'Kat Siegal'], text))
      .toEqual(['Heather Knight', 'Dr. Rick', 'Kat Siegal']);
  });

  it('drops names that never appear, and non-strings', () => {
    expect(guestsInTranscript(['Mia Chen', 'Kathleen Moore', 42], text)).toEqual([]);
  });

  it('matches whole words only', () => {
    // "Kat" appears, but "Katherine" should not be matched by "kat…" alone
    expect(guestsInTranscript(['Katherine Lee'], text)).toEqual([]);
  });

  it('allows small spelling differences in longer names', () => {
    expect(guestsInTranscript(['Marrianne Flores'], 'Say hi to Marianne, everybody.')).toEqual(['Marrianne Flores']);
    // but not against ordinary lowercase words ("more" is not "Moore")
    expect(guestsInTranscript(['Kathleen Moore'], 'We need more coffee.')).toEqual([]);
  });

  it('keeps names it cannot check and regulars from the spelling hints', () => {
    expect(guestsInTranscript(['DK', '2K', 'Suldrew'], 'No names here at all.')).toEqual(['DK', '2K', 'Suldrew']);
  });
});

describe('generateSummary on a thin transcript', () => {
  it('skips GPT and sets a neutral title', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const writes = [];
    const db = { prepare: sql => ({ bind: (...args) => ({ run: async () => { writes.push({ sql, args }); } }) }) };

    const out = await generateSummary(db, 'roll-over-easy_2015-01-01_07-30-00', segs(1), 'sk-test', TWO_HOURS);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out).toEqual({ title: 'Roll Over Easy · January 1, 2015', summary: null, guests: [], skipped: true });
    expect(writes).toEqual([{ sql: 'UPDATE episodes SET title = ? WHERE id = ?', args: ['Roll Over Easy · January 1, 2015', 'roll-over-easy_2015-01-01_07-30-00'] }]);
  });
});
