# Stellar Lexicon — Design Spec

An interactive visualization that renders every word spoken on Roll Over Easy as stars in a live night sky. Mobile visitors use their phone's gyroscope to look around a full 360-degree celestial sphere. Desktop visitors get a flat star chart (planisphere) of the same data.

Lives at `rollovereasy.org/stars`.

---

## 1. Mobile Experience (Primary)

### Concept

The visitor stands inside a celestial sphere. Every meaningful word from the show's transcripts is a star — brighter and larger the more frequently it was spoken. The sun, moon, and planets are astronomically accurate for the current moment over San Francisco. The visitor holds their phone up, tilts, turns, and looks in any direction to explore.

### Gyroscope Control

- Full 360-degree freedom via `DeviceOrientationEvent` API
- Smooth interpolation to reduce jitter
- Requires HTTPS (satisfied by Cloudflare Workers)
- Requires explicit user permission on iOS 13+ (see Permission Flow below)

### Permission Flow

1. Page loads with a dark splash screen: title ("Stellar Lexicon"), one-line description, and a "Tap to look up" button
2. Tapping the button calls `DeviceOrientationEvent.requestPermission()` on iOS, or proceeds directly on Android
3. On permission grant: transition to the planetarium view
4. On permission deny: fall back to touch-drag navigation (finger swipe rotates the sphere)

### Rendering

- **Engine:** Three.js
- **Scene:** Inverted sphere (skybox) containing all objects. Camera at center, orientation driven by gyroscope.
- **Word-stars:** Instanced point sprites for performance. Each star has size, brightness, glow radius, and color derived from its word count (see Star Visual Properties).
- **Celestial bodies:** Small meshes with glow shaders for the sun, moon, and planets (Mercury through Neptune). Moon renders with correct phase.
- **Ecliptic:** Subtle dashed arc showing the ecliptic path.
- **Horizon:** Gradient glow at the horizon line for grounding and orientation.
- **Compass:** Minimal cardinal direction indicator at the bottom of the viewport.

### Interaction

- **Tap a word-star:** A tooltip appears with the word and its total count across all episodes (e.g., "coffee — spoken 2,847 times"). Tap elsewhere to dismiss.
- No drawers, navigation panels, or complex UI. The sky is the interface.

---

## 2. Desktop Experience

### Concept

A flat circular star chart (planisphere) — the same celestial sphere projected via stereographic projection onto a 2D disc. Same word-stars, same live astronomical positions, native to mouse and screen.

### Rendering

