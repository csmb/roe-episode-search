# Hide Search UI

**Date:** 2026-04-18
**Status:** Approved

## Goal

Remove the transcript search UI from the public site. The transcript content feels too exposing to have publicly searchable. API routes stay live (not concerned about direct API access), but the UI should not offer search.

Move the search functionality to a new "Search" tab on the admin page, which is password-protected.

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

### 5. `index.js` — Add `/admin` route with password protection

The admin page currently has no explicit route (the catch-all serves `frontend.html`). Add:

- A `/admin` route that serves `admin.html`
- Password protection using a Cloudflare Workers secret `ADMIN_PASSWORD`
- The admin page shows a password prompt on load. The entered password is stored in `sessionStorage` and sent as a header (`X-Admin-Password`) with all admin API requests
- The worker checks this header on all `/admin` and `/api/admin/*` routes, returning 401 if missing/wrong
- After deploy, the user sets the secret via `wrangler secret put ADMIN_PASSWORD`

### 6. `admin.html` — Add "Search" tab

Add a fourth tab to the admin page alongside "All Guests", "Review Queue", and "Tools":

- **Search tab** contains: search input box, keyword/semantic mode toggle, status line, timeline chart, and search results
- Reuses the same search API endpoints (`/api/search`, `/api/semantic-search`, `/api/timeline`)
- Results render with the same episode card format (title, date, matches with timestamps, audio playback)
- The search functionality is a self-contained copy within admin.html (since the HTML files are independent inline files)

### What stays unchanged

- All search-related JS/CSS in `frontend.html` (dead code, harmless, keeps change minimal and reversible)
- All API routes (`/api/search`, `/api/semantic-search`, `/api/timeline`) — remain publicly accessible at the API level
- Audio player, On This Day, clip sharing, confetti on the public site
- The homepage still serves `frontend.html` with On This Day + info cards
