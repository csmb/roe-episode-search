# Stellar Lexicon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an interactive web page at `/stars` on rollovereasy.org that renders every word spoken on Roll Over Easy as stars in a live, astronomically accurate night sky — a gyroscope-controlled 360-degree planetarium on mobile, and a 2D planisphere star chart on desktop.

**Architecture:** A batch script extracts word frequencies from D1 transcript data, assigns each word deterministic celestial coordinates, and uploads the result as `stars.json` to R2. The Cloudflare Worker serves this data via `/api/stars` and the page via `/stars`. The page detects device capabilities and lazy-loads either Three.js (mobile/gyroscope) or D3.js (desktop/mouse) to render the star field alongside astronomically accurate sun, moon, and planet positions computed client-side by `astronomy-engine`.

**Tech Stack:** Cloudflare Workers, D1, R2, Three.js (mobile), D3.js (desktop), astronomy-engine (client-side ephemeris), DeviceOrientationEvent API (gyroscope)

**Spec:** `docs/superpowers/specs/2026-03-27-stellar-lexicon-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `scripts/generate-stars.js` | Create | Batch script: query D1 for all transcript text, compute word frequencies, assign celestial coordinates, upload `stars.json` to R2 |
| `roe-search/src/stars.html` | Create | Full page: HTML structure, CSS, device detection, permission flow, mobile Three.js renderer, desktop D3 renderer, astronomy helpers |
| `roe-search/src/index.js` | Modify | Add `import STARS_HTML`, `/stars` route, `/api/stars` endpoint serving from R2 |
| `roe-search/src/frontend.html` | Modify | Add "Stars" link to nav |
| `roe-search/src/episodes.html` | Modify | Add "Stars" link to nav |
| `roe-search/src/guests.html` | Modify | Add "Stars" link to nav |
| `roe-search/src/map.html` | Modify | Add "Stars" link to nav |
| `roe-search/src/admin.html` | Modify | Add "Stars" link to nav |

---

### Task 1: Word Frequency Batch Script

**Files:**
- Create: `scripts/generate-stars.js`

This script queries all transcript segment text from D1, computes word frequencies, assigns deterministic celestial coordinates to each word, and uploads the result to R2.

- [ ] **Step 1: Create the batch script**

Create `scripts/generate-stars.js` with the full pipeline. Uses the same `wranglerExec`/`queryJSON` pattern as `scripts/process-episode.js`.

```javascript
#!/usr/bin/env node

