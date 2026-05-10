# Map Page — Place Search Bar

**Date:** 2026-05-09
**Status:** Approved (verbal), pending written review
**Scope:** `roe-search/src/map.html` only. No worker/API changes.

## Goal

Let visitors find a specific San Francisco place on the map without scanning hundreds of pins. Type a place name (typos OK), pick from a dropdown, and the map flies to that pin and opens its popup.

## Non-goals

- Searching episode titles, guest names, or transcript text from this bar (those are separate features).
- Filtering / hiding non-matching pins.
- Server-side search.

## Architecture

A self-contained client-side feature added to the existing inline `<script>` in `map.html`.

- Add **Fuse.js** via CDN (`https://unpkg.com/fuse.js@7/dist/fuse.min.js`), matching the existing Leaflet-via-unpkg pattern.
- Reuse the existing `/api/map-places` payload — no new endpoints, no extra fetches.
- After fetching places, build:
  - A Fuse index over `places[].name`.
  - A `Map<string, L.CircleMarker>` (`markersByName`) so a search hit can act on the corresponding marker.
- Render the search UI as a **Leaflet custom control** (`L.Control.extend(...)`) in the top-left, so it shares lifecycle with the map and is unaffected by Leaflet's gesture handling.

## UI

### Layout

- Search input + results dropdown live in a single Leaflet control, top-left of the map.
- Leaflet's default zoom control is **moved to top-right** to avoid collision (`L.control.zoom({ position: 'topright' })`).

### Components

**Search input**
- `<input type="search" placeholder="Search a place…">` styled to match the existing CARTO/Leaflet aesthetic: white background, ~6px border-radius, subtle box-shadow, ~12–14px font.
- Width: 240px on desktop, expands to `calc(100vw - 32px)` on screens <640px so it's tap-friendly.
- Keyboard shortcut `/` focuses it (when not already focused on a text input).

**Results dropdown**
- `<ul>` absolutely positioned directly below the input, same width.
- Each `<li>` shows: place name (bold) + episode count subtitle (e.g., "Tartine Bakery · 12 episodes").
- Hidden when the input is empty.
- When the input has content but no matches, shows a single greyed-out row: "No matching places."
- Caps at 8 visible results; scrolls if more.
- Hovering or arrow-keying highlights a row.

### Behavior

| User action | Result |
|---|---|
| Focus input (click, tab, or `/`) | Cursor in input. If input has text, dropdown reopens. |
| Type | Debounced ~80ms, run Fuse query, render dropdown. |
| ↑ / ↓ | Move highlight between dropdown rows. |
| Enter | Select highlighted row (or first row if none highlighted). |
| Esc | Clear input, hide dropdown, blur on mobile. |
| Click outside | Hide dropdown (input keeps its text). |
| Click row / press Enter | See "On select" below. |

### On select

1. Look up marker via `markersByName.get(name)`.
2. `map.flyTo([lat, lng], 17, { duration: 0.6 })` — pan + zoom to street level.
3. `marker.openPopup()`.
4. Clear input, hide dropdown, blur on mobile.

## Data flow

```
Page load
  │
  ▼
GET /api/map-places  ──►  build pin layer (existing code, unchanged)
                     ──►  build Fuse index over places[].name
                     ──►  build markersByName Map<string, circleMarker>

User types "tartne"
  │
  ▼
debounce ~80ms  ──►  fuse.search("tartne", { limit: 8 })
                ──►  render dropdown rows (name + episode count)

User clicks "Tartine Bakery"
  │
  ▼
1. markersByName.get("Tartine Bakery")
2. map.flyTo([lat, lng], 17, { duration: 0.6 })
3. marker.openPopup()
4. clear input, hide dropdown, blur on mobile
```

## Fuse configuration

```js
new Fuse(places, {
  keys: ['name'],
  threshold: 0.4,        // 0 = exact, 1 = matches anything; 0.4 is forgiving but not spammy
  ignoreLocation: true,  // match anywhere in the string
  minMatchCharLength: 2, // avoid one-character match noise
});
```

## Edge cases

| Case | Handling |
|---|---|
| Two places share a name | Cannot happen; `places.name` is `UNIQUE` in the schema. |
| Empty places list (e.g., DB not seeded) | Search bar still renders. Dropdown shows "No places loaded yet." when typed into. |
| `/api/map-places` fails | Existing error path (`Failed to load places.`) handles this. Search bar stays inert (no Fuse index built). |
| Place name has special chars (`&`, accents) | Fuse handles natively; no extra normalization needed. |
| Mobile virtual keyboard covers dropdown | Dropdown anchors to the input which sits at the top of the map; viewport scroll keeps it visible above the keyboard. |

## Testing & verification

No test runner exists in this project — verification is manual, in-browser, on both desktop and mobile widths (~390px). Mobile responsiveness is a project requirement.

**Manual checklist:**

- [ ] Page loads, pins render as before (regression).
- [ ] Typing "tart" surfaces "Tartine Bakery" in the dropdown.
- [ ] Typing "doloeres" (typo) still surfaces "Dolores Park" — confirms fuzzy.
- [ ] Typing "xyznotaplace" shows the empty-state row.
- [ ] Clicking a result pans + zooms + opens the popup.
- [ ] Esc clears the input and hides the dropdown.
- [ ] `/` key focuses the search input from anywhere on the page.
- [ ] ↑ / ↓ / Enter keyboard navigation works.
- [ ] Zoom controls now appear in the top-right and still function.
- [ ] At ~390px width: input is tap-friendly, dropdown doesn't overflow the viewport.
- [ ] Hover-popup behavior on existing pins is unchanged.

## Deployment

- Single-file change to `roe-search/src/map.html`.
- Deploy with `cd roe-search && npx wrangler deploy`.
- No DB migrations, no new environment vars, no new bindings.

## Open questions

None. Design is fully specified.
