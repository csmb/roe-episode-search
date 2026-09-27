/**
 * Stand-ins for the Worker's bindings, strict where the real ones are strict:
 * - FakeStorage: Durable Object storage, with its 128 KiB-per-value and
 *   128-keys-per-call limits.
 * - makeD1: the real schema on node:sqlite, foreign keys on, FTS triggers,
 *   batch() as one transaction, D1's 100-parameter limit.
 * - makeR2: an R2 bucket holding synthetic MP3s.
 * - whisperAudio(): low-bitrate MP3 frames that carry their own frame number,
 *   so a fake Whisper can tell which stretch of the show it was sent.
 */

import v8 from 'node:v8';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// vitest's module loader doesn't know node:sqlite yet; require() does.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const SCHEMA = readFileSync(new URL('../../../schema.sql', import.meta.url), 'utf8');

const clone = value => v8.deserialize(v8.serialize(value));

export class FakeStorage {
  constructor() {
    this.data = new Map();
    this.alarm = null;
  }

  #check(key, value) {
    if (Buffer.byteLength(key) > 2048) throw new Error(`key over 2 KiB: ${key.slice(0, 40)}…`);
    if (value === undefined) throw new Error(`undefined value for ${key}`);
    const size = v8.serialize(value).length;
    if (size > 128 * 1024) throw new Error(`value for ${key} is ${size} bytes, over the 128 KiB limit`);
  }

  async get(keys) {
    if (Array.isArray(keys)) {
      if (keys.length > 128) throw new Error('get() of more than 128 keys');
      const out = new Map();
      for (const k of keys) if (this.data.has(k)) out.set(k, clone(this.data.get(k)));
      return out;
    }
    return this.data.has(keys) ? clone(this.data.get(keys)) : undefined;
  }

  async put(keyOrEntries, value) {
    const entries = typeof keyOrEntries === 'string' ? [[keyOrEntries, value]] : Object.entries(keyOrEntries);
    if (entries.length > 128) throw new Error('put() of more than 128 keys');
    for (const [k, v] of entries) this.#check(k, v);
    for (const [k, v] of entries) this.data.set(k, clone(v));
  }

  async delete(keys) {
    if (!Array.isArray(keys)) return this.data.delete(keys);
    if (keys.length > 128) throw new Error('delete() of more than 128 keys');
    let n = 0;
    for (const k of keys) if (this.data.delete(k)) n++;
    return n;
  }

  async deleteAll() { this.data.clear(); }

  async list({ prefix = '' } = {}) {
    const out = new Map();
    for (const k of [...this.data.keys()].sort()) if (k.startsWith(prefix)) out.set(k, clone(this.data.get(k)));
    return out;
  }

  async setAlarm(t) { this.alarm = typeof t === 'number' ? t : t.getTime(); }
  async getAlarm() { return this.alarm; }
  async deleteAlarm() { this.alarm = null; }
}

/** D1 on an in-memory SQLite database with the project's schema.sql. */
export function makeD1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(SCHEMA);
  const d1 = {
    sqlite,
    statements: 0,
    batches: [],
    failBatchAt: null, // index of a batch statement to fail, to test rollback

    prepare(sql) {
      const make = args => ({
        sql, args,
        bind: (...a) => make(a),
        run: async () => d1.exec(sql, args),
        all: async () => ({ results: d1.query(sql, args), success: true }),
        first: async col => {
          const row = d1.query(sql, args)[0];
          if (!row) return null;
          return col ? row[col] : row;
        },
      });
      return make([]);
    },

    async batch(stmts) {
      d1.batches.push(stmts.length);
      sqlite.exec('BEGIN');
      try {
        const out = stmts.map((s, i) => {
          if (d1.failBatchAt === i) throw new Error(`injected failure at statement ${i}`);
          return d1.exec(s.sql, s.args);
        });
        sqlite.exec('COMMIT');
        return out;
      } catch (err) {
        sqlite.exec('ROLLBACK');
        throw err;
      }
    },

    check(sql, args) {
      d1.statements++;
      if (args.length > 100) throw new Error(`D1 allows 100 bound parameters, got ${args.length}`);
      if (Buffer.byteLength(sql) > 100_000) throw new Error('SQL statement over 100 KB');
    },
    exec(sql, args) {
      d1.check(sql, args);
      const info = sqlite.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(info.changes) } };
    },
    query(sql, args) {
      d1.check(sql, args);
      return sqlite.prepare(sql).all(...args).map(r => ({ ...r }));
    },
    rows(sql, ...args) {
      return sqlite.prepare(sql).all(...args).map(r => ({ ...r }));
    },
  };
  return d1;
}

// MPEG-2 Layer III, 8 kbps, 22.05 kHz: 26-byte frames of 576 samples (~26 ms),
// so an hour of audio is only ~3.5 MB. Bytes 4–7 of each frame hold its number.
export const FRAME_BYTES = 26;
export const FRAME_SEC = 576 / 22050;

export function whisperAudio(seconds, { preamble = 0 } = {}) {
  const frames = Math.round(seconds / FRAME_SEC);
  const bytes = new Uint8Array(preamble + frames * FRAME_BYTES);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < frames; i++) {
    const off = preamble + i * FRAME_BYTES;
    bytes.set([0xFF, 0xF3, 0x10, 0x00], off);
    view.setUint32(off + 4, i);
  }
  return bytes;
}