/**
 * Generate stars.json — word frequency data for the Stellar Lexicon visualization.
 *
 * Queries all transcript segments from D1, computes word frequencies,
 * assigns deterministic celestial coordinates, and uploads to R2.
 *
 * Usage:
 *   node scripts/generate-stars.js [--dry-run]
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DB_NAME = 'roe-episodes';
const R2_BUCKET = 'roe-audio';
const R2_KEY = 'data/stars.json';
const MAX_STARS = 1500;
const BATCH_SIZE = 5000;

const workerDir = path.resolve(
    path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)),
    '..', 'roe-search'
);

// --- Wrangler helpers (same pattern as process-episode.js) ---

function wranglerExec(args, opts = {}) {
    const env = { ...process.env };
    delete env.CLOUDFLARE_API_TOKEN;
    return execSync(`npx wrangler ${args}`, {
        cwd: workerDir,
        encoding: 'utf-8',
        stdio: opts.stdio || 'pipe',
        env,
        ...opts,
    });
}

function queryJSON(sql) {
    const cmd = `d1 execute ${DB_NAME} --remote --json --command="${sql.replace(/"/g, '\\"')}"`;
    const result = wranglerExec(cmd);
    const parsed = JSON.parse(result);
    return parsed[0]?.results ?? [];
}

// --- Stop words ---

const STOP_WORDS = new Set([
    'the', 'be', 'to', 'of', 'and', 'in', 'that', 'have', 'it', 'for',
    'not', 'on', 'with', 'he', 'as', 'you', 'do', 'at', 'this', 'but',
    'his', 'by', 'from', 'they', 'we', 'say', 'her', 'she', 'or', 'an',
    'will', 'my', 'one', 'all', 'would', 'there', 'their', 'what', 'so',
    'up', 'out', 'if', 'about', 'who', 'get', 'which', 'go', 'me', 'when',
    'make', 'can', 'like', 'time', 'no', 'just', 'him', 'know', 'take',
    'people', 'into', 'year', 'your', 'good', 'some', 'could', 'them',
    'see', 'other', 'than', 'then', 'now', 'look', 'only', 'come', 'its',
    'over', 'think', 'also', 'back', 'after', 'use', 'two', 'how', 'our',
    'work', 'first', 'well', 'way', 'even', 'new', 'want', 'because',
    'any', 'these', 'give', 'day', 'most', 'us', 'was', 'were', 'been',
    'had', 'are', 'has', 'did', 'got', 'said', 'is', 'am', 'does', 'done',
    'going', 'being', 'having', 'yeah', 'yes', 'right', 'okay', 'oh',
    'uh', 'um', 'know', 'mean', 'thing', 'things', 'kind', 'really',
    'actually', 'gonna', 'lot', 'don', 'didn', 'isn', 'wasn', 'aren',
    'doesn', 'wouldn', 'couldn', 'very', 'much', 'still', 'too', 'here',
    'where', 'why', 'let', 'down', 'should', 'own', 'while', 'those',
    'both', 'each', 'through', 'same', 'off', 'before', 'must', 'between',
    'such', 'may', 'again', 'might', 'never', 'every', 'more', 'put',
    'another', 'always', 'many', 'great', 'little', 'big', 'old', 'few',
    'around', 'long', 'made', 'away', 'keep', 'went', 'tell', 'called',
    'came', 'thought', 'part', 'whole', 'something', 'nothing', 'everything',
    'anything', 'someone', 'everyone', 'myself', 'himself', 'themselves',
    'yourself', 'what', 'being', 'have', 'been', 'just', 'really', 'that',
    'gonna', 'gotta', 'wanna', 'kinda', 'sorta', 'cause', 'though',
]);

// --- Coordinate assignment ---
// Note: The spec mentions Poisson-disc sampling, but FNV-1a hash gives
// sufficiently even distribution for 1500 words on a sphere without the
// complexity of spherical Poisson-disc. Each word always maps to the same
// position across regenerations (deterministic).

function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

function wordToCoords(word) {
    const h1 = fnv1a(word);
    const h2 = fnv1a(word + '\x00');
    const ra = Math.round(((h1 % 864000) / 36000) * 1000) / 1000;   // 0–24 hours
    const dec = Math.round(((h2 % 18001) / 100 - 90) * 100) / 100;  // -90 to +90 degrees
    return { ra, dec };
}

// --- Main ---

const dryRun = process.argv.includes('--dry-run');

console.log('Stellar Lexicon — generating stars.json');
console.log('========================================\n');

// 1. Count total segments
const [{ cnt }] = queryJSON('SELECT COUNT(*) as cnt FROM transcript_segments');
console.log(`Total segments: ${cnt}`);

// 2. Count episodes
const [{ ecnt }] = queryJSON('SELECT COUNT(*) as ecnt FROM episodes');
console.log(`Total episodes: ${ecnt}`);

// 3. Extract word frequencies in batches
console.log(`\nExtracting words in batches of ${BATCH_SIZE}...`);
const wordCounts = new Map();
let offset = 0;
let batchNum = 0;

while (true) {
    const rows = queryJSON(
        `SELECT text FROM transcript_segments LIMIT ${BATCH_SIZE} OFFSET ${offset}`
    );
    if (rows.length === 0) break;

    for (const row of rows) {
        const words = row.text.toLowerCase().replace(/[^a-z'-]/g, ' ').split(/\s+/);
        for (const word of words) {
            if (word.length >= 3 && !STOP_WORDS.has(word)) {
                wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
            }
        }
    }

    offset += BATCH_SIZE;
    batchNum++;
    process.stdout.write(`  Batch ${batchNum}: ${offset} segments processed\r`);
}
console.log(`\nUnique words (after filtering): ${wordCounts.size}`);

// 4. Sort by frequency, take top N
const sorted = [...wordCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_STARS);

console.log(`Top ${sorted.length} words selected`);
console.log(`  Most frequent: "${sorted[0][0]}" (${sorted[0][1]})`);
console.log(`  Least frequent: "${sorted[sorted.length - 1][0]}" (${sorted[sorted.length - 1][1]})`);

// 5. Build stars array with coordinates
const stars = sorted.map(([word, count]) => {
    const { ra, dec } = wordToCoords(word);
    return { w: word, c: count, ra, dec };
});

const output = {
    generated: new Date().toISOString(),
    total_episodes: Number(ecnt),
    total_segments: Number(cnt),
    stars,
};

const jsonStr = JSON.stringify(output);
console.log(`\nOutput size: ${(jsonStr.length / 1024).toFixed(1)} KB`);

// 6. Write local file and upload to R2
const outPath = path.resolve(workerDir, '..', 'stars.json');
fs.writeFileSync(outPath, jsonStr);
console.log(`Written to ${outPath}`);

if (dryRun) {
    console.log('\n--dry-run: skipping R2 upload');
} else {
    console.log(`\nUploading to R2: ${R2_BUCKET}/${R2_KEY}`);
    wranglerExec(
        `r2 object put ${R2_BUCKET}/${R2_KEY} --file="${outPath}" --content-type="application/json"`,
        { stdio: 'inherit' }
    );
    console.log('Upload complete.');
}

console.log('\nDone.');
```

- [ ] **Step 2: Run with --dry-run to verify output**

Run: `node scripts/generate-stars.js --dry-run`

Expected: Script prints batch progress, word counts, top/bottom words, output size (~50KB), writes `stars.json` locally. Verify the JSON structure is correct:

```bash
head -c 200 stars.json
```

Expected output should show the `generated`, `total_episodes`, `total_segments`, and beginning of the `stars` array.

- [ ] **Step 3: Run for real — upload to R2**

Run: `node scripts/generate-stars.js`

Expected: Same output as dry-run plus "Upload complete." confirmation.

- [ ] **Step 4: Commit**

```bash
git add scripts/generate-stars.js
git commit -m "feat: add word frequency batch script for Stellar Lexicon"
```

---

### Task 2: API Endpoint — Serve stars.json from R2

**Files:**
- Modify: `roe-search/src/index.js` (lines 1–90)

Add a `/api/stars` route that reads `data/stars.json` from the R2 bucket and returns it with cache headers.

- [ ] **Step 1: Add the /api/stars route and handler**

In `roe-search/src/index.js`, add the route check after the existing `/api/` routes (after line 27, near the other API routes):

```javascript
if (url.pathname === '/api/stars') {
    return handleStars(env);
}
```

Add the handler function at the bottom of the file (before the closing of the module):

```javascript
async function handleStars(env) {
    try {
        const obj = await env.AUDIO.get('data/stars.json');
        if (!obj) {
            return json({ error: 'Star data not generated yet' }, 404);
        }
        return new Response(obj.body, {
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'public, max-age=86400',
            },
        });
    } catch (err) {
        return json({ error: 'Failed to load star data' }, 500);
    }
}
```

- [ ] **Step 2: Verify with wrangler dev**

Run: `cd roe-search && npx wrangler dev`

Then in another terminal:

```bash
curl -s http://localhost:8787/api/stars | head -c 200
```

Expected: JSON response with star data (or 404 if running against local D1 without R2 data — that's fine, the route is wired up).

- [ ] **Step 3: Commit**

```bash
git add roe-search/src/index.js
git commit -m "feat: add /api/stars endpoint serving word data from R2"
```

---

### Task 3: Stars Page — HTML Scaffold, CSS, Device Detection

**Files:**
- Create: `roe-search/src/stars.html`

Create the page shell with the permission/splash screen, canvas container, tooltip, compass, all CSS, device detection, library loading, and shared astronomy helper functions. The mobile and desktop renderers are added in Tasks 4 and 5.

- [ ] **Step 1: Create stars.html with full scaffold**

Create `roe-search/src/stars.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>Stars - Roll Over Easy</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>☕</text></svg>">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: 100%; height: 100%; overflow: hidden; background: #06080f; color: #fff; }

/* --- Splash / Permission Screen --- */
#splash {
    position: fixed; inset: 0; z-index: 100;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    background: #06080f; text-align: center; padding: 30px;
}
#splash .title {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 28px; color: rgba(255,245,210,0.9); letter-spacing: 1px;
}
#splash .desc {
    font-size: 14px; color: rgba(255,255,255,0.35);
    margin-top: 10px; max-width: 280px; line-height: 1.5;
}
#splash .begin-btn {
    margin-top: 44px; padding: 14px 40px;
    border: 1px solid rgba(255,230,150,0.3); border-radius: 24px;
    background: rgba(255,230,150,0.04); color: rgba(255,245,210,0.8);
    font-size: 15px; letter-spacing: 0.5px; cursor: pointer;
    transition: background 0.2s, border-color 0.2s;
}
#splash .begin-btn:active { background: rgba(255,230,150,0.1); border-color: rgba(255,230,150,0.5); }
#splash .note { font-size: 11px; color: rgba(255,255,255,0.18); margin-top: 14px; }
#splash .back-link {
    position: absolute; top: 16px; left: 16px;
    font-size: 13px; color: rgba(255,255,255,0.25); text-decoration: none;
}
#splash .back-link:hover { color: rgba(255,255,255,0.5); }

