# Serverless Episode Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a fully serverless pipeline that automatically transcribes, indexes, and summarizes podcast episodes when MP3s are uploaded to R2.

**Architecture:** R2 upload triggers a Queue message, consumed by a Worker that delegates to a Durable Object. The DO orchestrates: chunked Whisper transcription, D1 seeding, Vectorize embeddings, and GPT-4o-mini summary generation. All state lives in D1 and DO storage.

**Tech Stack:** Cloudflare Workers, Durable Objects, D1, R2, Vectorize, Workers AI, Queues, OpenAI Whisper API, OpenAI GPT-4o-mini

---

## File Structure

| File | Responsibility |
|------|---------------|
| Create: `roe-pipeline/package.json` | Dev dependencies (wrangler, vitest) |
| Create: `roe-pipeline/wrangler.jsonc` | Worker config with all bindings |
| Create: `roe-pipeline/vitest.config.js` | Test runner config |
| Create: `roe-pipeline/src/index.js` | Worker entry: queue consumer + DO export |
| Create: `roe-pipeline/src/pipeline.js` | EpisodePipeline Durable Object |
| Create: `roe-pipeline/src/parse-episode-id.js` | Filename-to-episode-ID parser |
| Create: `roe-pipeline/src/transcribe.js` | Chunked R2 reads + Whisper API |
| Create: `roe-pipeline/src/clean-segments.js` | Transcript segment cleaning |
| Create: `roe-pipeline/src/seed-db.js` | D1 episode + segment insertion |
| Create: `roe-pipeline/src/embeddings.js` | Windowed embeddings + Vectorize upsert |
| Create: `roe-pipeline/src/summary.js` | Title/summary/guests via GPT-4o-mini |
| Create: `roe-pipeline/test/parse-episode-id.test.js` | Unit tests for ID parser |
| Create: `roe-pipeline/test/clean-segments.test.js` | Unit tests for segment cleaning |

---

### Task 1: Project Scaffolding

