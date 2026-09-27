import { describe, it, expect, vi, afterEach } from 'vitest';
import { isThinTranscript, neutralTitle, guestsInTranscript, composeSummary } from '../src/summary.js';

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

describe('composeSummary', () => {
  const EP = 'roll-over-easy_2026-10-01_07-30-00';
  const show = segs(2000, 3600).map((s, i) => ({ ...s, text: i === 50 ? 'Say hi to Heather Knight and Sequoia.' : `Line ${i}.` }));
  const chat = (content, finish_reason = 'stop') => Response.json({ choices: [{ message: { content }, finish_reason }] });
  function stubOpenAI(reply) {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('sunrise-sunset')) return Response.json({ status: 'OK', results: { sunrise: '2026-10-01T14:07:00+00:00', sunset: '2026-10-02T01:52:00+00:00' } });
      return reply();
    }));
    return calls;
  }

  it('skips GPT for a thin transcript and gives it a neutral title', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await composeSummary('roll-over-easy_2015-01-01_07-30-00', segs(1), 'sk-test', TWO_HOURS);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out).toEqual({ title: 'Roll Over Easy · January 1, 2015', summary: null, guests: [], skipped: true });
  });

  it('returns the title, summary and the guests who are in the transcript, never the hosts', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls = stubOpenAI(() => chat(JSON.stringify({ title: 'Stairway Streets!', summary: 'Foggy.', guests: ['Heather Knight', 'Sequoia', 'The Early Bird', 'Mia Chen'] })));
    const out = await composeSummary(EP, show, 'sk-test', TWO_HOURS);
    expect(out).toEqual({ title: 'Stairway Streets!', summary: 'Foggy.', guests: ['Heather Knight'] });
    expect(calls.every(c => c.init?.signal instanceof AbortSignal)).toBe(true);
  });

  it('throws on a cut-off or unreadable reply instead of publishing it', async () => {
    stubOpenAI(() => chat('{"title": "Stairway', 'length'));
    await expect(composeSummary(EP, show, 'sk-test', TWO_HOURS)).rejects.toThrow('cut off');
    stubOpenAI(() => chat('Sure! Here is a summary of the show.'));
    await expect(composeSummary(EP, show, 'sk-test', TWO_HOURS)).rejects.toThrow('not readable');
  });

  it('marks a 4xx answer as permanent and a 5xx as worth retrying', async () => {
    stubOpenAI(() => new Response('bad key', { status: 401 }));
    await expect(composeSummary(EP, show, 'sk-test', TWO_HOURS)).rejects.toMatchObject({ permanent: true });
    stubOpenAI(() => new Response('overloaded', { status: 503 }));
    await expect(composeSummary(EP, show, 'sk-test', TWO_HOURS)).rejects.not.toHaveProperty('permanent');
  });
});
