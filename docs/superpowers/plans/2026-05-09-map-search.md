# Map Page Place Search — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fuzzy place search bar to the map page that pans, zooms, and opens a popup when a result is selected.

**Architecture:** Self-contained client-side feature. All changes live in `roe-search/src/map.html`. Adds Fuse.js via CDN, builds an in-memory index from the existing `/api/map-places` payload, renders the search UI as a Leaflet custom control in the top-left, and moves Leaflet's default zoom control to the top-right to avoid collision. No worker, API, or DB changes.

**Tech Stack:** Vanilla JS, Leaflet 1.9.4, Fuse.js 7 (via unpkg).

**Spec:** `docs/superpowers/specs/2026-05-09-map-search-design.md`

**Verification approach:** No test runner exists in this project; every task ends with manual in-browser verification on both desktop and mobile widths (~390px). Use `cd roe-search && npx wrangler dev --remote` and browse to `http://roe.localhost:8787/map`.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `roe-search/src/map.html` | Modify | All UI, styles, and search logic — single self-contained page. |

No new files. The existing inline `<script>` block grows; we group new helpers at the top of the script and the new control class above `loadPlaces()`.

---

## Task 1: Move zoom control to top-right and add Fuse.js dependency

**Files:**
- Modify: `roe-search/src/map.html`

This is the prep step: free up the top-left for the search control and load the fuzzy-match library. Tiny, isolated commit.

- [ ] **Step 1: Add Fuse.js script tag**

In `roe-search/src/map.html`, find this existing line in `<head>` (near line 9):

```html
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
```

Add this immediately after it:

```html
<script src="https://unpkg.com/fuse.js@7.0.0/dist/fuse.min.js"></script>
```

- [ ] **Step 2: Move zoom control to top-right**

Find the existing map initialization (around line 147):

```js
const map = L.map('map').setView([37.7749, -122.4194], 13);
```

Replace it with:

```js
const map = L.map('map', { zoomControl: false }).setView([37.7749, -122.4194], 13);
L.control.zoom({ position: 'topright' }).addTo(map);
```

- [ ] **Step 3: Manual verification**

Run `cd roe-search && npx wrangler dev --remote`, open `http://roe.localhost:8787/map`.

Expected:
- Map loads as before with all pins visible.
- Zoom +/− buttons appear in the **top-right** corner (not top-left).
- Top-left corner is empty (ready for the search bar).
- Open DevTools Console: no errors. Type `Fuse` at the console — it should resolve to the Fuse constructor function.

- [ ] **Step 4: Commit**

```bash
git add roe-search/src/map.html
git commit -m "feat(map): load Fuse.js and move zoom control to top-right"
```

---

## Task 2: Build Fuse index and marker lookup after places load

**Files:**
- Modify: `roe-search/src/map.html`

Wire the data side: after `/api/map-places` returns, build the Fuse index and a `Map<name, marker>` so the upcoming UI has something to query and act on.

- [ ] **Step 1: Add module-level state**

In `roe-search/src/map.html`, find the existing line (around line 147):

```js
const map = L.map('map', { zoomControl: false }).setView([37.7749, -122.4194], 13);
```

Add these declarations immediately after the `L.tileLayer(...).addTo(map);` call (around line 152):

```js
let fuseIndex = null;
const markersByName = new Map();
```

- [ ] **Step 2: Populate the index and lookup inside loadPlaces()**

Find the existing `for (const place of places)` loop in `loadPlaces()` (around line 178). Inside the loop, immediately after this existing line:

```js
const circle = L.circleMarker([place.lat, place.lng], {
```

…the loop ends with `circle.bindPopup(...)` and the hover handlers. After the entire `for` loop closes (around line 226, after the closing `}`), add:

```js
markersByName.set(place.name, circle);
```

Wait — the cleanest spot is **inside** the loop, right after `}).addTo(map);`. Place it there. Final `for` loop body opens with the existing `circleMarker` block; immediately after `.addTo(map);` add the line above.

