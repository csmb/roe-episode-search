# Places Extraction — Cloud Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add SF places extraction as a step in the `roe-pipeline` Durable Object so uploaded episodes automatically get place/map data.

**Architecture:** New `roe-pipeline/src/places.js` module mirrors the local script's logic (OpenAI + Nominatim geocoding) and is imported by `pipeline.js` as a soft-fail step between `summary` and `set-audio-url`. Tests cover the pure sampling function and the full extraction flow via fetch mocking.

**Tech Stack:** Cloudflare Workers (Durable Object), D1, OpenAI GPT-4o-mini, Nominatim OSM API, vitest

---

### Task 1: Create `src/places.js`

**Files:**
- Create: `roe-pipeline/src/places.js`
- Create: `roe-pipeline/test/places.test.js`

- [ ] **Step 1: Write failing tests for `sampleTranscript`**

Create `roe-pipeline/test/places.test.js`:

```js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sampleTranscript, extractAndSeedPlaces } from '../src/places.js';

describe('sampleTranscript', () => {
  it('joins all text for short episodes (< 50 segments)', () => {
    const segments = Array.from({ length: 10 }, (_, i) => ({ text: `word${i}` }));
    expect(sampleTranscript(segments)).toBe('word0 word1 word2 word3 word4 word5 word6 word7 word8 word9');
  });

  it('skips first ~5% of segments for long episodes', () => {
    const segments = Array.from({ length: 200 }, (_, i) => ({ text: `seg${i}` }));
    const result = sampleTranscript(segments);
    // First segment should be skipped (first 5% = ~10 segments skipped, but we skip up to 40)
    expect(result.startsWith('seg0')).toBe(false);
    expect(result.length).toBeGreaterThan(0);
  });

  it('caps output at 12000 characters', () => {
    const segments = Array.from({ length: 200 }, () => ({ text: 'a'.repeat(200) }));
    expect(sampleTranscript(segments).length).toBeLessThanOrEqual(12000);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /path/to/roe-episode-search/roe-pipeline && npx vitest run test/places.test.js
```

Expected: FAIL — `Cannot find module '../src/places.js'`

- [ ] **Step 3: Create `src/places.js`**

Create `roe-pipeline/src/places.js`:

```js
/**
 * Extract SF place names from episode transcript, geocode via Nominatim,
 * and seed D1 places + place_mentions tables.
 */

const SF_VIEWBOX = '-122.517,37.833,-122.355,37.708';
const NOMINATIM_DELAY_MS = 1100;

const PLACES_SYSTEM_PROMPT = `You extract San Francisco place names from a local radio show transcript.
This is "Roll Over Easy," a show deeply rooted in SF culture — hosts frequently mention restaurants, cafes, bars, taquerias, bakeries, bookstores, music venues, record shops, community spaces, murals, parks, plazas, beaches, hilltops, streets, intersections, neighborhoods, landmarks, schools, libraries, transit stops, and local businesses.

Return ONLY a JSON array of strings. Be thorough — capture every SF place mentioned, including:
- Restaurants & food: taquerias, dim sum spots, bakeries, coffee shops, ice cream parlors, breweries
- Nightlife & culture: bars, dive bars, music venues, theaters, galleries, bookstores, record shops
- Neighborhoods: Mission, Castro, Sunset, Richmond, Tenderloin, SoMa, Dogpatch, Excelsior, etc.
- Parks & outdoor: Dolores Park, Golden Gate Park, Ocean Beach, Bernal Hill, Twin Peaks, etc.
- Landmarks: Ferry Building, Transamerica Pyramid, Sutro Tower, Coit Tower, City Hall, etc.
- Streets & intersections: Market Street, Valencia Street, 24th & Mission, etc.
- Transit: Muni stops, BART stations, cable car lines
- Community spaces: Manny's, BFF.fm Studios, libraries, rec centers

