# ROE Episode Search

An archive of the Roll Over Easy podcast. Browse episodes, explore guests, and discover places mentioned on the show. There is no public search: transcript search (FTS5 + Cloudflare Vectorize) is on the password-protected admin page, and its API routes (`/api/search`, `/api/semantic-search`) need the admin password too.

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
    └──► R2 event notification ──► roe-pipeline-queue ──► EpisodePipeline DO (one per show date)
              │
              ├── 0. wait ──► 10 minutes after the last upload for that date; a show that came
              │               in parts is then joined into one MP3 (joined/Roll Over Easy YYYY-MM-DD.mp3)
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

**Cloudflare Worker** (`roe-search/src/index.js`) — serves the frontend and handles all API routes: keyword search (FTS5), semantic search (Vectorize), episode/guest/place listings, and audio proxying from R2 with range request support. API requests are rate limited per IP by Cloudflare's rate-limiting bindings (`ratelimits` in `roe-search/wrangler.jsonc`), with a budget per kind of route each minute: 30 keyword searches, 10 semantic searches, 120 for the pages' lists and details (map places, place detail, episodes, guests, On This Day) and 1,000 for `/api/episode/…`, which `/episodes` calls once per card as you scroll. The public feeds `/api/episodes/latest` and `/api/episodes/stats`, the pages and `/audio` are not limited. The admin password (on `/api/admin/…` and the two search routes) has its own limit: after 5 wrong passwords in a minute, that visitor's password requests are refused for 15 minutes, the right password included. A request with no password isn't counted.

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
- **Browser cache only.** `/api/map-places` (about 1 MB) is sent with `Cache-Control: public, max-age=3600`, so a repeat visit within the hour costs no download and no queries. D1 reads at the edge are fast enough for the query volume; if traffic grew, the next step would be putting Cloudflare Cache in front of it, not restructuring the data.

### Scripts

All scripts are in `scripts/` and run locally with Node.js:

