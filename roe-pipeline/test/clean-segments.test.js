import { describe, it, expect } from 'vitest';
import { cleanSegments, dropRepeatedLines, findLoops, isMostlyNonLatin, isPromptEcho } from '../src/clean-segments.js';

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

describe('dropRepeatedLines', () => {
  const line = (i, text) => ({ start_ms: i * 1000, end_ms: i * 1000 + 900, text });

  it('drops every copy of a long line repeated more than 20 times', () => {
    const lyric = 'Sitting on the dock of the bay, watching';
    const segs = [line(0, 'Good morning, San Francisco!')];
    for (let i = 1; i <= 21; i++) segs.push(line(i * 2, lyric), line(i * 2 + 1, `Something new number ${i}`));
    const kept = dropRepeatedLines(segs);
    expect(kept.some(s => s.text === lyric)).toBe(false);
    expect(kept).toHaveLength(22);
  });

  it('keeps short lines and lines repeated 20 times or fewer, as the old D1 rule did', () => {
    const segs = [];
    for (let i = 0; i < 30; i++) segs.push(line(i * 2, 'Thank you so much.'));   // 18 characters
    for (let i = 0; i < 20; i++) segs.push(line(100 + i, 'We will be right back after this.'));
    expect(dropRepeatedLines(segs)).toHaveLength(50);
  });
});

describe('findLoops', () => {
  // Lines every `step` seconds from `startSec`, taking their text from `text(i)`
  const lines = (count, text, { startSec = 0, step = 3 } = {}) => Array.from({ length: count }, (_, i) => ({
    start_ms: (startSec + i * step) * 1000, end_ms: (startSec + i * step + step - 0.5) * 1000, text: text(i),
  }));
  const talk = (count, opts) => lines(count, i => `Talk line number ${i} about the fog.`, opts);

  it('drops a loop of two lines taking turns, keeping the first copy of each', () => {
    const loop = lines(300, i => (i % 2 ? 'Something to wear.' : "I'm going to take the sun from everything."), { startSec: 600 });
    const { segments, loops } = findLoops([...talk(200), ...loop, ...talk(50, { startSec: 1600 })]);
    expect(loops).toEqual([expect.objectContaining({ removed: 298, top: expect.any(String) })]);
    expect(loops[0].startMs).toBeLessThanOrEqual(600_000);
    expect(loops[0].endMs).toBeGreaterThanOrEqual(1_496_000);
    expect(segments.filter(s => s.text === 'Something to wear.')).toHaveLength(1);
    expect(segments).toHaveLength(252);
  });

  it('leaves natural talk alone: a "yeah" every half minute for two hours', () => {
    const show = lines(2400, i => (i % 10 === 0 ? 'Yeah.' : `Line ${i} of a real conversation.`));
    expect(findLoops(show).loops).toEqual([]);
  });

  it('leaves a short dense exchange or a chorus alone', () => {
    // As on 10/24/2019: 38 quick repeats (a loop needs 50)
    const game = lines(40, i => (i % 2 ? 'Yep.' : 'Nope.'), { startSec: 900, step: 2 });
    const chorus = lines(40, i => ['Clap your hands now.', 'Stomp your feet.', 'Here we go.', 'One more time.'][i % 4], { startSec: 1200 });
    const { segments, loops } = findLoops([...talk(200), ...game, ...chorus]);
    expect(loops).toEqual([]);
    expect(segments).toHaveLength(280);
  });

  it('does not join two dense passages across a silence into one loop', () => {
    const a = lines(34, i => (i % 2 ? 'Yep.' : 'Nope.'), { startSec: 600, step: 2 });
    const b = lines(34, i => (i % 2 ? 'Clap.' : 'Stomp.'), { startSec: 900, step: 2 });
    expect(findLoops([...talk(100), ...a, ...b]).loops).toEqual([]);
  });

  it('dates the loop from the first copy of the looping line', () => {
    const loop = lines(120, () => 'Good vibrations.', { startSec: 1440 });
    const { loops } = findLoops([...talk(480), ...loop]);
    expect(loops).toEqual([{ startMs: 1_440_000, endMs: 1_799_500, removed: 119, top: 'Good vibrations.' }]);
  });
});
