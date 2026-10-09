import { describe, it, expect, vi, afterEach } from 'vitest';
import { apiError, isPermanent, withTimeout, PermanentError } from '../src/limits.js';
import { pageEntries, readPages } from '../src/stored-lists.js';
import { FakeStorage } from './helpers/fakes.js';

afterEach(() => { vi.useRealTimers(); });

describe('apiError', () => {
  it('is permanent for answers that mean the request itself is wrong', () => {
    for (const status of [400, 401, 403, 404, 413, 422]) expect(isPermanent(apiError('X', status, ''))).toBe(true);
    for (const status of [408, 429, 500, 502, 503]) expect(isPermanent(apiError('X', status, ''))).toBe(false);
    expect(apiError('Whisper API', 500, 'busy').message).toBe('Whisper API error 500: busy');
  });
  it('drops what OpenAI echoes of a rejected key, as the message reaches the upload log and notices', () => {
    const body = '{"error":{"message":"Incorrect API key provided: sk-proj-AbC1****************************wxyz. You can find your API key at …"}}';
    const message = apiError('OpenAI API', 401, body).message;
    expect(message).not.toMatch(/sk-proj|wxyz/);
    expect(message).toContain('Incorrect API key provided: sk-…');
    expect(isPermanent(new PermanentError('x'))).toBe(true);
    expect(isPermanent(new Error('x'))).toBe(false);
  });
});

describe('withTimeout', () => {
  it('rejects a call that never answers, and passes a quick one through', async () => {
    vi.useFakeTimers();
    const hung = withTimeout(new Promise(() => {}), 60_000, 'Workers AI');
    const check = expect(hung).rejects.toThrow('Workers AI timed out after 60 s');
    await vi.advanceTimersByTimeAsync(60_000);
    await check;
    await expect(withTimeout(Promise.resolve(7), 60_000, 'x')).resolves.toBe(7);
  });
});

describe('pageEntries / readPages', () => {
  it('splits a list by size and reads it back in order', async () => {
    const list = Array.from({ length: 50 }, (_, i) => ({ i, text: 'x'.repeat(100) }));
    const { entries, pages } = pageEntries('segments', list, 1000);
    expect(pages).toBeGreaterThan(5);
    for (const page of Object.values(entries)) expect(JSON.stringify(page).length).toBeLessThanOrEqual(1000);
    const storage = new FakeStorage();
    await storage.put(entries);
    expect(await readPages(storage, 'segments', pages)).toEqual(list);
  });

  it('stores nothing for an empty list', async () => {
    expect(pageEntries('x', [])).toEqual({ entries: {}, pages: 0 });
    expect(await readPages(new FakeStorage(), 'x', 0)).toEqual([]);
  });
});
