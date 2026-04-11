# Map Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pull SF businesses and POIs from Yelp, DataSF, and OpenStreetMap, cross-reference against episode transcripts, and seed verified matches to D1. Clean up existing false positives.

**Architecture:** Separate fetch scripts per data source write to `scripts/candidates/<source>.json` in a shared format. A merge script deduplicates across sources into `all.json`. A cross-reference script searches local transcript files for each candidate name, then verifies matches via GPT-4o-mini. Verified places are seeded to D1 using the existing `seed-business-places.js` pattern. A cleanup script re-verifies existing places and prunes false positives.

**Tech Stack:** Node.js (ESM), Yelp Fusion API, DataSF Socrata API, Overpass API, GPT-4o-mini, Cloudflare D1 (via wrangler CLI), node:test for unit tests

**Spec:** `docs/superpowers/specs/2026-04-10-map-enrichment-design.md`

---

## File Structure

```
scripts/
  candidates/
    fetch-yelp.js          — Fetch businesses from Yelp Fusion API by category
    fetch-datasf.js        — Fetch registered SF businesses from DataSF open data
    fetch-osm.js           — Fetch parks, trails, landmarks from OpenStreetMap
    merge-candidates.js    — Deduplicate and merge all sources into all.json
    merge-candidates.test.js — Tests for normalization and dedup logic
  cross-reference-candidates.js  — Search transcripts for candidate mentions, LLM verify
  seed-verified-places.js        — Push verified places to D1
  cleanup-places.js              — Re-verify existing D1 places, prune false positives
```

---

### Task 1: Create candidates directory and shared constants

**Files:**
- Create: `scripts/candidates/` directory

- [ ] **Step 1: Create the directory**

```bash
mkdir -p scripts/candidates
```

- [ ] **Step 2: Commit**

```bash
git add scripts/candidates/.gitkeep
git commit -m "chore: create scripts/candidates directory for map enrichment pipeline"
```

Note: If git won't track an empty directory, create a `.gitkeep` file:
```bash
touch scripts/candidates/.gitkeep
```

---

### Task 2: Fetch Yelp businesses (`scripts/candidates/fetch-yelp.js`)

**Files:**
- Create: `scripts/candidates/fetch-yelp.js`

**Context:** Yelp Fusion API requires a free API key from yelp.com/developers. The `/v3/businesses/search` endpoint returns up to 50 results per request, paginating up to 1,000 results per category query. We search 11 SF-relevant categories. The free tier allows 500 requests/day, and our sweep needs ~220 requests (11 categories × 20 pages), so it fits in one day.

- [ ] **Step 1: Write the fetch script**

```js
#!/usr/bin/env node
/**
 * fetch-yelp.js
 *
 * Fetches SF businesses from Yelp Fusion API by category.
 * Outputs scripts/candidates/yelp.json in shared candidate format.
 *
 * Usage:
 *   YELP_API_KEY=... node scripts/candidates/fetch-yelp.js [--resume]
 */

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, 'yelp.json');
const CHECKPOINT_PATH = path.join(__dirname, '.yelp-checkpoint.json');

const API_KEY = process.env.YELP_API_KEY;
if (!API_KEY) { console.error('YELP_API_KEY required'); process.exit(1); }

const RESUME = process.argv.includes('--resume');

const CATEGORIES = [
  'restaurants', 'bars', 'coffee', 'bakeries', 'musicvenues',
  'bookstores', 'grocery', 'arts', 'nightlife', 'breakfast_brunch',
  'foodtrucks',
];

const LIMIT = 50; // max per request
const MAX_RESULTS = 1000; // Yelp caps at 1000 per search

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function yelpSearch(category, offset) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      location: 'San Francisco, CA',
      categories: category,
      limit: String(LIMIT),
      offset: String(offset),
      sort_by: 'review_count',
    });
    const url = `https://api.yelp.com/v3/businesses/search?${params}`;
    https.get(url, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            reject(new Error(`Yelp API error: ${json.error.code} — ${json.error.description}`));
          } else {
            resolve(json);
          }
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function main() {
  // Load checkpoint if resuming
  let checkpoint = { completedCategories: [], businesses: {} };
  if (RESUME && fs.existsSync(CHECKPOINT_PATH)) {
    checkpoint = JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf8'));
    console.log(`Resuming — ${checkpoint.completedCategories.length} categories done, ${Object.keys(checkpoint.businesses).length} businesses loaded`);
  }

  const businesses = checkpoint.businesses; // keyed by yelp ID to deduplicate
  let requestCount = 0;

  for (const category of CATEGORIES) {
    if (checkpoint.completedCategories.includes(category)) {
      console.log(`  [skip] ${category} (already done)`);
      continue;
    }

    console.log(`\nFetching category: ${category}`);
    let offset = 0;
    let totalForCategory = 0;

    while (offset < MAX_RESULTS) {
      try {
        const result = await yelpSearch(category, offset);
        const batch = result.businesses || [];
        totalForCategory = result.total || 0;

        for (const biz of batch) {
          if (!businesses[biz.id]) {
            businesses[biz.id] = {
              name: biz.name,
              address: [biz.location?.address1, biz.location?.city, biz.location?.state].filter(Boolean).join(', '),
              lat: biz.coordinates?.latitude || null,
              lng: biz.coordinates?.longitude || null,
              source: 'yelp',
              category: category,
              meta: {
                yelp_id: biz.id,
                rating: biz.rating,
                review_count: biz.review_count,
                categories: (biz.categories || []).map(c => c.alias),
              },
            };
          }
        }

        requestCount++;
        offset += LIMIT;
        process.stdout.write(`\r  ${category}: ${offset}/${Math.min(totalForCategory, MAX_RESULTS)} (${Object.keys(businesses).length} unique total)`);

        if (batch.length < LIMIT) break; // no more results
        await sleep(200); // be polite
      } catch (err) {
        console.error(`\n  Error at ${category} offset ${offset}: ${err.message}`);
        if (err.message.includes('ACCESS_LIMIT')) {
          console.error('  Daily limit reached. Re-run tomorrow with --resume');
          // Save checkpoint before exiting
          checkpoint.businesses = businesses;
          fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(checkpoint, null, 2));
          process.exit(1);
        }
        break; // skip rest of this category on other errors
      }
    }

    console.log(`\n  ${category}: done (${totalForCategory} total on Yelp)`);
    checkpoint.completedCategories.push(category);
    checkpoint.businesses = businesses;
    fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(checkpoint, null, 2));
  }

  // Write final output
  const candidates = Object.values(businesses).filter(b => b.lat && b.lng);
  fs.writeFileSync(OUT_PATH, JSON.stringify({ candidates, fetched_at: new Date().toISOString() }, null, 2));
  console.log(`\nDone! ${candidates.length} businesses saved to ${OUT_PATH} (${requestCount} API requests)`);

  // Clean up checkpoint
  if (fs.existsSync(CHECKPOINT_PATH)) fs.unlinkSync(CHECKPOINT_PATH);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
