import { describe, it, expect, vi, afterEach } from 'vitest';
import { transcribeChunk } from '../src/transcribe.js';

afterEach(() => { vi.unstubAllGlobals(); });

function stubWhisper(segments, duration = 600) {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    calls.push({ url, body: new TextDecoder().decode(init.body) });
    return new Response(JSON.stringify({ duration, segments }), { status: 200 });
  }));
  return calls;
}

describe('transcribeChunk', () => {
  it('tells Whisper the audio is English and sends the spelling hints', async () => {
    const calls = stubWhisper([]);
    await transcribeChunk(new Uint8Array([1, 2, 3]), 'sk-test', 0);
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toContain('name="language"\r\n\r\nen\r\n');
    expect(calls[0].body).toContain('name="prompt"\r\n\r\n');
    expect(calls[0].body).toContain('Roll Over Easy.');
  });

  it('offsets times and drops wrong-language and prompt-echo lines', async () => {
    stubWhisper([
      { start: 0, end: 4, text: ' Good morning, San Francisco!' },
      { start: 4, end: 8, text: 'ශ්‍රී ලංකාවේ අද උදෑසන' },
      { start: 8, end: 12, text: 'Tartine, Humphry Slocombe, Bi-Rite, Hamburger Haven, the Ferry Building,' },
      { start: 12, end: 15, text: 'We love Tartine and Bi-Rite.' },
    ]);
    const { segments, duration } = await transcribeChunk(new Uint8Array([1]), 'sk-test', 900);
    expect(duration).toBe(600);
    expect(segments).toEqual([
      { start_ms: 900000, end_ms: 904000, text: 'Good morning, San Francisco!' },
      { start_ms: 912000, end_ms: 915000, text: 'We love Tartine and Bi-Rite.' },
    ]);
  });
});
