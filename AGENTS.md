# AGENTS.md

Searchable archive of the Roll Over Easy podcast. Live at rollovereasy.org.

## Directory Map

```
roe-episode-search/
├── roe-search/                # Cloudflare Worker — search frontend + API
│   └── src/
│       ├── index.js           # All routes (search, audio proxy, admin)
│       ├── frontend.html      # Homepage (On This Day, shared-clip card, audio player)
│       ├── episodes.html      # Browse all episodes
│       ├── guests.html        # Guest directory (not linked from the menu)
│       ├── admin.html         # Admin panel (password-protected: guest mgmt, search)
│       └── map.html           # Places mentioned map
├── roe-pipeline/              # Cloudflare Worker — serverless episode processing
│   └── src/
│       ├── index.js           # Queue consumer + /process and /status (bearer token)
│       ├── pipeline.js        # EpisodePipeline DO, one per show date: one step (or chunk) per alarm, retries, resume
│       ├── parts.js           # Which files make the show: parts, copies, what to wait for
│       ├── mp3-join.js        # Join a split show's parts into one MP3 in R2, with a new Xing header
│       ├── transcribe.js      # OpenAI Whisper API, six minutes of audio at a time
│       ├── gap-retry.js       # Re-send 5+ minute holes as 3-minute clips
│       ├── clean-segments.js  # Loop/hallucination/wrong-language cleaning
│       ├── summary.js         # GPT-4o-mini title/summary/guests (writes nothing)
│       ├── seed-db.js         # One D1 batch: episode row + segments (+FTS) + guests
│       ├── embeddings.js      # Workers AI embeddings (45s window, 35s step)
│       ├── guest-start.js     # "Skip to interview" time
│       ├── places.js          # GPT-4o-mini places + Nominatim geocoding
│       ├── sentiment.js       # Place sentiment, quotes and narratives
│       ├── hosts.js           # The hosts' names (never guests); the site imports it too
│       └── parse-episode-id.js # Filename → episode ID
├── scripts/                   # Local tools (Node.js 24.2+)
│   ├── process-episode.js     # Historical backfill path (whisper.cpp): transcribe → seed → embed → summary → upload
│   ├── process-all.js         # Batch runner with checkpoint/resume
│   ├── discover-episodes.js   # Scan directory, parse filenames
│   ├── generate-summaries.js  # Regenerate AI summaries
│   ├── cleanup-places.js      # Remove false positive places from D1
│   ├── redo-places.js         # Redo one episode's places with roe-pipeline's code
│   ├── delete-episode.js      # Back up, then remove an episode from D1 and Vectorize (--yes)
│   ├── episode-backup.js      # Back up an episode (with restore SQL) before a delete or merge
│   ├── archive/               # Retired one-off scripts, reference only (see its README)
│   └── ...                    # ~15 more utility scripts
├── schema.sql                 # D1 schema (episodes, segments, FTS5, guests, places)
├── transcripts/               # Generated JSON transcripts (local only)
└── docs/superpowers/          # Design specs and plans (local only: git ignores this folder)
```

The MP3 archive (661 files) is outside the repo, in iCloud Drive at
`~/Library/Mobile Documents/com~apple~CloudDocs/BFF.fm/Roll Over Easy/All Episodes/`.

## Component Quick Reference

| Component | Entry Point | Purpose | Infra |
|-----------|-------------|---------|-------|
| **roe-search** | `roe-search/src/index.js` | Search frontend + API. Serves HTML pages, FTS5/semantic search, audio streaming, admin endpoints | D1, R2, Vectorize, Workers AI |
| **roe-pipeline** | `roe-pipeline/src/index.js` | How new episodes arrive. R2 upload → queue → one Durable Object per show date, which waits 10 minutes for more parts, joins a show that came in parts, then runs transcribe → summary → seed → embed → guest-start → places → sentiment, with retries and resume | D1, R2, Vectorize, Workers AI, OpenAI |
| **scripts** | `scripts/process-episode.js` | Local processing used for the historical backfill (whisper-cpp + ffmpeg). Not the same as roe-pipeline: no places or sentiment, and its own prompts and cleaning | D1, R2, Vectorize, OpenAI |
| **D1 database** | `schema.sql` | SQLite: episodes, transcript_segments, transcript_fts (FTS5), episode_guests, places, place_mentions | |
| **R2 bucket** | `roe-audio` | Audio file storage. Public URL: `pub-e95bd2be3f9d4147b2955503d75e50c1.r2.dev` | |
| **Vectorize** | `roe-transcripts` | 768-dim embeddings (cosine). Model: `@cf/baai/bge-base-en-v1.5` | |

