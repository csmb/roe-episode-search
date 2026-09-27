# ROE Episode Search

An archive of the Roll Over Easy podcast. Browse episodes, explore guests, and discover places mentioned on the show. There is no public search box: transcript search (FTS5 + Cloudflare Vectorize) is on the password-protected admin page, though its API routes (`/api/search`, `/api/semantic-search`) are open.

**Live:** https://rollovereasy.org

## How it works

New episodes arrive by drag and drop: an MP3 uploaded to the `roe-audio` R2 bucket triggers the `roe-pipeline` Cloudflare Worker, whose Durable Object runs every step: transcription (OpenAI Whisper API), the title, summary and guests (GPT-4o-mini), one D1 write of the finished episode, vector embeddings, the "Skip to interview" time, SF places (GPT-4o-mini + Nominatim) and place sentiment. A second Worker (`roe-search`) serves the site and its API, with keyword search (FTS5) and semantic search (Vectorize) on the admin page; any search result plays the audio from that moment. The local scripts in `scripts/` did the historical backfill with whisper.cpp.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                          Pipeline                                │
│                                                                  │
│  MP3 upload ──► Cloudflare R2 ──► roe-pipeline Worker            │
│  (drag and drop)   (audio)        (Whisper API, GPT-4o-mini)     │
│                                          │                       │
│                                   ┌──────┴──────┐                │
│                                   ▼             ▼                │
│                            Cloudflare D1   Cloudflare Vectorize  │
│                         (episodes, lines,    (embeddings)        │
│                          guests, places)        │                │
│                                   │             │                │
│                                   ▼             ▼                │
│                           roe-search Worker (site + API)         │
│                                                                  │
│  Historical backfill: scripts/process-episode.js (whisper.cpp)   │
│  wrote to the same D1, Vectorize and R2.                         │
└──────────────────────────────────────────────────────────────────┘
```

### Data flow for a single episode

```
Upload "Roll Over Easy YYYY-MM-DD.mp3" to R2
    │
    └──► R2 event notification ──► roe-pipeline-queue ──► EpisodePipeline DO (one per file name)
              │
              ├── 1. transcribe ──► OpenAI Whisper API, one six-minute chunk per alarm;
              │                     holes of 5+ min are re-sent as 3-minute clips
              ├── 2. summary ──► GPT-4o-mini (title, summary, guests found in the transcript)
              ├── 3. seed-db ──► D1 in one transaction: the episode row with its title, summary
              │                  and MP3 link, transcript_segments (+ FTS5), and guests
              ├── 4. embeddings ──► Cloudflare Vectorize (45s chunks)
              ├── 5. guest-start ──► D1 ("Skip to interview" time)
              ├── 6. extract-places ──► GPT-4o-mini + Nominatim ──► D1 (places, place_mentions)
              ├── 7. score-places ──► GPT-4o-mini ──► D1 (sentiment, quotes, narratives)
              └── 8. finalize ──► clears the Durable Object's working storage