**Files:**
- Create: `roe-pipeline/package.json`
- Create: `roe-pipeline/wrangler.jsonc`
- Create: `roe-pipeline/vitest.config.js`
- Create: `roe-pipeline/src/index.js`

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p roe-pipeline/src roe-pipeline/test
```

- [ ] **Step 2: Create `roe-pipeline/package.json`**

```json
{
  "name": "roe-pipeline",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run"
  },
  "devDependencies": {
    "wrangler": "^3.0.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 3: Create `roe-pipeline/wrangler.jsonc`**

```jsonc
{
  "name": "roe-pipeline",
  "main": "src/index.js",
  "compatibility_date": "2024-12-01",

  // D1 — same database as roe-search
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "roe-episodes",
      "database_id": "cc7207a0-a581-4d3a-9c8f-12597b1ab46d"
    }
  ],

  // R2 — same bucket, also the event source
  "r2_buckets": [
    {
      "binding": "AUDIO_BUCKET",
      "bucket_name": "roe-audio"
    }
  ],

  // Vectorize — same index as roe-search
  "vectorize": [
    {
      "binding": "VECTORIZE",
      "index_name": "roe-transcripts"
    }
  ],

  // Workers AI — for embedding generation
  "ai": {
    "binding": "AI"
  },

  // Durable Object for pipeline orchestration
  "durable_objects": {
    "bindings": [
      {
        "name": "EPISODE_PIPELINE",
        "class_name": "EpisodePipeline"
      }
    ]
  },

  "migrations": [
    {
      "tag": "v1",
      "new_classes": ["EpisodePipeline"]
    }
  ],

  // Queue consumer for R2 event notifications
  "queues": {
    "consumers": [
      {
        "queue": "roe-pipeline-queue",
        "max_batch_size": 1,
        "max_retries": 3
      }
    ]
  },

  "vars": {
    "R2_PUBLIC_URL": "https://pub-e95bd2be3f9d4147b2955503d75e50c1.r2.dev"
  },

  "observability": {
    "enabled": true
  }
}
```

- [ ] **Step 4: Create `roe-pipeline/vitest.config.js`**

```js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
  },
});
```

- [ ] **Step 5: Create stub `roe-pipeline/src/index.js`**

```js
export { EpisodePipeline } from './pipeline.js';

export default {
  async queue(batch, env) {
    // TODO: implement in Task 9
  },

  async fetch(request, env) {
    return new Response('roe-pipeline worker', { status: 200 });
  },
};
```

- [ ] **Step 6: Create stub `roe-pipeline/src/pipeline.js`**

```js
export class EpisodePipeline {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    return new Response('EpisodePipeline stub', { status: 200 });
  }
}
```

- [ ] **Step 7: Install dependencies and verify**

```bash
cd roe-pipeline && npm install
```

Run: `cd roe-pipeline && npx wrangler deploy --dry-run`
Expected: No errors (config is valid)

- [ ] **Step 8: Commit**

```bash
git add roe-pipeline/
git commit -m "feat: scaffold roe-pipeline Worker project"
```

---

### Task 2: Episode ID Parser (TDD)

**Files:**
- Create: `roe-pipeline/src/parse-episode-id.js`
- Create: `roe-pipeline/test/parse-episode-id.test.js`
- Reference: `scripts/process-episode.js:204-311`

- [ ] **Step 1: Write failing tests**

Create `roe-pipeline/test/parse-episode-id.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd roe-pipeline && npx vitest run test/parse-episode-id.test.js`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `roe-pipeline/src/parse-episode-id.js`**

Port from `scripts/process-episode.js:204-311`, adapted for R2 object keys (no Node `path` module — use string manipulation):

```js
/**
 * Parse an episode ID from an R2 object key (filename).
 * Returns canonical format: roll-over-easy_YYYY-MM-DD_HH-MM-SS
 * Returns null if the filename is unrecognized or not an MP3.
 */

// Lookup table for historic month-day-only filenames (2014 episodes)
const MONTH_DAY_2014 = {
  'jan 9': '2014-01-09', 'jan 13': '2014-01-13', 'jan 16': '2014-01-16',
  'jan 23': '2014-01-23', 'jan 30': '2014-01-30',
  'feb 6': '2014-02-06', 'feb 13': '2014-02-13', 'feb 18': '2014-02-18',
  'feb 26': '2014-02-26',
  'march 6': '2014-03-06', 'march 13': '2014-03-13', 'march 20': '2014-03-20',
  'march 27': '2014-03-27',
  'april 3': '2014-04-03', 'april 10': '2014-04-10', 'april 17': '2014-04-17',
  'april 24': '2014-04-24',
};

export function parseEpisodeId(key) {
  // Strip directory prefix if present
  const filename = key.includes('/') ? key.split('/').pop() : key;

  // Only process MP3 files
  if (!filename.toLowerCase().endsWith('.mp3')) return null;

  // Strip extension
  const stem = filename.replace(/\.mp3$/i, '');

  // Canonical: roll-over-easy_2026-02-16_07-30-00 (with optional " copy")
  const canonicalMatch = stem.match(/^(roll-over-easy_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})(\s+copy)?$/);
  if (canonicalMatch) return canonicalMatch[1];

  // App Recording: "App Recording 20260216 0730"
  const appMatch = stem.match(/App[_ ]Recording[_ ]+(\d{4})(\d{2})(\d{2})[_ ]+(\d{2})(\d{2})/i);
  if (appMatch) {
    const [, y, m, d, hh, mm] = appMatch;
    return `roll-over-easy_${y}-${m}-${d}_${hh}-${mm}-00`;
  }

  // Input Device Recording: "Input Device Recording 20220815 2051"
  const inputMatch = stem.match(/Input Device Recording\s+(\d{4})(\d{2})(\d{2})\s+(\d{2})(\d{2})/i);
  if (inputMatch) {
    const [, y, m, d, hh, mm] = inputMatch;
    return `roll-over-easy_${y}-${m}-${d}_${hh}-${mm}-00`;
  }

  // Podcast Roll Over Easy YYYYMMDD
  const podcastMatch = stem.match(/Podcast Roll Over Easy\s+(\d{4})(\d{2})(\d{2})/i);
  if (podcastMatch) {
    const [, y, m, d] = podcastMatch;
    return `roll-over-easy_${y}-${m}-${d}_07-30-00`;
  }

  // Roll Over Easy YYYYMMDD
  const roeYMDMatch = stem.match(/^Roll Over Easy\s+(\d{4})(\d{2})(\d{2})/i);
  if (roeYMDMatch) {
    const [, y, m, d] = roeYMDMatch;
    return `roll-over-easy_${y}-${m}-${d}_07-30-00`;
  }

  // Roll Over Easy - YYYY-MM-DD
  const roeDashMatch = stem.match(/^Roll Over Easy\s*-\s*(\d{4})-(\d{2})-(\d{2})/i);
  if (roeDashMatch) {
    const [, y, m, d] = roeDashMatch;
    return `roll-over-easy_${y}-${m}-${d}_07-30-00`;
  }

  // Roll Over Easy YYYY-MM-DD
  const roeSpaceDashMatch = stem.match(/^Roll Over Easy\s+(\d{4})-(\d{2})-(\d{2})(?:\s|$)/i);
  if (roeSpaceDashMatch) {
    const [, y, m, d] = roeSpaceDashMatch;
    return `roll-over-easy_${y}-${m}-${d}_07-30-00`;
  }

  // Roll_Over_Easy_-_YYYY-MM-DD
  const roeUnderscoreDashMatch = stem.match(/^Roll_Over_Easy_-_(\d{4})-(\d{2})-(\d{2})/i);
  if (roeUnderscoreDashMatch) {
    const [, y, m, d] = roeUnderscoreDashMatch;
    return `roll-over-easy_${y}-${m}-${d}_07-30-00`;
  }

  // roll_over_easy-YYYY-MM-DD
  const roeUnderscoreMatch = stem.match(/^roll_over_easy-(\d{4})-(\d{2})-(\d{2})/i);
  if (roeUnderscoreMatch) {
    const [, y, m, d] = roeUnderscoreMatch;
    return `roll-over-easy_${y}-${m}-${d}_07-30-00`;
  }

  // roll-over-easy YYYY-MM-DD
  const roeSpaceMatch = stem.match(/^roll-over-easy\s+(\d{4})-(\d{2})-(\d{2})/i);
  if (roeSpaceMatch) {
    const [, y, m, d] = roeSpaceMatch;
    return `roll-over-easy_${y}-${m}-${d}_07-30-00`;
  }

  // rec_(YYYY_MM_DD)_N
  const recYMDMatch = stem.match(/^rec_\((\d{4})_(\d{2})_(\d{2})\)_/);
  if (recYMDMatch) {
    const [, y, m, d] = recYMDMatch;
    return `roll-over-easy_${y}-${m}-${d}_07-30-00`;
  }

  // rec_(MM_DD_YYYY)_N
  const recMDYMatch = stem.match(/^rec_\((\d{2})_(\d{2})_(\d{4})\)_/);
  if (recMDYMatch) {
    const [, m, d, y] = recMDYMatch;
    return `roll-over-easy_${y}-${m}-${d}_07-30-00`;
  }

  // Month-day-only: "Feb 6 - Roll Over Easy"
  const monthDayPrefix = stem.match(/^(Jan|Feb|March|April)\s+(\d{1,2})\s*-\s*Roll Over Easy/i);
  if (monthDayPrefix) {
    const key = `${monthDayPrefix[1].toLowerCase()} ${monthDayPrefix[2]}`;
    if (MONTH_DAY_2014[key]) return `roll-over-easy_${MONTH_DAY_2014[key]}_07-30-00`;
  }

  // Month-day-only: "Roll Over Easy March 20"
  const monthDaySuffix = stem.match(/^Roll Over Easy\s+(Jan|Feb|March|April)\s+(\d{1,2})/i);
  if (monthDaySuffix) {
    const key = `${monthDaySuffix[1].toLowerCase()} ${monthDaySuffix[2]}`;
    if (MONTH_DAY_2014[key]) return `roll-over-easy_${MONTH_DAY_2014[key]}_07-30-00`;
  }

  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd roe-pipeline && npx vitest run test/parse-episode-id.test.js`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add roe-pipeline/src/parse-episode-id.js roe-pipeline/test/parse-episode-id.test.js
git commit -m "feat: add episode ID parser for roe-pipeline"
```

---

### Task 3: Segment Cleaning (TDD)

**Files:**
- Create: `roe-pipeline/src/clean-segments.js`
- Create: `roe-pipeline/test/clean-segments.test.js`
- Reference: `scripts/process-episode.js:321-389`

- [ ] **Step 1: Write failing tests**

Create `roe-pipeline/test/clean-segments.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd roe-pipeline && npx vitest run test/clean-segments.test.js`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `roe-pipeline/src/clean-segments.js`**

Port from `scripts/process-episode.js:321-389`:

```js
/**
 * Clean Whisper transcription artifacts from segments.
 * Removes: zero-duration, consecutive duplicates, internal loops, hallucinations.
 */

export function cleanSegments(segments) {
  const cleaned = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];

    // Drop zero-duration segments
    if (seg.start_ms === seg.end_ms) continue;

    // Drop consecutive duplicates
    if (cleaned.length > 0 && seg.text === cleaned[cleaned.length - 1].text) continue;

    // Drop segments with internal phrase looping
    if (hasInternalLoop(seg.text)) continue;

    cleaned.push(seg);
  }

  // Remove non-consecutive hallucinated short phrases
  const freq = new Map();
  for (const seg of cleaned) {
    const words = seg.text.trim().split(/\s+/);
    if (words.length <= 3) {
      const key = seg.text.trim().toLowerCase();
      freq.set(key, (freq.get(key) || 0) + 1);
    }
  }
  const threshold = Math.max(10, Math.floor(cleaned.length * 0.02));
  const hallucinated = new Set();
  for (const [text, count] of freq) {
    if (count > threshold) hallucinated.add(text);
  }
  if (hallucinated.size > 0) {
    return cleaned.filter(seg => !hallucinated.has(seg.text.trim().toLowerCase()));
  }

  return cleaned;
}

