import { describe, it, expect } from 'vitest';
import { parseEpisodeId } from '../src/parse-episode-id.js';

describe('parseEpisodeId', () => {
  it('parses canonical format', () => {
    expect(parseEpisodeId('roll-over-easy_2026-03-27_07-30-00.mp3'))
      .toBe('roll-over-easy_2026-03-27_07-30-00');
  });

  it('parses canonical format with copy suffix', () => {
    expect(parseEpisodeId('roll-over-easy_2026-03-27_07-30-00 copy.mp3'))
      .toBe('roll-over-easy_2026-03-27_07-30-00');
  });

  it('parses "Roll Over Easy YYYY-MM-DD" format', () => {
    expect(parseEpisodeId('Roll Over Easy 2026-03-27.mp3'))
      .toBe('roll-over-easy_2026-03-27_07-30-00');
  });

  it('parses dash-separated format', () => {
    expect(parseEpisodeId('Roll Over Easy - 2026-03-27.mp3'))
      .toBe('roll-over-easy_2026-03-27_07-30-00');
  });

  it('parses YYYYMMDD format', () => {
    expect(parseEpisodeId('Roll Over Easy 20260327.mp3'))
      .toBe('roll-over-easy_2026-03-27_07-30-00');
  });

  it('parses App Recording format', () => {
    expect(parseEpisodeId('App Recording 20260327 0730.mp3'))
      .toBe('roll-over-easy_2026-03-27_07-30-00');
  });

  it('parses underscore-dash format', () => {
    expect(parseEpisodeId('Roll_Over_Easy_-_2026-03-27.mp3'))
      .toBe('roll-over-easy_2026-03-27_07-30-00');
  });

  it('strips directory path from key', () => {
    expect(parseEpisodeId('uploads/Roll Over Easy 2026-03-27.mp3'))
      .toBe('roll-over-easy_2026-03-27_07-30-00');
  });

  it('returns null for unrecognized filenames', () => {
    expect(parseEpisodeId('random-file.mp3')).toBeNull();
  });

  it('ignores non-mp3 files', () => {
    expect(parseEpisodeId('Roll Over Easy 2026-03-27.jpg')).toBeNull();
  });
});