/** An R2 bucket over in-memory files; records every ranged read. */
export function makeR2(files = {}) {
  const objects = new Map(Object.entries(files).map(([k, bytes]) => [k, { bytes, etag: 'etag-1' }]));
  const reads = [];
  return {
    objects,
    reads,
    async head(key) {
      const o = objects.get(key);
      return o ? { key, size: o.bytes.length, etag: o.etag } : null;
    },
    async get(key, opts = {}) {
      const o = objects.get(key);
      if (!o) return null;
      const offset = opts.range?.offset ?? 0;
      const length = opts.range?.length ?? o.bytes.length - offset;
      reads.push({ key, offset, length });
      const slice = o.bytes.slice(offset, offset + length);
      return { arrayBuffer: async () => slice.buffer };
    },
    replace(key, bytes, etag) {
      objects.set(key, { bytes, etag });
    },
  };
}

/** Audio bytes of the file part of a Whisper request. */
function audioPart(init) {
  const boundary = /boundary=(\S+)/.exec(init.headers['Content-Type'])[1];
  const body = init.body;
  const text = new TextDecoder('latin1').decode(body);
  const start = text.indexOf('\r\n\r\n', text.indexOf('filename="chunk.mp3"')) + 4;
  const end = text.indexOf(`\r\n--${boundary}`, start);
  return { audio: body.subarray(start, end), fields: text.slice(end) };
}

/** Where in the show a chunk starts (seconds) and how long it is. */
export function describeChunk(audio) {
  // The first frame sync; chunk 1 may start with a preamble
  let first = 0;
  while (first + 1 < audio.length && !(audio[first] === 0xFF && audio[first + 1] === 0xF3)) first++;
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  const frame = view.getUint32(first + 4);
  const frames = Math.floor((audio.length - first) / FRAME_BYTES);
  return { startSec: frame * FRAME_SEC, durationSec: frames * FRAME_SEC };
}

/**
 * A fake fetch for Whisper, GPT, sunrise and Nominatim.
 *
 * `speech(sec, { retry })` returns the words spoken in the 10-second slot at
 * `sec` into the show (5, 15, 25…; null for silence); `retry` is true for a
 * gap-retry clip (3 minutes or less). Other options script GPT replies. Every call is recorded with whether
 * it carried a time limit.
 */
export function fakeFetch({
  speech = sec => `Line at ${Math.round(sec)} seconds.`,
  whisper = null,       // (call) => Response to override a Whisper call
  summary = () => ({ title: 'Stairway Streets!', summary: 'A foggy morning on the stairs.', guests: ['Heather Knight'] }),
  summaryReply = null,  // (call) => raw chat completion JSON, to script failures
  places = () => [],
  placesReply = null,
  sentiment = () => ({ score: 0.5, label: 'positive', quote: 'we love it' }),
  geocode = () => [{ lat: '37.7596', lon: '-122.4269' }],
} = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const call = { url: String(url), hasTimeout: init.signal instanceof AbortSignal };
    calls.push(call);

    if (call.url.includes('/v1/audio/transcriptions')) {
      const { audio, fields } = audioPart(init);
      Object.assign(call, { kind: 'whisper', fields, ...describeChunk(audio) });
      call.retry = call.durationSec <= 181;
      if (whisper) {
        const res = await whisper(call);
        if (res) return res;
      }
      // One line per 10-second slot, starting at 5, 15, 25 s… so no slot starts right on
      // a chunk edge (the chunks are cut just past multiples of six minutes).
      const segments = [];
      const end = call.startSec + call.durationSec;
      for (let t = Math.ceil((call.startSec - 5) / 10) * 10 + 5; t < end; t += 10) {
        const text = speech(t, { retry: call.retry });
        if (text) segments.push({ start: t - call.startSec, end: Math.min(t + 10, end) - call.startSec, text });
      }
      return Response.json({ duration: call.durationSec, segments });
    }

    if (call.url.includes('/v1/chat/completions')) {
      const req = JSON.parse(init.body);
      const system = req.messages[0].content;
      call.request = req;
      const reply = content => Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }] });
      if (system.startsWith('You summarize transcripts')) {
        call.kind = 'summary';
        if (summaryReply) return summaryReply(call);
        return reply(JSON.stringify(summary(call)));
      }
      if (system.startsWith('You extract San Francisco place names')) {
        call.kind = 'places';
        if (placesReply) return placesReply(call);
        return reply(JSON.stringify(places(call)));
      }
      call.kind = 'sentiment';
      return reply(JSON.stringify(sentiment(call)));
    }

    if (call.url.includes('sunrise-sunset.org')) {
      call.kind = 'sunrise';
      return Response.json({ status: 'OK', results: { sunrise: '2026-10-01T14:07:00+00:00', sunset: '2026-10-02T01:52:00+00:00' } });
    }
    if (call.url.includes('nominatim.openstreetmap.org')) {
      call.kind = 'geocode';
      return Response.json(geocode(call));
    }
    throw new Error(`unexpected fetch: ${call.url}`);
  };
  fn.calls = calls;
  return fn;
}

/** Workers AI and Vectorize stand-ins that record what they were given. */
export function makeAI() {
  return { runs: 0, async run(_model, { text }) { this.runs++; return { data: text.map(() => [0.1, 0.2, 0.3]) }; } };
}
export function makeVectorize() {
  return { upserted: [], async upsert(vectors) { this.upserted.push(...vectors); return { count: vectors.length }; } };
}