/**
 * Detect internal looping: a phrase of 3-8 words repeating 4+ times consecutively.
 */
function hasInternalLoop(text) {
  const words = text.toLowerCase().split(/\s+/);
  if (words.length < 12) return false;

  for (let phraseLen = 3; phraseLen <= 8 && phraseLen <= words.length / 4; phraseLen++) {
    for (let start = 0; start <= words.length - phraseLen * 4; start++) {
      const phrase = words.slice(start, start + phraseLen).join(' ');
      let repeats = 1;
      let pos = start + phraseLen;
      while (pos + phraseLen <= words.length) {
        const next = words.slice(pos, pos + phraseLen).join(' ');
        if (next === phrase) {
          repeats++;
          pos += phraseLen;
        } else {
          break;
        }
      }
      if (repeats >= 4) return true;
    }
  }

  return false;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd roe-pipeline && npx vitest run test/clean-segments.test.js`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add roe-pipeline/src/clean-segments.js roe-pipeline/test/clean-segments.test.js
git commit -m "feat: add transcript segment cleaning for roe-pipeline"
```

---

### Task 4: Transcription Module

**Files:**
- Create: `roe-pipeline/src/transcribe.js`
- Reference: `scripts/process-episode.js:62-90` (SF_VOCAB_PROMPT)

- [ ] **Step 1: Implement `roe-pipeline/src/transcribe.js`**

Reads MP3 from R2 in ~20MB chunks, sends each to OpenAI Whisper API, stitches timestamps:

```js
/**
 * Transcribe an MP3 from R2 using OpenAI Whisper API.
 * Handles files >25MB by chunking and stitching timestamps.
 */

import { cleanSegments } from './clean-segments.js';

const CHUNK_SIZE = 20 * 1024 * 1024; // 20MB per chunk (under 25MB API limit)

// Whisper prompt for SF proper nouns — same as scripts/process-episode.js
const SF_VOCAB_PROMPT = [
  'Roll Over Easy, BFF.fm, Stroll Over Easy,',
  'SoMa, the Tenderloin, Dogpatch, Bernal Heights, Japantown, Visitacion Valley,',
  'Haight-Ashbury, Pac Heights, Noe Valley, Potrero Hill, the Fillmore, Bayview,',
  'the Ferry Building, Golden Gate Park, Sutro Baths, Lands End, McLaren Park,',
  'JFK Promenade, Crosstown Trail, Pier 70, Wave Organ, Transamerica Pyramid,',
  'Conservatory of Flowers, the Botanical Garden, Salesforce Park,',
  'Hamburger Haven, Club Fugazi, Manny\'s, The Lab, Spin City, Parklab,',
  'La Cocina, Bi-Rite, Tartine, Humphry Slocombe, Lazy Bear, Toronado,',
  'Wesburger, The New Wheel, Laughing Monk,',
  'Emperor Norton, Herb Caen, Cosmic Amanda, Dr. Guacamole,',
  'Muni Diaries, Noise Pop, Litquake, Litcrawl, KQED, KALW, Hoodline,',
  'Mission Local, SFGate, Tablehopper, Total SF, Bay City Beacon,',
  'BAYCAT, ODC, YBCA, Gray Area, SFMOMA, the Exploratorium,',
  'Sisters of Perpetual Indulgence, Cacophony Society,',
  'Muni, BART, Caltrain, the N-Judah, the F-Market,',
  'Eichler Homes, Compton\'s Cafeteria, Critical Mass, Sketch Fest, Karl the Fog,',
  'NIMBYism, YIMBYism, Dungeness crab, cioppino, dim sum, sourdough,',
].join(' ');

/**
 * Transcribe a full MP3 from R2, handling chunking for large files.
 *
 * @param {R2Bucket} bucket - R2 bucket binding
 * @param {string} key - R2 object key
 * @param {string} openaiApiKey - OpenAI API key
 * @param {object} [resume] - Resume state: { chunksCompleted, segments, timeOffset }
 * @returns {{ segments: Array, durationMs: number }}
 */
export async function transcribeFromR2(bucket, key, openaiApiKey, resume) {
  const head = await bucket.head(key);
  if (!head) throw new Error(`R2 object not found: ${key}`);

  const fileSize = head.size;
  const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);

  let allSegments = resume?.segments || [];
  let timeOffset = resume?.timeOffset || 0;
  const startChunk = resume?.chunksCompleted || 0;

  for (let i = startChunk; i < totalChunks; i++) {
    const offset = i * CHUNK_SIZE;
    const length = Math.min(CHUNK_SIZE, fileSize - offset);

    const obj = await bucket.get(key, { range: { offset, length } });
    if (!obj) throw new Error(`Failed to read R2 range: offset=${offset}, length=${length}`);

    const buffer = await obj.arrayBuffer();
    const { segments, duration } = await transcribeChunk(buffer, openaiApiKey, timeOffset);

    allSegments.push(...segments);
    timeOffset += duration;

    console.log(`  Chunk ${i + 1}/${totalChunks}: ${segments.length} segments, +${duration.toFixed(1)}s`);
  }

  const cleaned = cleanSegments(allSegments);
  const durationMs = Math.round(timeOffset * 1000);

  console.log(`  Total: ${cleaned.length} segments (${allSegments.length - cleaned.length} removed by cleaning), ${durationMs}ms`);

  return { segments: cleaned, durationMs, totalChunks };
}

/**
 * Send a single audio chunk to OpenAI Whisper API.
 */
async function transcribeChunk(buffer, apiKey, timeOffsetSec) {
  const blob = new Blob([buffer], { type: 'audio/mpeg' });
  const formData = new FormData();
  formData.append('file', blob, 'chunk.mp3');
  formData.append('model', 'whisper-1');
  formData.append('response_format', 'verbose_json');
  formData.append('timestamp_granularities[]', 'segment');
  formData.append('prompt', SF_VOCAB_PROMPT);

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Whisper API error ${res.status}: ${body}`);
  }

  const data = await res.json();

  const segments = (data.segments || []).map(seg => ({
    start_ms: Math.round((seg.start + timeOffsetSec) * 1000),
    end_ms: Math.round((seg.end + timeOffsetSec) * 1000),
    text: seg.text.trim(),
  })).filter(seg => seg.text.length > 0);

  return { segments, duration: data.duration || 0 };
}
```

- [ ] **Step 2: Commit**

```bash
git add roe-pipeline/src/transcribe.js
git commit -m "feat: add chunked Whisper API transcription module"
```

---

### Task 5: D1 Seeding Module

**Files:**
- Create: `roe-pipeline/src/seed-db.js`
- Reference: `scripts/process-episode.js:496-567`

- [ ] **Step 1: Implement `roe-pipeline/src/seed-db.js`**

Uses D1 prepared statements (not string interpolation like the local scripts):

```js
/**
 * Seed episode and transcript segments into D1.
 * FTS index is updated automatically by database triggers.
 */

