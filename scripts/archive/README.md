# Archived scripts

These are kept for reference only. Nothing in the live pipeline uses them, and they don't run as is:

- **Their imports and data paths are broken.** They were moved here from `scripts/` and `scripts/candidates/`, so imports like `./lib.js`, `./process-episode.js` and `./discover-episodes.js`, and paths that go up one folder to reach the project, no longer point at the right place.
- **Their input data has been deleted**: the business database, the transcript index, the candidate lists, the matched-places files and the episode manifest.

Don't run them again, and in particular:

- **The map build.** The April 2026 map build put the fake pins and the common-word places on the map (audit items M1 and M2). That's `harvest-businesses.js`, `build-transcript-index.js`, `cross-reference.js`, `common-words-blocklist.json`, `seed-business-places.js`, `extract-places.js`, everything in `candidates/`, `cross-reference-candidates.js` and `seed-verified-places.js`. New episodes get their places from the `extract-places` step in `roe-pipeline/`.
- **`backfill-guests.js`** replaces episodes' guest lists with a fresh GPT guess (every episode with `--force`, otherwise any episode with no guests yet). That would undo the guest lists that have been reviewed by hand (M6).
- **`migrations/2026-05-17-place-sentiment.sql`** has already been applied to the live database, and its columns and table are part of `schema.sql`. Running it again fails, because the columns already exist.

The rest are old episode-archive tools:

- `download-missing-episodes.js` downloaded episodes that were missing locally from bff.fm into `All episodes/bff-fm-downloads/`.
- `generate-manifest.js` built `scripts/episode-manifest.json`, an episode status list that nothing reads any more.
- `audit-episodes.js` listed off-Thursday dates, missing Thursdays and duplicate files in `All episodes/`.
