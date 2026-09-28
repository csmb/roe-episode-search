import { describe, it, expect } from 'vitest';
import { checkCoverage } from '../src/coverage.js';

// A line every 10 seconds from `fromMin` to `toMin`
const talk = (fromMin, toMin) => Array.from({ length: Math.round((toMin - fromMin) * 6) }, (_, i) => ({
  start_ms: fromMin * 60_000 + i * 10_000, end_ms: fromMin * 60_000 + i * 10_000 + 9_000, text: `Line ${i}.`,
}));
const HOUR2 = 120 * 60_000;

describe('checkCoverage', () => {
  it('accepts a whole show, and reports a long song as a hole without refusing it', () => {
    expect(checkCoverage(talk(0, 119.5), HOUR2)).toMatchObject({ ok: true, problems: [], holes: [] });
    const withSong = [...talk(0, 50), ...talk(58, 119.5)];
    expect(checkCoverage(withSong, HOUR2)).toMatchObject({ ok: true, holes: [{ startMs: 50 * 60_000 - 1_000, endMs: 58 * 60_000 }] });
  });

  it('refuses a transcript that stops early, like 7/16/2020 at 45 minutes', () => {
    const r = checkCoverage(talk(0, 45), HOUR2);
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/stops at 45\.0 min of the 120\.0 min recording \(37%\)/);
    expect(r.holes).toEqual([{ startMs: 45 * 60_000 - 1_000, endMs: HOUR2 }]);
  });

  it('refuses times past the end of the audio (the old ×10 bug), and an empty or unmeasured one', () => {
    const tenTimes = talk(0, 119).map(s => ({ ...s, start_ms: s.start_ms * 10, end_ms: s.end_ms * 10 }));
    expect(checkCoverage(tenTimes, HOUR2).problems[0]).toMatch(/after the 120\.0 min recording: the times are wrong/);
    expect(checkCoverage([], HOUR2).problems).toEqual(['it has no lines']);
    expect(checkCoverage(talk(0, 10), 0).problems).toEqual(["the recording's length is unknown"]);
  });

  it('allows the last line to run a little past the audio', () => {
    expect(checkCoverage(talk(0, 120.3), HOUR2).ok).toBe(true);
  });
});