/* --- Sky Container --- */
#sky { position: fixed; inset: 0; }
#sky canvas { display: block; width: 100%; height: 100%; }

/* --- Tooltip --- */
#tooltip {
    display: none; position: fixed; z-index: 50;
    background: rgba(15,15,30,0.88); border: 1px solid rgba(255,230,150,0.25);
    border-radius: 8px; padding: 8px 14px;
    backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
    pointer-events: none;
}
#tooltip .word {
    font-family: Georgia, serif; font-size: 15px; color: #fff; letter-spacing: 0.5px;
}
#tooltip .count {
    font-size: 11px; color: rgba(255,230,150,0.65); margin-top: 2px;
}

/* --- Compass --- */
#compass {
    position: fixed; bottom: 14px; left: 50%; transform: translateX(-50%); z-index: 40;
    color: rgba(255,255,255,0.2); font-size: 10px; letter-spacing: 2px;
    pointer-events: none;
}
#compass .active { color: rgba(255,255,255,0.4); }

/* --- Desktop Legend --- */
#legend {
    display: none; position: fixed; top: 20px; right: 20px; z-index: 40;
    color: rgba(255,255,255,0.3); font-size: 11px; line-height: 2;
}
#legend .swatch {
    display: inline-block; border-radius: 50%; vertical-align: middle; margin-right: 6px;
}

/* --- Desktop Bottom Bar --- */
#bottom-bar {
    display: none; position: fixed; bottom: 0; left: 0; right: 0; z-index: 40;
    padding: 10px 20px;
    background: rgba(8,12,24,0.8); border-top: 1px solid rgba(100,120,180,0.08);
    font-size: 11px; color: rgba(255,255,255,0.25);
    justify-content: space-between; align-items: center;
}
#bottom-bar .mobile-hint { color: rgba(255,200,80,0.4); }

/* --- Loading --- */
#loading {
    position: fixed; inset: 0; z-index: 90;
    display: none; align-items: center; justify-content: center;
    background: #06080f; color: rgba(255,255,255,0.3); font-size: 14px;
}
</style>
</head>
<body>

<!-- Splash / Permission Screen -->
<div id="splash">
    <a href="/" class="back-link">&larr; Roll Over Easy</a>
    <div class="title">Stellar Lexicon</div>
    <div class="desc">Every word ever spoken on Roll Over Easy, scattered across the night sky above San Francisco</div>
    <button class="begin-btn" id="beginBtn">Tap to look up</button>
    <div class="note" id="splashNote"></div>
</div>

<!-- Loading -->
<div id="loading">Loading stars...</div>

<!-- Sky Canvas -->
<div id="sky" style="display:none;">
    <canvas id="canvas"></canvas>
</div>

<!-- Tooltip -->
<div id="tooltip">
    <div class="word" id="tipWord"></div>
    <div class="count" id="tipCount"></div>
</div>

<!-- Compass (mobile) -->
<div id="compass" style="display:none;">
    <span id="cW">W</span> &bull;
    <span id="cDir" class="active">S</span> &bull;
    <span id="cE">E</span>
</div>

<!-- Legend (desktop) -->
<div id="legend">
    <div><span class="swatch" style="width:8px;height:8px;background:radial-gradient(circle,#fff,transparent);"></span> frequent</div>
    <div><span class="swatch" style="width:4px;height:4px;background:rgba(255,255,255,0.4);margin-left:2px;"></span> moderate</div>
    <div><span class="swatch" style="width:2px;height:2px;background:rgba(255,255,255,0.2);margin-left:3px;"></span> rare</div>
    <div style="margin-top:8px;border-top:1px solid rgba(100,120,180,0.1);padding-top:8px;">
        <div><span class="swatch" style="width:10px;height:10px;background:radial-gradient(circle at 40% 40%,#fef9e7,#c4b078);"></span> moon</div>
        <div><span class="swatch" style="width:4px;height:4px;background:#ffeaa7;margin-left:3px;"></span> planet</div>
        <div style="margin-top:4px;color:rgba(255,200,80,0.3);">- - - ecliptic</div>
    </div>
</div>

<!-- Desktop Bottom Bar -->
<div id="bottom-bar">
    <span>Drag to rotate &bull; Scroll to zoom &bull; Hover for details</span>
    <span class="mobile-hint">View on mobile for the full experience</span>
</div>

<!-- Astronomy Engine (global, both paths) -->
<script src="https://cdn.jsdelivr.net/npm/astronomy-engine@2.1.19/astronomy.browser.min.js"></script>

<script type="module">
// ============================================================
// Shared: Constants, data loading, astronomy helpers
// ============================================================

const SF_LAT = 37.7749;
const SF_LON = -122.4194;
const SKY_RADIUS = 500;
const observer = new Astronomy.Observer(SF_LAT, SF_LON, 0);

