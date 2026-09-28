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
│   ├── process-episode.js     # Local pipeline: transcribe (whisper.cpp or --engine openai) → seed → embed → summary → upload
│   ├── transcribe.js          # OpenAI Whisper with roe-pipeline's code, resumable chunk by chunk
│   ├── transcript-file.js     # Writes transcripts/<id>.json the same way for both engines (meta, loops, re-transcribe list)
│   ├── remote-cloudflare.js   # Workers AI + Vectorize stand-ins over the REST API (paced), for roe-pipeline's embeddings code
│   ├── vector-ids.js          # The search index's IDs by episode: one listing per run, waiting for Vectorize's queue
│   ├── generate-embeddings.js # Make the search index match D1's lines: dry run, --yes, --orphans, --resume (the rebuild)
│   ├── process-all.js         # Batch runner with checkpoint/resume; falls back to a date's next recording
│   ├── discover-episodes.js   # Scan directory, parse filenames, a date's file and its alternates
│   ├── generate-summaries.js  # Regenerate AI summaries
│   ├── rewrite-summaries.js   # Rewrite only the summary text (repaired episodes): dry run, review file, --apply --yes
│   ├── summary-engines.js     # Its summary-only prompt; GPT-4o-mini or a local model through Ollama
│   ├── cleanup-places.js      # Remove false positive places from D1
│   ├── redo-places.js         # Redo one episode's places with roe-pipeline's code
│   ├── delete-episode.js      # Back up, then remove an episode from D1 and Vectorize (--yes)
│   ├── episode-backup.js      # Back up an episode (with restore SQL) before a delete or merge
│   ├── repair-archive.js      # Redo damaged transcripts from a worklist: stage, check, then publish one at a time
│   ├── scan-transcripts.js    # Read-only scan of D1's transcripts (loops, holes, early stops, junk, durations)
│   ├── clean-junk-lines.js    # Delete junk lines in D1 by rule, then redo the embeddings (dry run unless --yes)
│   ├── transcript-checks.js   # The checks those three share (and the old prompt's terms)
│   ├── fill-interview-times.js  # After a repair: empty, 60:00 or sign-off interview times from the detector (dry run unless --yes)
│   ├── reanchor-place-quotes.js # After a repair: place-quote times moved to where the quotes are now (dry run unless --yes)
│   ├── repaired-episodes.js   # What those two share: --only / --from-repair / --all, D1 lines a page at a time
│   ├── test/                  # node:test files for the scripts' own logic
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
| **scripts** | `scripts/process-episode.js` | Local processing (whisper.cpp or OpenAI + ffmpeg). It imports roe-pipeline's code for transcription (OpenAI), cleaning and loops, file names, summaries, embeddings and interview times, so both pipelines give the same results; no places or sentiment (redo-places.js does those) | D1, R2, Vectorize, OpenAI |
| **D1 database** | `schema.sql` | SQLite: episodes, transcript_segments, transcript_fts (FTS5), episode_guests, places, place_mentions | |
| **R2 bucket** | `roe-audio` | Audio file storage. Public URL: `pub-e95bd2be3f9d4147b2955503d75e50c1.r2.dev` | |
| **Vectorize** | `roe-transcripts` | 768-dim embeddings (cosine). Model: `@cf/baai/bge-base-en-v1.5` | |

## How To

### Run roe-search locally
```
cd roe-search && npm run dev    # http://roe.localhost:8791 (the port is pinned in package.json)
```

### Deploy roe-search
```
cd roe-search && npx wrangler deploy
npm run smoke    # checks every route the pages use on rollovereasy.org; run after each deploy
```

### Run roe-pipeline locally
```
cd roe-pipeline && npm run dev    # http://127.0.0.1:8793
```

### Deploy roe-pipeline
```
cd roe-pipeline && npm run deploy
```

### Run roe-pipeline tests
```
cd roe-pipeline && npm test
```

### Run the scripts' tests
```
node --test scripts/test/*.test.js    # discover-episodes, process-all, the seed SQL, the repair tools' checks and plans, the summary rewrite
```

