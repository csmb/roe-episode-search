# ROE Episode Search

A searchable archive of the Roll Over Easy podcast. Search for any keyword or concept and jump directly to the moment it was said. Supports both keyword search (FTS5) and semantic search (Cloudflare Vectorize).

**Live:** https://roe-episode-search.christophersbunting.workers.dev

## How it works

Audio files are transcribed locally using whisper.cpp (large-v3 model with Silero VAD), stored in a SQLite database with full-text search (FTS5), and served via a Cloudflare Worker. Two search modes are available: **Keyword** finds exact word matches via FTS5, while **Semantic** finds conceptually related segments via vector embeddings (Cloudflare Vectorize + Workers AI). Click any result to play the audio from that exact moment.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                          Pipeline                                │
│                                                                  │
│  Local MP3s ──► whisper.cpp ──► JSON transcripts                 │
│       │        (process-episode.js)                               │
│       │                           │                              │
│       │                    ┌──────┴──────┐                       │
│       │                    ▼             ▼                        │
│       │             Cloudflare D1   Cloudflare Vectorize         │
│       │          (+ titles/summaries)  (embeddings)              │
│       │                    │             │                        │
│       ▼                    ▼             ▼                        │
│  Cloudflare R2            Cloudflare Worker                      │
│  (audio storage)      (search API + frontend)                    │
└──────────────────────────────────────────────────────────────────┘
```

### Components

**Cloudflare Worker** (`roe-search/src/index.js`) — The entire backend is a single Worker file:
- `GET /` — Serves the search frontend
- `GET /episodes` — Episode browsing page
- `GET /guests` — Guest directory page
- `GET /api/search?q=coffee` — Keyword search via FTS5. Returns matching segments grouped by episode with timestamps.
- `GET /api/semantic-search?q=morning+beverage` — Semantic search via Vectorize. Embeds query with Workers AI, finds similar transcript chunks by cosine similarity.
- `GET /api/timeline?q=coffee` — Monthly mention counts for a search term across all episodes (powers timeline visualizations).
- `GET /api/episodes` — Lists all episodes with metadata.
- `GET /api/guests` — Lists all guests with their episode appearances.
- `GET /audio/<file>` — Proxies audio from R2 with range request support for streaming/seeking.

**Cloudflare D1** — SQLite database with three key tables:
- `episodes` — Episode metadata (id, title, duration, summary)
- `transcript_segments` — Timestamped text segments (episode_id, start_ms, end_ms, text)
- `transcript_fts` — FTS5 virtual table for fast full-text search, kept in sync via triggers
- `episode_guests` — Guest names linked to episodes

**Cloudflare Vectorize** (`roe-transcripts` index) — Vector database storing embeddings of 45-second transcript chunks (768 dimensions, cosine similarity). Metadata includes full chunk text so search results don't require a D1 lookup.

**Cloudflare Workers AI** — Used at query time to embed search queries with `@cf/baai/bge-base-en-v1.5`, and at indexing time (via REST API) to embed transcript chunks.

**Cloudflare R2** — Object storage for audio files. Episodes are converted to M4A (AAC with faststart) for reliable browser streaming and seeking.

**Frontend** — Three HTML pages with inline CSS/JS:
- `frontend.html` — Search UI with Keyword/Semantic toggle, highlighted matches (keyword) or similarity scores (semantic), and a sticky audio player that seeks to the clicked timestamp.
- `episodes.html` — Episode browsing page listing all episodes with titles, dates, and summaries.
- `guests.html` — Guest directory showing all guests and their episode appearances.

### Scripts

All scripts are in `scripts/` and run locally with Node.js:

| Script | Purpose |
|---|---|
| `process-episode.js` | **Primary pipeline.** Process a single episode end-to-end: transcribe with whisper.cpp + VAD, seed D1, generate embeddings, generate AI title + summary, upload audio to R2. |
| `discover-episodes.js` | Scan an audio directory, parse all filename formats, deduplicate by date, and return a sorted episode list. |
| `process-all.js` | Batch runner — processes all discovered episodes sequentially with checkpoint/resume, cooldown, retries, and quality gates. |
| `generate-manifest.js` | Generate (or regenerate) `episode-manifest.json` from an audio directory, cross-referencing `batch-progress.json` and `transcripts/` to assign statuses (completed/pending/failed/skipped). |
| `manifest-status.js` | Print a human-readable progress summary from `episode-manifest.json`. |
| `rename-episodes.js` | Rename MP3 files to a uniform `Roll Over Easy YYYY-MM-DD.mp3` scheme. Dry-run by default; pass `--apply` to rename. |
| `audit-episodes.js` | Audit episode files for date anomalies: non-Thursday dates, missing Thursdays, duplicates, and unparseable filenames. |
| `transcribe.js` | Transcribe a single audio file via OpenAI Whisper API. |
| `transcribe-all.js` | Batch-transcribe a directory via Whisper API. Skips already-done files, retries failures. |
| `seed-db.js` | Push transcript JSON files into D1. Incremental — skips existing episodes. |
| `generate-summaries.js` | Generate episode titles and summaries using GPT-4o-mini and update D1. |
| `generate-embeddings.js` | Chunk transcripts into 45s windows, embed via Workers AI REST API, upsert to Vectorize. |
| `upload-audio.js` | Convert audio to M4A and upload to R2. Updates episode records with audio URLs. |
| `backfill-guests.js` | Extract guest names from transcripts using GPT-4o-mini and populate D1. |
| `clean-hallucinations.js` | Delete hallucinated repeated-phrase segments from D1. Finds any phrase >20 chars appearing >20× within one episode and removes matching rows. |

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

## Project structure

```
roe-episode-search/
├── .env                          # API keys (gitignored)
├── schema.sql                    # D1 database schema
├── package.json                  # Root deps (openai, wrangler)
├── scripts/
│   ├── process-episode.js        # Single-episode pipeline (transcribe → deploy)
│   ├── discover-episodes.js      # Scan + deduplicate audio files
│   ├── process-all.js            # Batch runner with checkpoint/resume
│   ├── generate-manifest.js      # Build/refresh episode-manifest.json
│   ├── manifest-status.js        # Print manifest progress summary
│   ├── rename-episodes.js        # Normalize MP3 filenames
│   ├── audit-episodes.js         # Audit for date anomalies + missing episodes
│   ├── transcribe.js             # Transcribe via Whisper API
│   ├── transcribe-all.js         # Batch transcribe via Whisper API
│   ├── seed-db.js                # Load transcripts into D1
│   ├── generate-summaries.js     # Generate episode titles + summaries
│   ├── generate-embeddings.js    # Embed transcripts into Vectorize
│   ├── upload-audio.js           # Convert + upload audio to R2
│   ├── backfill-guests.js        # Extract guest names into D1
│   ├── clean-hallucinations.js   # Remove hallucinated segments from D1
│   ├── episode-manifest.json     # Source-of-truth episode status list
│   └── batch-progress.json       # Checkpoint file for process-all.js
├── transcripts/                  # Generated JSON transcripts (gitignored)
└── roe-search/                   # Cloudflare Worker
    ├── wrangler.jsonc            # Worker config (D1, R2, Vectorize, AI bindings)
    └── src/
        ├── index.js              # Worker: search API + audio proxy
        ├── frontend.html         # Search UI
        ├── episodes.html         # Episode browsing page
        └── guests.html           # Guest directory
```

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

### Local development

```bash
cd roe-search
npx wrangler dev
# Visit http://localhost:8787
```

## Cloudflare resources

| Resource | Name | Purpose |
|---|---|---|
| Worker | `roe-episode-search` | Search API + frontend |
| D1 Database | `roe-episodes` | Transcripts + FTS index |
| Vectorize Index | `roe-transcripts` | Semantic search vectors (768-dim, cosine) |
| Workers AI | `@cf/baai/bge-base-en-v1.5` | Query embedding at search time |
| R2 Bucket | `roe-audio` | Audio file storage |