```

- [ ] **Step 2: Test manually with a small run**

```bash
YELP_API_KEY=... node scripts/candidates/fetch-yelp.js
```

Expected: Script outputs progress per category and saves `scripts/candidates/yelp.json` with business data. Verify the JSON has the correct structure by checking:

```bash
node -e "const d = require('./scripts/candidates/yelp.json'); console.log('Count:', d.candidates.length); console.log('Sample:', JSON.stringify(d.candidates[0], null, 2))"
```

- [ ] **Step 3: Commit**

```bash
git add scripts/candidates/fetch-yelp.js
git commit -m "feat: add Yelp Fusion API fetch script for SF businesses"
```

---

### Task 3: Fetch DataSF businesses (`scripts/candidates/fetch-datasf.js`)

**Files:**
- Create: `scripts/candidates/fetch-datasf.js`

**Context:** The SF Registered Business Locations dataset is available via Socrata Open Data API at `data.sfgov.org`. Dataset ID is `g8m3-pdis`. No auth required. We filter to food/entertainment/retail businesses active since 2013. The API supports SoQL filtering and pagination with `$limit` and `$offset`.

- [ ] **Step 1: Write the fetch script**

```js
#!/usr/bin/env node
/**
 * fetch-datasf.js
 *
 * Fetches registered SF businesses from DataSF Open Data (Socrata API).
 * Filters to food, entertainment, and retail businesses active since 2013.
 * Outputs scripts/candidates/datasf.json in shared candidate format.
 *
 * Usage:
 *   node scripts/candidates/fetch-datasf.js
 *
 * No API key required.
 */

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, 'datasf.json');

// NAICS codes for relevant business categories
// 72: Accommodation and Food Services
// 71: Arts, Entertainment, and Recreation
// 44-45: Retail Trade
const NAICS_PREFIXES = ['72', '71', '44', '45'];

