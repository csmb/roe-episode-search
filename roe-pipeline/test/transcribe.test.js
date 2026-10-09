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

  it('drops a looping lyric and segments Whisper itself flags as looping', async () => {
    stubWhisper([
      { start: 0, end: 4, text: 'Good morning!' },
      { start: 4, end: 8, text: "It's perfect for me." },
      { start: 8, end: 12, text: 'Sitting on the dock of the bay.' },
      { start: 12, end: 16, text: "It's perfect for me." },
      { start: 16, end: 20, text: "It's perfect for me." },
      { start: 20, end: 24, text: 'the the the the the the the the', compression_ratio: 3.1 },
      { start: 24, end: 28, text: 'Back to the show.' },
    ]);
    const { segments } = await transcribeChunk(new Uint8Array([1]), 'sk-test', 0);
    expect(segments.map(s => s.text)).toEqual(['Good morning!', "It's perfect for me.", 'Sitting on the dock of the bay.', 'Back to the show.']);
  });

  it("drops what Whisper invents over silence or music: its own no-speech sign, and a bare https:// address (2026-10-01's 72:00)", async () => {
    stubWhisper([
      { start: 0, end: 4, text: 'Good morning!', no_speech_prob: 0.01, avg_logprob: -0.2 },
      { start: 4, end: 34, text: 'https://www.youtube.com.com', no_speech_prob: 0.2, avg_logprob: -0.5 },
      { start: 34, end: 44, text: 'Thank you for watching.', no_speech_prob: 0.82, avg_logprob: -1.3 },
      { start: 44, end: 48, text: 'Hmm, quiet in here.', no_speech_prob: 0.7, avg_logprob: -0.4 }, // sure of its words: kept
      { start: 48, end: 52, text: 'Go to Yelp.com.', no_speech_prob: 0.1, avg_logprob: -0.3 },
      { start: 52, end: 56, text: "It's www.rollovereasy.org.", no_speech_prob: 0.1, avg_logprob: -0.3 },
    ]);
    const { segments } = await transcribeChunk(new Uint8Array([1]), 'sk-test', 0);
    expect(segments.map(s => s.text)).toEqual(['Good morning!', 'Hmm, quiet in here.', 'Go to Yelp.com.', "It's www.rollovereasy.org."]);
  });

  it('puts a time limit on every request: 5 minutes for a chunk, 90 s for a retry clip', async () => {
    stubWhisper([]);
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    await transcribeChunk(new Uint8Array([1]), 'sk-test', 0);
    await transcribeChunk(new Uint8Array([1]), 'sk-test', 0, { timeoutMs: 90_000 });
    expect(timeout.mock.calls).toEqual([[300_000], [90_000]]);
  });

  it('marks a rejected file as permanent and a server error as worth retrying', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Invalid file format', { status: 400 })));
    await expect(transcribeChunk(new Uint8Array([1]), 'sk-test', 0)).rejects.toMatchObject({ permanent: true, status: 400 });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('busy', { status: 502 })));
    await expect(transcribeChunk(new Uint8Array([1]), 'sk-test', 0)).rejects.toMatchObject({ status: 502 });
  });
});