### Test the scripts on a scratch D1
Scripts with `--local` use the local D1 copy (and local R2). With `ROE_PERSIST_TO=<dir>` that copy,
the transcripts, the backups and the warnings log all live in `<dir>` (transcripts in
`<dir>/transcripts`), and `lib.js` refuses any `--remote` wrangler call or Vectorize write, so a test
can't touch production or your own local state:
```
export ROE_PERSIST_TO=/tmp/roe-test
(cd roe-search && npx wrangler d1 execute roe-episodes --local --persist-to $ROE_PERSIST_TO --file=../schema.sql)
# …copy rows in (production SELECTs are fine), then e.g.:
node scripts/delete-episode.js <id> --local --yes
```
`process-all.js` has no `--local`: in a test run it asks the scratch D1 which episodes are done, runs
phase 2 with `--local`, and keeps its `batch-progress.json` in `<dir>`. With `--local`,
`episode-backup.js`, `delete-episode.js` and `merge-episode.js` neither read nor change Vectorize.
`generate-embeddings.js` only works on production, so it doesn't run in a test run at all.

### Process a single episode (local pipeline)
```
node scripts/process-episode.js "/path/to/Roll Over Easy 2026-03-27.mp3"
# Options: --episode-id ID, --force summary,guest-start (steps to redo), --skip transcribe,seed-db,
#          --include-reviewed, --local (the local D1 copy), --engine whisper.cpp|openai,
#          --no-gpu (whisper.cpp on the CPU), --accept-short (seed a transcript that stops early)
```
whisper.cpp can hang for good while it starts the GPU (Metal) on this Mac, with no message. So
before any work it gets a one-second test run (60 s limit), and the real run is stopped at 4x the
recording's length (8x with `--no-gpu`) plus 5 minutes. `--no-gpu` passes `-ng` and sets
`GGML_METAL_DEVICES=0`, since even `whisper-cli -ng` starts the Metal device otherwise. On the CPU it
takes about 2.5x the recording's length; on the GPU about a quarter. `process-all.js` and
`ingest-server.js` take `--no-gpu` too.

The transcript file is written by `transcript-file.js` for both engines: spelling fixes and
`findLoops` before saving, and a `meta` block (engine, settings, the recording's real length, loops,
holes, coverage). The seed step refuses a transcript that ends past its recording or stops before
90% of it unless `--accept-short`, re-seeds when D1 holds a different transcript (lines off by 20%+
or the end by 60 s+, and only from a complete file), sets `duration_ms` to the recording's real
length, and cleans an old file without `meta` the new way first (the original goes to
`transcripts/.backups/`). It replaces the lines in one D1 import (`seedSQL`, run with
`wrangler d1 execute --file`): a crash leaves the old transcript or the new one, never part of one,
and production D1 answers no other queries for the few seconds the import takes. (Staging the new
lines under a temporary episode ID would need a temporary `episodes` row for the foreign key, which
the site would list.) The embeddings step deletes the vectors a replaced transcript had and the
new one doesn't. Episodes needing another pass are listed in `transcripts/.retranscribe/episodes.json`.
With `--episode-id` and transcribe, seed-db and upload-audio skipped, no audio file is needed.

An episode whose guests were reviewed (`guests_reviewed = 1`) keeps its title, summary, guests and
interview time, even with `--force`, unless `--include-reviewed` is given (new AI guests then go
back to the admin page's review queue); the same goes for `generate-summaries.js`,
`backfill-guest-start.js` and `process-all.js`. The interview time is only filled in when empty
unless its step is forced. Forcing `transcribe` also forces `seed-db`, so D1 gets the new
transcript. A mistyped option or step name stops the script.

### Batch process episodes (local pipeline)
```
node scripts/process-all.js "/path/to/All episodes/" --cooldown 120 --dry-run
```
Dates recorded as several different files are skipped and listed as `MULTI-PART`: join the parts
into one file first. Episodes already complete on the site are left alone. When the quality gate
rejects a transcript, the date's next recording (discover-episodes' `alternates`: other files of
that date, not copies of the same size) is tried in the same run, under the date's episode ID. Every
rejected file is recorded (name and size) in `batch-progress.json`, and its transcript goes to
`transcripts/.rejected/`; a later run skips the date until a file it hasn't rejected appears.

