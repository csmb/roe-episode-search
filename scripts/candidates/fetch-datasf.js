#!/usr/bin/env node
/**
 * fetch-datasf.js
 *
 * Fetches registered SF businesses from the DataSF Open Data (Socrata) API
 * and saves them as candidates for map enrichment.
 *
 * No API key required.
 *
 * Usage:
 *   node scripts/candidates/fetch-datasf.js
 */

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, 'datasf.json');

const API_HOST = 'data.sfgov.org';
const API_PATH = '/resource/g8m3-pdis.json';
const PAGE_SIZE = 50000;

// NAICS code prefix → category label
// Checked from most-specific to least-specific (longer prefix wins).
const NAICS_CATEGORY_MAP = [
  { prefix: '7225', category: 'restaurant' },  // Restaurants and Other Eating Places
  { prefix: '7224', category: 'bar' },          // Drinking Places (Alcoholic Beverages)
  { prefix: '7222', category: 'restaurant' },   // Limited-Service Eating Places
  { prefix: '7223', category: 'restaurant' },   // Special Food Services
  { prefix: '7211', category: 'hotel' },        // Traveler Accommodation
  { prefix: '445',  category: 'grocery' },      // Food and Beverage Stores
  { prefix: '71',   category: 'entertainment' },// Arts, Entertainment, and Recreation
  { prefix: '44',   category: 'retail' },       // Retail Trade
  { prefix: '45',   category: 'retail' },       // Retail Trade (cont.)
  { prefix: '72',   category: 'food_service' }, // Accommodation and Food Services (catch-all)
];

function naicsToCategory(naics) {
  if (!naics) return null;
  const code = String(naics).replace(/\D/g, '');
  // Sort by prefix length descending so longer (more specific) prefixes match first
  const sorted = [...NAICS_CATEGORY_MAP].sort((a, b) => b.prefix.length - a.prefix.length);
  for (const { prefix, category } of sorted) {
    if (code.startsWith(prefix)) return category;
  }
  return null;
}

function httpsGet(urlPath) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: API_HOST,
      path: urlPath,
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'roe-episode-search/1.0',
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: [] });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function fetchPage(offset) {
  // Filter: NAICS codes starting with 72 (food/accommodation), 71 (entertainment),
  // 44 or 45 (retail). In the g8m3-pdis Socrata dataset the field is `naics_code`.
  // We also check `lic_code_description` as an alternative code field.
  // business start date >= 2013, city = San Francisco.
  const where = [
    "(naics_code like '72%' OR naics_code like '71%' OR naics_code like '44%' OR naics_code like '45%'",
    "OR lic_code_description like '72%' OR lic_code_description like '71%' OR lic_code_description like '44%' OR lic_code_description like '45%')",
    "AND location_start_date >= '2013-01-01T00:00:00.000'",
    "AND city = 'San Francisco'",
  ].join(' ');

  const params = new URLSearchParams({
    '$limit': String(PAGE_SIZE),
    '$offset': String(offset),
    '$where': where,
    '$order': 'location_start_date DESC',
  });

  const urlPath = `${API_PATH}?${params}`;
  const { status, body } = await httpsGet(urlPath);

  if (status !== 200) {
    throw new Error(`DataSF API error ${status}: ${JSON.stringify(body).slice(0, 200)}`);
  }

  return Array.isArray(body) ? body : [];
}

function mapCandidate(row) {
  const name = (row.dba_name || row.business_name || '').trim();
  if (!name) return null;

  // Try numeric NAICS code first; fall back to the description field if present
  const naics = row.naics_code || row.lic_code_description || '';
  const category = naicsToCategory(naics);

  const addressParts = [
    row.full_business_address,
    row.city,
    row.business_zip,
  ].filter(Boolean);

  return {
    name,
    address: addressParts.join(', '),
    lat: null,    // DataSF business registrations don't include geocoordinates
    lng: null,
    source: 'datasf',
    category,
    meta: {
      naics_code: row.naics_code || null,
      lic_code: row.lic_code_description || null,
      start_date: row.location_start_date || row.dba_start_date || null,
      end_date: row.location_end_date || row.dba_end_date || null,
      uniqueid: row.uniqueid || null,
    },
  };
}

async function main() {
  console.log('Fetching SF businesses from DataSF...');

  // Deduplicate by lowercase DBA name — keep first occurrence (most recent, due to ORDER BY DESC)
  const seen = new Map(); // lowercase name → candidate
  let offset = 0;
  let pageNum = 0;

  while (true) {
    process.stdout.write(`\r  Page ${pageNum + 1} (offset ${offset})... `);
    const rows = await fetchPage(offset);

    if (rows.length === 0) {
      console.log('\n  No more results.');
      break;
    }

    let pageAdded = 0;
    for (const row of rows) {
      const candidate = mapCandidate(row);
      if (!candidate) continue;
      const key = candidate.name.toLowerCase();
      if (!seen.has(key)) {
        seen.set(key, candidate);
        pageAdded++;
      }
    }

    process.stdout.write(`got ${rows.length} rows, ${pageAdded} new unique`);
    offset += rows.length;
    pageNum++;

    if (rows.length < PAGE_SIZE) {
      console.log('\n  Last page reached.');
      break;
    }
  }

  console.log(`\nTotal unique businesses: ${seen.size}`);

  const candidates = [...seen.values()];
  const output = {
    candidates,
    fetched_at: new Date().toISOString(),
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));
  console.log(`Saved ${candidates.length} candidates to ${OUT_PATH}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