const DB_BATCH_SIZE = 50;

/**
 * @param {D1Database} db
 * @param {string} episodeId
 * @param {number} durationMs
 * @param {Array<{start_ms: number, end_ms: number, text: string}>} segments
 */
export async function seedDatabase(db, episodeId, durationMs, segments) {
  // Insert episode row (title defaults to episodeId, updated later by summary step)
  await db.prepare('INSERT INTO episodes (id, title, duration_ms) VALUES (?, ?, ?)')
    .bind(episodeId, episodeId, durationMs)
    .run();

  // Insert transcript segments in batches
  for (let i = 0; i < segments.length; i += DB_BATCH_SIZE) {
    const batch = segments.slice(i, i + DB_BATCH_SIZE);
    const placeholders = batch.map(() => '(?, ?, ?, ?)').join(', ');
    const values = batch.flatMap(s => [episodeId, s.start_ms, s.end_ms, s.text]);

    await db.prepare(
      `INSERT INTO transcript_segments (episode_id, start_ms, end_ms, text) VALUES ${placeholders}`
    ).bind(...values).run();
  }

  console.log(`  Seeded ${segments.length} segments for ${episodeId}`);

  // Purge hallucinated phrases that survived cleaning
  await purgeHallucinations(db, episodeId);
}

async function purgeHallucinations(db, episodeId) {
  const { results } = await db.prepare(`
    SELECT text, COUNT(*) as cnt FROM transcript_segments
    WHERE episode_id = ? GROUP BY text HAVING cnt > 20 AND length(text) > 20
  `).bind(episodeId).all();

  if (!results || results.length === 0) return;

  for (const row of results) {
    await db.prepare(
      'DELETE FROM transcript_segments WHERE episode_id = ? AND text = ?'
    ).bind(episodeId, row.text).run();
  }

  const totalDeleted = results.reduce((sum, r) => sum + r.cnt, 0);
  console.log(`  Purged ${totalDeleted} hallucinated segments (${results.length} phrase(s))`);
}
```

- [ ] **Step 2: Commit**

```bash
git add roe-pipeline/src/seed-db.js
git commit -m "feat: add D1 seeding module for roe-pipeline"
```

---

### Task 6: Embeddings Module

**Files:**
- Create: `roe-pipeline/src/embeddings.js`
- Reference: `scripts/process-episode.js:571-686`

- [ ] **Step 1: Implement `roe-pipeline/src/embeddings.js`**

Uses Workers AI binding (not REST API like the local scripts):

```js
/**
 * Generate windowed embeddings and upsert to Vectorize.
 */