| Script | Purpose |
|---|---|
| `process-episode.js` | One episode through the local pipeline: transcribe (whisper.cpp, or `--engine openai` for the Cloudflare pipeline's own Whisper code), seed D1, embeddings, title + summary, "Skip to interview", .m4a upload. whisper.cpp gets a one-second test run first and a time limit, since its GPU start-up can hang on this Mac (`--no-gpu` runs it on the CPU, about 2.5x the recording's length). It uses the Worker's code for cleaning, loops, summaries, embeddings and interview times, so both pipelines agree. The seed step refuses a transcript that ends past its recording or stops before 90% of it (`--accept-short` to seed one anyway), re-seeds when D1 holds a different transcript, and gives the episode the recording's real length; it replaces the lines in one D1 import (`wrangler d1 execute --file`), so a crash leaves the old transcript or the new one, never part of one (production D1 answers no other queries for the few seconds an import takes). With `--episode-id` and transcribe, seed-db and upload-audio skipped, no audio file is needed (e.g. to redo an episode's embeddings). No places or sentiment; new episodes use the drag-and-drop pipeline. |
| `repair-archive.js` | Redo damaged transcripts from a worklist, checking each new one before it replaces the live one; see "Repairing damaged transcripts" below. |
| `scan-transcripts.js` | Read-only scan of the transcripts in D1 for loops, holes, early stops, wrong-language lines, prompt echoes and wrong durations (`--m4a` measures each .m4a too; `--json` keeps the findings to compare scans). |
| `clean-junk-lines.js` | Delete junk lines in D1 by rule (the prompt read back, loop repeats, optionally wrong-language openings), back the episode up first and redo its embeddings; a dry run unless `--yes`. |
| `fill-interview-times.js` | After a repair: propose the "Skip to interview" time where it is empty, the old 60:00 placeholder or the old sign-off pick (a show's last 10 minutes), from the lines D1 has now; every other time stays. A dry run (the list, with the line at each time) unless `--yes`, which backs up first. See "After a repair" below. |
| `reanchor-place-quotes.js` | After a repair (or on every show, `--all`): move the map's place-quote times to where each quote is in the transcript; a quote not found keeps its time. A dry run unless `--yes`, which backs up first. |
| `fix-spellings.js` | Apply the word corrections (`WORD_CORRECTIONS` in `roe-pipeline/src/clean-segments.js`, which both pipelines use on new transcripts) to the lines D1 already has, e.g. after adding one. A dry run unless `--yes`, which backs up first; then redo those episodes' search entries with the `generate-embeddings.js --only` command it prints. |
| `transcribe.js` | Transcribe one MP3 with OpenAI Whisper using the pipeline's code (six-minute chunks, gap retries, cleaning): `node scripts/transcribe.js <file.mp3> <episode-id>`. A failed chunk is retried, and progress is saved after every chunk, so a crash resumes without paying twice. About $0.72 for a two-hour show. |
| `transcribe-all.js` | The same for every show in an archive folder that has no transcript yet (split shows are skipped and listed). |
| `generate-embeddings.js` | Make episodes' search vectors exactly the windows of their lines in D1, with the pipeline's code (see "Rebuilding the search index"). A dry run unless `--yes`: `--only <id>[,<id>…]` or `--all` (every D1 episode), `--orphans` for vectors whose episode is gone, `--resume` to carry on a stopped run. |
| `generate-summaries.js` | Titles, summaries and guests with the pipeline's prompt and checks, for episodes missing a summary (`--force`, `--include-reviewed`, `--dry-run`). |
| `rewrite-summaries.js` | Rewrite only the summary text of some episodes (`--only`, or `--from-repair`: those the transcript repair finished) from their transcript in D1, with GPT-4o-mini (`--engine openai`, paid) or a local model through Ollama (`--engine ollama`, free). Titles, guests, reviewed flags and interview times stay, reviewed episodes included. A dry run unless `--yes`; see "New summaries for repaired episodes". |
| `process-all.js` | Batch runner with checkpoint/resume, cooldown, retries, and quality gates. Leaves episodes already complete on the site alone. When the gate rejects a transcript it tries the date's next recording, if there is one; a date whose every recording was rejected is skipped until a new or changed file for it appears (rejected transcripts go to `transcripts/.rejected/`). |
| `discover-episodes.js` | Scan an audio directory, parse filenames, deduplicate by date. A date recorded as several different files is skipped and listed as `MULTI-PART` (join the parts first); for any other date it also lists the date's other recordings to fall back on (a file the size of another is a copy and is left out). |
| `clean-hallucinations.js` | Delete Whisper's repetition loops from episodes already in D1, with the pipelines' loop check (each looping line keeps its first copy). |
| `delete-episode.js` | Back up an episode, then remove it from D1 and Vectorize: every vector whose ID starts with the episode's (a dry run without `--yes`; `--delete-audio` also removes its .m4a; `--local` leaves Vectorize alone). |
| `merge-episode.js` | Merge a same-date duplicate into the canonical episode: backs up both, gives the canonical the duplicate's transcript and `--mp3` as its audio (refused if the transcript runs past the MP3's end), keeps reviewed titles, summaries, guests and interview times, then deletes the duplicate and all its vectors. |
| `episode-backup.js` | Back up one episode (D1 rows, every search vector listed under its ID, local transcript, with `--with-audio` its .m4a) with restore SQL and a README, in `transcripts/.backups/`. |
| `repair-missing-m4a.js` | Make and upload the .m4a for episodes that only have their MP3. |
| `redo-places.js` | Redo one episode's places and their sentiment with the pipeline's own code (`--no-places` for every episode that has none). |

Transcript files (`transcripts/<episode-id>.json`, git-ignored) are written the same way by both engines (`scripts/transcript-file.js`): spelling fixes ("soldier" → "Suldrew") and loop removal happen before saving, and a `meta` block records the engine, model, settings, the recording's real length, what was removed, holes of 5+ minutes, and whether it covers the recording. An episode that lost 50+ lines to a loop, has a 5-minute hole or stops early goes on the re-transcribe list, `transcripts/.retranscribe/episodes.json`. The archive folder the scripts read is `ARCHIVE_DIR` in `scripts/lib.js` (the BFF.fm archive in iCloud; set `ROE_ARCHIVE_DIR` to use another).

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

Drag the MP3 into the `roe-audio` R2 bucket in the Cloudflare dashboard, named `Roll Over Easy YYYY-MM-DD.mp3`. The pipeline starts by itself ten minutes later: it waits in case the show comes in parts. (`npx wrangler r2 object put roe-audio/"Roll Over Easy 2026-04-02.mp3" --file=…` works too.)

A show recorded as several files: upload them all, named `Roll Over Easy YYYY-MM-DD 1.mp3`, `… 2.mp3` and so on (the first may have no number). Ten minutes after the last one arrives, the pipeline joins them in order into `joined/Roll Over Easy YYYY-MM-DD.mp3`, with a new header so players show the right length and seek to the right place, and runs that; the parts stay in R2. A file identical to another is a copy and is left out, as is a `… (1).mp3`. The pipeline waits for you instead, with the reason in `problem` on `/status`, when a part is missing, two different files are the same part, the parts are in different formats, or they add up to more than 3.5 hours (a copy of the whole show among the parts, as some archive dates have). Fix the files in R2, then POST `/process` for any part with `&force=1`, which also goes ahead without a missing part.

The admin page's **Uploads** tab lists every file the pipeline saw, newest first, and what became of it: started, skipped with the reason (a name it can't read, a second copy, a show already on the site), retrying, or gave up. That last one means every hand-over to the show's pipeline failed, after tries 1, 2, 4… minutes apart for about an hour, and the message reached the queue's dead-letter queue (`roe-pipeline-dlq`). When a run ends it adds a second row: **published** (title, length, lines), **published with problems** (stretches with no transcript, a transcript that stops early, a step skipped), **failed** with the reason, or **waiting for you** (a missing part, two files for one part…). The tab's number counts the ones from the last 14 days to look at. The rows are D1's `ingest_log` table; the pipeline's own files (joined shows, the site's .m4a) aren't listed.

