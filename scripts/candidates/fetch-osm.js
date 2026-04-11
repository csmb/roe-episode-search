#!/usr/bin/env node
/**
 * fetch-osm.js
 *
 * Fetches parks, trails, landmarks, transit, cultural venues, and natural
 * features from OpenStreetMap via the Overpass API.
 *
 * No API key required.
 *
 * Usage:
 *   node scripts/candidates/fetch-osm.js
 */

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, 'osm.json');

const OVERPASS_HOST = 'overpass-api.de';
const OVERPASS_PATH = '/api/interpreter';

// SF bounding box: south,west,north,east (Overpass format)
const SF_BBOX = '37.703,-122.527,37.812,-122.348';

// Delay between Overpass queries to respect rate limits
const QUERY_DELAY_MS = 5000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Overpass QL query definitions: [label, category, ql_body]
const QUERIES = [
  {
    label: 'Parks & Gardens',
    category: 'park',
    // Named ways, relations, and nodes tagged as parks or gardens
    ql: `
[out:json][timeout:60];
(
  way["leisure"="park"]["name"](${SF_BBOX});
  relation["leisure"="park"]["name"](${SF_BBOX});
  node["leisure"="park"]["name"](${SF_BBOX});
  way["leisure"="garden"]["name"](${SF_BBOX});
  relation["leisure"="garden"]["name"](${SF_BBOX});
  node["leisure"="garden"]["name"](${SF_BBOX});
);
out center;
    `.trim(),
  },
  {
    label: 'Trails & Paths',
    category: 'trail',
    ql: `
[out:json][timeout:60];
(
  way["highway"="path"]["name"](${SF_BBOX});
  way["highway"="footway"]["name"](${SF_BBOX});
  way["highway"="steps"]["name"](${SF_BBOX});
  relation["route"="hiking"]["name"](${SF_BBOX});
);
out center;
    `.trim(),
  },
  {
    label: 'Landmarks & Historic',
    category: 'landmark',
    ql: `
[out:json][timeout:60];
(
  node["historic"]["name"](${SF_BBOX});
  way["historic"]["name"](${SF_BBOX});
  node["tourism"="attraction"]["name"](${SF_BBOX});
  way["tourism"="attraction"]["name"](${SF_BBOX});
  node["tourism"="viewpoint"]["name"](${SF_BBOX});
  way["tourism"="viewpoint"]["name"](${SF_BBOX});
);
out center;
    `.trim(),
  },
  {
    label: 'Transit Stations',
    category: 'transit',
    ql: `
[out:json][timeout:60];
(
  node["railway"="station"]["name"](${SF_BBOX});
  node["station"="subway"]["name"](${SF_BBOX});
  node["public_transport"="stop_position"]["name"]["network"~"BART|Muni"](${SF_BBOX});
  node["railway"="tram_stop"]["name"](${SF_BBOX});
);
out center;
    `.trim(),
  },
  {
    label: 'Cultural Venues',
    category: 'cultural',
    ql: `
[out:json][timeout:60];
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
out center;
    `.trim(),
  },
  {
    label: 'Beaches & Natural',
    category: 'natural',
    ql: `
[out:json][timeout:60];
(
  node["natural"="beach"]["name"](${SF_BBOX});
  way["natural"="beach"]["name"](${SF_BBOX});
  node["natural"="peak"]["name"](${SF_BBOX});
  way["natural"="peak"]["name"](${SF_BBOX});
  node["natural"="cliff"]["name"](${SF_BBOX});
  way["natural"="cliff"]["name"](${SF_BBOX});
);
out center;
    `.trim(),
  },
];

function overpassPost(queryBody) {
  return new Promise((resolve, reject) => {
    const postData = `data=${encodeURIComponent(queryBody)}`;
    const options = {
      hostname: OVERPASS_HOST,
      path: OVERPASS_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': 'roe-episode-search/1.0',
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
          resolve({ status: res.statusCode, body: { elements: [] } });
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function getCoords(element) {
  // Nodes have lat/lon directly; ways/relations have a center from `out center`
  if (element.type === 'node') {
    return { lat: element.lat, lng: element.lon };
  }
  if (element.center) {
    return { lat: element.center.lat, lng: element.center.lon };
  }
  return { lat: null, lng: null };
}

function mapCandidate(element, category) {
  const tags = element.tags || {};
  const name = tags.name || '';
  const { lat, lng } = getCoords(element);

  // Build a clean address from addr:* tags when available
  const addressParts = [
    tags['addr:housenumber'] && tags['addr:street']
      ? `${tags['addr:housenumber']} ${tags['addr:street']}`
      : tags['addr:street'] || null,
    tags['addr:city'] || null,
  ].filter(Boolean);

  return {
    name,
    address: addressParts.join(', ') || null,
    lat,
    lng,
    source: 'osm',
    category,
    meta: {
      osm_id: element.id,
      osm_type: element.type,
      tags: { ...tags },
    },
  };
}

async function main() {
  console.log('Fetching SF POIs from OpenStreetMap Overpass API...');
  console.log(`SF bounding box: ${SF_BBOX}`);
  console.log(`${QUERY_DELAY_MS / 1000}s delay between queries\n`);

  // Deduplicate by lowercase name across all categories
  const seen = new Map(); // lowercase name → candidate
  let totalElements = 0;

  for (let i = 0; i < QUERIES.length; i++) {
    const { label, category, ql } = QUERIES[i];

    if (i > 0) {
      process.stdout.write(`  Waiting ${QUERY_DELAY_MS / 1000}s before next query...`);
      await sleep(QUERY_DELAY_MS);
      process.stdout.write('\r' + ' '.repeat(60) + '\r');
    }

    process.stdout.write(`[${i + 1}/${QUERIES.length}] ${label}... `);

    const { status, body } = await overpassPost(ql);

    if (status !== 200) {
      console.log(`ERROR (HTTP ${status})`);
      console.error(`  Response: ${JSON.stringify(body).slice(0, 300)}`);
      continue;
    }

    const elements = body.elements || [];
    let added = 0;

    for (const element of elements) {
      const tags = element.tags || {};
      const name = (tags.name || '').trim();
      if (!name) continue;

      const key = name.toLowerCase();
      if (!seen.has(key)) {
        const candidate = mapCandidate(element, category);
        seen.set(key, candidate);
        added++;
      }
    }

    totalElements += elements.length;
    console.log(`${elements.length} elements, ${added} new unique (total: ${seen.size})`);
  }

  console.log(`\nTotal OSM elements across all queries: ${totalElements}`);
  console.log(`Unique named POIs (deduped by name): ${seen.size}`);

  const candidates = [...seen.values()];
  const output = {
    candidates,
    fetched_at: new Date().toISOString(),
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));
  console.log(`Saved ${candidates.length} candidates to ${OUT_PATH}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