const WINDOW_SEC = 45;
const STEP_SEC = 35;
const EMBED_BATCH_SIZE = 100;
const UPSERT_BATCH_SIZE = 1000;

function isAscii(text) {
  return /^[\x00-\x7F]*$/.test(text);
}

/**
 * @param {Ai} ai - Workers AI binding
 * @param {VectorizeIndex} vectorize - Vectorize binding
 * @param {string} episodeId
 * @param {Array<{start_ms: number, end_ms: number, text: string}>} segments
 * @param {number} durationMs
 * @returns {number} Number of vectors upserted
 */
export async function generateEmbeddings(ai, vectorize, episodeId, segments, durationMs) {
  if (segments.length === 0) return 0;

  // Build windowed chunks
  const windowMs = WINDOW_SEC * 1000;
  const stepMs = STEP_SEC * 1000;
  const chunks = [];

  for (let windowStart = 0; windowStart < durationMs; windowStart += stepMs) {
    const windowEnd = windowStart + windowMs;
    const windowSegments = segments.filter(s => s.end_ms > windowStart && s.start_ms < windowEnd);
    if (windowSegments.length === 0) continue;

    const text = windowSegments.map(s => s.text).join(' ');
    if (!isAscii(text)) continue;
    if (text.trim().length < 20) continue;

    const chunkStartMs = windowSegments[0].start_ms;
    const chunkEndMs = windowSegments[windowSegments.length - 1].end_ms;

    chunks.push({
      id: `${episodeId}:${chunkStartMs}`,
      metadata: {
        episode_id: episodeId,
        title: episodeId,
        start_ms: chunkStartMs,
        end_ms: chunkEndMs,
        text: text.trim(),
      },
      text: text.trim(),
    });
  }

  console.log(`  ${chunks.length} chunks to embed`);

  // Generate embeddings in batches via Workers AI
  const vectors = [];
  for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
    const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
    const texts = batch.map(c => c.text);

    const result = await ai.run('@cf/baai/bge-base-en-v1.5', { text: texts });

    for (let j = 0; j < batch.length; j++) {
      vectors.push({
        id: batch[j].id,
        values: result.data[j],
        metadata: batch[j].metadata,
      });
    }

    console.log(`  Embedded ${Math.min(i + EMBED_BATCH_SIZE, chunks.length)}/${chunks.length}`);
  }

  // Upsert to Vectorize in batches
  for (let i = 0; i < vectors.length; i += UPSERT_BATCH_SIZE) {
    const batch = vectors.slice(i, i + UPSERT_BATCH_SIZE);
    await vectorize.upsert(batch);
    console.log(`  Upserted ${Math.min(i + UPSERT_BATCH_SIZE, vectors.length)}/${vectors.length}`);
  }

  return vectors.length;
}
```

- [ ] **Step 2: Commit**

```bash
git add roe-pipeline/src/embeddings.js
git commit -m "feat: add embeddings module for roe-pipeline"
```

---

### Task 7: Summary Module

**Files:**
- Create: `roe-pipeline/src/summary.js`
- Reference: `scripts/process-episode.js:690-858`

- [ ] **Step 1: Implement `roe-pipeline/src/summary.js`**

Ports the exact prompt and sunrise/sunset fetch from the existing pipeline:

```js
/**
 * Generate episode title, summary, and guest list via GPT-4o-mini.
 * Updates D1 with results.
 */

/**
 * @param {D1Database} db
 * @param {string} episodeId
 * @param {Array<{text: string}>} segments
 * @param {string} openaiApiKey
 */
