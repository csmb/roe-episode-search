# Map Enrichment: External Data Sources Pipeline

**Date:** 2026-04-10
**Status:** Approved

## Goal

Enrich the Roll Over Easy map by pulling SF businesses, parks, trails, and landmarks from free external APIs, cross-referencing them against the show's 571 episode transcripts, and seeding verified matches to D1. Also clean up existing false positives in the places table.

## Current State

- 1,264 places in D1 with 5,718 place-mention links
- Existing pipeline: GPT-4o-mini extracts places from transcripts, geocodes via Nominatim, seeds to D1
- Known false positives in existing data ("Anthony", "Lyft", "Rogue", "Irving")
- 882 business matches already seeded from a prior cross-reference pass

## Approach

Hybrid pipeline: separate fetch scripts per data source, shared candidate format, single cross-reference + LLM verification step.

## Data Sources

### 1. Yelp Fusion API (`scripts/candidates/fetch-yelp.js`)

- **Endpoint:** `/v3/businesses/search`
- **Auth:** Free API key (500 req/day)
- **Strategy:** Search SF by category. Categories: `restaurants`, `bars`, `coffee`, `bakeries`, `musicvenues`, `bookstores`, `grocery`, `arts`, `nightlife`, `breakfast_brunch`, `foodtrucks`
- **Pagination:** 50 results/request, up to 1,000 per query. ~11 categories x 20 pages = ~220 requests. Full sweep in 1 day.
- **Output fields:** name, address, lat/lng, category, Yelp rating

### 2. DataSF Open Data (`scripts/candidates/fetch-datasf.js`)

- **Endpoint:** SF Registered Business Locations dataset via Socrata API (`data.sfgov.org`)
- **Auth:** None required
- **Strategy:** Bulk download active businesses with DBA names. Filter to relevant categories (food, entertainment, retail) and businesses registered 2013+.
- **Volume:** Tens of thousands of records.
- **Output fields:** DBA name, address, business start date, NAICS category

### 3. OpenStreetMap Overpass API (`scripts/candidates/fetch-osm.js`)

- **Endpoint:** Overpass API (`overpass-api.de`)
- **Auth:** None required
- **Strategy:** Query POIs within SF bounding box:
  - Parks and gardens (Golden Gate Park features, neighborhood parks)
  - Trails and paths (Presidio, Lands End, etc.)
  - Landmarks and historic sites
  - Transit stations
  - Cultural venues (theaters, galleries, museums)
- **Volume:** A few thousand POIs.
- **Output fields:** name, lat/lng, OSM tags (type, amenity)

### Shared Candidate Format

All fetchers output to `scripts/candidates/<source>.json`:

```json
{
  "name": "Ritual Coffee Roasters",
  "address": "1026 Valencia St",
  "lat": 37.7565,
  "lng": -122.4212,
  "source": "yelp",
  "category": "coffee",
  "meta": {}
}
```

## Deduplication & Merge (`scripts/candidates/merge-candidates.js`)

Takes the three source files, produces `scripts/candidates/all.json`.

**Dedup logic:**
- Normalize names: lowercase, strip common suffixes ("Inc", "LLC", "SF"), collapse whitespace
- Group by normalized name — merge duplicates across sources
- Prefer coordinates from OSM/Yelp (more precise) over DataSF (address-based)
- Track which sources contributed each candidate

**Filtering:**
- Drop candidates with names <= 2 characters or purely numeric
- Drop names that are common English words (maintain a stoplist to avoid false positives like "The Page", "Amber", "Grace")
- Drop DataSF businesses that closed before 2013

**Expected volume:** 5,000-15,000 unique candidates after dedup.

## Cross-Reference (`scripts/cross-reference-candidates.js`)

### Step 1: FTS5 Screening

- Query D1's `transcript_fts` table for each candidate: `WHERE transcript_fts MATCH '"candidate name"'` (phrase match)
- Use Cloudflare D1 HTTP API (not wrangler CLI) for speed at volume
- Batch queries, pace at ~50/sec
- Output: candidate -> list of `{episode_id, segment_text, start_ms, end_ms}` hits

### Step 2: Pre-LLM Filtering

- Skip candidates with 0 transcript hits
- Skip candidates whose name is a substring of a longer already-matched candidate
- Skip obviously wrong matches where detectable

### Step 3: LLM Verification

- For each candidate with hits, send surrounding context (+/- 200 chars) to GPT-4o-mini
- Prompt: "Is the speaker referring to [name], the [category] at [address] in San Francisco? Or is this a coincidental word match? Reply YES or NO with a one-line reason."
- Batch ~10 verifications per API call to reduce cost
- Expected: most candidates have 0 FTS5 hits. ~1,000-3,000 need LLM verification. ~100-300 GPT-4o-mini calls. Cost: ~$0.50-2.00.

### Step 4: Output

`scripts/verified_places.json`:

```json
{
  "matches": [
    {
      "name": "Tartine Bakery",
      "lat": 37.7614,
      "lng": -122.4241,
      "source": "yelp",
      "category": "bakery",
      "confidence": "llm_verified",
      "episode_count": 12,
      "episodes": [
        {
          "episode_id": "roll-over-easy_2014-02-06_07-30-00",
          "mentions": [
            { "start_ms": 1234, "end_ms": 5678, "context": "..." }
          ]
        }
      ]
    }
  ]
}
```

**Checkpoint/resume:** Save progress after each batch for restartability.

## Seeding to D1 (`scripts/seed-verified-places.js`)

- Reads `verified_places.json`
- Same pattern as existing `seed-business-places.js`:
  - `INSERT OR IGNORE INTO places (name, lat, lng)` in batches of 20
  - Fetch back place IDs
  - `INSERT OR IGNORE INTO place_mentions (place_id, episode_id)` in batches of 20
- Skips episodes not in DB
- Idempotent

## Cleanup Existing False Positives (`scripts/cleanup-places.js`)

- Fetches all 1,264 current places from D1
- For each, queries `transcript_fts` for the place name
- Sends context to GPT-4o-mini for verification
- Outputs `scripts/cleanup_report.json` listing places to remove with reasons
- `--apply` flag: deletes flagged places and mentions from D1
- Without `--apply`: dry run, user reviews report first

## Execution Order

```
1. fetch-yelp.js          (needs YELP_API_KEY)
2. fetch-datasf.js        (no auth)
3. fetch-osm.js           (no auth)
   (1-3 run in parallel)

4. merge-candidates.js    (depends on 1-3)
5. cross-reference-candidates.js  (depends on 4, needs OPENAI_API_KEY + D1 access)
6. seed-verified-places.js        (depends on 5, needs D1 access)
7. cleanup-places.js              (independent, needs OPENAI_API_KEY + D1)
```

## Environment Variables

- `OPENAI_API_KEY` — existing
- `CLOUDFLARE_ACCOUNT_ID` — existing
- `CLOUDFLARE_API_TOKEN` — existing
- `YELP_API_KEY` — new, free signup at yelp.com/developers

## What Changes

- **New files:** 7 scripts in `scripts/` and `scripts/candidates/`
- **New data files:** candidate JSONs, verified_places.json, cleanup_report.json

## What Stays the Same

- Map UI (`map.html`) — no changes
- Schema (`places`, `place_mentions`) — no changes
- Existing pipeline (`process-episode.js`) — untouched
- `places.json` — not modified
- No `wrangler deploy` needed

## Expected Outcome

- Current: 1,264 places, 5,718 mentions
- After: ~2,000-4,000 places, ~10,000-20,000+ mentions
- False positives like "Anthony" and "Lyft" removed