- **Engine:** D3.js with Canvas or SVG
- **Layout:** Circular planisphere centered on the page with subtle grid lines (declination circles, RA lines), cardinal directions (N/S/E/W), and ecliptic path
- **Background:** Dark (#080c18) with faint Milky Way hint

### Interaction

- **Click-drag** rotates the chart
- **Scroll wheel** zooms in/out (reveals more word labels at higher zoom)
- **Hover** a word-star to see tooltip (same format as mobile: word + count)
- **Subtle prompt** in bottom bar: "View on mobile for the full experience"

### Legend

Small legend in the corner showing:
- Star size scale (frequent → rare)
- Moon, planet, and ecliptic markers

---

## 3. Astronomical Accuracy

### Library

`astronomy-engine` by Don Cross — lightweight JavaScript library (~50KB gzipped) that computes precise positions for all solar system bodies. Runs entirely client-side, no API calls.

### Bodies Rendered

| Body | Visual |
|------|--------|
| Sun | Large glow below/at horizon (or visible if above). Sets scene lighting. |
| Moon | Disc with correct phase shading |
| Mercury | Small dot with label |
| Venus | Brighter dot with label |
| Mars | Reddish dot with label |
| Jupiter | Dot with label |
| Saturn | Dot with label |
| Uranus | Dim dot with label |
| Neptune | Dim dot with label |
| Ecliptic | Dashed arc showing the plane of the solar system |

### Reference Point

- **Location:** San Francisco (37.7749°N, 122.4194°W)
- **Time:** Current moment (real-time via `Date.now()`)
- Celestial body positions update continuously (subtle drift visible if watching long enough)
- Word-star positions are fixed — they do not move with time

### Sky Rendering

The sky is always rendered as night (dark background) regardless of the actual time of day. The sun, moon, and planets are in their astronomically correct positions, but the sky does not brighten at daytime. This is an artistic choice — the visualization is a star field, and visibility of word-stars requires a dark canvas.

---

## 4. Data Pipeline

### Word Frequency Extraction

A batch Node.js script that:

1. **Extracts** all segment text from the D1 `transcript_segments` table via Wrangler
2. **Tokenizes** into words — lowercase, strip punctuation
3. **Filters** — removes English stop words, words under 3 characters, residual Whisper artifacts
4. **Ranks** — keeps top ~1500 words by frequency
5. **Positions** — hashes each word to a deterministic seed, generates (right ascension, declination) coordinates on the celestial sphere using Poisson-disc sampling to ensure even distribution and avoid clumping
6. **Outputs** `stars.json`

### stars.json Format

```json
{
  "generated": "2026-03-27T06:00:00Z",
  "total_episodes": 487,
  "total_segments": 284031,
  "stars": [
    { "w": "coffee", "c": 2847, "ra": 4.287, "dec": 31.42 },
    { "w": "morning", "c": 3412, "ra": 12.053, "dec": -8.71 }
  ]
}
```

- Short keys (`w`, `c`, `ra`, `dec`) to minimize payload
- ~50KB for 1500 entries
- Uploaded to R2 and served via `GET /api/stars` with cache headers
- Regenerated whenever new episodes are processed through the pipeline

### Star Visual Properties (Client-Side)

| Property | Derives From | Range |
|----------|-------------|-------|
| Size | log(count) normalized | 1px – 12px |
| Brightness / opacity | log(count) normalized | 0.15 – 1.0 |
| Glow radius | size × 2.5 | 2px – 30px |
| Color temperature | hash of word | Warm gold – cool blue (mimics stellar classification) |
| Label visible | count rank ≤ 500 | On/off (more appear on zoom) |

---

## 5. Page Structure & Integration

### Route

`/stars` — served by the existing Cloudflare Worker in `roe-search/src/index.js`. New inline HTML file (`stars.html`) following the same pattern as `frontend.html`, `episodes.html`, etc.

### Device Detection & Lazy Loading

On page load, detect gyroscope support:
- **Has gyroscope (mobile):** Load Three.js + app code for the 3D planetarium
- **No gyroscope (desktop):** Load D3.js + app code for the 2D planisphere
- Each path only loads its own renderer — mobile never downloads D3, desktop never downloads Three.js

### Dependencies (CDN)

| Dependency | Used By | Size (gzipped) |
|-----------|---------|----------------|
| Three.js | Mobile | ~150KB |
| D3.js | Desktop | ~90KB |
| astronomy-engine | Both | ~50KB |
| stars.json | Both | ~50KB |

### Navigation

Add a link to `/stars` from the existing site navigation. Keep it discoverable but not cluttering the primary search experience.

### Data Endpoint

`GET /api/stars` — serves `stars.json` from R2 with appropriate cache headers (e.g., `Cache-Control: public, max-age=86400`). Alternative: inline the JSON in the HTML if it stays under ~60KB to avoid an extra network request on mobile.

---

## 6. Performance Budget

| Target | Budget |
|--------|--------|
| Time to interactive (mobile) | < 3s on 4G |
| Frame rate (gyroscope) | 60fps on iPhone 12+ |
| Total JS payload (mobile) | ~200KB gzipped |
| Star data | ~50KB |
| Render capacity | 1500 point sprites + 9 celestial bodies + glow passes |

### Strategies

- Instanced rendering for word-stars (single draw call)
- Labels rendered as a separate text layer, culled by distance/zoom level
- Astronomy positions computed once per frame (lightweight math, no allocations)
- CDN-hosted libraries with long cache TTLs
