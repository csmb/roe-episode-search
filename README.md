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
│       │             (+ summaries)   (embeddings)                  │
│       │                    │             │                        │
│       ▼                    ▼             ▼                        │
│  Cloudflare R2            Cloudflare Worker                      │
│  (audio storage)      (search API + frontend)                    │
└──────────────────────────────────────────────────────────────────┘
```

### Components

**Cloudflare Worker** (`my-first-worker/src/index.js`) — The entire backend is a single Worker file:
- `GET /` — Serves the search frontend
- `GET /api/search?q=coffee` — Keyword search via FTS5. Returns matching segments grouped by episode with timestamps.
- `GET /api/semantic-search?q=morning+beverage` — Semantic search via Vectorize. Embeds query with Workers AI, finds similar transcript chunks by cosine similarity.
- `GET /api/episodes` — Lists all episodes
- `GET /audio/<file>` — Proxies audio from R2 with range request support for streaming/seeking

**Cloudflare D1** — SQLite database with three key tables:
- `episodes` — Episode metadata (id, title, duration, summary)
- `transcript_segments` — Timestamped text segments (episode_id, start_ms, end_ms, text)
- `transcript_fts` — FTS5 virtual table for fast full-text search, kept in sync via triggers

**Cloudflare Vectorize** (`roe-transcripts` index) — Vector database storing embeddings of 45-second transcript chunks (768 dimensions, cosine similarity). Metadata includes full chunk text so search results don't require a D1 lookup.

**Cloudflare Workers AI** — Used at query time to embed search queries with `@cf/baai/bge-base-en-v1.5`, and at indexing time (via REST API) to embed transcript chunks.

**Cloudflare R2** — Object storage for audio files. Episodes are converted to M4A (AAC with faststart) for reliable browser streaming and seeking.

**Frontend** (`my-first-worker/src/frontend.html`) — Single HTML file with inline CSS/JS. Keyword/Semantic toggle, search results with highlighted matches (keyword) or similarity scores (semantic), and a sticky audio player that seeks to the clicked timestamp.

### Scripts

All scripts are in `scripts/` and run locally with Node.js:

| Script | Purpose |
|---|---|
| `process-episode.js` | **Primary pipeline.** Process a single episode end-to-end: transcribe with whisper.cpp + VAD, seed D1, generate embeddings, generate AI summary, upload audio to R2. |
| `discover-episodes.js` | Scan an audio directory, parse all filename formats, deduplicate by date, and output an episode manifest. |
| `process-all.js` | Batch runner — processes all discovered episodes sequentially with checkpoint/resume, cooldown, retries, and quality gates. |
| `transcribe.js` | Transcribe a single audio file via OpenAI Whisper API. |
| `transcribe-all.js` | Batch-transcribe a directory via Whisper API. Skips already-done files, retries failures. |
| `seed-db.js` | Push transcript JSON files into D1. Incremental — skips existing episodes. |
| `generate-summaries.js` | Generate episode summaries using an LLM and update D1. |
| `generate-embeddings.js` | Chunk transcripts into 45s windows, embed via Workers AI REST API, upsert to Vectorize. |
| `upload-audio.js` | Convert audio to M4A and upload to R2. Updates episode records with audio URLs. |

### Data flow for a single episode

```
episode.mp3
    │
    └──► process-episode.js
              │
              ├── 1. whisper.cpp + VAD ──► transcripts/episode.json
              ├── 2. seed-db ──► D1 (episodes + transcript_segments + FTS index)
              ├── 3. embeddings ──► Vectorize (45s vector chunks)
              ├── 4. summary ──► D1 (AI-generated episode summary)
              └── 5. upload ──► ffmpeg (MP3 → M4A) ──► R2
```

### Batch processing

```bash
# Preview what will be processed
node scripts/discover-episodes.js "/path/to/All episodes/"

# Process everything (with checkpoint/resume)
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... OPENAI_API_KEY=... \
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
├── schema.sql                    # D1 database schema
├── package.json                  # Root deps (openai, wrangler)
├── scripts/
│   ├── process-episode.js        # Single-episode pipeline (transcribe → deploy)
│   ├── discover-episodes.js      # Scan + deduplicate audio files
│   ├── process-all.js            # Batch runner with checkpoint/resume
│   ├── transcribe.js             # Transcribe via Whisper API
│   ├── transcribe-all.js         # Batch transcribe via Whisper API
│   ├── seed-db.js                # Load transcripts into D1
│   ├── generate-summaries.js     # Generate episode summaries
│   ├── generate-embeddings.js    # Embed transcripts into Vectorize
│   └── upload-audio.js           # Convert + upload audio to R2
├── transcripts/                  # Generated JSON transcripts (gitignored)
└── my-first-worker/              # Cloudflare Worker
    ├── wrangler.jsonc            # Worker config (D1, R2, Vectorize, AI bindings)
    └── src/
        ├── index.js              # Worker: search API + audio proxy
        └── frontend.html         # Search UI
```

## Setup

### Prerequisites

- Node.js >= 18
- ffmpeg installed (`brew install ffmpeg`)
- whisper-cli installed (`brew install whisper-cpp`) with large-v3 model
- Silero VAD model (`~/.cache/whisper-cpp/ggml-silero-v6.2.0.bin`)
- OpenAI API key (for summaries)
- Cloudflare account with Wrangler authenticated (`npx wrangler login`)
- Cloudflare API token and account ID (for embeddings)

### First-time setup

```bash
# Install dependencies
npm install
cd my-first-worker && npm install && cd ..

# Create D1 database (already done — ID is in wrangler.jsonc)
# npx wrangler d1 create roe-episodes

# Create Vectorize index (already done)
# npx wrangler vectorize create roe-transcripts --dimensions=768 --metric=cosine

# Apply schema
cd my-first-worker
npx wrangler d1 execute roe-episodes --remote --file=../schema.sql
cd ..
```

### Processing episodes

```bash
# Process a single episode (transcribe → D1 → embeddings → summary → R2)
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... OPENAI_API_KEY=... \
  node scripts/process-episode.js /path/to/episode.mp3

# Process all episodes in batch
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... OPENAI_API_KEY=... \
  node scripts/process-all.js "/path/to/All episodes/" --cooldown 120

# Deploy
cd my-first-worker && npx wrangler deploy
```

Each step is idempotent — safe to re-run, skips already-processed episodes.

### Local development

```bash
cd my-first-worker
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