export async function generateSummary(db, episodeId, segments, openaiApiKey) {
  const transcriptText = segments.map(s => s.text).join('\n');

  // Extract date from episode ID
  const dateMatch = episodeId.match(/(\d{4}-\d{2}-\d{2})/);
  const dateStr = dateMatch ? dateMatch[1] : null;

  // Fetch sunrise/sunset for context
  let sunData = null;
  if (dateStr) {
    sunData = await fetchSunriseSunset(dateStr);
  }

  // Build system prompt (matches scripts/process-episode.js exactly)
  const systemLines = [
    'You summarize transcripts from "Roll Over Easy," a live morning radio show on BFF.fm broadcast from the Ferry Building in San Francisco.',
    '',
    'Respond with a JSON object containing three fields:',
    '',
    '1. "title": A short, catchy episode title (3-8 words). Highlight the main guest or topic. Use an exclamation point for energy. Examples: "Super Bowl Thursday!", "Jane Natoli\'s San Francisco!", "Tree Twins and Muni Diaries".',
    '',
    '2. "summary": A concise summary in this format:',
    '   Line 1: The weather/vibe that morning (if mentioned \u2014 fog, sun, rain, cold, etc.). If not mentioned, skip this line.',
    '   Line 2: Who joined the show \u2014 name any guests who came on for a segment and briefly note who they are. The show is live on location, so random passersby sometimes hop on the mic for a few seconds to a few minutes \u2014 mention these folks too if they say something memorable or funny.',
    '   Line 3-4: What stories and topics came up \u2014 San Francisco news, local culture, neighborhood happenings, food, music, etc.',
    '   Keep a warm, San Francisco tone. Use 2-5 sentences total. Do not use bullet points or labels like "Weather:" \u2014 just weave it naturally.',
    '',
    '3. "guests": An array of guest full names mentioned in the episode. Exclude the hosts Sequoia and The Early Bird. Return an empty array if there are no guests.',
  ];

  if (dateStr || sunData) {
    systemLines.push('');
    systemLines.push('Additional context for this episode:');
    if (dateStr) {
      const formatted = new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric',
      });
      systemLines.push(`- Date: ${formatted}`);
    }
    if (sunData) {
      systemLines.push(`- Sunrise: ${sunData.sunrise} PT`);
      systemLines.push(`- Sunset: ${sunData.sunset} PT`);
    }
    systemLines.push('Include the weather and temperature explicitly in your summary (pull temperature from what the hosts mention in the transcript). Also mention what time sunrise and sunset were that day.');
  }

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${openaiApiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemLines.join('\n') },
        { role: 'user', content: `Summarize this Roll Over Easy episode transcript:\n\n${transcriptText}` },
      ],
      temperature: 0.5,
      max_tokens: 400,
      response_format: { type: 'json_object' },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${body}`);
  }

  const data = await res.json();
  const content = data.choices[0].message.content.trim();

  let title, summary, guests = [];
  try {
    const parsed = JSON.parse(content);
    title = parsed.title?.trim();
    summary = parsed.summary?.trim();
    guests = Array.isArray(parsed.guests) ? parsed.guests : [];
  } catch {
    summary = content;
  }

  // Update D1
  if (title) {
    await db.prepare('UPDATE episodes SET title = ?, summary = ? WHERE id = ?')
      .bind(title, summary, episodeId).run();
  } else {
    await db.prepare('UPDATE episodes SET summary = ? WHERE id = ?')
      .bind(summary, episodeId).run();
  }

  // Insert guests
  if (guests.length > 0) {
    await db.prepare('DELETE FROM episode_guests WHERE episode_id = ?')
      .bind(episodeId).run();
    for (const guest of guests) {
      const name = guest.trim();
      if (name) {
        await db.prepare('INSERT OR IGNORE INTO episode_guests (episode_id, guest_name) VALUES (?, ?)')
          .bind(episodeId, name).run();
      }
    }
  }

  console.log(`  Title: ${title || '(none)'}`);
  console.log(`  Summary: ${(summary || '').slice(0, 100)}...`);
  if (guests.length > 0) console.log(`  Guests: ${guests.join(', ')}`);

  return { title, summary, guests };
}

function utcToPacific(isoString) {
  const date = new Date(isoString);
  return date.toLocaleTimeString('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: 'numeric',
    minute: '2-digit',
  });
}

async function fetchSunriseSunset(dateStr) {
  // Ferry Building coordinates
  const url = `https://api.sunrise-sunset.org/json?lat=37.7955&lng=-122.3937&date=${dateStr}&formatted=0`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.status !== 'OK') return null;
    return {
      sunrise: utcToPacific(data.results.sunrise),
      sunset: utcToPacific(data.results.sunset),
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add roe-pipeline/src/summary.js
git commit -m "feat: add GPT-4o-mini summary module for roe-pipeline"
```

---

### Task 8: Durable Object Pipeline

**Files:**
- Modify: `roe-pipeline/src/pipeline.js`

- [ ] **Step 1: Implement `EpisodePipeline` Durable Object**

Replace the stub with the full orchestrator. Uses alarm-based processing to decouple from the queue consumer:

```js
/**
 * EpisodePipeline Durable Object.
 * Orchestrates the full episode processing pipeline.
 * Uses alarm-based execution to avoid blocking the queue consumer.
 */

import { parseEpisodeId } from './parse-episode-id.js';
import { transcribeFromR2 } from './transcribe.js';
import { seedDatabase } from './seed-db.js';
import { generateEmbeddings } from './embeddings.js';
import { generateSummary } from './summary.js';

const STEPS = ['transcribe', 'seed-db', 'embeddings', 'summary', 'set-audio-url'];

export class EpisodePipeline {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const { key } = await request.json();

    // Parse episode ID from R2 key
    const episodeId = parseEpisodeId(key);
    if (!episodeId) {
      return Response.json({ error: `Could not parse episode ID from: ${key}` }, { status: 400 });
    }

    // Check if already processing or completed
    const status = await this.state.storage.get('status');
    if (status === 'processing') {
      return Response.json({ status: 'already_processing', episodeId });
    }

    // Check D1 for existing episode (dedup)
    const existing = await this.env.DB.prepare('SELECT id FROM episodes WHERE id = ?')
      .bind(episodeId).first();
    if (existing) {
      return Response.json({ status: 'already_exists', episodeId });
    }

    // Save job and trigger alarm for async processing
    await this.state.storage.put('status', 'processing');
    await this.state.storage.put('step', 'transcribe');
    await this.state.storage.put('key', key);
    await this.state.storage.put('episodeId', episodeId);
    await this.state.storage.setAlarm(Date.now());

    console.log(`Pipeline started for ${episodeId} (key: ${key})`);
    return Response.json({ status: 'started', episodeId });
  }

  async alarm() {
    const key = await this.state.storage.get('key');
    const episodeId = await this.state.storage.get('episodeId');
    const step = await this.state.storage.get('step');

    if (!key || !episodeId || !step) return;

    console.log(`[${episodeId}] Running step: ${step}`);

    try {
      switch (step) {
        case 'transcribe': {
          // Resume support: check for partial transcription progress
          const resume = await this.state.storage.get('transcribeResume');

          const { segments, durationMs, totalChunks } = await transcribeFromR2(
            this.env.AUDIO_BUCKET, key, this.env.OPENAI_API_KEY, resume
          );

          await this.state.storage.put('segments', segments);
          await this.state.storage.put('durationMs', durationMs);
          await this.state.storage.delete('transcribeResume');
          await this.advanceStep('seed-db');
          break;
        }

        case 'seed-db': {
          const segments = await this.state.storage.get('segments');
          const durationMs = await this.state.storage.get('durationMs');
          await seedDatabase(this.env.DB, episodeId, durationMs, segments);
          await this.advanceStep('embeddings');
          break;
        }

        case 'embeddings': {
          const segments = await this.state.storage.get('segments');
          const durationMs = await this.state.storage.get('durationMs');
          const vectorCount = await generateEmbeddings(
            this.env.AI, this.env.VECTORIZE, episodeId, segments, durationMs
          );
          console.log(`[${episodeId}] ${vectorCount} vectors upserted`);
          await this.advanceStep('summary');
          break;
        }

        case 'summary': {
          const segments = await this.state.storage.get('segments');
          await generateSummary(this.env.DB, episodeId, segments, this.env.OPENAI_API_KEY);
          await this.advanceStep('set-audio-url');
          break;
        }

        case 'set-audio-url': {
          const audioUrl = `${this.env.R2_PUBLIC_URL}/${encodeURIComponent(key)}`;
          await this.env.DB.prepare('UPDATE episodes SET audio_file = ? WHERE id = ?')
            .bind(audioUrl, episodeId).run();
          console.log(`[${episodeId}] audio_file set to ${audioUrl}`);

          // Pipeline complete — clean up DO storage
          await this.state.storage.deleteAll();
          await this.state.storage.put('status', 'completed');
          console.log(`[${episodeId}] Pipeline completed successfully`);
          break;
        }
      }
    } catch (err) {
      console.error(`[${episodeId}] Pipeline failed at step "${step}":`, err.message);
      await this.state.storage.put('status', 'failed');
      await this.state.storage.put('error', err.message);
      await this.state.storage.put('failedAt', new Date().toISOString());
    }
  }

  /** Advance to next step and set alarm for immediate execution. */
  async advanceStep(nextStep) {
    await this.state.storage.put('step', nextStep);
    await this.state.storage.setAlarm(Date.now());
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add roe-pipeline/src/pipeline.js
git commit -m "feat: implement EpisodePipeline Durable Object"
```

---

### Task 9: Worker Entry Point (Queue Consumer)

**Files:**
- Modify: `roe-pipeline/src/index.js`

- [ ] **Step 1: Implement queue consumer and manual trigger**

Replace the stub with the full implementation:

```js
/**
 * roe-pipeline Worker
 *
 * Queue consumer: receives R2 event notifications and dispatches to
 * EpisodePipeline Durable Object for processing.
 *
 * Also exposes a fetch handler for manual triggering and status checks.
 */

export { EpisodePipeline } from './pipeline.js';

export default {
  /**
   * Queue consumer — handles R2 object-create events.
   * Each message contains an R2 event with the uploaded object key.
   */
  async queue(batch, env) {
    for (const message of batch.messages) {
      const event = message.body;
      const key = event.object?.key;

      if (!key) {
        console.warn('Queue message missing object key, acking:', JSON.stringify(event));
        message.ack();
        continue;
      }

      // Only process MP3 files
      if (!key.toLowerCase().endsWith('.mp3')) {
        console.log(`Skipping non-MP3 file: ${key}`);
        message.ack();
        continue;
      }

      console.log(`Processing R2 event: ${key} (${event.object.size} bytes)`);

      try {
        // Dispatch to Durable Object keyed by filename (dedup by file)
        const doId = env.EPISODE_PIPELINE.idFromName(key);
        const stub = env.EPISODE_PIPELINE.get(doId);

        const res = await stub.fetch('http://internal/process', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key }),
        });

        const result = await res.json();
        console.log(`DO response for ${key}:`, JSON.stringify(result));
        message.ack();
      } catch (err) {
        console.error(`Failed to dispatch ${key} to DO:`, err.message);
        message.retry();
      }
    }
  },

  /**
   * Fetch handler for manual triggering and status checks.
   *
   * POST /process?key=filename.mp3 — manually trigger pipeline
   * GET  /status?key=filename.mp3  — check pipeline status
   * GET  /                         — health check
   */
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/process' && request.method === 'POST') {
      const key = url.searchParams.get('key');
      if (!key) return Response.json({ error: 'Missing ?key= parameter' }, { status: 400 });

      const doId = env.EPISODE_PIPELINE.idFromName(key);
      const stub = env.EPISODE_PIPELINE.get(doId);
      const res = await stub.fetch('http://internal/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      return res;
    }

    if (url.pathname === '/status') {
      const key = url.searchParams.get('key');
      if (!key) return Response.json({ error: 'Missing ?key= parameter' }, { status: 400 });

      const doId = env.EPISODE_PIPELINE.idFromName(key);
      const stub = env.EPISODE_PIPELINE.get(doId);
      const res = await stub.fetch('http://internal/status', { method: 'GET' });
      return res;
    }

    return Response.json({ service: 'roe-pipeline', status: 'ok' });
  },
};
```

- [ ] **Step 2: Add status endpoint to the Durable Object**

Add to `roe-pipeline/src/pipeline.js`, inside the `fetch` method, before the existing logic:

```js
  async fetch(request) {
    const url = new URL(request.url);

    // Status check
    if (request.method === 'GET' || url.pathname === '/status') {
      const status = await this.state.storage.get('status') || 'idle';
      const step = await this.state.storage.get('step');
      const episodeId = await this.state.storage.get('episodeId');
      const error = await this.state.storage.get('error');
      return Response.json({ status, step, episodeId, error });
    }

    // --- existing POST /process logic below ---
    const { key } = await request.json();
    // ...
  }
