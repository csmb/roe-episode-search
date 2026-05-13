# ROE Episode Search

An archive of the Roll Over Easy podcast. Browse episodes, explore guests, and discover places mentioned on the show. Transcript search (FTS5 + Cloudflare Vectorize) is available behind the password-protected admin page.

**Live:** https://rollovereasy.org

## How it works

Audio files are uploaded to Cloudflare R2. An R2 event notification triggers the `roe-pipeline` Cloudflare Worker, which runs the full processing pipeline via a Durable Object: transcription (OpenAI Whisper API), D1 seeding, vector embeddings, AI title/summary/guest extraction (GPT-4o-mini), SF place geocoding (Nominatim), and audio URL linking. The resulting data is served via a second Cloudflare Worker (`roe-search`) with keyword search (FTS5) and semantic search (Vectorize). Click any result to play the audio from that exact moment.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                          Pipeline                                │
│                                                                  │
│  Local MP3s ──► whisper.cpp ──► JSON transcripts                 │
│       │        (process-episode.js)                              │
│       │                           │                              │
│       │                    ┌──────┴──────┐                       │
│       │                    ▼             ▼                       │
│       │             Cloudflare D1   Cloudflare Vectorize         │
│       │          (+ titles/summaries)  (embeddings)              │
│       │                    │             │                       │
│       ▼                    ▼             ▼                       │
│  Cloudflare R2            Cloudflare Worker                      │
│  (audio storage)      (search API + frontend)                    │
└──────────────────────────────────────────────────────────────────┘
```

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

### Components

**Cloudflare Worker** (`roe-search/src/index.js`) — serves the frontend and handles all API routes: keyword search (FTS5), semantic search (Vectorize), timeline data, episode/guest listings, and audio proxying from R2 with range request support.

**Cloudflare D1** — SQLite database with episode metadata, timestamped transcript segments, an FTS5 virtual table, and guest-episode links.

**Cloudflare Vectorize** — Vector database storing embeddings of 45-second transcript chunks (768 dimensions, cosine similarity).

**Cloudflare R2** — Audio files converted to M4A (AAC with faststart) for reliable browser streaming and seeking.

**Frontend** — Six inline HTML pages: homepage (`frontend.html`), episode browser (`episodes.html`), guest directory (`guests.html`), password-protected admin panel with transcript search (`admin.html`), places map (`map.html`), and Stellar Lexicon (`stars.html`).

### Map endpoint

The map is a self-contained slice of the worker: two routes, two D1 tables, one HTML file. There is no separate map service, no build step, and no tile server of our own.

#### Routes

Both are served by `roe-search/src/index.js`:

| Route | Handler | Purpose |
|---|---|---|
| `GET /map` | inline | Returns the imported `map.html` as `text/html`. No params, no auth, no rate limit. |
| `GET /api/map-places` | `handleMapPlaces` | Returns every geocoded place plus its episode list in a single JSON payload. |

`/api/map-places` runs two D1 queries and joins them in JS:

1. **Aggregate** — `places` JOIN `place_mentions` GROUPed by `p.id`, ordered by `episode_count DESC`. One row per place with its count.
2. **Mentions** — `place_mentions` JOIN `episodes` to pull episode titles for every mention.

The handler builds a `place_id → [{id, title}, ...]` map in memory, attaches the episode list onto each place row, and returns:

```json
{
  "places": [
    { "name": "Tartine", "lat": 37.76, "lng": -122.42, "episode_count": 7, "episodes": [{"id": "...", "title": "..."}, ...] }
  ],
  "total_mentions": 1234
}
```

The dataset is small (hundreds of places, thousands of mentions), so there's no pagination, no spatial index, no caching layer. One query, one response, every load.

#### Data model

Two tables in D1 back the map (`schema.sql`):

- `places(id, name UNIQUE, lat, lng)` — one row per geocoded SF location. The `UNIQUE` constraint on `name` is what keeps "Tartine" from getting two rows.
- `place_mentions(place_id, episode_id)` — composite primary key, so a place mentioned twice in one episode still counts as one mention.

These are populated by step 5 of the episode pipeline (`extract-places`). The Durable Object asks GPT-4o-mini for SF place names in the transcript, then geocodes each unique name through Nominatim inside an SF bounding box at 1 request/second. Hits get inserted into `places`; the `(place, episode)` pairs go into `place_mentions`. Misses are dropped silently — the map only shows places that successfully geocoded.

#### Frontend (`map.html`)

A single static HTML file with everything inline. Loaded straight from the worker; no framework, no bundler. Dependencies pulled from unpkg at runtime:

- **Leaflet 1.9.4** — map, markers, popups
- **Fuse.js 7.0.0** — fuzzy place-name search
- **CARTO Voyager raster tiles** — base layer

The lifecycle is dead simple:

1. `loadPlaces()` fetches `/api/map-places` once on page load.
2. For each place it creates a `L.circleMarker`. Radius is sqrt-scaled by episode count against the dataset max (6px–28px) — sqrt because area, not radius, should feel proportional to magnitude.
3. Each marker gets a popup with the place name, mention count, and a date-descending list of episode links that deep-link back to `frontend.html` via `?episode=<id>`.
4. The places array is handed to Fuse.js (`keys: ['name']`, `threshold: 0.4`, `ignoreLocation: true`) to power the search box.

Interaction details worth knowing:

- **Hover popups on desktop only.** The code feature-detects `(hover: hover) and (pointer: fine)`. Desktop opens the popup on `mouseover` and closes it on `mouseout` with a 300ms grace timer so the cursor can travel from marker to popup without dismissing it. Mobile keeps Leaflet's default click-to-open behavior.
- **Search.** Debounced 80ms. Renders a dropdown of up to 8 hits; the first row is pre-highlighted as "active." Arrow keys move the active row, Enter selects it, Escape clears the box. Pressing `/` anywhere outside an input focuses the search field.
- **Selection.** Search resolves a name → marker via a `markersByName` Map (O(1)), then `map.flyTo(latlng, 17, { duration: 0.6 })` and `marker.openPopup()`.

#### Why this shape

The map endpoint is intentionally the cheapest possible architecture for the dataset size:

- **One round-trip.** Hundreds of points fit comfortably in a single JSON payload, so there's no need for viewport-based loading or vector tiles.
- **No server-side rendering.** The worker just hands back the static HTML; all rendering happens in the browser against the JSON.
- **No cache layer.** D1 reads at the edge are fast enough for the query volume; if traffic grew, the next step would be putting Cloudflare Cache in front of `/api/map-places`, not restructuring the data.

### Scripts

All scripts are in `scripts/` and run locally with Node.js:

| Script | Purpose |
|---|---|
| `process-episode.js` | **Primary pipeline.** Transcribe, seed D1, generate embeddings, generate title + summary, upload audio. |
| `process-all.js` | Batch runner with checkpoint/resume, cooldown, retries, and quality gates. |
| `discover-episodes.js` | Scan an audio directory, parse filenames, deduplicate by date. |
| `rename-episodes.js` | Normalize MP3 filenames to `Roll Over Easy YYYY-MM-DD.mp3`. Dry-run by default. |
| `audit-episodes.js` | Audit for non-Thursday dates, missing Thursdays, duplicates, unparseable filenames. |
| `clean-hallucinations.js` | Remove hallucinated repeated-phrase segments from D1. |
| `generate-manifest.js` / `manifest-status.js` | Build and inspect the episode manifest. |

### Batch processing

```bash
# Preview what will be processed
node scripts/discover-episodes.js "/path/to/All episodes/"

