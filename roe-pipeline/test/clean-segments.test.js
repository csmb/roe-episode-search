import { describe, it, expect } from 'vitest';
import { cleanSegments } from '../src/clean-segments.js';

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