```

- [ ] **Step 3: Commit**

```bash
git add roe-pipeline/src/index.js roe-pipeline/src/pipeline.js
git commit -m "feat: implement queue consumer and manual trigger endpoints"
```

---

### Task 10: Deploy, Configure R2 Events & E2E Test

**Files:**
- No new files. Configuration via CLI.

- [ ] **Step 1: Set the OpenAI API key secret**

```bash
cd roe-pipeline && echo "<YOUR_OPENAI_API_KEY>" | npx wrangler secret put OPENAI_API_KEY
```

- [ ] **Step 2: Deploy the Worker**

```bash
cd roe-pipeline && npx wrangler deploy
```

Expected: Successful deploy with queue consumer and DO bindings created.
Note: Wrangler auto-creates the `roe-pipeline-queue` queue.

- [ ] **Step 3: Configure R2 event notification**

Create the event notification rule linking the `roe-audio` R2 bucket to the queue.

Via Cloudflare dashboard:
1. Go to **R2** > **roe-audio** bucket > **Settings** > **Event notifications**
2. Click **Add notification**
3. Event type: **Object creation** (`PutObject`, `CompleteMultipartUpload`, `CopyObject`)
4. Queue: **roe-pipeline-queue**
5. Optional suffix filter: `.mp3`

Or via wrangler CLI:
```bash
npx wrangler r2 bucket notification create roe-audio \
  --event-type object-create \
  --queue roe-pipeline-queue \
  --suffix ".mp3"