# Process everything (with checkpoint/resume)
node scripts/process-all.js "/path/to/All episodes/" --cooldown 120

# Process a specific date range
node scripts/process-all.js "/path/to/All episodes/" --start-from 2025-01-01 --max 10

# Dry run
node scripts/process-all.js "/path/to/All episodes/" --dry-run
```

The batch runner supports checkpoint/resume via `scripts/batch-progress.json`, so it can be stopped and restarted at any time.

## Setup

### Prerequisites

- Node.js >= 18
- ffmpeg installed (`brew install ffmpeg`)
- whisper-cli installed (`brew install whisper-cpp`) with large-v3 model
- Silero VAD model (`~/.cache/whisper-cpp/ggml-silero-v6.2.0.bin`)
- Cloudflare account with Wrangler authenticated (`npx wrangler login`)

### Environment variables

Create a `.env` file in the project root (auto-loaded by the pipeline scripts):

```
CLOUDFLARE_ACCOUNT_ID=your-account-id
CLOUDFLARE_API_TOKEN=your-api-token
OPENAI_API_KEY=your-openai-key
```

The Cloudflare API token needs permissions for D1, R2, Vectorize, and Workers AI. The OpenAI key is used for generating episode titles and summaries (GPT-4o-mini).

### First-time setup

```bash
# Install dependencies
npm install
cd roe-search && npm install && cd ..

# Create D1 database (already done — ID is in wrangler.jsonc)
# npx wrangler d1 create roe-episodes

# Create Vectorize index (already done)
# npx wrangler vectorize create roe-transcripts --dimensions=768 --metric=cosine

# Apply schema
cd roe-search
npx wrangler d1 execute roe-episodes --remote --file=../schema.sql
cd ..
```

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

### Local development

```bash
cd roe-search
npx wrangler dev
# Visit http://localhost:8787
```

