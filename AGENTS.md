# AGENTS.md

Searchable archive of the Roll Over Easy podcast. Live at rollovereasy.org.

## Directory Map

```
roe-episode-search/
├── roe-search/                # Cloudflare Worker — search frontend + API
│   └── src/
│       ├── index.js           # All routes (search, audio proxy, admin)
│       ├── frontend.html      # Main search page with player
│       ├── episodes.html      # Browse all episodes
│       ├── guests.html        # Guest directory
│       ├── admin.html         # Admin panel (guest/episode management)
│       └── map.html           # Places mentioned map
├── roe-pipeline/              # Cloudflare Worker — serverless episode processing
│   └── src/
│       ├── index.js           # Queue consumer, dispatches to Durable Object
│       ├── pipeline.js        # EpisodePipeline DO (orchestrates all steps)
│       ├── transcribe.js      # OpenAI Whisper API, chunked
│       ├── embeddings.js      # Workers AI embeddings (45s window, 35s step)
│       ├── summary.js         # GPT-4o-mini title/summary/guests
│       ├── seed-db.js         # D1 insert (episodes + segments + FTS)
│       ├── clean-segments.js  # Hallucination/dedupe cleaning
│       └── parse-episode-id.js # Filename → episode ID
├── scripts/                   # Local processing pipeline (Node.js)
│   ├── process-episode.js     # Single episode: transcribe → seed → embed → summary → upload
│   ├── process-all.js         # Batch runner with checkpoint/resume
│   ├── discover-episodes.js   # Scan directory, parse filenames
│   ├── generate-summaries.js  # Regenerate AI summaries
│   ├── backfill-guests.js     # Populate episode_guests from summaries
│   └── ...                    # ~20 more utility scripts
├── schema.sql                 # D1 schema (episodes, segments, FTS5, guests, places)
├── All episodes/              # 69GB MP3 archive (local only, not in git)
├── transcripts/               # Generated JSON transcripts (local only)
└── docs/superpowers/          # Design specs and implementation plans
```

## Component Quick Reference

| Component | Entry Point | Purpose | Infra |
|-----------|-------------|---------|-------|
| **roe-search** | `roe-search/src/index.js` | Search frontend + API. Serves HTML pages, FTS5/semantic search, audio streaming, admin endpoints | D1, R2, Vectorize, Workers AI |
| **roe-pipeline** | `roe-pipeline/src/index.js` | Serverless episode processing. R2 upload triggers queue → Durable Object runs transcribe → seed → embed → summarize | D1, R2, Vectorize, Workers AI, OpenAI |
| **scripts** | `scripts/process-episode.js` | Local episode processing. Same pipeline as roe-pipeline but uses whisper-cpp + ffmpeg locally | D1, R2, Vectorize, OpenAI |
| **D1 database** | `schema.sql` | SQLite: episodes, transcript_segments, transcript_fts (FTS5), episode_guests, places, place_mentions | |
| **R2 bucket** | `roe-audio` | Audio file storage. Public URL: `pub-e95bd2be3f9d4147b2955503d75e50c1.r2.dev` | |
| **Vectorize** | `roe-transcripts` | 768-dim embeddings (cosine). Model: `@cf/baai/bge-base-en-v1.5` | |

## How To

### Run roe-search locally
```
cd roe-search && npx wrangler dev    # http://localhost:8787
```

### Deploy roe-search
```
cd roe-search && npx wrangler deploy
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
# Options: --episode-id ID, --force, --skip transcribe,seed-db
```

### Batch process episodes (local pipeline)
```
node scripts/process-all.js "/path/to/All episodes/" --cooldown 120 --dry-run
```

### Apply schema to D1
```
cd roe-search && npx wrangler d1 execute roe-episodes --remote --file=../schema.sql
```

### Regenerate summaries
```
node scripts/generate-summaries.js
```

### Backfill guest names
```
node scripts/backfill-guests.js
```

## Key Files

| File | What's In It |
|------|-------------|
| `schema.sql` | D1 schema — episodes, transcript_segments, transcript_fts (FTS5), episode_guests, places, place_mentions |
| `roe-search/wrangler.jsonc` | Worker config — D1, R2, Vectorize, AI bindings |
| `roe-pipeline/wrangler.jsonc` | Worker config — D1, R2, Vectorize, Durable Object, queue bindings |
| `.env` | Secrets: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, OPENAI_API_KEY |
| `r2-cors.json` | R2 CORS rules (GET/HEAD from all origins) |
| `scripts/batch-progress.json` | Checkpoint/resume state for process-all.js |
| `docs/superpowers/specs/` | Design specs for major features |
| `docs/superpowers/plans/` | Implementation plans |
