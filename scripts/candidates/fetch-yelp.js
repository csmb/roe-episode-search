#!/usr/bin/env node
/**
 * fetch-yelp.js
 *
 * Fetches SF businesses from the Yelp Fusion API and saves them as candidates.
 *
 * Usage:
 *   YELP_API_KEY=... node scripts/candidates/fetch-yelp.js [--resume]
 *
 *   --resume   Skip categories already in .yelp-checkpoint.json
 */

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, 'yelp.json');
const CHECKPOINT_PATH = path.join(__dirname, '.yelp-checkpoint.json');

const YELP_API_KEY = process.env.YELP_API_KEY;
if (!YELP_API_KEY) { console.error('YELP_API_KEY required'); process.exit(1); }

const RESUME = process.argv.includes('--resume');

const CATEGORIES = [
  'restaurants',
  'bars',
  'coffee',
  'bakeries',
  'musicvenues',
  'bookstores',
  'grocery',
  'arts',
  'nightlife',
  'breakfast_brunch',
  'foodtrucks',
];

const PAGE_SIZE = 50;
const MAX_PER_CATEGORY = 1000;
const REQUEST_DELAY_MS = 200;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function yelpRequest(urlPath) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.yelp.com',
      path: urlPath,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${YELP_API_KEY}`,
        Accept: 'application/json',
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: {} });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function mapCandidate(biz, category) {
  const loc = biz.location || {};
  const coords = biz.coordinates || {};
  const addressParts = [
    loc.address1,
    loc.city,
    loc.state,
    loc.zip_code,
  ].filter(Boolean);

  return {
    name: biz.name || '',
    address: addressParts.join(', '),
    lat: coords.latitude ?? null,
    lng: coords.longitude ?? null,
    source: 'yelp',
    category,
    meta: {
      yelp_id: biz.id || '',
      rating: biz.rating ?? null,
      review_count: biz.review_count ?? null,
      categories: (biz.categories || []).map(c => c.alias),
    },
  };
}

function loadCheckpoint() {
  if (RESUME && fs.existsSync(CHECKPOINT_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf-8'));
    } catch {}
  }
  return { done: [], businesses: {} };
}

function saveCheckpoint(checkpoint) {
  fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(checkpoint, null, 2));
}

async function fetchCategory(category, checkpoint) {
  const seen = checkpoint.businesses;
  let offset = 0;
  let fetched = 0;

  console.log(`\nFetching category: ${category}`);

  while (offset < MAX_PER_CATEGORY) {
    const params = new URLSearchParams({
      location: 'San Francisco, CA',
      categories: category,
      limit: String(PAGE_SIZE),
      offset: String(offset),
      sort_by: 'review_count',
    });

    const urlPath = `/v3/businesses/search?${params}`;
    const { status, body } = await yelpRequest(urlPath);

    // Yelp returns ACCESS_LIMIT_REACHED when the daily quota is hit
    if (body.error && body.error.code === 'ACCESS_LIMIT_REACHED') {
      console.log(`\n  Access limit reached. Saving checkpoint and exiting.`);
      console.log(`  Run again tomorrow with --resume to continue.`);
      return false; // signal caller to abort
    }

    if (status !== 200 || !Array.isArray(body.businesses)) {
      console.log(`\n  Unexpected response (status ${status}): ${JSON.stringify(body).slice(0, 200)}`);
      break;
    }

    const businesses = body.businesses;
    if (businesses.length === 0) break;

    for (const biz of businesses) {
      if (biz.id && !seen[biz.id]) {
        seen[biz.id] = mapCandidate(biz, category);
      }
    }

    fetched += businesses.length;
    offset += businesses.length;
    process.stdout.write(`\r  ${category}: ${fetched} fetched, ${Object.keys(seen).length} unique total`);

    // Yelp caps at 1000 results per search
    if (offset >= (body.total || 0) || businesses.length < PAGE_SIZE) break;

    await sleep(REQUEST_DELAY_MS);
  }

  console.log('');
  return true; // success
}

async function main() {
  const checkpoint = loadCheckpoint();
  if (RESUME && checkpoint.done.length > 0) {
    console.log(`Resuming — ${checkpoint.done.length} categories already done: ${checkpoint.done.join(', ')}`);
  }

  for (const category of CATEGORIES) {
    if (checkpoint.done.includes(category)) {
      console.log(`Skipping ${category} (already done)`);
      continue;
    }

    const ok = await fetchCategory(category, checkpoint);
    if (!ok) {
      // Access limit hit — save checkpoint so user can resume tomorrow
      saveCheckpoint(checkpoint);
      process.exit(1);
    }

    checkpoint.done.push(category);
    saveCheckpoint(checkpoint);
  }

  // Build final output — filter out entries missing coordinates
  const all = Object.values(checkpoint.businesses);
  const candidates = all.filter(c => c.lat !== null && c.lng !== null);
  const dropped = all.length - candidates.length;

  const output = {
    candidates,
    fetched_at: new Date().toISOString(),
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\nSaved ${candidates.length} candidates to ${OUT_PATH}`);
  if (dropped > 0) console.log(`  (${dropped} dropped — missing lat/lng)`);

  // Clean up checkpoint on success
  if (fs.existsSync(CHECKPOINT_PATH)) fs.unlinkSync(CHECKPOINT_PATH);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