### Repair damaged transcripts
```
node scripts/repair-archive.js --worklist repair-worklist.csv --dry-run      # plan, audio, GPU time, cost
node scripts/repair-archive.js --worklist repair-worklist.csv --acts T        # a stage (or --only <dates>)
node scripts/scan-transcripts.js --only <dates> --m4a --json after.json      # read-only, before and after
```
The worklist's `act` column: W/O redo whole, J join a split show then redo, T install
`transcripts/.trial-2026-09-27/<id>.json`, L junk lines only (`clean-junk-lines.js`), M fix
`duration_ms`, X leave alone. Transcripts are made in `transcripts/.repair/staging/` (whisper.cpp
`large-v3-turbo` on the GPU by default; `--engine openai` is paid and capped by `--max-cost`, default
$0), checked (the site's audio length first, then coverage, no loops, 80% of the old words, 70% of its
distinctive words; holes are only listed), then published one at a time: backup, install,
`process-episode.js --force seed-db` (joins: seed and upload, times moved, then embeddings), and
checks on D1 (lines, keyword search, length, reviewed fields unchanged). `--local` needs
`ROE_PERSIST_TO`; one run at a time (a lock file). A
show that fails twice is set aside and the run goes on; a publishing failure stops it. It resumes
from `transcripts/.repair/progress.json`. Joined shows' interview and quote times move by the parts
added before the site's part. Each episode's backup (`transcripts/.backups/<date>-<id>/`) undoes it:
`restore.sql`, then `generate-embeddings.js --only <id> --yes`, the old transcript and, for joins, the
old .m4a (its README.txt has the commands). Details: README,
"Repairing damaged transcripts". Every write to production is gated by the owner: rehearse with
`--local` on a scratch D1 first.