const PAGE_SIZE = 50000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchPage(offset) {
  return new Promise((resolve, reject) => {
    const where = [
      `business_start_date >= '2013-01-01T00:00:00'`,
      `city = 'San Francisco'`,
      `(${NAICS_PREFIXES.map(p => `starts_with(naics_code, '${p}')`).join(' OR ')})`,
    ].join(' AND ');

    const params = new URLSearchParams({
      $limit: String(PAGE_SIZE),
      $offset: String(offset),
      $where: where,
      $order: 'business_start_date DESC',
    });

    const url = `https://data.sfgov.org/resource/g8m3-pdis.json?${params}`;
    https.get(url, { headers: { 'User-Agent': 'roe-episode-search/1.0' } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// Map NAICS prefixes to human-readable categories
function naicsToCategory(code) {
  if (!code) return 'other';
  if (code.startsWith('7225')) return 'restaurant';
  if (code.startsWith('7224')) return 'bar';
  if (code.startsWith('7222') || code.startsWith('7223')) return 'restaurant';
  if (code.startsWith('7211')) return 'hotel';
  if (code.startsWith('71')) return 'entertainment';
  if (code.startsWith('445')) return 'grocery';
  if (code.startsWith('44') || code.startsWith('45')) return 'retail';
  if (code.startsWith('72')) return 'food_service';
  return 'other';
}

async function main() {
  console.log('Fetching SF businesses from DataSF...');
  const allRecords = [];
  let offset = 0;

  while (true) {
    const page = await fetchPage(offset);
    if (!page || page.length === 0) break;
    allRecords.push(...page);
    console.log(`  Fetched ${allRecords.length} records (offset ${offset})...`);
    offset += PAGE_SIZE;
    if (page.length < PAGE_SIZE) break;
    await sleep(500);
  }

  console.log(`\nTotal records: ${allRecords.length}`);

  // Deduplicate by DBA name (keep most recent)
  const seen = new Map(); // lowercase dba_name → record
  for (const record of allRecords) {
    const name = (record.dba_name || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (!seen.has(key)) {
      seen.set(key, record);
    }
  }

  console.log(`Unique DBA names: ${seen.size}`);

  const candidates = [];
  for (const [, record] of seen) {
    const name = (record.dba_name || '').trim();
    const address = [
      record.street_address,
      record.city,
      record.state,
    ].filter(Boolean).join(', ');

    candidates.push({
      name,
      address,
      lat: null, // DataSF doesn't include coordinates in this dataset
      lng: null,
      source: 'datasf',
      category: naicsToCategory(record.naics_code),
      meta: {
        naics_code: record.naics_code,
        naics_description: record.naics_code_description,
        business_start_date: record.business_start_date,
        dba_name_raw: record.dba_name,
      },
    });
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify({ candidates, fetched_at: new Date().toISOString() }, null, 2));
  console.log(`\nDone! ${candidates.length} businesses saved to ${OUT_PATH}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
```

- [ ] **Step 2: Run and verify**

```bash
node scripts/candidates/fetch-datasf.js
```

Expected: Downloads thousands of records. Verify output:

```bash
node -e "const d = require('./scripts/candidates/datasf.json'); console.log('Count:', d.candidates.length); console.log('Sample:', JSON.stringify(d.candidates[0], null, 2))"
```

- [ ] **Step 3: Commit**

```bash
git add scripts/candidates/fetch-datasf.js
git commit -m "feat: add DataSF fetch script for registered SF businesses"
```

---

### Task 4: Fetch OpenStreetMap POIs (`scripts/candidates/fetch-osm.js`)

**Files:**
- Create: `scripts/candidates/fetch-osm.js`

**Context:** The Overpass API provides free access to OpenStreetMap data. We query for named POIs within the SF bounding box — parks, trails, landmarks, transit stations, cultural venues. The API accepts Overpass QL queries and returns JSON. No auth needed, just respect rate limits.

- [ ] **Step 1: Write the fetch script**

```js
#!/usr/bin/env node
/**
 * fetch-osm.js
 *
 * Fetches parks, trails, landmarks, transit, and cultural venues from
 * OpenStreetMap via the Overpass API.
 * Outputs scripts/candidates/osm.json in shared candidate format.
 *
 * Usage:
 *   node scripts/candidates/fetch-osm.js
 *
 * No API key required.
 */

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, 'osm.json');

// SF bounding box: south, west, north, east
const SF_BBOX = '37.703,-122.527,37.812,-122.348';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Each query targets a different category of POI
const QUERIES = [
  {
    label: 'Parks & Gardens',
    category: 'park',
    query: `[out:json][timeout:60];
(
  way["leisure"="park"]["name"](${SF_BBOX});
  relation["leisure"="park"]["name"](${SF_BBOX});
  way["leisure"="garden"]["name"](${SF_BBOX});
  node["leisure"="park"]["name"](${SF_BBOX});
);
out center;`,
  },
  {
    label: 'Trails & Paths',
    category: 'trail',
    query: `[out:json][timeout:60];
(
  way["highway"="path"]["name"](${SF_BBOX});
  way["highway"="footway"]["name"](${SF_BBOX});
  way["highway"="steps"]["name"](${SF_BBOX});
  relation["route"="hiking"]["name"](${SF_BBOX});
);
out center;`,
  },
  {
    label: 'Landmarks & Historic',
    category: 'landmark',
    query: `[out:json][timeout:60];
(
  node["historic"]["name"](${SF_BBOX});
  way["historic"]["name"](${SF_BBOX});
  node["tourism"="attraction"]["name"](${SF_BBOX});
  way["tourism"="attraction"]["name"](${SF_BBOX});
  node["tourism"="viewpoint"]["name"](${SF_BBOX});
);
out center;`,
  },
  {
    label: 'Transit Stations',
    category: 'transit',
    query: `[out:json][timeout:60];
(
  node["railway"="station"]["name"](${SF_BBOX});
  node["station"="subway"]["name"](${SF_BBOX});
  node["public_transport"="stop_position"]["name"]["network"~"BART|Muni"](${SF_BBOX});
  node["railway"="tram_stop"]["name"](${SF_BBOX});
);
out center;`,
  },
  {
    label: 'Cultural Venues',
    category: 'cultural',
    query: `[out:json][timeout:60];
(
  node["amenity"="theatre"]["name"](${SF_BBOX});
  way["amenity"="theatre"]["name"](${SF_BBOX});
  node["amenity"="arts_centre"]["name"](${SF_BBOX});
  way["amenity"="arts_centre"]["name"](${SF_BBOX});
  node["tourism"="museum"]["name"](${SF_BBOX});
  way["tourism"="museum"]["name"](${SF_BBOX});
  node["tourism"="gallery"]["name"](${SF_BBOX});
  way["tourism"="gallery"]["name"](${SF_BBOX});
  node["amenity"="library"]["name"](${SF_BBOX});
  way["amenity"="library"]["name"](${SF_BBOX});
);
out center;`,
  },
  {
    label: 'Beaches & Natural Features',
    category: 'nature',
    query: `[out:json][timeout:60];
(
  node["natural"="beach"]["name"](${SF_BBOX});
  way["natural"="beach"]["name"](${SF_BBOX});
  node["natural"="peak"]["name"](${SF_BBOX});
  node["natural"="cliff"]["name"](${SF_BBOX});
);
out center;`,
  },
];

function overpassQuery(query) {
  return new Promise((resolve, reject) => {
    const postData = `data=${encodeURIComponent(query)}`;
    const req = https.request({
      hostname: 'overpass-api.de',
      path: '/api/interpreter',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': 'roe-episode-search/1.0',
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Parse error: ${data.substring(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function extractCoords(element) {
  // Nodes have lat/lon directly; ways/relations have center if requested
  if (element.lat !== undefined) return { lat: element.lat, lng: element.lon };
  if (element.center) return { lat: element.center.lat, lng: element.center.lon };
  return null;
}

async function main() {
  console.log('Fetching SF POIs from OpenStreetMap...');
  const allCandidates = new Map(); // name (lowercase) → candidate

  for (const { label, category, query } of QUERIES) {
    console.log(`\n  ${label}...`);
    try {
      const result = await overpassQuery(query);
      const elements = result.elements || [];
      let added = 0;

      for (const el of elements) {
        const name = el.tags?.name;
        if (!name) continue;
        const coords = extractCoords(el);
        if (!coords) continue;

        const key = name.toLowerCase();
        if (!allCandidates.has(key)) {
          allCandidates.set(key, {
            name,
            address: '',
            lat: coords.lat,
            lng: coords.lng,
            source: 'osm',
            category,
            meta: {
              osm_id: el.id,
              osm_type: el.type,
              tags: el.tags,
            },
          });
          added++;
        }
      }

      console.log(`    ${elements.length} elements, ${added} new unique places`);
    } catch (err) {
      console.error(`    Error: ${err.message}`);
    }

    await sleep(5000); // Overpass asks for 5s between requests
  }

  const candidates = [...allCandidates.values()];
  fs.writeFileSync(OUT_PATH, JSON.stringify({ candidates, fetched_at: new Date().toISOString() }, null, 2));
  console.log(`\nDone! ${candidates.length} POIs saved to ${OUT_PATH}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
```

- [ ] **Step 2: Run and verify**

```bash
node scripts/candidates/fetch-osm.js
```

Expected: Fetches POIs across 6 categories. Takes ~30s due to Overpass rate limits. Verify:

```bash
node -e "const d = require('./scripts/candidates/osm.json'); console.log('Count:', d.candidates.length); const cats = {}; d.candidates.forEach(c => cats[c.category] = (cats[c.category]||0)+1); console.log('By category:', cats)"
```

- [ ] **Step 3: Commit**

```bash
git add scripts/candidates/fetch-osm.js
git commit -m "feat: add OpenStreetMap fetch script for SF parks, trails, landmarks"
```

---

### Task 5: Merge and deduplicate candidates (`scripts/candidates/merge-candidates.js`)

**Files:**
- Create: `scripts/candidates/merge-candidates.js`
- Create: `scripts/candidates/merge-candidates.test.js`

**Context:** This is the only script with substantial pure logic (name normalization, deduplication, stoplist filtering). We test this logic with `node:test` (built into Node.js 18+, no extra dependencies). The merge script reads `yelp.json`, `datasf.json`, and `osm.json`, normalizes names, deduplicates, filters out stoplist words and short names, and outputs `all.json`.

- [ ] **Step 1: Write the failing tests**

```js
// scripts/candidates/merge-candidates.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeName, shouldFilter, deduplicateCandidates } from './merge-candidates.js';

describe('normalizeName', () => {
  it('lowercases and trims', () => {
    assert.equal(normalizeName('  Ritual Coffee  '), 'ritual coffee');
  });

  it('strips common business suffixes', () => {
    assert.equal(normalizeName('Acme Foods Inc'), 'acme foods');
    assert.equal(normalizeName('Acme LLC'), 'acme');
    assert.equal(normalizeName('Acme Corp.'), 'acme');
  });

  it('collapses whitespace', () => {
    assert.equal(normalizeName('Golden   Gate   Park'), 'golden gate park');
  });

  it('strips trailing SF/San Francisco', () => {
    assert.equal(normalizeName('Tartine Bakery SF'), 'tartine bakery');
    assert.equal(normalizeName('Blue Bottle San Francisco'), 'blue bottle');
  });
});

describe('shouldFilter', () => {
  it('filters names with 2 or fewer characters', () => {
    assert.equal(shouldFilter({ name: 'AB' }), true);
    assert.equal(shouldFilter({ name: 'ABC' }), false);
  });

  it('filters purely numeric names', () => {
    assert.equal(shouldFilter({ name: '12345' }), true);
  });

  it('filters common English stoplist words', () => {
    assert.equal(shouldFilter({ name: 'The Page' }), true);
    assert.equal(shouldFilter({ name: 'Grace' }), true);
    assert.equal(shouldFilter({ name: 'Amber' }), true);
  });

  it('passes valid business names', () => {
    assert.equal(shouldFilter({ name: 'Ritual Coffee Roasters' }), false);
    assert.equal(shouldFilter({ name: 'Dolores Park' }), false);
    assert.equal(shouldFilter({ name: 'Tartine Bakery' }), false);
  });
});

describe('deduplicateCandidates', () => {
  it('merges candidates with same normalized name', () => {
    const candidates = [
      { name: 'Ritual Coffee', lat: 37.75, lng: -122.42, source: 'yelp', category: 'coffee' },
      { name: 'Ritual Coffee', lat: null, lng: null, source: 'datasf', category: 'restaurant' },
    ];
    const result = deduplicateCandidates(candidates);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].sources, ['yelp', 'datasf']);
  });

  it('prefers coordinates from yelp/osm over datasf', () => {
    const candidates = [
      { name: 'Test Place', lat: null, lng: null, source: 'datasf', category: 'food' },
      { name: 'Test Place', lat: 37.75, lng: -122.42, source: 'yelp', category: 'coffee' },
    ];
    const result = deduplicateCandidates(candidates);
    assert.equal(result[0].lat, 37.75);
    assert.equal(result[0].lng, -122.42);
  });

  it('keeps distinct places separate', () => {
    const candidates = [
      { name: 'Ritual Coffee', lat: 37.75, lng: -122.42, source: 'yelp', category: 'coffee' },
      { name: 'Tartine Bakery', lat: 37.76, lng: -122.42, source: 'yelp', category: 'bakery' },
    ];
    const result = deduplicateCandidates(candidates);
    assert.equal(result.length, 2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test scripts/candidates/merge-candidates.test.js
```

Expected: Fails because `merge-candidates.js` doesn't export the functions yet.

- [ ] **Step 3: Write the merge script with exported functions**

```js
#!/usr/bin/env node
/**
 * merge-candidates.js
 *
 * Merges yelp.json, datasf.json, and osm.json into a single
 * deduplicated all.json. Normalizes names, filters stoplist words,
 * and prefers coordinates from Yelp/OSM over DataSF.
 *
 * Usage:
 *   node scripts/candidates/merge-candidates.js
 *
 * Exports normalizeName, shouldFilter, deduplicateCandidates for testing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Words that cause excessive false positives when searched in transcripts.
// These are real SF businesses whose names are common English words.
const STOPLIST = new Set([
  'the page', 'amber', 'grace', 'maven', 'slate', 'the social',
  'the vault', 'the mint', 'urban', 'nova', 'the ramp', 'sage',
  'the corner', 'local', 'the plant', 'the mill', 'the grove',
  'the square', 'bon', 'reed', 'the den', 'the net', 'rogue',
  'the marsh', 'the line', 'the center', 'the shop', 'the bar',
  'haven', 'the hall', 'the bay', 'native', 'pearl', 'the start',
  'standard', 'the independent', 'the market', 'noble', 'anthony',
  'irving', 'lyft', 'uber', 'meta', 'stripe',
]);

const SUFFIX_RE = /\s+(inc\.?|llc\.?|corp\.?|co\.?|ltd\.?|l\.?p\.?|sf|san\s+francisco)\s*$/i;

export function normalizeName(name) {
  return name
    .trim()
    .replace(SUFFIX_RE, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function shouldFilter(candidate) {
  const name = candidate.name.trim();
  // Too short
  if (name.length <= 2) return true;
  // Purely numeric
  if (/^\d+$/.test(name)) return true;
  // On the stoplist
  if (STOPLIST.has(name.toLowerCase())) return true;
  return false;
}

export function deduplicateCandidates(candidates) {
  const groups = new Map(); // normalized name → merged candidate

  for (const c of candidates) {
    const key = normalizeName(c.name);
    if (!key) continue;

    if (groups.has(key)) {
      const existing = groups.get(key);
      existing.sources.push(c.source);
      // Prefer coords from yelp/osm over datasf (datasf has null coords)
      if (!existing.lat && c.lat) {
        existing.lat = c.lat;
        existing.lng = c.lng;
      }
      // Merge categories
      if (c.category && !existing.categories.includes(c.category)) {
        existing.categories.push(c.category);
      }
    } else {
      groups.set(key, {
        name: c.name, // keep original casing from first source
        normalizedName: key,
        address: c.address || '',
        lat: c.lat || null,
        lng: c.lng || null,
        source: c.source,
        sources: [c.source],
        category: c.category || 'other',
        categories: [c.category || 'other'],
        meta: c.meta || {},
      });
    }
  }

  return [...groups.values()];
}

// CLI entrypoint — only run when executed directly
const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));

if (isMain) {
  const SOURCES = ['yelp.json', 'datasf.json', 'osm.json'];
  const allCandidates = [];

  for (const file of SOURCES) {
    const filePath = path.join(__dirname, file);
    if (!fs.existsSync(filePath)) {
      console.log(`  [skip] ${file} not found`);
      continue;
    }
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    console.log(`  ${file}: ${data.candidates.length} candidates`);
    allCandidates.push(...data.candidates);
  }

  console.log(`\nTotal raw candidates: ${allCandidates.length}`);

  // Deduplicate
  let merged = deduplicateCandidates(allCandidates);
  console.log(`After dedup: ${merged.length}`);

  // Filter
  const beforeFilter = merged.length;
  merged = merged.filter(c => !shouldFilter(c));
  console.log(`After stoplist/filter: ${merged.length} (removed ${beforeFilter - merged.length})`);

  // Sort by name
  merged.sort((a, b) => a.normalizedName.localeCompare(b.normalizedName));

  const outPath = path.join(__dirname, 'all.json');
  fs.writeFileSync(outPath, JSON.stringify({
    candidates: merged,
    merged_at: new Date().toISOString(),
    source_counts: {
      yelp: merged.filter(c => c.sources.includes('yelp')).length,
      datasf: merged.filter(c => c.sources.includes('datasf')).length,
      osm: merged.filter(c => c.sources.includes('osm')).length,
    },
  }, null, 2));
  console.log(`\nSaved ${merged.length} candidates to ${outPath}`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test scripts/candidates/merge-candidates.test.js
```

Expected: All 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/candidates/merge-candidates.js scripts/candidates/merge-candidates.test.js
git commit -m "feat: add merge-candidates script with dedup, normalization, stoplist filtering"
```

---

### Task 6: Cross-reference candidates against transcripts (`scripts/cross-reference-candidates.js`)

**Files:**
- Create: `scripts/cross-reference-candidates.js`

**Context:** This is the core matching step. It loads all 571 local transcript JSON files, builds an in-memory index, then searches for each candidate name. Matches are verified via GPT-4o-mini. We search locally (not via D1) for simplicity — the transcripts are already on disk. We use case-insensitive word-boundary matching to find candidate mentions, extract surrounding context, then batch-verify with GPT-4o-mini.

- [ ] **Step 1: Write the cross-reference script**

```js
#!/usr/bin/env node
/**
 * cross-reference-candidates.js
 *
 * Searches all episode transcripts for mentions of candidate place names,
 * then verifies matches via GPT-4o-mini.
 *
 * Usage:
 *   OPENAI_API_KEY=... node scripts/cross-reference-candidates.js [--skip-verify] [--resume]
 *
 *   --skip-verify  Output all text matches without LLM verification
 *   --resume       Resume from checkpoint (skips already-processed candidates)
 */

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRANSCRIPTS_DIR = path.join(__dirname, '..', 'transcripts');
const CANDIDATES_PATH = path.join(__dirname, 'candidates', 'all.json');
const OUT_PATH = path.join(__dirname, 'verified_places.json');
const CHECKPOINT_PATH = path.join(__dirname, '.crossref-checkpoint.json');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SKIP_VERIFY = process.argv.includes('--skip-verify');
const RESUME = process.argv.includes('--resume');

if (!SKIP_VERIFY && !OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY required (or use --skip-verify)');
  process.exit(1);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---- Transcript Loading ----

function loadTranscripts() {
  const files = fs.readdirSync(TRANSCRIPTS_DIR).filter(f => f.endsWith('.json'));
  console.log(`Loading ${files.length} transcripts...`);

  const episodes = [];
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(TRANSCRIPTS_DIR, file), 'utf8'));
      const episodeId = path.basename(file, '.json');
      episodes.push({
        id: episodeId,
        segments: data.segments || [],
        // Precompute lowercase full text for fast initial screening
        fullTextLower: (data.segments || []).map(s => s.text).join(' ').toLowerCase(),
      });
    } catch {
      // skip corrupt files
    }
  }
  console.log(`Loaded ${episodes.length} episodes`);
  return episodes;
}

// ---- Transcript Searching ----

function searchTranscripts(candidateName, episodes) {
  const nameLower = candidateName.toLowerCase();
  // Quick check: if the name doesn't appear in the full text at all, skip
  const matchingEpisodes = episodes.filter(ep => ep.fullTextLower.includes(nameLower));
  if (matchingEpisodes.length === 0) return [];

  // Build regex with word boundaries for more precise matching
  const escaped = candidateName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`\\b${escaped}\\b`, 'i');

  const results = [];
  for (const ep of matchingEpisodes) {
    const mentions = [];
    for (const seg of ep.segments) {
      if (regex.test(seg.text)) {
        mentions.push({
          start_ms: seg.start_ms,
          end_ms: seg.end_ms,
          context: seg.text,
        });
      }
    }
    if (mentions.length > 0) {
      results.push({ episode_id: ep.id, mentions });
    }
  }
  return results;
}

// ---- LLM Verification ----

function openaiVerifyBatch(items) {
  // Each item: { name, category, address, context }
  // We ask the LLM to verify each match
  const prompt = items.map((item, i) =>
    `${i + 1}. Name: "${item.name}" (${item.category} at ${item.address || 'San Francisco'})\n   Transcript: "${item.context}"\n   Is the speaker referring to this specific place?`
  ).join('\n\n');

  const body = JSON.stringify({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: `You are verifying whether transcript excerpts from a San Francisco radio show ("Roll Over Easy") are referring to specific businesses or places.

For each numbered item, reply with ONLY the number followed by YES or NO and a brief reason.

Rules:
- YES if the speaker is clearly referring to that specific place (by name, location, or context)
- NO if it's a coincidental word match, a person's name, a different place, or ambiguous
- When in doubt, say NO

Example response:
1. YES — they mention the coffee shop by name and its Valencia St location
2. NO — "ritual" here means "daily ritual", not the coffee shop
3. YES — discussing the park's playground specifically`,
      },
      { role: 'user', content: prompt },
    ],
    temperature: 0,
    max_tokens: 1500,
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const content = json.choices?.[0]?.message?.content || '';
          // Parse "1. YES — reason" lines
          const verdicts = [];
          for (const line of content.split('\n')) {
            const match = line.match(/^(\d+)\.\s*(YES|NO)/i);
            if (match) {
              verdicts.push({
                index: parseInt(match[1]) - 1,
                verified: match[2].toUpperCase() === 'YES',
                reason: line.replace(/^\d+\.\s*(YES|NO)\s*[-—]?\s*/i, '').trim(),
              });
            }
          }
          resolve(verdicts);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---- Main ----

async function main() {
  if (!fs.existsSync(CANDIDATES_PATH)) {
    console.error('candidates/all.json not found — run merge-candidates.js first');
    process.exit(1);
  }

  const { candidates } = JSON.parse(fs.readFileSync(CANDIDATES_PATH, 'utf8'));
  console.log(`${candidates.length} candidates to cross-reference`);

  const episodes = loadTranscripts();

  // Load checkpoint if resuming
  let processed = new Set();
  let matches = [];
  if (RESUME && fs.existsSync(CHECKPOINT_PATH)) {
    const cp = JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf8'));
    processed = new Set(cp.processed || []);
    matches = cp.matches || [];
    console.log(`Resuming — ${processed.size} candidates already processed, ${matches.length} matches found`);
  }

  // Phase 1: Text search
  console.log('\n--- Phase 1: Text search ---');
  const textMatches = []; // candidates with transcript hits
  let searched = 0;

  for (const candidate of candidates) {
    if (processed.has(candidate.normalizedName)) {
      searched++;
      continue;
    }

    const results = searchTranscripts(candidate.name, episodes);
    if (results.length > 0) {
      textMatches.push({ candidate, results });
    }

    searched++;
    if (searched % 500 === 0 || searched === candidates.length) {
      process.stdout.write(`\r  Searched: ${searched}/${candidates.length} — ${textMatches.length} with hits`);
    }
  }
  console.log(`\n  ${textMatches.length} candidates have transcript matches`);

  if (SKIP_VERIFY) {
    // Output all text matches without verification
    const allMatches = textMatches.map(({ candidate, results }) => ({
      name: candidate.name,
      lat: candidate.lat,
      lng: candidate.lng,
      address: candidate.address,
      source: candidate.source,
      sources: candidate.sources,
      category: candidate.category,
      confidence: 'text_match',
      episode_count: results.length,
      total_mentions: results.reduce((s, r) => s + r.mentions.length, 0),
      episodes: results,
    }));
    fs.writeFileSync(OUT_PATH, JSON.stringify({ matches: allMatches }, null, 2));
    console.log(`\nSaved ${allMatches.length} text matches to ${OUT_PATH} (unverified)`);
    return;
  }

  // Phase 2: LLM verification in batches
  console.log('\n--- Phase 2: LLM verification ---');
  const BATCH_SIZE = 10;
  let verified = 0;
  let verifiedYes = 0;

  for (let i = 0; i < textMatches.length; i += BATCH_SIZE) {
    const batch = textMatches.slice(i, i + BATCH_SIZE);

    // Build verification items — use the first mention's context for each candidate
    const items = batch.map(({ candidate, results }) => ({
      name: candidate.name,
      category: candidate.category,
      address: candidate.address,
      context: results[0].mentions[0].context,
    }));

    try {
      const verdicts = await openaiVerifyBatch(items);

      for (const verdict of verdicts) {
        if (verdict.index >= 0 && verdict.index < batch.length && verdict.verified) {
          const { candidate, results } = batch[verdict.index];
          matches.push({
            name: candidate.name,
            lat: candidate.lat,
            lng: candidate.lng,
            address: candidate.address,
            source: candidate.source,
            sources: candidate.sources,
            category: candidate.category,
            confidence: 'llm_verified',
            episode_count: results.length,
            total_mentions: results.reduce((s, r) => s + r.mentions.length, 0),
            episodes: results,
          });
          verifiedYes++;
        }
      }
    } catch (err) {
      console.error(`\n  Batch error: ${err.message}`);
    }

    // Mark batch as processed
    for (const { candidate } of batch) {
      processed.add(candidate.normalizedName);
    }

    verified += batch.length;
    process.stdout.write(`\r  Verified: ${verified}/${textMatches.length} — ${verifiedYes} confirmed`);

    // Save checkpoint
    if (verified % 50 === 0 || verified >= textMatches.length) {
      fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify({
        processed: [...processed],
        matches,
      }, null, 2));
    }

    await sleep(200); // rate limit
  }

  console.log(`\n\n  ${verifiedYes} verified matches out of ${textMatches.length} text matches`);

  // Write final output
  fs.writeFileSync(OUT_PATH, JSON.stringify({ matches }, null, 2));
  console.log(`Saved ${matches.length} verified places to ${OUT_PATH}`);

  // Clean up checkpoint
  if (fs.existsSync(CHECKPOINT_PATH)) fs.unlinkSync(CHECKPOINT_PATH);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
```

- [ ] **Step 2: Run a quick test with `--skip-verify` to check text matching**

```bash
node scripts/cross-reference-candidates.js --skip-verify
```

Expected: Searches all transcripts for each candidate, outputs `scripts/verified_places.json` with text matches (no LLM verification). Check output:

```bash
node -e "const d = require('./scripts/verified_places.json'); console.log('Matches:', d.matches.length); console.log('Top 5:', d.matches.sort((a,b) => b.episode_count - a.episode_count).slice(0,5).map(m => m.name + ' (' + m.episode_count + ' eps)'))"
```

- [ ] **Step 3: Run full cross-reference with LLM verification**

```bash
OPENAI_API_KEY=... node scripts/cross-reference-candidates.js
```

Expected: Text search phase runs first, then LLM verification on matches. Saves `scripts/verified_places.json` with `confidence: "llm_verified"` entries. This may take a few minutes depending on how many text matches need verification.

- [ ] **Step 4: Commit**

```bash
git add scripts/cross-reference-candidates.js
git commit -m "feat: add cross-reference script to match candidates against transcripts"
```

---

### Task 7: Seed verified places to D1 (`scripts/seed-verified-places.js`)

**Files:**
- Create: `scripts/seed-verified-places.js`

**Context:** This follows the exact same pattern as the existing `seed-business-places.js`. It reads `verified_places.json`, inserts new places (with geocoding for any missing coordinates), and adds place_mentions links. Uses wrangler CLI for D1 access. Batches of 20 to avoid SQL variable limits.

- [ ] **Step 1: Write the seed script**

```js
#!/usr/bin/env node
/**
 * seed-verified-places.js
 *
 * Reads verified_places.json and seeds confirmed matches into
 * the D1 places + place_mentions tables.
 *
 * Geocodes addresses via Nominatim for places missing lat/lng.
 *
 * Usage:
 *   node scripts/seed-verified-places.js [--dry-run]
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERIFIED_PATH = path.join(__dirname, 'verified_places.json');
const DRY_RUN = process.argv.includes('--dry-run');

// Strip CLOUDFLARE_API_TOKEN so wrangler uses its OAuth login
const wranglerEnv = { ...process.env };
delete wranglerEnv.CLOUDFLARE_API_TOKEN;

function d1(sql) {
  if (DRY_RUN) { console.log('  [dry-run] SQL:', sql.substring(0, 120)); return [{ results: [] }]; }
  const result = execSync(
    `npx wrangler d1 execute roe-episodes --remote --json --command=${JSON.stringify(sql)}`,
    { cwd: path.join(__dirname, '..', 'roe-search'), env: wranglerEnv }
  );
  return JSON.parse(result.toString());
}

// SF bounding box for Nominatim
const SF_BOUNDS = { south: 37.703, north: 37.812, west: -122.527, east: -122.348 };

function geocode(address) {
  return new Promise((resolve, reject) => {
    const q = encodeURIComponent(address + ', San Francisco, CA');
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${q}&viewbox=${SF_BOUNDS.west},${SF_BOUNDS.north},${SF_BOUNDS.east},${SF_BOUNDS.south}&bounded=1&limit=1`;
    https.get(url, { headers: { 'User-Agent': 'roe-episode-search/1.0' } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const results = JSON.parse(data);
          if (results.length > 0) {
            resolve({ lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) });
          } else {
            resolve(null);
          }
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  if (!fs.existsSync(VERIFIED_PATH)) {
    console.error('verified_places.json not found — run cross-reference-candidates.js first');
    process.exit(1);
  }

  const { matches } = JSON.parse(fs.readFileSync(VERIFIED_PATH, 'utf8'));
  console.log(`${matches.length} verified places to seed`);

  // Fetch existing places from D1
  const existingRows = d1('SELECT id, name, LOWER(name) as lower_name FROM places');
  const existingNames = new Map();
  for (const row of (existingRows[0]?.results || [])) {
    existingNames.set(row.lower_name, row.id);
  }
  console.log(`${existingNames.size} existing places in D1`);

  const toInsert = [];
  const toLink = []; // { placeId (or null for new), name, episodeIds }
  let alreadyExisted = 0;

  for (const match of matches) {
    const lowerName = match.name.toLowerCase();
    const episodeIds = match.episodes.map(e => e.episode_id);

    if (existingNames.has(lowerName)) {
      alreadyExisted++;
      toLink.push({ placeId: existingNames.get(lowerName), episodeIds });
    } else {
      toInsert.push(match);
    }
  }

  console.log(`${alreadyExisted} already in places, ${toInsert.length} new to insert`);

  // Geocode places missing coordinates
  const geocoded = [];
  let needsGeocode = toInsert.filter(m => !m.lat || !m.lng);
  let hasCoords = toInsert.filter(m => m.lat && m.lng);

  console.log(`${hasCoords.length} have coordinates, ${needsGeocode.length} need geocoding`);

  for (const match of hasCoords) {
    geocoded.push({
      name: match.name,
      lat: match.lat,
      lng: match.lng,
      episodeIds: match.episodes.map(e => e.episode_id),
    });
  }

  if (!DRY_RUN && needsGeocode.length > 0) {
    console.log(`\nGeocoding ${needsGeocode.length} places (1 req/sec for Nominatim)...`);
    for (let i = 0; i < needsGeocode.length; i++) {
      const match = needsGeocode[i];
      const searchTerm = match.address || match.name;
      try {
        const coords = await geocode(searchTerm);
        if (coords) {
          geocoded.push({
            name: match.name,
            lat: coords.lat,
            lng: coords.lng,
            episodeIds: match.episodes.map(e => e.episode_id),
          });
        } else {
          console.log(`\n  Could not geocode: ${match.name}`);
        }
        await sleep(1100);
      } catch (err) {
        console.error(`\n  Geocode error for ${match.name}: ${err.message}`);
      }
      if ((i + 1) % 10 === 0) process.stdout.write(`\r  Geocoded: ${i + 1}/${needsGeocode.length}`);
    }
    console.log('');
  }

  if (DRY_RUN) {
    console.log('\n[dry-run] Would insert:');
    for (const g of geocoded.slice(0, 20)) {
      console.log(`  ${g.name} (${g.lat}, ${g.lng}) — ${g.episodeIds.length} episodes`);
    }
    if (geocoded.length > 20) console.log(`  ... and ${geocoded.length - 20} more`);
    console.log(`\nWould add ${toLink.reduce((s, l) => s + l.episodeIds.length, 0)} mention links for existing places`);
    return;
  }

  // Insert new places in batches
  console.log('\nInserting new places into D1...');
  const BATCH = 20;
  let inserted = 0;
  for (let i = 0; i < geocoded.length; i += BATCH) {
    const chunk = geocoded.slice(i, i + BATCH);
    const values = chunk.map(p =>
      `(${JSON.stringify(p.name)}, ${p.lat}, ${p.lng})`
    ).join(', ');
    try {
      d1(`INSERT OR IGNORE INTO places (name, lat, lng) VALUES ${values}`);
    } catch (err) {
      console.error(`  Insert error: ${err.message}`);
    }
    inserted += chunk.length;
    process.stdout.write(`\r  Places: ${inserted}/${geocoded.length}`);
  }
  console.log('');

  // Fetch all place IDs (existing + new)
  const allRows = d1('SELECT id, LOWER(name) as lower_name FROM places');
  const nameToId = new Map();
  for (const row of (allRows[0]?.results || [])) {
    nameToId.set(row.lower_name, row.id);
  }

  // Build all mention pairs
  const mentionPairs = [];
  for (const link of toLink) {
    for (const eid of link.episodeIds) {
      mentionPairs.push([link.placeId, eid]);
    }
  }
  for (const g of geocoded) {
    const placeId = nameToId.get(g.name.toLowerCase());
    if (!placeId) continue;
    for (const eid of g.episodeIds) {
      mentionPairs.push([placeId, eid]);
    }
  }

  console.log(`Inserting ${mentionPairs.length} place_mentions...`);
  let mInserted = 0;
  for (let i = 0; i < mentionPairs.length; i += BATCH) {
    const chunk = mentionPairs.slice(i, i + BATCH);
    const values = chunk.map(([pid, eid]) =>
      `(${pid}, ${JSON.stringify(eid)})`
    ).join(', ');
    try {
      d1(`INSERT OR IGNORE INTO place_mentions (place_id, episode_id) VALUES ${values}`);
    } catch {
      // episode may not exist in DB yet; skip
    }
    mInserted += chunk.length;
    process.stdout.write(`\r  Mentions: ${mInserted}/${mentionPairs.length}`);
  }
  console.log('\nDone!');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
```

- [ ] **Step 2: Dry run to verify logic**

```bash
node scripts/seed-verified-places.js --dry-run
```

Expected: Shows what would be inserted without modifying D1.

- [ ] **Step 3: Run for real**

```bash
node scripts/seed-verified-places.js
```

Expected: Inserts new places and mention links into D1. Verify with:

```bash
npx wrangler d1 execute roe-episodes --remote --json --command="SELECT COUNT(*) as c FROM places" 2>/dev/null
npx wrangler d1 execute roe-episodes --remote --json --command="SELECT COUNT(*) as c FROM place_mentions" 2>/dev/null
```

- [ ] **Step 4: Commit**

```bash
git add scripts/seed-verified-places.js
git commit -m "feat: add seed script for verified places from enrichment pipeline"
```

---

### Task 8: Clean up existing false positives (`scripts/cleanup-places.js`)

**Files:**
- Create: `scripts/cleanup-places.js`

**Context:** The existing 1,264 places in D1 include false positives like "Anthony", "Lyft", "Rogue", and "Irving". This script fetches all places, checks each against the stoplist and runs borderline cases through GPT-4o-mini for re-verification, then outputs a report. With `--apply`, it deletes flagged places from D1.

- [ ] **Step 1: Write the cleanup script**

```js
#!/usr/bin/env node
/**
 * cleanup-places.js
 *
 * Re-verifies existing D1 places and removes false positives.
 * Checks against stoplist first, then uses GPT-4o-mini for borderline cases.
 *
 * Usage:
 *   OPENAI_API_KEY=... node scripts/cleanup-places.js [--apply]
 *
 *   Without --apply: generates cleanup_report.json (dry run)
 *   With --apply: deletes flagged places from D1
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = path.join(__dirname, 'cleanup_report.json');
const TRANSCRIPTS_DIR = path.join(__dirname, '..', 'transcripts');
const APPLY = process.argv.includes('--apply');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) { console.error('OPENAI_API_KEY required'); process.exit(1); }

// Strip CLOUDFLARE_API_TOKEN so wrangler uses its OAuth login
const wranglerEnv = { ...process.env };
delete wranglerEnv.CLOUDFLARE_API_TOKEN;

function d1(sql) {
  const result = execSync(
    `npx wrangler d1 execute roe-episodes --remote --json --command=${JSON.stringify(sql)}`,
    { cwd: path.join(__dirname, '..', 'roe-search'), env: wranglerEnv }
  );
  return JSON.parse(result.toString());
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Same stoplist as merge-candidates.js — places with these names are almost
// certainly false positives from the original GPT extraction.
const STOPLIST = new Set([
  'the page', 'amber', 'grace', 'maven', 'slate', 'the social',
  'the vault', 'the mint', 'urban', 'nova', 'the ramp', 'sage',
  'the corner', 'local', 'the plant', 'the mill', 'the grove',
  'the square', 'bon', 'reed', 'the den', 'the net', 'rogue',
  'the marsh', 'the line', 'the center', 'the shop', 'the bar',
  'haven', 'the hall', 'the bay', 'native', 'pearl', 'the start',
  'standard', 'the independent', 'the market', 'noble', 'anthony',
  'irving', 'lyft', 'uber', 'meta', 'stripe',
]);

// Places with high episode counts that are obviously real SF places.
// Skip LLM verification for these to save API calls.
const KNOWN_GOOD = new Set([
  'mission district', 'dolores park', 'ocean beach', 'golden gate park',
  'twin peaks', 'bernal hill', 'market street', 'valencia street',
  'ferry building', 'castro', 'haight-ashbury', 'the sunset',
  'inner richmond', 'outer richmond', 'dogpatch', 'soma',
  'tenderloin', 'civic center', 'north beach', 'chinatown',
  'presidio', 'lands end', 'baker beach', 'coit tower',
  'transamerica pyramid', 'sutro tower', 'alamo square',
]);

function loadTranscriptContext(placeName) {
  // Search local transcripts for a sample mention of this place
  const nameLower = placeName.toLowerCase();
  const files = fs.readdirSync(TRANSCRIPTS_DIR).filter(f => f.endsWith('.json'));

  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(TRANSCRIPTS_DIR, file), 'utf8'));
      for (const seg of (data.segments || [])) {
        if (seg.text.toLowerCase().includes(nameLower)) {
          return { episodeId: path.basename(file, '.json'), context: seg.text };
        }
      }
    } catch { continue; }
  }
  return null;
}

function openaiVerifyBatch(items) {
  const prompt = items.map((item, i) =>
    `${i + 1}. Name: "${item.name}" (${item.episodeCount} episodes)\n   Transcript: "${item.context}"\n   Is this a real San Francisco place (not a person's name, company, or common word)?`
  ).join('\n\n');

  const body = JSON.stringify({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: `You are cleaning up a database of San Francisco places mentioned on a local radio show. Some entries are false positives — person names, company names, or common words that aren't actual SF locations.

For each item, reply with the number followed by KEEP or REMOVE and a brief reason.
- KEEP: It's a real SF place (park, restaurant, bar, street, neighborhood, landmark, venue, etc.)
- REMOVE: It's a person's name, a non-SF company, a common word, or not a place at all`,
      },
      { role: 'user', content: prompt },
    ],
    temperature: 0,
    max_tokens: 1500,
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const content = json.choices?.[0]?.message?.content || '';
          const verdicts = [];
          for (const line of content.split('\n')) {
            const match = line.match(/^(\d+)\.\s*(KEEP|REMOVE)/i);
            if (match) {
              verdicts.push({
                index: parseInt(match[1]) - 1,
                keep: match[2].toUpperCase() === 'KEEP',
                reason: line.replace(/^\d+\.\s*(KEEP|REMOVE)\s*[-—]?\s*/i, '').trim(),
              });
            }
          }
          resolve(verdicts);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  console.log('Fetching all places from D1...');
  const placesResult = d1('SELECT p.id, p.name, COUNT(pm.episode_id) as ep_count FROM places p LEFT JOIN place_mentions pm ON pm.place_id = p.id GROUP BY p.id ORDER BY ep_count DESC');
  const places = placesResult[0]?.results || [];
  console.log(`${places.length} places in D1\n`);

  const toRemove = [];
  const toVerify = [];
  let kept = 0;

  // Phase 1: Stoplist check
  for (const place of places) {
    const lower = place.name.toLowerCase();
    if (STOPLIST.has(lower)) {
      toRemove.push({ id: place.id, name: place.name, episodes: place.ep_count, reason: 'stoplist' });
    } else if (KNOWN_GOOD.has(lower)) {
      kept++;
    } else if (place.name.length <= 2) {
      toRemove.push({ id: place.id, name: place.name, episodes: place.ep_count, reason: 'too short' });
    } else {
      toVerify.push(place);
    }
  }

  console.log(`Stoplist removals: ${toRemove.length}`);
  console.log(`Known good (skipped): ${kept}`);
  console.log(`Need LLM verification: ${toVerify.length}`);

  // Phase 2: LLM verification for borderline cases
  const BATCH_SIZE = 10;
  let verified = 0;

  for (let i = 0; i < toVerify.length; i += BATCH_SIZE) {
    const batch = toVerify.slice(i, i + BATCH_SIZE);
    const items = [];

    for (const place of batch) {
      const ctx = loadTranscriptContext(place.name);
      items.push({
        name: place.name,
        episodeCount: place.ep_count,
        context: ctx?.context || '(no transcript context found)',
      });
    }

    try {
      const verdicts = await openaiVerifyBatch(items);
      for (const v of verdicts) {
        if (v.index >= 0 && v.index < batch.length && !v.keep) {
          const place = batch[v.index];
          toRemove.push({ id: place.id, name: place.name, episodes: place.ep_count, reason: v.reason });
        }
      }
    } catch (err) {
      console.error(`  Batch error: ${err.message}`);
    }

    verified += batch.length;
    process.stdout.write(`\r  Verified: ${verified}/${toVerify.length}`);
    await sleep(200);
  }

  console.log(`\n\nTotal to remove: ${toRemove.length}`);

  // Write report
  toRemove.sort((a, b) => b.episodes - a.episodes);
  fs.writeFileSync(REPORT_PATH, JSON.stringify({ toRemove, total: toRemove.length }, null, 2));
  console.log(`Report saved to ${REPORT_PATH}`);

  if (!APPLY) {
    console.log('\nTop removals:');
    for (const r of toRemove.slice(0, 20)) {
      console.log(`  ${r.name} (${r.episodes} eps) — ${r.reason}`);
    }
    console.log('\nRun with --apply to delete from D1');
    return;
  }

  // Apply deletions
  console.log('\nDeleting from D1...');
  const BATCH = 20;
  for (let i = 0; i < toRemove.length; i += BATCH) {
    const chunk = toRemove.slice(i, i + BATCH);
    const ids = chunk.map(r => r.id).join(', ');
    try {
      d1(`DELETE FROM place_mentions WHERE place_id IN (${ids})`);
      d1(`DELETE FROM places WHERE id IN (${ids})`);
    } catch (err) {
      console.error(`  Delete error: ${err.message}`);
    }
    process.stdout.write(`\r  Deleted: ${Math.min(i + BATCH, toRemove.length)}/${toRemove.length}`);
  }
  console.log('\nDone!');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
```

- [ ] **Step 2: Run dry run (no --apply) and review the report**

```bash
OPENAI_API_KEY=... node scripts/cleanup-places.js
```

Expected: Generates `scripts/cleanup_report.json` listing places to remove with reasons. Review the report before applying:

```bash
node -e "const r = require('./scripts/cleanup_report.json'); console.log('Total to remove:', r.total); r.toRemove.slice(0, 20).forEach(p => console.log('  ' + p.name + ' (' + p.episodes + ' eps) — ' + p.reason))"
```

- [ ] **Step 3: Apply deletions (after reviewing report)**

```bash
OPENAI_API_KEY=... node scripts/cleanup-places.js --apply
```

Expected: Deletes flagged places and their mentions from D1.

- [ ] **Step 4: Commit**

```bash
git add scripts/cleanup-places.js
git commit -m "feat: add cleanup script to remove false positive places from D1"
```

---

### Task 9: Add data files to .gitignore and final commit

**Files:**
- Modify: `.gitignore`

**Context:** The fetched candidate data, checkpoints, and reports are generated files. They should not be committed. The scripts themselves are committed.

- [ ] **Step 1: Add data patterns to .gitignore**

Add these lines to `.gitignore`:

```
# Map enrichment pipeline data (generated)
scripts/candidates/*.json
scripts/candidates/.*.json
scripts/verified_places.json
scripts/cleanup_report.json
scripts/.crossref-checkpoint.json
```

Note: do NOT gitignore `scripts/candidates/merge-candidates.js`, `scripts/candidates/merge-candidates.test.js`, or any other `.js` files.

- [ ] **Step 2: Remove .gitkeep if it exists**

```bash
rm -f scripts/candidates/.gitkeep
```

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore: gitignore generated data files from map enrichment pipeline"
```

---

### Task 10: End-to-end verification

- [ ] **Step 1: Run the full pipeline end-to-end**

```bash
# 1. Fetch from all sources (DataSF and OSM don't need API keys)
node scripts/candidates/fetch-datasf.js
node scripts/candidates/fetch-osm.js
# Yelp requires API key:
YELP_API_KEY=... node scripts/candidates/fetch-yelp.js

# 2. Merge and dedup
node scripts/candidates/merge-candidates.js

# 3. Cross-reference (skip-verify first to check text matching)
node scripts/cross-reference-candidates.js --skip-verify

# 4. Full cross-reference with LLM verification
OPENAI_API_KEY=... node scripts/cross-reference-candidates.js

# 5. Seed to D1
node scripts/seed-verified-places.js --dry-run  # review first
node scripts/seed-verified-places.js             # then for real

# 6. Clean up existing false positives
OPENAI_API_KEY=... node scripts/cleanup-places.js          # review report
OPENAI_API_KEY=... node scripts/cleanup-places.js --apply  # then apply
```

- [ ] **Step 2: Verify results in D1**

```bash
npx wrangler d1 execute roe-episodes --remote --json --command="SELECT COUNT(*) as places FROM places" 2>/dev/null
npx wrangler d1 execute roe-episodes --remote --json --command="SELECT COUNT(*) as mentions FROM place_mentions" 2>/dev/null
npx wrangler d1 execute roe-episodes --remote --json --command="SELECT p.name, COUNT(pm.episode_id) as eps FROM places p JOIN place_mentions pm ON pm.place_id = p.id GROUP BY p.id ORDER BY eps DESC LIMIT 20" 2>/dev/null
```

Expected: Place count should be higher than 1,264 (new places added), mention count higher than 5,718 (new links), and false positives like "Anthony" and "Lyft" should be gone.

- [ ] **Step 3: Check the live map**

Open `https://rollovereasy.org/map` and verify more dots appear on the map. The map frontend reads from `/api/map-places` which queries D1, so no deploy is needed.

- [ ] **Step 4: Run tests one final time**

```bash
node --test scripts/candidates/merge-candidates.test.js
```

Expected: All tests pass.
