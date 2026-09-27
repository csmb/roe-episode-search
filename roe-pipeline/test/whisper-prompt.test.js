import { describe, it, expect } from 'vitest';
import { SF_VOCAB_PROMPT, PROMPT_TERMS, normalizeTerm } from '../src/whisper-prompt.js';

describe('SF_VOCAB_PROMPT', () => {
  // Whisper only reads the last ~224 tokens of a prompt. The current list is
  // 503 characters = 177 Whisper tokens; 560 characters keeps it near 200.
  it('stays short enough for Whisper to read all of it', () => {
    expect(SF_VOCAB_PROMPT.length).toBeLessThanOrEqual(560);
  });

  it('ends with the names that matter most', () => {
    expect(SF_VOCAB_PROMPT.endsWith('Sequoia, The Early Bird, Suldrew, BFF.fm, Roll Over Easy.')).toBe(true);
  });
});

describe('PROMPT_TERMS', () => {
  it('holds each list item normalized', () => {
    expect(PROMPT_TERMS.has('roll over easy')).toBe(true);
    expect(PROMPT_TERMS.has('tenderloin')).toBe(true); // "the Tenderloin"
    expect(PROMPT_TERMS.has('early bird')).toBe(true); // "The Early Bird"
  });

  it('normalizes like the echo filter does', () => {
    expect(normalizeTerm('  The Ferry Building. ')).toBe('ferry building');
  });
});