```

- [ ] **Step 4: E2E test — upload a small test MP3**

Upload a short test MP3 (a few seconds) to verify the full pipeline:

```bash
npx wrangler r2 object put roe-audio/roll-over-easy_2026-03-27_07-30-00.mp3 \
  --file=/path/to/short-test.mp3 \
  --content-type="audio/mpeg"
```

- [ ] **Step 5: Monitor pipeline execution**

Check real-time logs:
```bash
cd roe-pipeline && npx wrangler tail
```

Expected log sequence:
```
Processing R2 event: roll-over-easy_2026-03-27_07-30-00.mp3 (...)
Pipeline started for roll-over-easy_2026-03-27_07-30-00
[roll-over-easy_2026-03-27_07-30-00] Running step: transcribe
  Chunk 1/1: N segments, +Xs
  Total: N segments (M removed by cleaning), Xms
[roll-over-easy_2026-03-27_07-30-00] Running step: seed-db
  Seeded N segments
[roll-over-easy_2026-03-27_07-30-00] Running step: embeddings
  M chunks to embed
  M vectors upserted
[roll-over-easy_2026-03-27_07-30-00] Running step: summary
  Title: ...
[roll-over-easy_2026-03-27_07-30-00] Running step: set-audio-url
[roll-over-easy_2026-03-27_07-30-00] Pipeline completed successfully
```

- [ ] **Step 6: Verify results in D1**

```bash
cd roe-search && npx wrangler d1 execute roe-episodes \
  --command "SELECT id, title, audio_file, duration_ms FROM episodes WHERE id = 'roll-over-easy_2026-03-27_07-30-00'"
```

Expected: Row with title, audio_file URL, and duration.

- [ ] **Step 7: Verify on the live site**

Visit https://rollovereasy.org and search for the test episode. Confirm:
- Episode appears in search results
- Audio player works (MP3 playback)
- Semantic search returns relevant segments

- [ ] **Step 8: Commit any configuration adjustments**

```bash
git add roe-pipeline/
git commit -m "feat: finalize roe-pipeline deployment configuration"
```

---

## Notes

- **Whisper API file limit:** 25MB. Episodes up to ~200MB are split into ~20MB chunks automatically. Chunk boundaries may cause minor timestamp gaps (<0.1s) — acceptable for podcast search.
- **DO alarm model:** Each pipeline step runs in a separate alarm invocation. If a step fails, the DO records the error and stops. Re-uploading the same file (or calling `POST /process?key=...`) retries.
- **Re-processing:** Delete the episode from D1 first, then re-upload: `npx wrangler d1 execute roe-episodes --command "DELETE FROM episodes WHERE id = 'episode-id'"`
- **Cost:** ~$0.72/episode for Whisper ($0.006/min * 120min), plus negligible GPT-4o-mini and Cloudflare costs. Under $1/week for one episode.
