# ROE Episode Search

A searchable archive of the Roll Over Easy podcast. Search for any keyword and jump directly to the moment it was said.

**Live:** https://roe-episode-search.christophersbunting.workers.dev

## How it works

Audio files are transcribed into timestamped segments using OpenAI's Whisper API, stored in a SQLite database with full-text search (FTS5), and served via a Cloudflare Worker. When you search for a word, the app returns every segment where it appears — click a result to play the audio from that exact moment.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Pipeline                             │
│                                                             │
│  Local MP3s ──► Whisper API ──► JSON transcripts            │
│       │              (scripts/transcribe.js)                │
│       │                           │                         │
│       │                           ▼                         │
│       │                    Cloudflare D1                    │
│       │              (scripts/seed-db.js)                   │
│       │                           │                         │
│       ▼                           ▼                         │
│  Cloudflare R2             Cloudflare Worker                │
│  (audio storage)       (search API + frontend)              │
│  (scripts/upload-audio.js)  (my-first-worker/)              │
└─────────────────────────────────────────────────────────────┘
```

### Components

**Cloudflare Worker** (`my-first-worker/src/index.js`) — The entire backend is a single Worker file:
- `GET /` — Serves the search frontend
- `GET /api/search?q=coffee` — Full-text search across all transcripts. Returns matching segments grouped by episode with timestamps.
- `GET /api/episodes` — Lists all episodes
- `GET /audio/<file>` — Proxies audio from R2 with range request support for streaming/seeking

**Cloudflare D1** — SQLite database with three key tables:
- `episodes` — Episode metadata (id, title, duration)
- `transcript_segments` — Timestamped text segments (episode_id, start_ms, end_ms, text)
- `transcript_fts` — FTS5 virtual table for fast full-text search, kept in sync via triggers

**Cloudflare R2** — Object storage for audio files. Episodes are converted to M4A (AAC with faststart) for reliable browser streaming and seeking.

**Frontend** (`my-first-worker/src/frontend.html`) — Single HTML file with inline CSS/JS. Search box, results with highlighted matches, and a sticky audio player that seeks to the clicked timestamp.

### Scripts

All scripts are in `scripts/` and run locally with Node.js:

| Script | Purpose |
|---|---|
| `transcribe.js` | Transcribe a single audio file. Splits into 10-min chunks via ffmpeg, sends to Whisper API, stitches timestamps, outputs JSON. |
| `transcribe-all.js` | Batch-transcribe an entire directory. Skips already-done files, retries failures. |
| `seed-db.js` | Push transcript JSON files into D1. Incremental — skips existing episodes. |
| `upload-audio.js` | Convert audio to M4A and upload to R2. Updates episode records with audio URLs. |

### Data flow for a single episode

```
episode.mp3
    │
    ├──► transcribe.js ──► transcripts/episode.json
    │                              │
    │                              ├──► seed-db.js ──► D1 (episodes + transcript_segments + FTS index)
    │
    └──► upload-audio.js ──► ffmpeg (MP3 → M4A) ──► R2 (audio/episode.m4a)
```

## Project structure

```
roe-episode-search/
├── schema.sql                    # D1 database schema
├── package.json                  # Root deps (openai, wrangler)
├── scripts/
│   ├── transcribe.js             # Single-file transcription
│   ├── transcribe-all.js         # Batch transcription
│   ├── seed-db.js                # Load transcripts into D1
│   └── upload-audio.js           # Convert + upload audio to R2
├── transcripts/                  # Generated JSON transcripts (gitignored)
└── my-first-worker/              # Cloudflare Worker
    ├── wrangler.jsonc            # Worker config (D1 + R2 bindings)
    └── src/
        ├── index.js              # Worker: search API + audio proxy
        └── frontend.html         # Search UI
```

## Setup

### Prerequisites

- Node.js >= 18
- ffmpeg installed (`brew install ffmpeg`)
- OpenAI API key
- Cloudflare account with Wrangler authenticated (`npx wrangler login`)

### First-time setup

```bash
# Install dependencies
npm install
cd my-first-worker && npm install && cd ..

# Create D1 database (already done — ID is in wrangler.jsonc)
# npx wrangler d1 create roe-episodes

# Apply schema
cd my-first-worker
npx wrangler d1 execute roe-episodes --remote --file=../schema.sql
cd ..
```

### Processing episodes

```bash
# 1. Transcribe (costs ~$0.72 per 2-hour episode)
OPENAI_API_KEY=sk-... node scripts/transcribe-all.js /path/to/audio/

# 2. Load into database
node scripts/seed-db.js

# 3. Convert and upload audio
node scripts/upload-audio.js /path/to/audio/

# 4. Deploy
cd my-first-worker && npx wrangler deploy
```

Each script is incremental — safe to re-run, skips already-processed episodes.

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
| R2 Bucket | `roe-audio` | Audio file storage |
