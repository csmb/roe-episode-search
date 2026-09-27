import { describe, it, expect } from 'vitest';
import { cleanSegments, isMostlyNonLatin, isPromptEcho } from '../src/clean-segments.js';

describe('cleanSegments', () => {
  it('removes zero-duration segments', () => {
    const segments = [
      { start_ms: 0, end_ms: 5000, text: 'Hello' },
      { start_ms: 5000, end_ms: 5000, text: 'Ghost' },
      { start_ms: 5000, end_ms: 10000, text: 'World' },
    ];
    const result = cleanSegments(segments);
    expect(result).toHaveLength(2);
    expect(result.map(s => s.text)).toEqual(['Hello', 'World']);
  });

  it('removes consecutive duplicates', () => {
    const segments = [
      { start_ms: 0, end_ms: 5000, text: 'Hello' },
      { start_ms: 5000, end_ms: 10000, text: 'Hello' },
      { start_ms: 10000, end_ms: 15000, text: 'World' },
    ];
    const result = cleanSegments(segments);
    expect(result).toHaveLength(2);
    expect(result.map(s => s.text)).toEqual(['Hello', 'World']);
  });

  it('removes segments with internal phrase looping', () => {
    // "I think that" repeated 4+ times
    const looped = Array(5).fill('I think that').join(' ');
    const segments = [
      { start_ms: 0, end_ms: 5000, text: 'Normal text here' },
      { start_ms: 5000, end_ms: 10000, text: looped },
      { start_ms: 10000, end_ms: 15000, text: 'More normal text' },
    ];
    const result = cleanSegments(segments);
    expect(result).toHaveLength(2);
    expect(result.map(s => s.text)).toEqual(['Normal text here', 'More normal text']);
  });

  it('removes hallucinated short phrases exceeding threshold', () => {
    // Create 100 segments, 15 of which are "coffee."
    const segments = [];
    for (let i = 0; i < 85; i++) {
      segments.push({ start_ms: i * 1000, end_ms: (i + 1) * 1000, text: `Segment ${i}` });
    }
    for (let i = 85; i < 100; i++) {
      segments.push({ start_ms: i * 1000, end_ms: (i + 1) * 1000, text: 'coffee.' });
    }
    const result = cleanSegments(segments);
    expect(result.every(s => s.text !== 'coffee.')).toBe(true);
  });

  it('preserves non-consecutive duplicates below threshold', () => {
    const segments = [
      { start_ms: 0, end_ms: 5000, text: 'Hello' },
      { start_ms: 5000, end_ms: 10000, text: 'World' },
      { start_ms: 10000, end_ms: 15000, text: 'Hello' },
    ];
    const result = cleanSegments(segments);
    expect(result).toHaveLength(3);
  });

  it('returns empty array for empty input', () => {
    expect(cleanSegments([])).toEqual([]);
  });
});

describe('isMostlyNonLatin', () => {
  it('flags text in another script', () => {
    expect(isMostlyNonLatin('ශ්‍රී ලංකාවේ අද උදෑසන')).toBe(true);
    expect(isMostlyNonLatin('早上好，旧金山')).toBe(true);
  });

  it('keeps English, accented Latin and short or letterless lines', () => {
    expect(isMostlyNonLatin('Good morning, San Francisco!')).toBe(false);
    expect(isMostlyNonLatin('Café au lait at the Ferry Building')).toBe(false);
    expect(isMostlyNonLatin('ok')).toBe(false);
    expect(isMostlyNonLatin('♪ ♪')).toBe(false);
  });
});

describe('isPromptEcho', () => {
  it('flags a line that is mostly the spelling-hint list', () => {
    expect(isPromptEcho('Tartine, Humphry Slocombe, Bi-Rite, Hamburger Haven, the Ferry Building,')).toBe(true);
  });

  it('keeps ordinary speech that names a few of the same places', () => {
    expect(isPromptEcho('We walked past Tartine and Bi-Rite on the way to Dolores Park.')).toBe(false);
    expect(isPromptEcho('Coffee, eggs, toast, and a little jam.')).toBe(false);
  });
});

describe('cleanSegments wrong-language and prompt-echo lines', () => {
  it('drops them and keeps the rest', () => {
    const result = cleanSegments([
      { start_ms: 0, end_ms: 4000, text: 'Good morning, San Francisco!' },
      { start_ms: 4000, end_ms: 8000, text: 'ශ්‍රී ලංකාවේ අද උදෑසන' },
      { start_ms: 8000, end_ms: 12000, text: 'Muni, BART, Caltrain, the N-Judah, SoMa, the Tenderloin,' },
      { start_ms: 12000, end_ms: 16000, text: 'Café au lait at the Ferry Building.' },
    ]);
    expect(result.map(s => s.text)).toEqual(['Good morning, San Francisco!', 'Café au lait at the Ferry Building.']);
  });
});
