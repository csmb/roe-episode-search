import { describe, it, expect } from 'vitest';
import { HOST_NAMES, isHost } from '../src/hosts.js';

describe('isHost', () => {
  it('knows every host name, whatever the case or spacing', () => {
    for (const name of HOST_NAMES) expect(isHost(name)).toBe(true);
    expect(isHost('  the early   bird ')).toBe(true);
    expect(isHost('PAPA SEQUOIA')).toBe(true);
  });

  it('does not treat guests as hosts', () => {
    expect(isHost('Claire')).toBe(false);
    expect(isHost('Sequoia Park')).toBe(false);
    expect(isHost('')).toBe(false);
    expect(isHost(null)).toBe(false);
  });
});