Only include places in San Francisco proper (not Oakland, Berkeley, Marin, or other Bay Area cities unless the place is an SF icon like the Golden Gate Bridge).
Normalise names to how they'd appear on a map:
- "17th and valencia" → "17th Street & Valencia Street"
- "dolores park" → "Dolores Park"
- "the mission" → "Mission District"
If nothing qualifies, return [].`;

export function sampleTranscript(segments) {
  const total = segments.length;
  if (total < 50) return segments.map(s => s.text).join(' ');

  const start = Math.min(40, Math.floor(total * 0.05));
  const usable = total - start;
  const windowSize = Math.min(200, Math.floor(usable / 5));
  const windows = [];
  for (let i = 0; i < 5; i++) {
    const offset = start + Math.floor((usable / 5) * i);
    windows.push(segments.slice(offset, offset + windowSize));
  }
  return windows.flat().map(s => s.text).join(' ').slice(0, 12000);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function nominatimSearch(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'roe-episode-search/1.0' } });
  if (!res.ok) return [];
  return res.json();
}

async function geocodePlace(placeName) {
  const q1 = encodeURIComponent(placeName + ' San Francisco CA');
  try {
    const results = await nominatimSearch(
      `https://nominatim.openstreetmap.org/search?q=${q1}&format=json&limit=1&viewbox=${SF_VIEWBOX}&bounded=1`
    );
    if (results.length > 0) return { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) };
  } catch {}

  await sleep(NOMINATIM_DELAY_MS);

  if (placeName.includes('&') || placeName.includes(' and ')) {
    const parts = placeName.split(/\s*[&]\s*|\s+and\s+/i);
    if (parts.length === 2) {
      const q2 = encodeURIComponent(parts[0].trim() + ' and ' + parts[1].trim() + ', San Francisco');
      try {
        const results = await nominatimSearch(
          `https://nominatim.openstreetmap.org/search?q=${q2}&format=json&limit=1&viewbox=${SF_VIEWBOX}&bounded=1`
        );
        if (results.length > 0) return { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) };
      } catch {}
      await sleep(NOMINATIM_DELAY_MS);

      const q3 = encodeURIComponent(parts[0].trim() + ', San Francisco CA');
      try {
        const results = await nominatimSearch(
          `https://nominatim.openstreetmap.org/search?q=${q3}&format=json&limit=1&viewbox=${SF_VIEWBOX}&bounded=1`
        );
        if (results.length > 0) return { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) };
      } catch {}
      await sleep(NOMINATIM_DELAY_MS);
    }
  }

  const q4 = encodeURIComponent(placeName + ' San Francisco CA');
  try {
    const results = await nominatimSearch(
      `https://nominatim.openstreetmap.org/search?q=${q4}&format=json&limit=1&viewbox=${SF_VIEWBOX}&bounded=0`
    );
    if (results.length > 0) {
      const lat = parseFloat(results[0].lat);
      const lng = parseFloat(results[0].lon);
      if (lat >= 37.7 && lat <= 37.84 && lng >= -122.52 && lng <= -122.35) {
        return { lat, lng };
      }
    }
  } catch {}

  return null;
}

/**
 * @param {D1Database} db
 * @param {string} episodeId
 * @param {Array<{text: string}>} segments
 * @param {string} openaiApiKey
 */