## How To

### Run roe-search locally
```
cd roe-search && npx wrangler dev --port 8791    # http://roe.localhost:8791
```

### Deploy roe-search
```
cd roe-search && npx wrangler deploy
npm run smoke    # checks every route the pages use on rollovereasy.org; run after each deploy
```

### Run roe-pipeline locally
```
cd roe-pipeline && npm run dev
```

### Deploy roe-pipeline
```
cd roe-pipeline && npm run deploy
```

### Run roe-pipeline tests
```
cd roe-pipeline && npm test
```

### Process a single episode (local pipeline)
```
node scripts/process-episode.js "/path/to/Roll Over Easy 2026-03-27.mp3"
# Options: --episode-id ID, --force summary,guest-start (steps to redo), --skip transcribe,seed-db,
#          --include-reviewed, --local (the local D1 copy)
```
An episode whose guests were reviewed (`guests_reviewed = 1`) keeps its title, summary, guests and
interview time, even with `--force`, unless `--include-reviewed` is given; the same goes for
`generate-summaries.js`, `backfill-guest-start.js` and `process-all.js`. The interview time is only
filled in when empty unless its step is forced. A mistyped option or step name stops the script.

### Batch process episodes (local pipeline)
```
node scripts/process-all.js "/path/to/All episodes/" --cooldown 120 --dry-run
```
Dates recorded as several different files are skipped and listed as `MULTI-PART`: join the parts
into one file first. Episodes already complete on the site are left alone.

### Apply schema to D1
```
cd roe-search && npx wrangler d1 execute roe-episodes --remote --file=../schema.sql
```

### Regenerate summaries
```
node scripts/generate-summaries.js --dry-run    # lists the episodes it would do (no OpenAI calls)
node scripts/generate-summaries.js
```

### Places on the map

New episodes get their places from roe-pipeline's `extract-places` step, which only keeps
names the transcript mentions. `scripts/redo-places.js <episode-id>` runs the same code for
an existing episode. `scripts/cleanup-places.js` removes false positives from D1: its dry run
(GPT-4o-mini) writes `scripts/cleanup_report.json`, and `--apply` deletes exactly the places
listed there (edit it first to keep any), refusing if one was renamed or removed since, after a
backup with `undo.sql` in `transcripts/.backups/<date>-cleanup-places/`.
The April 2026 map build (external business lists matched against transcripts) is archived
in `scripts/archive/`: it caused the fake pins and common-word places cleaned up in
September, so don't re-run it as is. Guest lists are edited in the admin page; the old
`backfill-guests.js` is archived too, because it overwrites reviewed guests.

## Key Files

| File | What's In It |
|------|-------------|
| `schema.sql` | D1 schema — episodes, transcript_segments, transcript_fts (FTS5), episode_guests, places, place_mentions |
| `roe-search/wrangler.jsonc` | Worker config — D1, R2, Vectorize, AI bindings |
| `roe-pipeline/wrangler.jsonc` | Worker config — D1, R2, Vectorize, Durable Object, queue bindings |
| `.env` | Secrets: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, OPENAI_API_KEY, PIPELINE_TOKEN (for roe-pipeline's /process and /status) |
| `r2-cors.json` | R2 CORS rules (GET/HEAD from all origins) |
| `scripts/batch-progress.json` | Checkpoint/resume state for process-all.js |
| `scripts/archive/README.md` | What the retired scripts were, and which must not be re-run |
| `docs/superpowers/specs/` | Design specs for major features (local only) |
| `docs/superpowers/plans/` | Implementation plans (local only) |