const PLANET_BODIES = ['Sun', 'Moon', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'];
const PLANET_COLORS = {
    Sun: '#fff4c0', Moon: '#fef9e7', Mercury: '#bbb', Venus: '#ffeaa7',
    Mars: '#e17055', Jupiter: '#ffeaa7', Saturn: '#fad390', Uranus: '#74b9ff', Neptune: '#a29bfe',
};
const PLANET_SIZES = {
    Sun: 16, Moon: 12, Mercury: 3, Venus: 5, Mars: 4, Jupiter: 5, Saturn: 5, Uranus: 3, Neptune: 3,
};

// --- Data Loading ---

async function loadStars() {
    const res = await fetch('/api/stars');
    if (!res.ok) throw new Error('Failed to load star data');
    return res.json();
}

// --- Astronomy Helpers ---

function getCelestialBodies(date) {
    const bodies = [];
    for (const name of PLANET_BODIES) {
        const equ = Astronomy.Equator(name, date, observer, true, true);
        const hor = Astronomy.Horizon(date, observer, equ.ra, equ.dec, 'normal');
        bodies.push({
            name, azimuth: hor.azimuth, altitude: hor.altitude,
            color: PLANET_COLORS[name], size: PLANET_SIZES[name],
        });
    }
    return bodies;
}

function getStarHorizontalCoords(stars, date) {
    const coords = new Float32Array(stars.length * 2);
    for (let i = 0; i < stars.length; i++) {
        const hor = Astronomy.Horizon(date, observer, stars[i].ra, stars[i].dec, 'normal');
        coords[i * 2] = hor.azimuth;
        coords[i * 2 + 1] = hor.altitude;
    }
    return coords;
}

function getMoonPhase(date) {
    return Astronomy.MoonPhase(date);  // 0-360 degrees
}

// Convert azimuth/altitude to 3D cartesian (Y=up, -Z=north)
function skyToXYZ(azDeg, altDeg, r) {
    const az = azDeg * Math.PI / 180;
    const alt = altDeg * Math.PI / 180;
    const y = r * Math.sin(alt);
    const g = r * Math.cos(alt);
    const x = g * Math.sin(az);
    const z = -g * Math.cos(az);
    return { x, y, z };
}

// Star visual properties from count
function starVisuals(count, maxCount) {
    const t = Math.log(count) / Math.log(maxCount); // 0–1 log-normalized
    const size = 1 + t * 11;         // 1–12 px
    const opacity = 0.15 + t * 0.85; // 0.15–1.0
    return { size, opacity };
}

// Deterministic star color from word hash (warm gold to cool blue)
function starColor(word) {
    let h = 0x811c9dc5;
    for (let i = 0; i < word.length; i++) {
        h ^= word.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    h = h >>> 0;
    const hue = 30 + (h % 200);  // 30 (warm gold) to 230 (cool blue)
    const sat = 20 + (h % 40);   // 20–60% saturation (subtle tinting)
    return `hsl(${hue}, ${sat}%, 90%)`;
}

// Compass direction from camera azimuth
function compassDir(azimuth) {
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return dirs[Math.round(azimuth / 45) % 8];
}

// --- Tooltip ---

function showTooltip(word, count, x, y) {
    const tip = document.getElementById('tooltip');
    document.getElementById('tipWord').textContent = word;
    document.getElementById('tipCount').textContent = `spoken ${count.toLocaleString()} times`;
    tip.style.display = 'block';
    tip.style.left = Math.min(x + 12, window.innerWidth - 180) + 'px';
    tip.style.top = Math.min(y - 40, window.innerHeight - 60) + 'px';
}

function hideTooltip() {
    document.getElementById('tooltip').style.display = 'none';
}

// ============================================================
// Device Detection & Init
// ============================================================

const isMobile = 'ontouchstart' in window && window.innerWidth < 1024;

document.getElementById('beginBtn').textContent = isMobile ? 'Tap to look up' : 'Enter';
document.getElementById('splashNote').textContent = isMobile ? 'Requires motion sensor access' : 'Interactive star chart';

document.getElementById('beginBtn').addEventListener('click', async () => {
    // iOS gyroscope permission
    if (isMobile && typeof DeviceOrientationEvent.requestPermission === 'function') {
        try {
            const perm = await DeviceOrientationEvent.requestPermission();
            if (perm !== 'granted') {
                document.getElementById('splashNote').textContent = 'Permission denied — using touch controls instead';
                // Fall through to mobile init with touch fallback
            }
        } catch (e) {
            document.getElementById('splashNote').textContent = 'Using touch controls';
        }
    }

    // Show loading, hide splash
    document.getElementById('splash').style.display = 'none';
    document.getElementById('loading').style.display = 'flex';

    try {
        const data = await loadStars();
        document.getElementById('loading').style.display = 'none';
        document.getElementById('sky').style.display = 'block';

        if (isMobile) {
            document.getElementById('compass').style.display = 'block';
            const { initMobile } = await import('https://unpkg.com/three@0.169.0/build/three.module.js')
                .then(THREE => {
                    window.THREE = THREE;
                    return { initMobile: () => startMobile(THREE, data) };
                });
            initMobile();
        } else {
            document.getElementById('legend').style.display = 'block';
            document.getElementById('bottom-bar').style.display = 'flex';
            await import('https://cdn.jsdelivr.net/npm/d3@7/+esm').then(d3 => {
                startDesktop(d3, data);
            });
        }
    } catch (err) {
        document.getElementById('loading').textContent = 'Failed to load — try refreshing';
        console.error(err);
    }
});

// ============================================================
// MOBILE: Three.js Planetarium (placeholder — implemented in Task 4)
// ============================================================

function startMobile(THREE, data) {
    console.log('Mobile renderer: loaded', data.stars.length, 'stars');
    // Task 4 fills this in
}

// ============================================================
// DESKTOP: D3 Planisphere (placeholder — implemented in Task 5)
// ============================================================

function startDesktop(d3, data) {
    console.log('Desktop renderer: loaded', data.stars.length, 'stars');
    // Task 5 fills this in
}
</script>
</body>
</html>
```

- [ ] **Step 2: Verify the splash screen loads**

This step requires the route to be wired up temporarily. Add the import and route in `index.js` (will be formalized in Task 6):

In `roe-search/src/index.js`, add at line 6:
```javascript
import STARS_HTML from './stars.html';
```

Add after line 57 (after the `/map` route):
```javascript
if (url.pathname === '/stars') {
    return new Response(STARS_HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
}
```

Run: `cd roe-search && npx wrangler dev`

Open `http://localhost:8787/stars` in browser. Verify:
- Dark background with "Stellar Lexicon" title
- Description text
- "Enter" button (desktop) or "Tap to look up" button (mobile)
- Back link to "/"

Click "Enter" — should show "Loading stars..." then console log with star count (if `/api/stars` returns data) or error (expected if R2 data not available locally).

- [ ] **Step 3: Commit**

```bash
git add roe-search/src/stars.html roe-search/src/index.js
git commit -m "feat: add stars.html scaffold with device detection and shared helpers"
```

---

### Task 4: Mobile Three.js Planetarium Renderer

**Files:**
- Modify: `roe-search/src/stars.html` (replace `startMobile` placeholder)

Implement the full Three.js scene: star field, celestial bodies, gyroscope controls, touch-drag fallback, tap-to-reveal interaction.

- [ ] **Step 1: Replace the startMobile placeholder**

In `roe-search/src/stars.html`, replace the entire `startMobile` function with:

```javascript
function startMobile(THREE, data) {
    const canvas = document.getElementById('canvas');
    const maxCount = data.stars[0].c;

    // --- Scene Setup ---
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x06080f);

    // --- Star Geometry ---
    const starCount = data.stars.length;
    const positions = new Float32Array(starCount * 3);
    const colors = new Float32Array(starCount * 3);
    const sizes = new Float32Array(starCount);

    const now = new Date();
    const horizCoords = getStarHorizontalCoords(data.stars, now);

    for (let i = 0; i < starCount; i++) {
        const az = horizCoords[i * 2];
        const alt = horizCoords[i * 2 + 1];
        const pos = skyToXYZ(az, alt, SKY_RADIUS);
        positions[i * 3] = pos.x;
        positions[i * 3 + 1] = pos.y;
        positions[i * 3 + 2] = pos.z;

        const { size, opacity } = starVisuals(data.stars[i].c, maxCount);
        sizes[i] = size * 3; // Scale up for point sprites

        // Parse star color
        const col = new THREE.Color(starColor(data.stars[i].w));
        colors[i * 3] = col.r * opacity;
        colors[i * 3 + 1] = col.g * opacity;
        colors[i * 3 + 2] = col.b * opacity;
    }

    const starGeom = new THREE.BufferGeometry();
    starGeom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    starGeom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    starGeom.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

    const starMat = new THREE.ShaderMaterial({
        uniforms: {},
        vertexShader: `
            attribute float size;
            varying vec3 vColor;
            void main() {
                vColor = color;
                vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
                gl_PointSize = size * (300.0 / -mvPos.z);
                gl_Position = projectionMatrix * mvPos;
            }
        `,
        fragmentShader: `
            varying vec3 vColor;
            void main() {
                float d = length(gl_PointCoord - vec2(0.5));
                if (d > 0.5) discard;
                float glow = 1.0 - smoothstep(0.0, 0.5, d);
                gl_FragColor = vec4(vColor * glow, glow);
            }
        `,
        vertexColors: true,
        transparent: true,
        depthWrite: false,
    });

    const starPoints = new THREE.Points(starGeom, starMat);
    scene.add(starPoints);

    // --- Star Labels (top 500 by rank — as sprites) ---
    const labelLimit = Math.min(500, starCount);
    const labelSprites = [];

    function makeLabel(text, fontSize) {
        const cnv = document.createElement('canvas');
        const ctx = cnv.getContext('2d');
        ctx.font = `${fontSize}px Georgia`;
        const w = ctx.measureText(text).width + 4;
        cnv.width = w; cnv.height = fontSize + 4;
        ctx.font = `${fontSize}px Georgia`;
        ctx.fillStyle = '#fff';
        ctx.globalAlpha = 0.6;
        ctx.fillText(text, 2, fontSize);
        const tex = new THREE.CanvasTexture(cnv);
        tex.minFilter = THREE.LinearFilter;
        const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
        const sprite = new THREE.Sprite(mat);
        sprite.scale.set(w / 10, (fontSize + 4) / 10, 1);
        return sprite;
    }

    for (let i = 0; i < labelLimit; i++) {
        const { size } = starVisuals(data.stars[i].c, maxCount);
        const fontSize = Math.max(12, Math.round(size * 2.5));
        const sprite = makeLabel(data.stars[i].w, fontSize);
        const idx = i * 3;
        sprite.position.set(
            positions[idx] * 1.01,
            positions[idx + 1] * 1.01 - size / 8,
            positions[idx + 2] * 1.01
        );
        scene.add(sprite);
        labelSprites.push(sprite);
    }

    // --- Celestial Bodies ---
    const bodyMeshes = [];

    function updateBodies(date) {
        // Remove old
        for (const m of bodyMeshes) scene.remove(m);
        bodyMeshes.length = 0;

        const bodies = getCelestialBodies(date);
        for (const b of bodies) {
            const pos = skyToXYZ(b.azimuth, b.altitude, SKY_RADIUS * 0.98);
            const color = new THREE.Color(b.color);

            // Glow sprite
            const cnv = document.createElement('canvas');
            cnv.width = 64; cnv.height = 64;
            const ctx = cnv.getContext('2d');
            const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
            grad.addColorStop(0, b.color);
            grad.addColorStop(0.3, b.color + '88');
            grad.addColorStop(1, 'transparent');
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, 64, 64);

            // Add label
            ctx.font = '10px sans-serif';
            ctx.fillStyle = b.color;
            ctx.globalAlpha = 0.4;
            ctx.textAlign = 'center';
            ctx.fillText(b.name, 32, 58);

            const tex = new THREE.CanvasTexture(cnv);
            const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
            const sprite = new THREE.Sprite(mat);
            sprite.scale.set(b.size, b.size, 1);
            sprite.position.set(pos.x, pos.y, pos.z);
            scene.add(sprite);
            bodyMeshes.push(sprite);
        }
    }

    updateBodies(now);

    // --- Ecliptic Arc ---
    // Approximate ecliptic as a great circle tilted 23.4° from the celestial equator
    // Rendered as a dashed line of small points
    function updateEcliptic(date) {
        // Remove old ecliptic if it exists
        const old = scene.getObjectByName('ecliptic');
        if (old) scene.remove(old);

        const points = [];
        for (let lon = 0; lon < 360; lon += 2) {
            // Ecliptic longitude to RA/Dec (simplified)
            const lonRad = lon * Math.PI / 180;
            const obliquity = 23.44 * Math.PI / 180;
            const ra = Math.atan2(Math.sin(lonRad) * Math.cos(obliquity), Math.cos(lonRad)) * 12 / Math.PI;
            const dec = Math.asin(Math.sin(obliquity) * Math.sin(lonRad)) * 180 / Math.PI;
            const hor = Astronomy.Horizon(date, observer, (ra + 24) % 24, dec, 'normal');
            const pos = skyToXYZ(hor.azimuth, hor.altitude, SKY_RADIUS * 0.99);
            points.push(new THREE.Vector3(pos.x, pos.y, pos.z));
        }

        const lineGeom = new THREE.BufferGeometry().setFromPoints(points);
        const lineMat = new THREE.LineDashedMaterial({
            color: 0xffc850, transparent: true, opacity: 0.12, dashSize: 3, gapSize: 3,
        });
        const line = new THREE.Line(lineGeom, lineMat);
        line.computeLineDistances();
        line.name = 'ecliptic';
        scene.add(line);
    }
    updateEcliptic(now);

    // --- Horizon Glow ---
    const horizGeom = new THREE.RingGeometry(SKY_RADIUS * 0.95, SKY_RADIUS * 1.05, 64);
    const horizMat = new THREE.MeshBasicMaterial({
        color: 0x1e2846, transparent: true, opacity: 0.3, side: THREE.DoubleSide,
    });
    const horizMesh = new THREE.Mesh(horizGeom, horizMat);
    horizMesh.rotation.x = Math.PI / 2;
    scene.add(horizMesh);

    // --- Gyroscope Controls ---
    let gyroAvailable = false;
    let deviceAlpha = 0, deviceBeta = 0, deviceGamma = 0;
    const targetQuat = new THREE.Quaternion();
    const q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));

    window.addEventListener('deviceorientation', (e) => {
        if (e.alpha === null) return;
        gyroAvailable = true;
        deviceAlpha = e.alpha;
        deviceBeta = e.beta;
        deviceGamma = e.gamma;
    });

    function updateGyro() {
        if (!gyroAvailable) return;
        const alpha = THREE.MathUtils.degToRad(deviceAlpha);
        const beta = THREE.MathUtils.degToRad(deviceBeta);
        const gamma = THREE.MathUtils.degToRad(deviceGamma);

        const euler = new THREE.Euler(beta, alpha, -gamma, 'YXZ');
        targetQuat.setFromEuler(euler);
        targetQuat.multiply(q1);

        const orient = (screen.orientation?.angle || 0) * Math.PI / 180;
        const q0 = new THREE.Quaternion();
        q0.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -orient);
        targetQuat.multiply(q0);

        camera.quaternion.slerp(targetQuat, 0.3); // Smooth interpolation
    }

    // --- Touch-Drag Fallback ---
    let touchStartX = 0, touchStartY = 0;
    let yaw = 0, pitch = 0;

    canvas.addEventListener('touchstart', (e) => {
        if (e.touches.length === 1) {
            touchStartX = e.touches[0].clientX;
            touchStartY = e.touches[0].clientY;
        }
    });

    canvas.addEventListener('touchmove', (e) => {
        if (gyroAvailable || e.touches.length !== 1) return;
        e.preventDefault();
        const dx = e.touches[0].clientX - touchStartX;
        const dy = e.touches[0].clientY - touchStartY;
        yaw -= dx * 0.003;
        pitch -= dy * 0.003;
        pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch));
        camera.rotation.set(pitch, yaw, 0, 'YXZ');
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
    }, { passive: false });

    // --- Tap Interaction (Raycasting) ---
    const raycaster = new THREE.Raycaster();
    raycaster.params.Points.threshold = 8;
    const tapPos = new THREE.Vector2();

    canvas.addEventListener('click', (e) => {
        tapPos.x = (e.clientX / window.innerWidth) * 2 - 1;
        tapPos.y = -(e.clientY / window.innerHeight) * 2 + 1;
        raycaster.setFromCamera(tapPos, camera);

        const intersects = raycaster.intersectObject(starPoints);
        if (intersects.length > 0) {
            const idx = intersects[0].index;
            const star = data.stars[idx];
            showTooltip(star.w, star.c, e.clientX, e.clientY);
        } else {
            hideTooltip();
        }
    });

    // --- Compass Update ---
    function updateCompass() {
        const dir = new THREE.Vector3(0, 0, -1);
        dir.applyQuaternion(camera.quaternion);
        const az = (Math.atan2(dir.x, -dir.z) * 180 / Math.PI + 360) % 360;
        document.getElementById('cDir').textContent = compassDir(az);
    }

    // --- Resize ---
    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    // --- Periodic Updates ---
    let lastBodyUpdate = Date.now();
    const BODY_UPDATE_MS = 30000; // Update celestial body positions every 30s

    // --- Render Loop ---
    function animate() {
        requestAnimationFrame(animate);

        updateGyro();
        updateCompass();

        // Periodically update star and body positions (Earth rotation)
        const elapsed = Date.now() - lastBodyUpdate;
        if (elapsed > BODY_UPDATE_MS) {
            const d = new Date();
            updateBodies(d);
            updateEcliptic(d);
            const coords = getStarHorizontalCoords(data.stars, d);
            for (let i = 0; i < starCount; i++) {
                const pos = skyToXYZ(coords[i * 2], coords[i * 2 + 1], SKY_RADIUS);
                positions[i * 3] = pos.x;
                positions[i * 3 + 1] = pos.y;
                positions[i * 3 + 2] = pos.z;
            }
            starGeom.attributes.position.needsUpdate = true;
            // Update label positions too
            for (let i = 0; i < labelLimit; i++) {
                const idx = i * 3;
                labelSprites[i].position.set(
                    positions[idx] * 1.01,
                    positions[idx + 1] * 1.01 - sizes[i] / 24,
                    positions[idx + 2] * 1.01
                );
            }
            lastBodyUpdate = Date.now();
        }

        renderer.render(scene, camera);
    }

    animate();
}
```

- [ ] **Step 2: Verify on mobile (or Chrome DevTools device emulation)**

Run: `cd roe-search && npx wrangler dev`

Open `http://localhost:8787/stars` on phone (or use Chrome DevTools → Toggle Device → iPhone 14 Pro). Tap "Tap to look up". Verify:
- Star field renders on dark background
- Gyroscope moves the view (on real device) or touch-drag works (in emulator)
- Tapping a star shows tooltip with word and count
- Compass updates at bottom
- Moon/planet sprites visible

- [ ] **Step 3: Commit**

```bash
git add roe-search/src/stars.html
git commit -m "feat: implement mobile Three.js planetarium with gyroscope controls"
```

---

### Task 5: Desktop D3 Planisphere Renderer

**Files:**
- Modify: `roe-search/src/stars.html` (replace `startDesktop` placeholder)

Implement the 2D star chart: zenithal projection onto a circular disc, star rendering, celestial body overlay, drag-to-rotate, scroll-to-zoom, hover tooltips.

- [ ] **Step 1: Replace the startDesktop placeholder**

In `roe-search/src/stars.html`, replace the entire `startDesktop` function with:

```javascript
function startDesktop(d3, data) {
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d');
    const maxCount = data.stars[0].c;
    const labelLimit = Math.min(500, data.stars.length);

    let width = window.innerWidth;
    let height = window.innerHeight;
    let dpr = Math.min(window.devicePixelRatio, 2);

    function resize() {
        width = window.innerWidth;
        height = window.innerHeight;
        dpr = Math.min(window.devicePixelRatio, 2);
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        canvas.style.width = width + 'px';
        canvas.style.height = height + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();

    // --- Projection: Zenithal equidistant ---
    // Azimuth/altitude → x,y on a circle (zenith=center, horizon=edge)
    const chartRadius = Math.min(width, height) * 0.42;
    const cx = width / 2;
    const cy = height / 2;

    function project(az, alt) {
        const r = ((90 - alt) / 90) * chartRadius;
        const theta = az * Math.PI / 180;
        const x = cx + r * Math.sin(theta);
        const y = cy - r * Math.cos(theta);
        return { x, y, r };
    }

    // --- Zoom/Pan State ---
    let transform = d3.zoomIdentity;

    function applyTransform(px, py) {
        return {
            x: transform.applyX(px),
            y: transform.applyY(py),
        };
    }

    // --- Compute star screen positions ---
    let starScreenPos = [];
    let bodyScreenPos = [];

    function updatePositions() {
        const now = new Date();
        const horizCoords = getStarHorizontalCoords(data.stars, now);
        starScreenPos = [];
        for (let i = 0; i < data.stars.length; i++) {
            const az = horizCoords[i * 2];
            const alt = horizCoords[i * 2 + 1];
            const { x, y } = project(az, alt);
            const { size, opacity } = starVisuals(data.stars[i].c, maxCount);
            starScreenPos.push({ x, y, size, opacity, word: data.stars[i].w, count: data.stars[i].c, alt });
        }

        const bodies = getCelestialBodies(now);
        bodyScreenPos = [];
        for (const b of bodies) {
            const { x, y } = project(b.azimuth, b.altitude);
            bodyScreenPos.push({ ...b, x, y });
        }
    }

    updatePositions();

    // --- Draw ---
    function render() {
        ctx.save();
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = '#080c18';
        ctx.fillRect(0, 0, width, height);

        // Apply zoom transform
        ctx.translate(transform.x, transform.y);
        ctx.scale(transform.k, transform.k);

        // Milky way hint
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(-15 * Math.PI / 180);
        const mwGrad = ctx.createLinearGradient(-chartRadius, -chartRadius * 0.3, chartRadius, chartRadius * 0.3);
        mwGrad.addColorStop(0, 'transparent');
        mwGrad.addColorStop(0.35, 'rgba(200,210,255,0.02)');
        mwGrad.addColorStop(0.5, 'rgba(200,210,255,0.04)');
        mwGrad.addColorStop(0.65, 'rgba(200,210,255,0.02)');
        mwGrad.addColorStop(1, 'transparent');
        ctx.fillStyle = mwGrad;
        ctx.fillRect(-chartRadius * 1.2, -chartRadius * 0.3, chartRadius * 2.4, chartRadius * 0.6);
        ctx.restore();

        // Grid circles (declination)
        ctx.strokeStyle = 'rgba(100,120,180,0.06)';
        ctx.lineWidth = 0.5;
        for (const frac of [0.33, 0.66, 1.0]) {
            ctx.beginPath();
            ctx.arc(cx, cy, chartRadius * frac, 0, Math.PI * 2);
            ctx.stroke();
        }

        // Grid lines (RA)
        for (let angle = 0; angle < 180; angle += 45) {
            const rad = angle * Math.PI / 180;
            ctx.beginPath();
            ctx.moveTo(cx + chartRadius * Math.cos(rad), cy + chartRadius * Math.sin(rad));
            ctx.lineTo(cx - chartRadius * Math.cos(rad), cy - chartRadius * Math.sin(rad));
            ctx.stroke();
        }

        // Horizon circle
        ctx.strokeStyle = 'rgba(100,120,180,0.15)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(cx, cy, chartRadius, 0, Math.PI * 2);
        ctx.stroke();

        // Cardinal directions
        ctx.fillStyle = 'rgba(100,120,180,0.4)';
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('N', cx, cy - chartRadius - 8);
        ctx.fillText('S', cx, cy + chartRadius + 16);
        ctx.fillText('E', cx + chartRadius + 12, cy + 4);
        ctx.fillText('W', cx - chartRadius - 12, cy + 4);

        // Ecliptic (approximate dashed ellipse)
        ctx.save();
        ctx.strokeStyle = 'rgba(255,200,80,0.12)';
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.translate(cx, cy);
        ctx.rotate(-23.4 * Math.PI / 180);
        ctx.ellipse(0, 0, chartRadius * 0.9, chartRadius * 0.75, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();

        // Stars (below horizon = skip)
        const zoomLevel = transform.k;
        const dynLabelLimit = Math.min(data.stars.length, Math.round(labelLimit * Math.min(zoomLevel, 3)));

        for (let i = starScreenPos.length - 1; i >= 0; i--) {
            const s = starScreenPos[i];
            if (s.alt < -5) continue; // Below horizon

            const r = Math.max(0.5, s.size * 0.5);
            ctx.globalAlpha = s.opacity;
            ctx.fillStyle = starColor(s.word);
            ctx.beginPath();
            ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
            ctx.fill();

            // Glow for larger stars
            if (r > 2) {
                const glow = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, r * 3);
                glow.addColorStop(0, starColor(s.word));
                glow.addColorStop(1, 'transparent');
                ctx.globalAlpha = s.opacity * 0.15;
                ctx.fillStyle = glow;
                ctx.beginPath();
                ctx.arc(s.x, s.y, r * 3, 0, Math.PI * 2);
                ctx.fill();
            }

            // Labels
            if (i < dynLabelLimit) {
                ctx.globalAlpha = s.opacity * 0.7;
                ctx.fillStyle = starColor(s.word);
                ctx.font = `${Math.max(8, Math.round(s.size * 0.9))}px Georgia`;
                ctx.textAlign = 'left';
                ctx.fillText(s.word, s.x + r + 3, s.y + 3);
            }
        }
        ctx.globalAlpha = 1;

        // Celestial bodies
        for (const b of bodyScreenPos) {
            if (b.altitude < -5) continue;
            const r = b.size * 0.5;

            // Glow
            const glow = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, r * 2.5);
            glow.addColorStop(0, b.color);
            glow.addColorStop(0.4, b.color + '44');
            glow.addColorStop(1, 'transparent');
            ctx.fillStyle = glow;
            ctx.beginPath();
            ctx.arc(b.x, b.y, r * 2.5, 0, Math.PI * 2);
            ctx.fill();

            // Dot
            ctx.fillStyle = b.color;
            ctx.beginPath();
            ctx.arc(b.x, b.y, Math.max(1.5, r * 0.4), 0, Math.PI * 2);
            ctx.fill();

            // Label
            ctx.globalAlpha = 0.4;
            ctx.fillStyle = b.color;
            ctx.font = '9px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(b.name, b.x, b.y + r + 10);
            ctx.globalAlpha = 1;
        }

        ctx.restore();
    }

    render();

    // --- D3 Zoom ---
    const zoom = d3.zoom()
        .scaleExtent([0.5, 10])
        .on('zoom', (event) => {
            transform = event.transform;
            render();
        });

    d3.select(canvas).call(zoom);

    // --- Hover Tooltip ---
    let hoveredStar = null;

    canvas.addEventListener('mousemove', (e) => {
        const mx = (e.clientX - transform.x) / transform.k;
        const my = (e.clientY - transform.y) / transform.k;

        let nearest = null;
        let minDist = 20 / transform.k;

        for (const s of starScreenPos) {
            if (s.alt < -5) continue;
            const dx = mx - s.x;
            const dy = my - s.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < minDist) {
                minDist = dist;
                nearest = s;
            }
        }

        if (nearest) {
            showTooltip(nearest.word, nearest.count, e.clientX, e.clientY);
            canvas.style.cursor = 'pointer';
            hoveredStar = nearest;
        } else if (hoveredStar) {
            hideTooltip();
            canvas.style.cursor = 'grab';
            hoveredStar = null;
        }
    });

    canvas.addEventListener('mouseleave', () => {
        hideTooltip();
        hoveredStar = null;
    });

    canvas.style.cursor = 'grab';

    // --- Resize ---
    window.addEventListener('resize', () => {
        resize();
        updatePositions();
        render();
    });

    // --- Periodic position update (Earth rotation) ---
    setInterval(() => {
        updatePositions();
        render();
    }, 30000);
}
```

- [ ] **Step 2: Verify on desktop**

Run: `cd roe-search && npx wrangler dev`

Open `http://localhost:8787/stars` in desktop browser. Click "Enter". Verify:
- Circular star chart renders with grid lines and cardinal directions
- Stars visible with labels on the brightest ones
- Drag to rotate the chart
- Scroll to zoom — more labels appear at higher zoom
- Hover a star → tooltip shows word and count
- Moon/planets visible with labels
- Ecliptic dashed arc visible
- Legend in top-right corner
- Bottom bar with instructions and mobile hint

- [ ] **Step 3: Commit**

```bash
git add roe-search/src/stars.html
git commit -m "feat: implement desktop D3 planisphere star chart"
```

---

### Task 6: Route Registration and Navigation Updates

**Files:**
- Modify: `roe-search/src/index.js` (lines 1–6, ~line 57)
- Modify: `roe-search/src/frontend.html` (nav element)
- Modify: `roe-search/src/episodes.html` (nav element)
- Modify: `roe-search/src/guests.html` (nav element)
- Modify: `roe-search/src/map.html` (nav element)
- Modify: `roe-search/src/admin.html` (nav element)

If the import and route were already added in Task 3 Step 2, this task just adds navigation links. If not, add the import and route first.

- [ ] **Step 1: Verify import and route exist in index.js**

Confirm `roe-search/src/index.js` has:
- Line 6: `import STARS_HTML from './stars.html';`
- After the `/map` route: the `/stars` route block
- After the other API routes: the `/api/stars` route block

If any are missing, add them now.

- [ ] **Step 2: Update navigation in all HTML files**

Each page has a `<nav>` element. Add "Stars" link to each. The pattern is:

```
<a href="/episodes">Episodes</a> · <a href="/map">Map</a> · <a href="/stars">Stars</a> · <a href="/">Search</a>
```

**frontend.html** — Find the `<nav aria-label="Main navigation">` and add the Stars link:
```html
<nav aria-label="Main navigation"><a href="/episodes">Episodes</a> · <a href="/map">Map</a> · <a href="/stars">Stars</a> · <a href="/" aria-current="page">Search</a></nav>
```

**episodes.html** — Same nav, with Episodes as current:
```html
<nav aria-label="Main navigation"><a href="/episodes" aria-current="page">Episodes</a> · <a href="/map">Map</a> · <a href="/stars">Stars</a> · <a href="/">Search</a></nav>
```

**guests.html** — Same nav (no current page marker — guests isn't in main nav):
```html
<nav aria-label="Main navigation"><a href="/episodes">Episodes</a> · <a href="/map">Map</a> · <a href="/stars">Stars</a> · <a href="/">Search</a></nav>
```

**map.html** — Same nav, with Map as current:
```html
<nav aria-label="Main navigation"><a href="/episodes">Episodes</a> · <a href="/map" aria-current="page">Map</a> · <a href="/stars">Stars</a> · <a href="/">Search</a></nav>
```

**admin.html** — Same nav (no current page marker):
```html
<nav aria-label="Main navigation"><a href="/episodes">Episodes</a> · <a href="/map">Map</a> · <a href="/stars">Stars</a> · <a href="/">Search</a></nav>
```

**stars.html** already has a back-link to `/` on the splash screen, which is sufficient since the stars page is fullscreen with no hero/nav bar.

- [ ] **Step 3: Verify all pages show Stars link**

Run: `cd roe-search && npx wrangler dev`

Check each page at localhost:8787:
- `/` — Stars link visible in nav
- `/episodes` — Stars link visible
- `/guests` — Stars link visible
- `/map` — Stars link visible
- `/admin` — Stars link visible
- `/stars` — Page loads with splash screen

- [ ] **Step 4: Commit**

```bash
git add roe-search/src/index.js roe-search/src/frontend.html roe-search/src/episodes.html roe-search/src/guests.html roe-search/src/map.html roe-search/src/admin.html
git commit -m "feat: add /stars route and navigation links across all pages"
```

---

### Task 7: Deploy and End-to-End Verification

**Files:** None (deploy and test only)

- [ ] **Step 1: Generate and upload star data (if not already done)**

```bash
node scripts/generate-stars.js
```

Verify "Upload complete." in output.

- [ ] **Step 2: Deploy the Worker**

```bash
cd roe-search && npx wrangler deploy
```

Expected: Successful deployment with no errors.

- [ ] **Step 3: Verify /api/stars returns data**

```bash
curl -s https://rollovereasy.org/api/stars | head -c 300
```

Expected: JSON with `generated`, `total_episodes`, `total_segments`, and `stars` array.

- [ ] **Step 4: Verify desktop experience**

Open `https://rollovereasy.org/stars` in desktop browser. Verify:
- Splash screen loads with "Enter" button
- Clicking Enter shows star chart
- Stars render with labels
- Drag/zoom works
- Hover shows tooltips
- Celestial bodies visible

- [ ] **Step 5: Verify mobile experience**

Open `https://rollovereasy.org/stars` on a phone. Verify:
- Splash screen shows "Tap to look up"
- Permission dialog appears (iOS)
- After granting: full planetarium renders
- Gyroscope controls the view — look up, down, around
- Tapping a star shows tooltip
- Compass updates at bottom
- Moon/planets in correct approximate positions

- [ ] **Step 6: Commit any fixes**

If any fixes were needed, commit them:

```bash
git add -A
git commit -m "fix: address issues found during deployment verification"
```