export async function extractAndSeedPlaces(db, episodeId, segments, openaiApiKey) {
  if (!openaiApiKey) {
    console.warn(`[${episodeId}] OPENAI_API_KEY not set — skipping places extraction`);
    return;
  }

  const text = sampleTranscript(segments);

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openaiApiKey}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: PLACES_SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
      temperature: 0,
      max_tokens: 1000,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${body}`);
  }

  const data = await res.json();
  const content = data.choices[0].message.content.trim()
    .replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();

  let placeNames = [];
  try {
    placeNames = JSON.parse(content);
    if (!Array.isArray(placeNames)) placeNames = [];
  } catch {
    console.warn(`[${episodeId}] Failed to parse places response, skipping`);
    return;
  }

  if (placeNames.length === 0) {
    console.log(`[${episodeId}] No places found`);
    return;
  }

  // Check D1 for already-known places to avoid re-geocoding
  const { results: existingPlaces } = await db.prepare('SELECT id, name FROM places').all();
  const knownPlaces = new Map(existingPlaces.map(p => [p.name, p.id]));

  const geocoded = [];
  for (const name of placeNames) {
    if (knownPlaces.has(name)) {
      geocoded.push(name);
      continue;
    }
    await sleep(NOMINATIM_DELAY_MS);
    const coords = await geocodePlace(name);
    if (coords) {
      await db.prepare('INSERT OR IGNORE INTO places (name, lat, lng) VALUES (?, ?, ?)')
        .bind(name, coords.lat, coords.lng).run();
      geocoded.push(name);
    } else {
      console.log(`[${episodeId}] Could not geocode: ${name}`);
    }
  }

  if (geocoded.length === 0) {
    console.log(`[${episodeId}] No places geocoded`);
    return;
  }

  // Re-query to get IDs for newly inserted places
  const { results: allPlaces } = await db.prepare('SELECT id, name FROM places').all();
  const placeIdMap = new Map(allPlaces.map(p => [p.name, p.id]));

  await db.prepare('DELETE FROM place_mentions WHERE episode_id = ?').bind(episodeId).run();
  for (const name of geocoded) {
    const placeId = placeIdMap.get(name);
    if (placeId != null) {
      await db.prepare('INSERT OR IGNORE INTO place_mentions (place_id, episode_id) VALUES (?, ?)')
        .bind(placeId, episodeId).run();
    }
  }

  console.log(`[${episodeId}] Seeded ${geocoded.length} places`);
}
```

- [ ] **Step 4: Run `sampleTranscript` tests**

```bash
cd roe-pipeline && npx vitest run test/places.test.js
```