After a repair (both read D1's lines as they are now; a dry run lists everything unless `--yes`):
```
node scripts/fill-interview-times.js --from-repair          # or --only <dates>, or --all; --except <dates>
node scripts/reanchor-place-quotes.js --from-repair
node scripts/fill-interview-times.js --apply transcripts/.backups/<date>-interview-times-plan/proposals.json --yes   # write what you read
```
`fill-interview-times.js` proposes the detector's time only where `guest_start_ms` is empty or
exactly 3,600,000 (60:00, the old detector's "found nothing"), that 60:00 moved by a join, or in
the last 10 minutes of a show 100+ minutes long (the old detector's sign-off pick; 60:00 when the
detector finds nothing there), reviewed episodes included; any other time stays.
`reanchor-place-quotes.js` finds each place
quote in the new lines (word for word, or 75% of its words in order; near a line naming the place
or its old time; in more than one place and none near the old time: kept) and moves only
`snippet_start_ms`, only where the old time no longer leads into the quote; it never adds or
deletes a row. `--from-repair` is every episode `transcripts/.repair/progress.json` (or
`--progress <file>`) has published or done, `--all` every episode in D1; an episode the repair is
working on is left out even with `--only`. A dry run saves its list in
`transcripts/.backups/<date>-interview-times-plan/` or `<date>-place-quotes-plan/` (there, moves.txt
is only the quotes that move), and `--apply <that list> --yes` writes it as it is (edit it first to
leave some out). Writing backs up first (`<date>-interview-times/` or `<date>-place-quotes/`:
before.json, applied.sql, restore.sql, README.txt), writes in one D1 import where the value (and
for a quote, its text) is still the one read, then reads it back. Details: README, "After a
repair: interview times and place quotes".

### Apply schema to D1
```
cd roe-search && npx wrangler d1 execute roe-episodes --remote --file=../schema.sql
```

### Regenerate summaries
```
node scripts/generate-summaries.js --dry-run    # lists the episodes it would do (no OpenAI calls)
node scripts/generate-summaries.js
```

### Rewrite summary text only (repaired episodes)
```
node scripts/rewrite-summaries.js --from-repair --engine ollama --plan               # episodes, size, cost; nothing asked
node scripts/rewrite-summaries.js --only <date|id>,… --engine ollama                # dry run: old and new side by side
node scripts/rewrite-summaries.js --from-repair --engine openai --max-cost 1          # GPT-4o-mini (paid), capped
node scripts/rewrite-summaries.js --apply transcripts/.summaries/<file>.json --yes     # write what you read
```
Sets `episodes.summary` and nothing else: title, guests, `guests_reviewed` and `guest_start_ms`
stay, reviewed episodes included (unlike `generate-summaries.js`). `--from-repair` takes the
episodes `transcripts/.repair/progress.json` shows as published or done; an episode the repair is
still working on is always left out. The prompt (`summary-engines.js`) is the Worker's summary
instructions asking for the summary only, with the hosts named as never guests and a reviewed
episode's guests given for their spelling; both engines get the same one. `--engine openai` runs
only within `--max-cost` (default $0: it stops after the plan); a dry run spends it too.
`--engine ollama` (default model `qwen3:30b`, free) needs the Ollama app or `ollama serve`; its
context is 32,768 tokens (`--num-ctx`), and a transcript too long for it leaves out its shortest
lines; thinking is off unless `--think`; it won't start while a whisper-cli without `-ng` is running
(the repair's, on the GPU). Ollama is called over `node:http`: `fetch` gives up after
300 s without response headers, and Ollama sends none until its whole answer is ready. The dry run
saves `transcripts/.summaries/<time>-<engine>-<model>.json` and `.md` with notes on what to check
(weather, temperatures or names the transcript lacks, a host called a guest). Writing backs up to
`transcripts/.backups/<date>-summaries/` (`restore.sql`), then one import that changes a summary
only where it is still the one the new one was made against and the transcript (its lines,
characters and end) the one it was made from, then checks. Details: README, "New summaries for
repaired episodes".

### Rebuild or check the search index (Vectorize)
```
node scripts/generate-embeddings.js --all                        # dry run: what differs from D1 (read-only)
node scripts/generate-embeddings.js --only <id>,<id> --yes       # re-embed some episodes
node scripts/generate-embeddings.js --all --orphans --yes        # the whole index (~$1.20 of Workers AI)
```
Each episode's vectors should be exactly the windows of its lines in D1. process-episode's
embeddings step does that for one episode: it embeds the lines and length D1 has (what the site
shows, not the local file), then deletes the episode's other vectors, including any a replaced
transcript left in `transcripts/.stale-vectors/`. A vector's ID is `<episode-id>:<window start ms>`,
and the only way to find an episode's vectors is to list the whole index (about 100 requests; the
Worker's binding can't list), so each script run lists it once and keeps that snapshot up to date
as it writes (`scripts/vector-ids.js`; a merge's process-episode run lists again, and
generate-embeddings again for its closing check), and matches IDs with `isEpisodeVectorId` (exactly
`<id>:<digits>`, never a same-date neighbour). A listing that comes back short of the count the
index gave stops the script. `replaceEmbeddings` (roe-pipeline/src/embeddings.js) upserts every
window before it deletes anything, and deletes 100 IDs a call. Vectorize applies writes from a queue
(under 30 s as a rule), so a listing right after a write may not show it; generate-embeddings waits
for the queue before its closing check. Cloudflare allows 1,200 API requests per 5 minutes per user
(going over blocks every call, wrangler's too, for 5 minutes): `remote-cloudflare.js` sends at most
about 3 a second. The rebuild's backups, plan and progress go to
`transcripts/.backups/<date>-embeddings/`. See README.md, "Rebuilding the search index". Tests:
`node --test scripts/test/*.test.js` runs these tools against a stand-in for the REST API (no
network), and roe-pipeline's vitest covers `replaceEmbeddings`.

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
| `roe-search/wrangler.jsonc` | Worker config — D1, R2, Vectorize, AI bindings, and the per-IP rate limits (`ratelimits`) |
| `roe-pipeline/wrangler.jsonc` | Worker config — D1, R2, Vectorize, Durable Object, queue bindings |
| `.env` | Secrets: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, OPENAI_API_KEY, PIPELINE_TOKEN (for roe-pipeline's /process and /status) |
| `r2-cors.json` | R2 CORS rules (GET/HEAD from all origins) |
| `scripts/batch-progress.json` | Checkpoint/resume state for process-all.js |
| `scripts/archive/README.md` | What the retired scripts were, and which must not be re-run |
| `docs/superpowers/specs/` | Design specs for major features (local only) |
| `docs/superpowers/plans/` | Implementation plans (local only) |
