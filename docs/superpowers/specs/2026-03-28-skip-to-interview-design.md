# Skip to Interview Feature

## Summary

Add a "Skip to interview with [Guest Name]" button to each episode card that jumps the audio player to the start of the guest interview segment. Guest interview start timestamps are detected from transcript data and stored in the database.

## Data Layer

### Schema Change

Add `guest_start_ms` column to the `episodes` table:

```sql
ALTER TABLE episodes ADD COLUMN guest_start_ms INTEGER;
```

One timestamp per episode (not per guest) — guests typically arrive together for a single interview segment.

### Backfill Script

A new script (`scripts/backfill-guest-start.js`) scans all 570 transcripts and computes `guest_start_ms` using the following detection logic:

**Detection algorithm (ordered by priority):**

1. **Time window filter** — Only consider transcript segments after the 50-minute mark (3,000,000ms)
2. **Song break detection** — Find the last segment with duration 180s+ (song) or a timestamp gap of 60s+ between consecutive segments in the 50-75 minute window
3. **Guest name match** — After that song break, find the first segment mentioning any of the episode's guest names (case-insensitive substring match)
4. **Fallback A** — If no song break found, use the first guest name mention after 50 minutes
5. **Fallback B** — If no guest name found at all, use the first speech segment after the last song break
6. **Fallback C** — Fixed offset of 3,600,000ms (1 hour)

**Skip conditions:**
- Episodes with no guests in `episode_guests` — no `guest_start_ms` is set
- Episodes shorter than 50 minutes — no `guest_start_ms` is set

**Data source:** Local transcript JSON files in `transcripts/` directory (same format used by `seed-db.js`).

**Output:** Updates `episodes.guest_start_ms` in D1 via Cloudflare API.

### Pipeline Integration

Update `scripts/process-episode.js` to compute and store `guest_start_ms` for new episodes as part of the existing pipeline, using the same detection logic.

## API Layer

### Episode List Response

The existing `/api/episodes` endpoint already returns episode fields. Include `guest_start_ms` in the response. Also include guest names per episode (join with `episode_guests`).

### Episode Detail Response

The existing `/api/episode/:id` endpoint should also return `guest_start_ms` and guest names.

## Frontend

### Button

Add a "Skip to interview with [Guest Name]" button to each episode card in `episodes.html`.

**Behavior:**
- Calls the existing `playAt(audioUrl, guest_start_ms, title)` function
- Only rendered when `guest_start_ms` is populated and the episode has guests
- For multiple guests, combine names: "Skip to interview with John Smith & Jane Doe"
- If more than 3 guests, truncate: "Skip to interview with John Smith, Jane Doe & 2 others"

**Styling:**
- Consistent with existing "Play" and "Skip intro" buttons (same button class/style)
- Placed alongside those buttons in the action row

### Search Results (frontend.html)

If an episode appears in search results and has `guest_start_ms`, show the same button in the result card.

## File Changes

| File | Change |
|------|--------|
| `schema.sql` | Add `guest_start_ms` column to `episodes` |
| `scripts/backfill-guest-start.js` | New script — detect and store guest interview timestamps |
| `scripts/process-episode.js` | Compute `guest_start_ms` during pipeline |
| `roe-search/src/index.js` | Include `guest_start_ms` and guest names in API responses |
| `roe-search/src/episodes.html` | Add "Skip to interview" button to episode cards |
| `roe-search/src/frontend.html` | Add "Skip to interview" button to search result cards |