Expected: 3 tests pass (the `extractAndSeedPlaces` tests don't exist yet)

- [ ] **Step 5: Add tests for `extractAndSeedPlaces`**

Append to `roe-pipeline/test/places.test.js`:

```js
describe('extractAndSeedPlaces', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function makeMockDb(initialPlaces = []) {
    const inserted = [...initialPlaces];
    const runs = [];
    return {
      runs,
      prepare: (sql) => ({
        bind: (...args) => ({
          run: async () => {
            runs.push({ sql, args });
            if (sql.includes('INSERT OR IGNORE INTO places')) {
              inserted.push({ id: inserted.length + 1, name: args[0] });
            }
          },
          all: async () => ({ results: [] }),
        }),
        all: async () => ({ results: inserted }),
      }),
    };
  }

  it('skips all work when openaiApiKey is falsy', async () => {
    const db = makeMockDb();
    await extractAndSeedPlaces(db, 'ep-1', [], null);
    expect(db.runs).toHaveLength(0);
  });

  it('skips D1 writes when OpenAI returns empty array', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '[]' } }] }),
    });
    const db = makeMockDb();
    await extractAndSeedPlaces(db, 'ep-1', [{ text: 'no places here' }], 'sk-test');
    expect(db.runs).toHaveLength(0);
  });

  it('inserts geocoded place into D1', async () => {
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '["Dolores Park"]' } }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ lat: '37.7596', lon: '-122.4269' }],
      });

    const db = makeMockDb();
    const p = extractAndSeedPlaces(db, 'ep-1', [{ text: 'We went to Dolores Park' }], 'sk-test');
    await vi.runAllTimersAsync();
    await p;

    const insertPlace = db.runs.find(r => r.sql.includes('INSERT OR IGNORE INTO places'));
    expect(insertPlace).toBeDefined();
    expect(insertPlace.args[0]).toBe('Dolores Park');
    expect(insertPlace.args[1]).toBeCloseTo(37.7596);
    expect(insertPlace.args[2]).toBeCloseTo(-122.4269);
  });

  it('skips places that fail all geocoding strategies', async () => {
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '["Fake Nonexistent Place"]' } }] }),
      })
      .mockResolvedValue({ ok: true, json: async () => [] });

    const db = makeMockDb();
    const p = extractAndSeedPlaces(db, 'ep-1', [{ text: 'some text' }], 'sk-test');
    await vi.runAllTimersAsync();
    await p;

    expect(db.runs.find(r => r.sql.includes('INSERT OR IGNORE INTO places'))).toBeUndefined();
  });

  it('skips geocoding for already-known places', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '["Golden Gate Park"]' } }] }),
    });

    // Golden Gate Park is already in DB
    const db = makeMockDb([{ id: 1, name: 'Golden Gate Park' }]);
    const p = extractAndSeedPlaces(db, 'ep-1', [{ text: 'Golden Gate Park today' }], 'sk-test');
    await vi.runAllTimersAsync();
    await p;

    // fetch should only be called once (OpenAI), not twice (OpenAI + Nominatim)
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0]).toContain('openai.com');
  });
});
```

- [ ] **Step 6: Run all places tests**

```bash
cd roe-pipeline && npx vitest run test/places.test.js
```

Expected: 8 tests pass

- [ ] **Step 7: Commit**

```bash
cd /path/to/roe-episode-search
git add roe-pipeline/src/places.js roe-pipeline/test/places.test.js
git commit -m "feat: add places extraction module for cloud pipeline"
```

---

### Task 2: Wire `extract-places` into `pipeline.js`

**Files:**
- Modify: `roe-pipeline/src/pipeline.js`

- [ ] **Step 1: Add the import**

At the top of `roe-pipeline/src/pipeline.js`, add after the existing imports:

```js
import { extractAndSeedPlaces } from './places.js';
```

- [ ] **Step 2: Change `summary` step to advance to `extract-places`**

Find this line in the `summary` case:

```js
await this.advanceStep('set-audio-url');
```

Change it to:

```js
await this.advanceStep('extract-places');
```

- [ ] **Step 3: Add the `extract-places` case**

Add this case after the `summary` case and before `set-audio-url`:

```js
case 'extract-places': {
  const segments = await this.loadSegments();
  try {
    await extractAndSeedPlaces(this.env.DB, episodeId, segments, this.env.OPENAI_API_KEY);
  } catch (err) {
    console.error(`[${episodeId}] Places extraction failed (soft): ${err.message}`);
  }
  await this.advanceStep('set-audio-url');
  break;
}
```

- [ ] **Step 4: Run all tests**

```bash
cd roe-pipeline && npx vitest run
```

Expected: all tests pass

- [ ] **Step 5: Commit**

```bash
cd /path/to/roe-episode-search
git add roe-pipeline/src/pipeline.js
git commit -m "feat: add extract-places step to cloud pipeline"
```

---

### Task 3: Update README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace "How it works" paragraph**

Find:

```markdown
Audio files are transcribed locally using whisper.cpp (large-v3 model with Silero VAD), stored in a SQLite database with full-text search (FTS5), and served via a Cloudflare Worker. Two search modes are available: **Keyword** finds exact word matches via FTS5, while **Semantic** finds conceptually related segments via vector embeddings (Cloudflare Vectorize + Workers AI). Click any result to play the audio from that exact moment.
```

Replace with:

```markdown
Audio files are uploaded to Cloudflare R2. An R2 event notification triggers the `roe-pipeline` Cloudflare Worker, which runs the full processing pipeline via a Durable Object: transcription (OpenAI Whisper API), D1 seeding, vector embeddings, AI title/summary/guest extraction (GPT-4o-mini), SF place geocoding (Nominatim), and audio URL linking. The resulting data is served via a second Cloudflare Worker (`roe-search`) with keyword search (FTS5) and semantic search (Vectorize). Click any result to play the audio from that exact moment.
```

- [ ] **Step 2: Replace the pipeline data-flow diagram**

Find:

```
### Data flow for a single episode

```
episode.mp3
    │
    └──► process-episode.js
              │
              ├── 1. whisper.cpp + VAD ──► transcripts/episode.json
              ├── 2. seed-db ──► D1 (episodes + transcript_segments + FTS index)
              ├── 3. embeddings ──► Vectorize (45s vector chunks)
              ├── 4. title + summary ──► D1 (AI-generated via GPT-4o-mini)
              └── 5. upload ──► ffmpeg (MP3 → M4A) ──► R2
```
```

Replace with:

````markdown
### Data flow for a single episode

```
Upload episode.mp3 to R2
    │
    └──► R2 event notification ──► roe-pipeline-queue ──► EpisodePipeline DO
              │
              ├── 1. transcribe ──► OpenAI Whisper API (chunked for large files)
              ├── 2. seed-db ──► D1 (episodes + transcript_segments + FTS5)
              ├── 3. embeddings ──► Cloudflare Vectorize (45s chunks)
              ├── 4. summary ──► GPT-4o-mini ──► D1 (title, summary, guests)
              ├── 5. extract-places ──► GPT-4o-mini + Nominatim ──► D1 (places, place_mentions)
              └── 6. set-audio-url ──► D1 (links episode to R2 MP3 URL)
```
````

- [ ] **Step 3: Replace "Processing episodes" section under Setup**

Find:

```markdown
### Processing episodes

```bash
# Process a single episode (transcribe → D1 → embeddings → title/summary → R2)
node scripts/process-episode.js /path/to/episode.mp3

# Process all episodes in batch
node scripts/process-all.js "/path/to/All episodes/" --cooldown 120

# Deploy
cd roe-search && npx wrangler deploy
```

Each step is idempotent — safe to re-run, skips already-processed episodes.
```

Replace with:

````markdown
### Processing a new episode

Upload the MP3 to the `roe-audio` R2 bucket — the pipeline triggers automatically:

```bash
# Via wrangler CLI:
npx wrangler r2 object put roe-audio/"Roll Over Easy 2026-04-02.mp3" \
  --file="/path/to/Roll Over Easy 2026-04-02.mp3"
```

Processing takes ~10–15 minutes for a 2-hour episode. Check status:

```bash
curl "https://roe-pipeline.christophersbunting.workers.dev/status?key=Roll%20Over%20Easy%202026-04-02.mp3"
# {"status":"completed"} when done
```

To manually re-trigger (e.g. after a pipeline fix), delete the episode from D1 first to clear the dedup check, then POST to `/process`:

```bash
# Delete episode (if partially seeded)
TOKEN=<your-cloudflare-api-token>
curl -X POST "https://api.cloudflare.com/client/v4/accounts/c300f1dedb1ae128ce63852774e32976/d1/database/cc7207a0-a581-4d3a-9c8f-12597b1ab46d/query" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"sql": "DELETE FROM episodes WHERE id = '"'"'roll-over-easy_YYYY-MM-DD_07-30-00'"'"'"}'

# Re-trigger
curl -X POST "https://roe-pipeline.christophersbunting.workers.dev/process?key=Roll%20Over%20Easy%20YYYY-MM-DD.mp3"
```

### Batch processing (historical backfill only)

For processing large numbers of older episodes locally:

```bash
# Process a single episode locally
node scripts/process-episode.js /path/to/episode.mp3

# Process all episodes in batch with checkpoint/resume
node scripts/process-all.js "/path/to/All episodes/" --cooldown 120
```
````

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: update README for cloud pipeline with places extraction"
```

---

### Task 4: Deploy, verify, and push

- [ ] **Step 1: Deploy `roe-pipeline`**

```bash
cd roe-pipeline && npx wrangler deploy
```

Expected: `Deployed roe-pipeline triggers` with a new Version ID

- [ ] **Step 2: Verify with a fresh test trigger**

The April 2 episode's DO is already `completed` so it won't re-run automatically. Confirm the new step would appear by checking the pipeline source code deployed correctly:

```bash
curl -s https://roe-pipeline.christophersbunting.workers.dev/
# Expected: {"service":"roe-pipeline","status":"ok"}
```

- [ ] **Step 3: Push all commits**

```bash
cd /path/to/roe-episode-search && git push
```

Expected: all 4 commits pushed to `main`