To hear about each run as it ends, set a notice address as a Worker secret: `cd roe-pipeline && npx wrangler secret put NOTIFY_URL`, with an [ntfy](https://ntfy.sh) topic URL (`https://ntfy.sh/<a long random topic>`, then subscribe to it in the ntfy app) or a Slack incoming-webhook URL. Each notice is titled like "Roll Over Easy 2026-10-08: on the site" (or "…, with problems", "failed", "waiting for you"). Without the secret nothing is sent.

Processing takes ~10–15 minutes for a 2-hour episode, after the ten-minute wait. Check status:

```bash
# PIPELINE_TOKEN is in the project .env (the same value is a Worker secret)
curl -H "Authorization: Bearer $PIPELINE_TOKEN" \
  "https://roe-pipeline.christophersbunting.workers.dev/status?key=Roll%20Over%20Easy%202026-04-02.mp3"
```

`status` is `waiting` (with `waitingUntil`, or a `problem` to fix), `processing`, `failed` or `completed`. `parts` lists the files the show is made of, `ignored` any left out, and `file` the one transcribed. Any part's name, or the joined file's, works as the `key`. While it runs you also see the `step`, its `attempt`, `progress` (chunks and bytes transcribed) and the `lastError` it's waiting to retry. `warnings` lists extras that were skipped (and files that arrived after the run started, which aren't added to it), and `holes` any stretches of 5+ minutes still without transcript.

If a run fails (OpenAI down for half an hour, say), fix the cause and ask it to carry on. It resumes at the failed step, without paying to transcribe again:

```bash
curl -X POST -H "Authorization: Bearer $PIPELINE_TOKEN" \
  "https://roe-pipeline.christophersbunting.workers.dev/process?key=Roll%20Over%20Easy%20YYYY-MM-DD.mp3"
```

Uploading the same file again does the same thing. A run that has been silent for an hour counts as stuck and resumes the same way; add `&force=1` to wake one sooner, or `&restart=1` to start over from scratch (only before the episode is published).

To redo an episode that's already on the site, delete it first, then POST `/process` as above:

```bash
node scripts/delete-episode.js roll-over-easy_YYYY-MM-DD_07-30-00          # dry run: shows what it would remove
node scripts/delete-episode.js roll-over-easy_YYYY-MM-DD_07-30-00 --yes    # backs it up, then deletes it
```

