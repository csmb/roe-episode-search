# ROE Episode Search

A searchable archive of the Roll Over Easy podcast. Search for any keyword or concept and jump directly to the moment it was said. Supports both keyword search (FTS5) and semantic search (Cloudflare Vectorize).

**Live:** https://rollovereasy.org

## How it works

Audio files are transcribed locally using whisper.cpp (large-v3 model with Silero VAD), stored in a SQLite database with full-text search (FTS5), and served via a Cloudflare Worker. Two search modes are available: **Keyword** finds exact word matches via FTS5, while **Semantic** finds conceptually related segments via vector embeddings (Cloudflare Vectorize + Workers AI). Click any result to play the audio from that exact moment.

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

### Components

**Cloudflare Worker** (`roe-search/src/index.js`) — serves the frontend and handles all API routes: keyword search (FTS5), semantic search (Vectorize), timeline data, episode/guest listings, and audio proxying from R2 with range request support.

**Cloudflare D1** — SQLite database with episode metadata, timestamped transcript segments, an FTS5 virtual table, and guest-episode links.

**Cloudflare Vectorize** — Vector database storing embeddings of 45-second transcript chunks (768 dimensions, cosine similarity).

**Cloudflare R2** — Audio files converted to M4A (AAC with faststart) for reliable browser streaming and seeking.

**Frontend** — Three inline HTML pages: search UI (`frontend.html`), episode browser (`episodes.html`), guest directory (`guests.html`).

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

