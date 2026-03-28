# Serverless Episode Processing Pipeline

**Date:** 2026-03-27
**Status:** Draft

## Summary

Replace the local, manually-triggered episode processing pipeline with a fully serverless pipeline on Cloudflare. Uploading an MP3 to the R2 bucket via the Cloudflare dashboard triggers automatic transcription, database seeding, embedding generation, and summary creation — no manual intervention beyond the upload itself.

## Architecture

### Trigger

- Upload an MP3 to the existing `roe-audio` R2 bucket (via Cloudflare dashboard drag-and-drop)
- R2 **event notification** on `object-create` fires a new `roe-pipeline` Worker

### Components

| Component | Role |
|-----------|------|
| `roe-audio` R2 bucket | Stores episode MP3s; fires event notifications on upload |
| `roe-pipeline` Worker | Receives R2 events, delegates to Durable Object |
| `EpisodePipeline` Durable Object | Orchestrates the full pipeline for a single episode |
| OpenAI Whisper API | Transcription (replaces local whisper-cpp) |
| OpenAI GPT-4o-mini | Title and summary generation |
| Cloudflare D1 (`roe-episodes`) | Episode metadata, transcript segments, FTS index |
| Cloudflare Vectorize (`roe-transcripts`) | Semantic search embeddings |
| `roe-search` Worker | **Unchanged** — continues serving the site and API |

### Data Flow

```
Upload MP3 to R2
  → R2 object-create event notification
  → roe-pipeline Worker receives event
  → Creates/gets EpisodePipeline Durable Object (keyed by episode ID)
  → DO streams MP3 from R2
  → DO parses MP3 frames, chunks into ~20MB segments
  → Each chunk → OpenAI Whisper API → transcript segments
  → Stitch segments with cumulative time offsets
  → Seed D1: episodes row + transcript_segments + transcript_fts
  → Generate embeddings (45s windows, 35s step) → Vectorize
  → Generate title + summary via GPT-4o-mini → update D1
  → Update episodes.audio_file with R2 public URL
```

## Filename Convention

The pipeline parses episode ID and date from the uploaded filename. It reuses the existing `parseEpisodeId()` logic, which handles formats like:

- `roll-over-easy_2026-03-27_07-30-00.mp3` (canonical)
- `Roll Over Easy 2026-03-27.mp3`
- `Roll Over Easy - 2026-03-27.mp3`

The only requirement is that the filename contains a recognizable date.

## Audio Chunking

Episodes are up to ~200MB. OpenAI Whisper API has a 25MB file size limit. The Durable Object handles chunking:

1. Stream MP3 from R2 using range requests
2. Parse MP3 frame headers (fixed-size headers, ~417 bytes per frame at 128kbps)
3. Accumulate frames until chunk reaches ~20MB
4. Send chunk to Whisper API with cumulative time offset
5. Stitch transcript segments across chunks, adjusting timestamps

MP3 frame parsing is straightforward — each frame starts with a sync word (`0xFFE0` mask), and the frame size is calculable from the header's bitrate and sample rate fields.

## Durable Object: `EpisodePipeline`

**Why a Durable Object:**
- No CPU time limit (billed by wall-clock duration) — essential for multi-minute transcription jobs
- Holds state across async steps (current chunk, accumulated transcript)
- Single-threaded per episode ID — natural dedup if the same file triggers twice
- Built-in storage for checkpointing progress

**Keyed by:** episode ID (e.g., `roll-over-easy_2026-03-27_07-30-00`)

**Pipeline steps executed in the DO:**

| Step | Action | Idempotency Check |
|------|--------|--------------------|
| 1. Parse filename | Extract episode ID and date | — |
| 2. Dedup check | `SELECT id FROM episodes WHERE id = ?` | Skip if exists |
| 3. Chunk & transcribe | Stream from R2, chunk, send to Whisper API | Resume from last chunk via DO storage |
| 4. Seed D1 | Insert episode + transcript_segments + FTS | Skip if episode row exists |
| 5. Embeddings | 45s windows, 35s step → Vectorize | Always runs (upserts) |
| 6. Summary | GPT-4o-mini generates title + summary | Skip if summary exists |
| 7. Set audio URL | Update `episodes.audio_file` to R2 public URL | Skip if already set |

**Episode status in D1:** `processing` → `completed` or `failed`

**Error handling:** If a step fails, the DO stores its progress (current step, chunk index) in Durable Object storage. A retry (re-upload or manual trigger) resumes from the last successful step.

**Re-processing:** To reprocess an episode (e.g., a better quality MP3), delete the episode row from D1 first, then re-upload. The dedup check will see no existing row and run the full pipeline.

## Configuration

### `wrangler.toml` (new `roe-pipeline` project)

```toml
name = "roe-pipeline"
main = "src/index.js"
compatibility_date = "2024-01-01"

[[d1_databases]]
binding = "DB"
database_name = "roe-episodes"
database_id = "<same as roe-search>"

[[r2_buckets]]
binding = "AUDIO_BUCKET"
bucket_name = "roe-audio"

[[vectorize]]
binding = "VECTORIZE"
index_name = "roe-transcripts"

[durable_objects]
bindings = [
  { name = "EPISODE_PIPELINE", class_name = "EpisodePipeline" }
]

[[migrations]]
tag = "v1"
new_classes = ["EpisodePipeline"]

[vars]
R2_PUBLIC_URL = "https://pub-e95bd2be3f9d4147b2955503d75e50c1.r2.dev"
EMBED_MODEL = "@cf/baai/bge-base-en-v1.5"
```

### Secrets (via `wrangler secret put`)

- `OPENAI_API_KEY` — for Whisper API and GPT-4o-mini

### R2 Event Notification

Configured via Cloudflare dashboard or wrangler CLI:
- Bucket: `roe-audio`
- Event type: `object-create`
- Target: `roe-pipeline` Worker
- Prefix filter (optional): none, or filter to `.mp3` suffix

## What Changes vs. What Stays

### New
- `roe-pipeline` Worker project (new directory alongside `roe-search`)
- `EpisodePipeline` Durable Object class
- R2 event notification on `roe-audio` bucket
- OpenAI Whisper API integration
- JS-based MP3 frame parser for chunking

### Unchanged
- `roe-search` Worker — no modifications
- D1 schema — same tables, same columns
- Vectorize index — same embeddings approach
- R2 bucket — same bucket, now also the trigger source
- Existing local pipeline scripts — remain for backfilling old episodes

### Not needed in new pipeline
- whisper-cpp (replaced by OpenAI Whisper API)
- ffmpeg/ffprobe (no audio conversion — MP3 stored as-is)
- Local manifest/checkpoint system (D1 is the source of truth)

## Embedding Parameters

Carried over from the existing pipeline:
- Window size: 45 seconds
- Step size: 35 seconds (10-second overlap)
- Model: `@cf/baai/bge-base-en-v1.5` (768 dimensions)
- Batch size: 100 embeddings per API call
- Upsert batch size: 1000 vectors per Vectorize call

## Cost Considerations

- **OpenAI Whisper API:** $0.006/minute of audio. A 2-hour episode = ~$0.72
- **OpenAI GPT-4o-mini:** Negligible for a single title/summary
- **Durable Object:** Billed by wall-clock duration ($0.15 per million requests + $12.50 per million GB-s)
- **R2 event notifications:** Free
- **R2 storage:** Existing cost, no change

Weekly cost for one episode: under $1.
