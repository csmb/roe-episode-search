# Places Extraction — Cloud Pipeline Design

**Date:** 2026-04-02
**Status:** Approved

## Background

The local `scripts/process-episode.js` pipeline extracts SF place names from episode transcripts, geocodes them, and seeds `places` + `place_mentions` in D1. The cloud `roe-pipeline` worker handles all new episodes but was missing this step, so episodes processed via R2 upload had no map data.

## Goal

Add places extraction as a step in the `roe-pipeline` Durable Object so future episodes automatically get place data without any local script involvement.

## Architecture

New file `src/places.js` exports a single function following the same pattern as `src/summary.js`. The Durable Object `pipeline.js` gains a new `extract-places` alarm step between `summary` and `set-audio-url`.

### Step order

```
transcribe → seed-db → embeddings → summary → extract-places → set-audio-url
```

### Soft-fail behavior

Places extraction is best-effort. The `extract-places` case in the alarm wraps `extractAndSeedPlaces()` in its own try/catch — on any error it logs the failure and calls `advanceStep('set-audio-url')` so the episode still completes.

## `src/places.js`

**Signature:** `extractAndSeedPlaces(db, episodeId, segments, openaiApiKey)`

### Transcript sampling

For episodes with fewer than 50 segments, join all segment text. For longer episodes, sample 5 evenly-spaced windows of up to 200 segments each, skipping the first 5% of the episode (typically music/intro), capped at 12,000 characters total. This mirrors the local script exactly.

### Place name extraction

POST to `https://api.openai.com/v1/chat/completions` with model `gpt-4o-mini`, temperature 0, max_tokens 1000, using `PLACES_SYSTEM_PROMPT` (copied verbatim from `scripts/process-episode.js`). Response is a JSON array of normalised SF place name strings. Strip markdown code fences before parsing. Return `[]` on parse failure (soft-fail at this sub-step).

### Geocoding

For each extracted place name, call Nominatim with four fallback strategies (same as local script):

1. Bounded SF search (`bounded=1`)
2. Intersection reformat (split on `&`/` and `, rejoin)
3. First street only (for intersections)
4. Unbounded with lat/lng validation (`37.7–37.84`, `-122.52–-122.35`)

Rate limit: 1,100ms `setTimeout` delay between each Nominatim request. Skip places with no geocode result.

Before geocoding a name, check D1's `places` table — if the place already exists, reuse its coords rather than calling Nominatim. This avoids re-geocoding well-known recurring places across episodes.

### D1 writes

1. `DELETE FROM place_mentions WHERE episode_id = ?` (idempotent)
2. For each geocoded place: `INSERT OR IGNORE INTO places (name, lat, lng) VALUES (?, ?, ?)`
3. `SELECT id, name FROM places` — build name→id map
4. `INSERT OR IGNORE INTO place_mentions (place_id, episode_id) VALUES (?, ?)` — one row per place

### Missing API key

If `openaiApiKey` is falsy, log a warning and return without throwing (consistent with local script).

## `pipeline.js` changes

- Import `extractAndSeedPlaces` from `./places.js`
- Add `'extract-places'` case in the alarm switch:

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

- Change `summary` case's `advanceStep` call from `'set-audio-url'` to `'extract-places'`

## No config changes needed

`OPENAI_API_KEY` is already set as a Worker secret. All required D1 bindings exist. No `wrangler.jsonc` changes.

## Out of scope

- `guest_start_ms` detection (not requested)
- Changes to the local `scripts/process-episode.js` pipeline
- Backfilling places for existing episodes processed before this change