```

Nothing reaches the site until step 3 writes the finished episode. Steps 4–7 only
enrich it: if one keeps failing, the run records a warning (see `/status`) and carries
on. A failed step is retried after 1, 5 and 15 minutes, except for errors a retry can't
fix (a 4xx from OpenAI, an empty transcript, a missing file), which fail the run at once.
Progress is saved after every chunk and step, so a crash or deploy mid-run costs one
chunk at most, and the run can be resumed (see "Processing a new episode").

### Components

**Cloudflare Worker** (`roe-search/src/index.js`) — serves the frontend and handles all API routes: keyword search (FTS5), semantic search (Vectorize), episode/guest/place listings, and audio proxying from R2 with range request support.

**Cloudflare D1** — SQLite database with episode metadata, timestamped transcript segments, an FTS5 virtual table, and guest-episode links.

**Cloudflare Vectorize** — Vector database storing embeddings of 45-second transcript chunks (768 dimensions, cosine similarity).

**Cloudflare R2** — The uploaded MP3s, plus an M4A (AAC with faststart) for each episode processed locally or repaired with `scripts/repair-missing-m4a.js`. A new drag-and-drop episode starts with only its MP3, which `/audio/{id}.m4a` serves until an M4A exists.

**Frontend** — Five inline HTML pages: homepage (`frontend.html`), episode browser (`episodes.html`), guest directory (`guests.html`, not linked from the menu), password-protected admin panel with transcript search (`admin.html`), and places map (`map.html`).

### Map endpoint

The map is a self-contained slice of the worker: a few routes, three D1 tables, one HTML file. There is no separate map service, no build step, and no tile server of our own.

#### Routes

Both are served by `roe-search/src/index.js`:

| Route | Handler | Purpose |
|---|---|---|
| `GET /map` | inline | Returns the imported `map.html` as `text/html`. No params, no auth, no rate limit. |
| `GET /api/map-places` | `handleMapPlaces` | Returns every geocoded place plus its episode list in a single JSON payload. |
| `GET /api/place-detail?name=` | `handlePlaceDetail` | One place: each episode's sentiment score and label, a quote with its start time (for `/?episode=…&t=` links), and the place's narrative. `/map?place=` opens it directly. |
| `GET /api/episode/{id}/places` | `handleEpisodePlaces` | The places one episode mentions, for the mini-maps on episode cards. |

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

The dataset is small (about 1,600 places and 10,500 mentions in September 2026), so there's no pagination, no spatial index, no caching layer. One query, one response, every load.

#### Data model

Three tables in D1 back the map (`schema.sql`):

- `places(id, name UNIQUE, lat, lng)` — one row per geocoded SF location. The `UNIQUE` constraint on `name` is what keeps "Tartine" from getting two rows.
- `place_mentions(place_id, episode_id, sentiment, sentiment_label, snippet, snippet_start_ms, analyzed_at)` — composite primary key, so a place mentioned twice in one episode still counts as one mention. The other columns hold how the hosts talked about the place in that episode, with a quote and its start time.
- `place_narratives(place_id, early_text, recent_text, arc_text, episode_count, year_min, year_max, generated_at)` — how the hosts' take on a place changed, written for places in 3+ episodes across 2+ years.

These are populated by steps 6 and 7 of the episode pipeline. `extract-places` asks GPT-4o-mini for the SF place names in the whole transcript (after the intro), keeps only names the transcript actually mentions (GPT otherwise copies the examples in its prompt), then geocodes each new name through Nominatim inside an SF bounding box at 1 request/second. Hits get inserted into `places`; the `(place, episode)` pairs go into `place_mentions`. Misses are dropped — the map only shows places that successfully geocoded. `score-places` then fills in the sentiment columns and refreshes the narratives of the places involved.

#### Frontend (`map.html`)

A single static HTML file with everything inline. Loaded straight from the worker; no framework, no bundler. Dependencies pulled from unpkg at runtime:

- **Leaflet 1.9.4** — map, markers, popups
- **Fuse.js 7.0.0** — fuzzy place-name search
- **Esri Light Gray Canvas raster tiles** — base layer (keyless; native tiles to z16, Leaflet upscales past that). Replaced CARTO Voyager after CARTO began watermarking anonymous tiles with "API KEY REQUIRED".

The lifecycle is dead simple:

1. `loadPlaces()` fetches `/api/map-places` once on page load.
2. For each place it creates a `L.circleMarker`. Radius is sqrt-scaled by episode count against the dataset max (6px–28px) — sqrt because area, not radius, should feel proportional to magnitude.
3. Each marker gets a popup with the place name, mention count, and a date-descending list of episode links that deep-link back to `frontend.html` via `?episode=<id>`.
4. The places array is handed to Fuse.js (`keys: ['name']`, `threshold: 0.4`, `ignoreLocation: true`) to power the search box.

Interaction details worth knowing:

- **Hover popups on desktop only.** The code feature-detects `(hover: hover) and (pointer: fine)`. Desktop opens a summary popup on `mouseover` and closes it on `mouseout` with a 300ms grace timer so the cursor can travel from marker to popup without dismissing it. A click (a tap on phones) opens the place's details: a popup on desktop, a bottom sheet at 640px and below.
- **Search.** Debounced 80ms. Renders a dropdown of up to 8 hits; the first row is pre-highlighted as "active." Arrow keys move the active row, Enter selects it, Escape clears the box. Pressing `/` anywhere outside an input focuses the search field.
- **Selection.** Search resolves a name → marker via a `markersByName` Map (O(1)), then flies there (`map.flyTo(latlng, 17, { duration: 0.6 })`) and opens the place the same way a marker click and a `?place=` link do.

#### Why this shape

The map endpoint is intentionally the cheapest possible architecture for the dataset size:

- **One round-trip.** Hundreds of points fit comfortably in a single JSON payload, so there's no need for viewport-based loading or vector tiles.
- **No server-side rendering.** The worker just hands back the static HTML; all rendering happens in the browser against the JSON.
- **No cache layer.** D1 reads at the edge are fast enough for the query volume; if traffic grew, the next step would be putting Cloudflare Cache in front of `/api/map-places`, not restructuring the data.

### Scripts

All scripts are in `scripts/` and run locally with Node.js:

| Script | Purpose |
|---|---|
| `process-episode.js` | The local whisper.cpp path used for the historical backfill: transcribe, seed D1, embeddings, title + summary, "Skip to interview", .m4a upload. No places or sentiment; new episodes use the drag-and-drop pipeline. |
| `process-all.js` | Batch runner with checkpoint/resume, cooldown, retries, and quality gates. |
| `discover-episodes.js` | Scan an audio directory, parse filenames, deduplicate by date. |
| `clean-hallucinations.js` | Remove hallucinated repeated-phrase segments from D1. |
| `delete-episode.js` | Remove an episode from D1, Vectorize, R2 and its local transcript. |
| `repair-missing-m4a.js` | Make and upload the .m4a for episodes that only have their MP3. |

Retired one-off scripts (the April map build, old archive tools) are kept in `scripts/archive/` for reference only; its README says which must not be run again.
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

- Node.js 24.2 or later (the scripts use `import.meta.main`)
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

Drag the MP3 into the `roe-audio` R2 bucket in the Cloudflare dashboard, named `Roll Over Easy YYYY-MM-DD.mp3`. The pipeline starts by itself. (`npx wrangler r2 object put roe-audio/"Roll Over Easy 2026-04-02.mp3" --file=…` works too.)

Processing takes ~10–15 minutes for a 2-hour episode. Check status:

```bash
# PIPELINE_TOKEN is in the project .env (the same value is a Worker secret)
curl -H "Authorization: Bearer $PIPELINE_TOKEN" \
  "https://roe-pipeline.christophersbunting.workers.dev/status?key=Roll%20Over%20Easy%202026-04-02.mp3"