`delete-episode.js` first backs the episode up with `episode-backup.js` (its rows, search entries and local transcript, with a `restore.sql` and a README, in `transcripts/.backups/<date>-<id>/`); the local transcript is moved there. It finds the search entries by listing the index (every ID that starts with the episode's), so drag-and-drop episodes, and entries an older transcript left, are covered. To put an episode back, follow the backup's README: `restore.sql`, then `generate-embeddings.js --only <id> --yes`, which makes its search entries again and deletes any made since (a later run's). The episode's .m4a stays in R2 unless you add `--delete-audio` (it is then saved in the backup first): do that when the new upload has different audio (joined parts, say), or the site keeps playing the old recording. Without an .m4a the site plays the MP3 until `node scripts/repair-missing-m4a.js --only <id>` makes it again. Raw MP3 uploads are never deleted.

### Rebuilding the search index

Each episode's search entries should be exactly the 45-second windows of its lines in D1. `process-episode.js`'s embeddings step keeps one episode that way: it embeds the lines D1 has (what the site shows), then deletes the episode's other entries, found by listing the index (about half a minute). `generate-embeddings.js` does it for any number of episodes, and without `--yes` only says what it would change:

```bash
node scripts/generate-embeddings.js --all                          # dry run: lists the index, reads D1 (read-only, free)
node scripts/generate-embeddings.js --only <id>,<id> --yes         # a few episodes first, as a check
node scripts/generate-embeddings.js --all --orphans --yes          # every episode, and entries whose episode is gone
node scripts/generate-embeddings.js --all --orphans --yes --resume transcripts/.backups/<date>-embeddings
```

Vectorize can't be asked for one episode's entries, so the tool lists the whole index once (about 100 requests) and reads D1 after it. Per episode it backs up the entries it will delete (`deleted-vectors/<id>.ndjson` in its folder under `transcripts/.backups/`), embeds every window of the D1 lines, upserts them, and only then deletes the episode's other entries; each finished episode goes in `progress.ndjson`, which `--resume` skips. It leaves alone (and says so) an episode whose lines end 30+ seconds past its length, like 2014-09-04's stretched times. At the end it waits for Vectorize's write queue, lists the index again and checks that each episode it did holds exactly its windows and nothing else changed (`verify.json`). All 544 episodes come to about 83,000 windows, $1.10-1.20 of Workers AI and about 2,800 API requests, paced to stay under Cloudflare's limit of 1,200 per 5 minutes. Run it with nothing else writing D1 or Vectorize, not while the pipeline is taking in a show, and after any transcript repairs: some old entries hold speech that D1's lines are still missing.

### Batch processing (historical backfill only)

For processing large numbers of older episodes locally:

```bash
# Process a single episode locally (whisper.cpp; add --engine openai to use OpenAI's Whisper)
node scripts/process-episode.js /path/to/episode.mp3

# Process all episodes in batch with checkpoint/resume
node scripts/process-all.js "/path/to/All episodes/" --cooldown 120
```

### Repairing damaged transcripts

`scripts/repair-archive.js` redoes the transcripts a worklist names (a CSV with `date,act,src,file,tags,show_min,patch_min,rev,gs_min,disk,note`, from the 2026-09-27 research). The `act` says what to do: W and O redo the whole transcript, J joins a split show's parts first, T installs a ready transcript from `transcripts/.trial-2026-09-27/`, L deletes junk lines only, M corrects `duration_ms` to the site's .m4a, X is left alone. The `src` says where the audio comes from: the archive file in `file` (A, A*), the archive's parts (J), the site's .m4a made into an MP3 (R), or the raw upload in R2 (E).

```bash
node scripts/repair-archive.js --worklist repair-worklist.csv --dry-run           # the plan, audio, GPU time and cost
node scripts/repair-archive.js --worklist repair-worklist.csv --acts T             # stage by stage: the trial shows,
node scripts/repair-archive.js --worklist repair-worklist.csv --only 2014-09-04,…  # a pilot,
node scripts/repair-archive.js --worklist repair-worklist.csv --acts J             # the split shows, …
node scripts/scan-transcripts.js --only 2014-09-04,… --json after.json            # before and after each stage
```

- **Transcription** goes to `transcripts/.repair/staging/`, never over the live file: whisper.cpp with `large-v3-turbo` on the GPU by default (free; about 0.06-0.09x the show's length), `--parallel N` at a time. `--engine openai` uses OpenAI instead (paid); `--max-cost` caps a run's OpenAI spending (default $0).
- **Checks before anything changes:** before any transcribing, the audio has to be the recording the site plays (within 5 s; for a join, the site has to be playing the part the worklist names). Then the transcript has to cover its recording without Whisper looping, have at least 80% (`--min-word-share`) of the live transcript's words, not counting loop repeats and junk (whisper.cpp leaves song lyrics out), and at least 70% (`--min-same-show`) of its distinctive words (the same show), with no junk lines left. Holes of 5+ minutes are listed for you to listen to, not refused. A show that fails is tried once more with the other model (`--retry-model`), then with OpenAI only with `--fallback-openai`; one that still fails is set aside (listed at the end; `--retry-failed` tries it again) and the run goes on. Three set aside in a row stop the run.
- **Publishing, one episode at a time:** the site's audio measured again, `episode-backup.js` (with the .m4a for a join), the old local transcript's search IDs kept as stale, the new file installed, then `process-episode.js --skip transcribe,summary,guest-start,upload-audio --force seed-db`, which seeds D1 in one import and redoes the embeddings (skipped with `--local`). A join seeds and uploads its audio first, then its times move, then its embeddings run. Then D1 is checked: every line in and found by keyword search, `duration_ms` the recording's length, and the title, summary, guests, reviewed flag, interview time, audio and place quotes as they were. Any failure here stops the run.
- **Split shows** are joined with the pipeline's own joiner (`roe-pipeline/src/mp3-join.js`), checked against the sum of the parts and with a full decode, and replace the site's .m4a. Where parts now come before the one the site had, the interview time and place-quote times move by their length, reviewed or not (the old times pointed into the old audio); the run lists them for you to check.
- **Resume:** state is in `transcripts/.repair/progress.json` and a log per episode in `transcripts/.repair/logs/<date>.log`. Run the same command again after a stop (Ctrl-C stops a run and its transcriptions): published episodes are skipped, a checked transcript is published without being made again, and OpenAI carries on from its last chunk. One run at a time (`transcripts/.repair/run.lock`). The run keeps the Mac awake (`caffeinate`).
- **Rehearsal:** `--local` works on a scratch D1 only (`ROE_PERSIST_TO=<folder>`, see AGENTS.md), so its state never mixes with the real run's; Vectorize is left alone.
- **Lines only:** `scripts/clean-junk-lines.js --only <dates>` (a dry run unless `--yes`) is what the L rows run: the prompt read back as speech (today's prompt or the old one's terms), loop repeats, and with `--rules non-latin` wrong-language lines in a show's first 10 minutes.

To undo one episode, use its backup, `transcripts/.backups/<date>-<id>/` (its README.txt has the exact commands): `restore.sql` puts the D1 rows back (`npx wrangler d1 execute roe-episodes --remote --file …`), `generate-embeddings.js --only <id> --yes` makes its search entries again from those lines, copy the old `<id>.json` back into `transcripts/`, and for a join put the old `<id>.m4a` back in R2. Then remove the episode from `transcripts/.repair/progress.json` if it should be redone.

### New summaries for repaired episodes

The repair keeps each episode's title, summary and guests, but the summaries were written from the old, partial transcripts (one has a "sunny 65 degree" morning the hosts never mention). `scripts/rewrite-summaries.js` writes a new summary from the transcript now in D1 and changes nothing else: the title, the guests, the reviewed flag and the interview time stay, reviewed episodes included.

```bash
node scripts/rewrite-summaries.js --from-repair --engine ollama --plan          # the episodes, their size, the cost; nothing asked
node scripts/rewrite-summaries.js --only 2014-03-20,2020-01-16 --engine ollama   # a dry run: old and new side by side
node scripts/rewrite-summaries.js --from-repair --engine openai --max-cost 1     # GPT-4o-mini, within $1
node scripts/rewrite-summaries.js --apply transcripts/.summaries/<file>.json --yes   # write the summaries you read
```

- **Which episodes:** `--only <dates or IDs>`, or `--from-repair`: the episodes `transcripts/.repair/progress.json` shows as published (a new transcript) or done (junk lines deleted, or the duration fixed), less any no longer in D1. An episode the repair is still working on is always left out: its transcript is about to change, and the repair checks that its summary doesn't.
- **The prompt** is the Worker's summary instructions (`roe-pipeline/src/summary.js`) asking for the summary alone, with the date and sunrise/sunset, the hosts named as never guests (`hosts.js`), a reviewed episode's hand-checked guests for their spelling, and "never make up weather, temperatures, guests, places or events". A transcript too thin to summarize (the Worker's rule) keeps its summary.
- **`--engine openai`:** GPT-4o-mini with the Worker's settings, about half a cent a 2-hour show (180 shows: about $0.85). The run stops after the plan unless `--max-cost` covers the estimate, and a dry run spends it too (it makes the summaries to show them). A failed reply is asked for again up to three times; every answer counts toward the cap (a refused one is paid for too), which is checked before each episode.
- **`--engine ollama`:** a local model (`--model`, default `qwen3:30b`), free; the Ollama app or `ollama serve` has to be running. The context is set to 32,768 tokens (`--num-ctx`), which fits nearly every 2-hour show; a longer transcript leaves out its shortest lines ("Yeah.", "Mm-hmm.") to fit, and a prompt that still doesn't fit is refused, never cut at the start as Ollama otherwise does. Thinking is off; `--think` lets a thinking model reason first (slower; the reasoning is kept out of the answer). Each reply may take minutes; a failed one is asked for once more, and one that doesn't come in 30 minutes, twice, stops the run (the next show would take as long). qwen3:30b is 18.6 GB, so on a 24 GB Mac part of it may run on the CPU. It won't start while whisper.cpp is transcribing on the GPU (the repair's runs): both would slow down, and the transcription could pass its time limit.
- **The review:** each episode's old and new summary are printed side by side and saved to `transcripts/.summaries/<time>-<engine>-<model>.json` and `.md`, with notes on what to check in each: weather or a temperature the transcript never mentions, capitalized words it doesn't have (a made-up name), a host called a guest, reasoning where a summary should be.
- **Writing:** `--apply <file.json> --yes` writes the summaries in the file (edit them there first if you like) without asking a model again; `--yes` on a run writes as soon as it's done. First a backup, `transcripts/.backups/<date>-summaries/` (`summaries.json`, `restore.sql`, `README.txt`), then one D1 import that sets only `summary`, and only where it is still the summary the new one was made against and the transcript is still the one it was made from (an episode whose summary or transcript changed since is left alone), then a check of what D1 holds: the new summaries in, nothing else changed. The review file notes each write. `restore.sql` puts the old summaries back where the summary is still the one written.

### After a repair: interview times and place quotes

A repair leaves titles, summaries, guests, interview times and place quotes as they were. Two tools follow it up, each a dry run unless `--yes`, on `--only <dates>`, `--from-repair` (every episode `progress.json` has published or done, less any no longer in D1) or `--all` (every episode in D1), less `--except <dates>`. An episode the repair is still working on is always left out, even by name: its transcript is about to change, and the repair checks that its interview time and quotes don't. `--progress <file>` reads another repair state file, which only counts for the database it was made on:

```bash
node scripts/fill-interview-times.js --from-repair      # empty, 60:00 or sign-off interview times: old -> proposed, and the line there
node scripts/reanchor-place-quotes.js --from-repair     # place quotes: found word for word / close / not found, and where they move
```

- **Interview times** come from the detector (`roe-pipeline/src/guest-start.js`, the one both pipelines use) on the lines D1 has now, only where `guest_start_ms` is empty or exactly 3,600,000 (60:00, what the old detector gave when it found nothing), that 60:00 as a join moved it (`progress.json` records the move), or in the last 10 minutes of a show 100+ minutes long (the old detector took the first mention after the last song, often the thank-you at the end), reviewed episodes included ("reviewed" is the guest list, not the time). Any other time stays, reviewed or not (2026-09-24's hand-set 77:17 included). There is no proposal without guests, for a show under 50 minutes, or when the detector finds nothing; a sign-off time then gets 60:00, as the goodbye is never the interview. Check the list: in a hand check of 86 shows the detector was within 3 minutes of the interview's start on 72.
- **Place quotes** are looked for in the episode's lines as words (case and punctuation ignored, across line breaks): word for word, or for 6+ words, 75% of them in order. A place counts only within 90 s of a line naming the place (whole words) or 3 minutes of the quote's old time (a short quote like "It's really cool." is said more than once); of several, the one the old time leads into, else the nearest, and when none is near the old time (or there is none) it keeps its time. The time moves to the start of the line the quote begins in, unless the old time still leads into it (up to 30 s before, as the pipeline sets it). Only `snippet_start_ms` changes, and only where the quote and its time are still the ones read; rows are never added or deleted, and a quote not found keeps its time.
- **Writing:** `--apply <proposals.json or quotes.json> --yes` writes the list a dry run saved, as it is: edit it first to leave some out (a proposal's "proposed" set to null, a quote's "new" to its "old") or to change a time. `--yes` on a run writes what that run works out. Either way, first `transcripts/.backups/<date>-interview-times/` or `<date>-place-quotes/` (the list, before.json, applied.sql, restore.sql and a README with the undo command); then one D1 import, each value only changing if it is still the one read; then the values are read back. A dry run's list goes to `…-plan/`, and the command to write it is printed. For quotes, `moves.txt` there has only the ones that move, each with the line it is in now: the list to check after a run over every show.

### Local development

```bash
cd roe-search
npm run dev    # port 8791, pinned in package.json (roe-pipeline's npm run dev uses 8793)
# Visit http://roe.localhost:8791 (its own origin, so no cookies or storage shared with other projects;
# every page also unregisters any service worker another project left there)
node smoke-test.mjs http://roe.localhost:8791   # the post-deploy route check, against the local copy
```

