#!/usr/bin/env node
/**
 * fetch-datasf.js
 *
 * Fetches registered SF businesses from the DataSF Open Data (Socrata) API
 * and saves them as candidates for map enrichment.
 *
 * The g8m3-pdis dataset has business registrations with DBA names, addresses,
 * and dates — but no industry/NAICS codes. We pull all SF businesses active
 * since 2013 and let the cross-reference step filter to those actually
 * mentioned in the show.
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
  const where = [
    "location_start_date >= '2013-01-01T00:00:00.000'",
    "city = 'San Francisco'",
  ].join(' AND ');

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

async function main() {
  console.log('Fetching SF businesses from DataSF...');

  // Deduplicate by lowercase DBA name — keep first occurrence (most recent, due to ORDER BY DESC)
  const seen = new Map();
  let offset = 0;
  let pageNum = 0;
  let totalRows = 0;

  while (true) {
    process.stdout.write(`\r  Page ${pageNum + 1} (offset ${offset})... `);
    const rows = await fetchPage(offset);

    if (rows.length === 0) {
      console.log('\n  No more results.');
      break;
    }

    totalRows += rows.length;
    let pageAdded = 0;
    for (const row of rows) {
      const name = (row.dba_name || '').trim();
      if (!name) continue;

      const key = name.toLowerCase();
      if (!seen.has(key)) {
        seen.set(key, {
          name,
          address: [row.full_business_address, row.city, row.state].filter(Boolean).join(', '),
          lat: null,
          lng: null,
          source: 'datasf',
          category: 'business',
          meta: {
            start_date: row.location_start_date || row.dba_start_date || null,
            end_date: row.location_end_date || row.dba_end_date || null,
            uniqueid: row.uniqueid || null,
          },
        });
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

    await sleep(500);
  }

  console.log(`\nTotal rows fetched: ${totalRows}`);
  console.log(`Unique DBA names: ${seen.size}`);

  const candidates = [...seen.values()];
  fs.writeFileSync(OUT_PATH, JSON.stringify({ candidates, fetched_at: new Date().toISOString() }, null, 2));
  console.log(`Saved ${candidates.length} candidates to ${OUT_PATH}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
