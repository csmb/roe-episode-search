# Hide Search UI

**Date:** 2026-04-18
**Status:** Approved

## Goal

Remove the transcript search UI from the public site. The transcript content feels too exposing to have publicly searchable. API routes stay live (not concerned about direct API access), but the UI should not offer search.

## Changes

### 1. `frontend.html` — Remove search bar and mode toggle

Remove the search box (input + button) and the keyword/semantic mode toggle from the DOM. The `#panel-search` section keeps its container (for On This Day, clip card, status, etc.) but loses the search input controls.

Also remove the URL-based auto-search: the `?bummer-and-lazarus-fetch-me=` parameter check on page load should no longer trigger `doSearch()`.

### 2. `frontend.html` — Remove per-episode "Search" buttons

Three places render a per-episode search link (`&#128269; Search` pointing to `/?q=&episode=...`):

- `renderEpisode()` — search result cards
- `loadClip()` — shared clip card
- `loadOnThisDay()` — On This Day cards

Remove the search link from all three.

### 3. `episodes.html` — Remove per-episode "Search" button

The episode card renderer includes the same `&#128269; Search` link. Remove it.

### 4. Nav links — Drop "Search"

All pages with the shared nav show "Episodes · Map · Search". Change to "Episodes · Map". Affected files:

- `frontend.html`
- `episodes.html`
- Any other HTML files sharing the same nav (guests.html, admin.html, map.html, stars.html)

### What stays unchanged

- All search-related JS/CSS in `frontend.html` (dead code, harmless, keeps change minimal and reversible)
- All API routes (`/api/search`, `/api/semantic-search`, `/api/timeline`)
- Audio player, On This Day, clip sharing, confetti
- The homepage still serves `frontend.html` with On This Day + info cards