After the entire `for` loop closes, add (still inside `loadPlaces`, before the function's closing `}`):

```js
fuseIndex = new Fuse(places, {
    keys: ['name'],
    threshold: 0.4,
    ignoreLocation: true,
    minMatchCharLength: 2,
});
```

- [ ] **Step 3: Manual verification**

Reload `http://roe.localhost:8787/map`. In DevTools Console, run:

```js
markersByName.size       // should equal the place count shown in the hero
fuseIndex.search('tart') // should return an array of matches with .item.name set
```

Expected: `markersByName.size` matches the number in "X places" in the header. `fuseIndex.search('tart')` returns at least one result with `Tartine` in the name (assuming Tartine is in the data).

- [ ] **Step 4: Commit**

```bash
git add roe-search/src/map.html
git commit -m "feat(map): build Fuse index and marker lookup on load"
```

---

## Task 3: Add the search control UI (input + dropdown shell)

**Files:**
- Modify: `roe-search/src/map.html`

Render the empty UI as a Leaflet custom control. Wire the input to a debounced search that renders dropdown rows from Fuse hits. Click handlers and keyboard nav come in later tasks.

- [ ] **Step 1: Add CSS for the search control**

In `roe-search/src/map.html`, find the existing `#loading {` rule (around line 115). **Before** that block, add:

```css
.map-search {
    background: #fff;
    border-radius: 6px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.18);
    overflow: visible;
    width: 240px;
    font-family: inherit;
}
.map-search input {
    width: 100%;
    border: none;
    outline: none;
    padding: 8px 12px;
    font-size: 14px;
    border-radius: 6px;
    background: transparent;
    color: #2c2c2c;
}
.map-search input::-webkit-search-cancel-button { cursor: pointer; }
.map-search-results {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 320px;
    overflow-y: auto;
    border-top: 1px solid #eee;
    background: #fff;
    border-bottom-left-radius: 6px;
    border-bottom-right-radius: 6px;
}
.map-search-results.hidden { display: none; }
.map-search-results li {
    padding: 8px 12px;
    cursor: pointer;
    font-size: 13px;
    border-bottom: 1px solid #f0f0f0;
}
.map-search-results li:last-child { border-bottom: none; }
.map-search-results li.active,
.map-search-results li:hover { background: #f6f6f6; }
.map-search-results li .ep-count {
    display: block;
    font-size: 11px;
    color: #777;
    margin-top: 1px;
}
.map-search-results li.empty {
    color: #999;
    cursor: default;
    font-style: italic;
}
.map-search-results li.empty:hover { background: transparent; }

@media (max-width: 640px) {
    .map-search { width: calc(100vw - 32px); }
}
```

- [ ] **Step 2: Define the search control class**

In the inline `<script>` block in `map.html`, find the existing line:

```js
function escapeHtml(str) {
```

Immediately **before** that function, add:

```js
const SearchControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
        const container = L.DomUtil.create('div', 'map-search leaflet-bar');
        container.innerHTML = `
            <input type="search" placeholder="Search a place…" autocomplete="off" spellcheck="false" aria-label="Search places">
            <ul class="map-search-results hidden" role="listbox"></ul>
        `;
        // Stop map from intercepting clicks/scroll inside the control
        L.DomEvent.disableClickPropagation(container);
        L.DomEvent.disableScrollPropagation(container);
        return container;
    },
});

function debounce(fn, ms) {
    let t = null;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), ms);
    };
}

function renderSearchResults(listEl, hits) {
    if (hits.length === 0) {
        listEl.innerHTML = '<li class="empty">No matching places.</li>';
        listEl.classList.remove('hidden');
        return;
    }
    listEl.innerHTML = hits.map((h, i) => {
        const p = h.item;
        const plural = p.episode_count === 1 ? 'episode' : 'episodes';
        return `<li role="option" data-name="${escapeHtml(p.name)}"${i === 0 ? ' class="active"' : ''}>
            ${escapeHtml(p.name)}
            <span class="ep-count">${p.episode_count} ${plural}</span>
        </li>`;
    }).join('');
    listEl.classList.remove('hidden');
}
```

- [ ] **Step 3: Mount the control and wire input → search**

In `loadPlaces()`, after the `fuseIndex = new Fuse(...)` line you added in Task 2, add:

```js
const searchControl = new SearchControl();
searchControl.addTo(map);
const container = searchControl.getContainer();
const input = container.querySelector('input');
const list = container.querySelector('.map-search-results');

const runSearch = debounce(() => {
    const q = input.value.trim();
    if (!q) {
        list.classList.add('hidden');
        list.innerHTML = '';
        return;
    }
    const hits = fuseIndex.search(q, { limit: 8 });
    renderSearchResults(list, hits);
}, 80);

input.addEventListener('input', runSearch);
input.addEventListener('focus', () => {
    if (input.value.trim()) list.classList.remove('hidden');
});
document.addEventListener('click', (e) => {
    if (!container.contains(e.target)) list.classList.add('hidden');
});
```

- [ ] **Step 4: Manual verification**

Reload the map page.

Expected:
- A white search input appears in the top-left of the map.
- Typing "tart" shows a dropdown listing "Tartine Bakery" (or similar) with the episode count.
- Typing "xyznotaplace" shows a single italic row "No matching places."
- Clearing the input hides the dropdown.
- Clicking outside the search bar hides the dropdown.
- The dropdown rows highlight on hover.
- No console errors.

- [ ] **Step 5: Commit**

```bash
git add roe-search/src/map.html
git commit -m "feat(map): add search bar UI with debounced fuzzy results"
```

---

## Task 4: Wire result selection (pan + zoom + open popup)

**Files:**
- Modify: `roe-search/src/map.html`

When a row is clicked, fly to the marker and open its popup. Also: clear the input and hide the dropdown. Mobile should also blur the input so the soft keyboard dismisses.

- [ ] **Step 1: Add a selectResult helper**

In the inline `<script>` block, find the `renderSearchResults` function you added in Task 3. Immediately **after** it, add:

```js
function selectResult(name, input, list) {
    const marker = markersByName.get(name);
    if (!marker) return;
    const latlng = marker.getLatLng();
    map.flyTo(latlng, 17, { duration: 0.6 });
    marker.openPopup();
    input.value = '';
    list.classList.add('hidden');
    list.innerHTML = '';
    // Blur on touch devices so the soft keyboard dismisses
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
        input.blur();
    }
}
```

- [ ] **Step 2: Wire the click handler**

In `loadPlaces()`, after the `document.addEventListener('click', ...)` line you added in Task 3, add:

```js
list.addEventListener('click', (e) => {
    const row = e.target.closest('li[data-name]');
    if (!row) return;
    selectResult(row.dataset.name, input, list);
});
```

- [ ] **Step 3: Manual verification**

Reload the map page.

Expected:
- Type "dolores", click "Dolores Park" in the dropdown.
- Map smoothly pans/zooms to Dolores Park (zoom level ~17, street level).
- The Dolores Park popup opens, showing the episode list.
- The search input clears and the dropdown hides.
- Repeat for several other places to confirm consistent behavior.
- The empty-state row ("No matching places.") is not clickable (clicking does nothing — it has no `data-name`).

- [ ] **Step 4: Commit**

```bash
git add roe-search/src/map.html
git commit -m "feat(map): fly to and open popup on search result click"
```

---

## Task 5: Keyboard navigation (↑ ↓ Enter Esc and global "/" focus)

**Files:**
- Modify: `roe-search/src/map.html`

Standard combobox keyboard behavior, plus a global `/` shortcut to focus the search input from anywhere on the page.

- [ ] **Step 1: Add a helper to move the active row**

In the inline `<script>` block, find the `selectResult` function from Task 4. Immediately **after** it, add:

```js
function moveActive(list, dir) {
    const rows = [...list.querySelectorAll('li[data-name]')];
    if (rows.length === 0) return;
    const currentIdx = rows.findIndex(r => r.classList.contains('active'));
    const nextIdx = ((currentIdx === -1 ? 0 : currentIdx + dir) + rows.length) % rows.length;
    rows.forEach((r, i) => r.classList.toggle('active', i === nextIdx));
    rows[nextIdx].scrollIntoView({ block: 'nearest' });
}
```

- [ ] **Step 2: Wire keyboard handlers on the input**

In `loadPlaces()`, after the `list.addEventListener('click', ...)` from Task 4, add:

```js
input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (list.classList.contains('hidden') && input.value.trim()) {
            list.classList.remove('hidden');
        }
        moveActive(list, 1);
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveActive(list, -1);
    } else if (e.key === 'Enter') {
        e.preventDefault();
        const active = list.querySelector('li.active[data-name]');
        if (active) selectResult(active.dataset.name, input, list);
    } else if (e.key === 'Escape') {
        input.value = '';
        list.classList.add('hidden');
        list.innerHTML = '';
        input.blur();
    }
});
```

- [ ] **Step 3: Add the global "/" focus shortcut**

After the `input.addEventListener('keydown', ...)` block from Step 2, add:

```js
document.addEventListener('keydown', (e) => {
    if (e.key !== '/') return;
    const target = e.target;
    const isTyping = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
    if (isTyping) return;
    e.preventDefault();
    input.focus();
});
```

- [ ] **Step 4: Manual verification**

Reload the map page.

Expected:
- Type "mission", press ↓ — highlight moves to next row.
- Press ↑ — highlight moves up; wraps at edges.
- Press Enter — selected place behaves like a click (fly + popup + clear).
- Type something, press Esc — input clears, dropdown hides, focus leaves input.
- With focus elsewhere (click on the map), press `/` — search input gains focus and `/` does NOT appear in it.
- With focus already in the input, pressing `/` types a literal `/` (the global handler defers).

- [ ] **Step 5: Commit**

```bash
git add roe-search/src/map.html
git commit -m "feat(map): keyboard nav for search (arrows, enter, esc, slash)"
```

---

## Task 6: Mobile responsive verification + final regression pass

**Files:**
- Modify: `roe-search/src/map.html` (only if issues found)

The CSS in Task 3 already handles the mobile width breakpoint. This task is a dedicated mobile + regression check before deploy.

- [ ] **Step 1: Desktop regression check**

Reload the map page at desktop width (≥1000px).

Verify the **full original behavior** still works:
- All pins render with correct sizes (largest = most-mentioned).
- Hovering a pin opens its popup; mousing out closes it after a brief delay.
- Hovering the popup keeps it open.
- Episode links in popups still open in new tabs.
- The "X places · Y episode mentions" header still updates correctly.

- [ ] **Step 2: Mobile responsive check**

In DevTools, switch to a mobile viewport (~390px wide, e.g. iPhone 12 Pro preset). Reload.

Expected:
- Search input expands to roughly full map width (with ~16px gutter on each side).
- Tapping the input opens the soft keyboard; dropdown is visible above it.
- Tapping a result pans/zooms and dismisses the keyboard.
- Pin tap (not hover) still opens popups (existing behavior).
- Zoom controls in the top-right are tap-friendly and don't overlap the search bar.

- [ ] **Step 3: Edge case checks**

Verify each spec edge case:
- Type a query that returns zero matches → "No matching places." row appears.
- Refresh with the network throttled or `/api/map-places` blocked (DevTools → Network → block URL pattern) → page still shows the original "Failed to load places." state; search bar is either absent or inert (no JS errors).

- [ ] **Step 4: Commit any fixes**

If any issues were found and fixed, commit:

```bash
git add roe-search/src/map.html
git commit -m "fix(map): <describe fix>"
```

If nothing needed fixing, skip this step.

---

## Task 7: Deploy to production

**Files:**
- None (deploy step only)

- [ ] **Step 1: Confirm clean working tree**

```bash
git status
```

Expected: working tree clean (or only the unrelated pre-existing untracked files like `package 2.json` etc.). Map-related changes should all be committed.

- [ ] **Step 2: Deploy the worker**

```bash
cd roe-search && npx wrangler deploy
```

Expected: wrangler reports a successful deploy with a URL ending in `workers.dev` (or the custom domain `rollovereasy.org`).

- [ ] **Step 3: Smoke test production**

Open `https://rollovereasy.org/map` in a fresh browser tab (not the dev tab — to bypass any cached service workers).

Expected:
- Pins render.
- Search bar is in the top-left, zoom in the top-right.
- Typing a place name returns results and selecting one flies the map to it.
- Mobile view (DevTools or actual phone) looks right.

- [ ] **Step 4: Done**

If smoke test passes, the feature is live. No further action.

---

## Self-Review

**Spec coverage:**

| Spec section | Covered by |
|---|---|
| Architecture (Fuse via CDN, custom Leaflet control, in-memory index) | Tasks 1–3 |
| UI: search input, results dropdown, zoom-control move | Tasks 1, 3 |
| Behavior table (focus, type, ↑/↓, Enter, Esc, click outside, click row) | Tasks 3–5 |
| On-select: flyTo + openPopup + clear + blur on mobile | Task 4 |
| Fuse config (threshold 0.4, ignoreLocation, minMatchCharLength 2) | Task 2 |
| Edge case: empty places list → inert search | Task 6 step 3 |
| Edge case: `/api/map-places` failure → existing error handling | Task 6 step 3 |
| Mobile responsive (≤640px width) | Tasks 3 (CSS), 6 (verification) |
| Manual checklist (regression + new features) | Task 6 |
| Deploy via `wrangler deploy` | Task 7 |

All spec items mapped.

**Placeholder scan:** No "TBD", "TODO", or vague handwave steps. Every code-bearing step shows the actual code.

**Type/identifier consistency:** `markersByName`, `fuseIndex`, `selectResult`, `moveActive`, `renderSearchResults`, `SearchControl`, `runSearch`, `debounce`, `container`, `input`, `list` — names are stable across Tasks 2–5. The `data-name` attribute on `<li>` rows is set in Task 3 and read in Tasks 4 + 5. The `.active` class is set in Task 3 (initial highlight on first row) and managed in Task 5 (`moveActive`). Consistent.

No issues found.