```

`status` is `processing`, `failed` or `completed`. While it runs you also see the `step`, its `attempt`, `progress` (chunks and bytes transcribed) and the `lastError` it's waiting to retry. `warnings` lists extras that were skipped, and `holes` any stretches of 5+ minutes still without transcript.

If a run fails (OpenAI down for half an hour, say), fix the cause and ask it to carry on. It resumes at the failed step, without paying to transcribe again:

```bash
curl -X POST -H "Authorization: Bearer $PIPELINE_TOKEN" \
  "https://roe-pipeline.christophersbunting.workers.dev/process?key=Roll%20Over%20Easy%20YYYY-MM-DD.mp3"
```

Uploading the same file again does the same thing. A run that has been silent for an hour counts as stuck and resumes the same way; add `&force=1` to wake one sooner, or `&restart=1` to start over from scratch (only before the episode is published).

To redo an episode that's already on the site, delete it first, then POST `/process` as above:

```bash
node scripts/delete-episode.js roll-over-easy_YYYY-MM-DD_07-30-00
```

`delete-episode.js` finds an episode's search entries from its local transcript file, which drag-and-drop episodes don't have; their old entries stay in Vectorize for now. The site plays the MP3 until `node scripts/repair-missing-m4a.js --only <id>` makes the .m4a again.

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
npx wrangler dev --port 8791
# Visit http://roe.localhost:8791 (its own origin, so no cookies or storage shared with other projects)
node smoke-test.mjs http://roe.localhost:8791   # the post-deploy route check, against the local copy
```

