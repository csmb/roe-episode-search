#!/usr/bin/env node
/**
 * merge-candidates.js
 *
 * Reads yelp.json, datasf.json, and osm.json from the same directory,
 * normalizes names, deduplicates across sources, filters stoplist words,
 * and outputs all.json.
 *
 * Usage:
 *   node scripts/candidates/merge-candidates.js
 *
 * Exported functions (for testing):
 *   normalizeName(name)
 *   shouldFilter(candidate)
 *   deduplicateCandidates(candidates)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Stoplist — generic/ambiguous words that aren't usable place names
// ---------------------------------------------------------------------------

const STOPLIST = new Set([
  'the page', 'amber', 'grace', 'maven', 'slate', 'the social', 'the vault',
  'the mint', 'urban', 'nova', 'the ramp', 'sage', 'the corner', 'local',
  'the plant', 'the mill', 'the grove', 'the square', 'bon', 'reed',
  'the den', 'the net', 'rogue', 'the marsh', 'the line', 'the center',
  'the shop', 'the bar', 'haven', 'the hall', 'the bay', 'native', 'pearl',
  'the start', 'standard', 'the independent', 'the market', 'noble',
  'anthony', 'irving', 'lyft', 'uber', 'meta', 'stripe',
]);

// ---------------------------------------------------------------------------
// Business suffixes to strip from the end of a name
// Each pattern matches the suffix optionally followed by a period,
// anchored to the end of the string.
// ---------------------------------------------------------------------------

const SUFFIX_PATTERNS = [
  /\s+inc\.?$/i,
  /\s+llc\.?$/i,
  /\s+corp\.?$/i,
  /\s+co\.?$/i,
  /\s+ltd\.?$/i,
  /\s+lp\.?$/i,
  // Location suffixes
  /\s+sf\.?$/i,
  /\s+san\s+francisco\.?$/i,
];

// ---------------------------------------------------------------------------
// normalizeName(name)
//
// - Trim whitespace
// - Strip common business suffixes (case-insensitive, optional period)
// - Collapse multiple spaces to single
// - Lowercase
// ---------------------------------------------------------------------------

export function normalizeName(name) {
  if (!name) return '';
  let n = name.trim();

  // Strip each suffix pattern in order; repeat until no more match
  // (handles pathological cases like "Acme Inc LLC" though unlikely)
  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of SUFFIX_PATTERNS) {
      const next = n.replace(pattern, '');
      if (next !== n) {
        n = next;
        changed = true;
      }
    }
  }

  // Collapse multiple spaces, lowercase
  return n.replace(/\s+/g, ' ').trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// shouldFilter(candidate)
//
// Returns true (filter out) if:
//   - name is <= 2 characters
//   - name is purely numeric
//   - lowercase name is in STOPLIST
// ---------------------------------------------------------------------------

export function shouldFilter(candidate) {
  const name = candidate.name || '';
  if (name.length <= 2) return true;
  if (/^\d+$/.test(name)) return true;
  if (STOPLIST.has(name.toLowerCase())) return true;
  return false;
}

// ---------------------------------------------------------------------------
// deduplicateCandidates(candidates)
//
// Groups candidates by normalizedName and merges duplicates:
//   - tracks all sources as array
//   - merges categories array (unique values)
//   - prefers lat/lng from yelp or osm over datasf (which has null coords)
//
// Each merged candidate has:
//   name, normalizedName, address, lat, lng,
//   source (first), sources (array),
//   category (first), categories (array),
//   meta
// ---------------------------------------------------------------------------

export function deduplicateCandidates(candidates) {
  // Map from normalizedName → merged candidate
  const byName = new Map();

  for (const c of candidates) {
    const key = c.normalizedName;

    if (!byName.has(key)) {
      // First occurrence: clone and ensure sources/categories are arrays
      byName.set(key, {
        name: c.name,
        normalizedName: c.normalizedName,
        address: c.address,
        lat: c.lat,
        lng: c.lng,
        source: c.source,
        sources: Array.isArray(c.sources) ? [...c.sources] : [c.source],
        category: c.category,
        categories: Array.isArray(c.categories) ? [...c.categories] : [c.category].filter(Boolean),
        meta: c.meta,
      });
    } else {
      // Merge into existing entry
      const existing = byName.get(key);

      // Track sources (deduplicated)
      const incomingSources = Array.isArray(c.sources) ? c.sources : [c.source];
      for (const s of incomingSources) {
        if (s && !existing.sources.includes(s)) existing.sources.push(s);
      }

      // Merge categories (deduplicated)
      const incomingCategories = Array.isArray(c.categories) ? c.categories : [c.category].filter(Boolean);
      for (const cat of incomingCategories) {
        if (cat && !existing.categories.includes(cat)) existing.categories.push(cat);
      }

      // Prefer yelp/osm coords over datasf null coords
      if ((existing.lat === null || existing.lng === null) &&
          c.lat !== null && c.lng !== null) {
        existing.lat = c.lat;
        existing.lng = c.lng;
      }
    }
  }

  return [...byName.values()];
}

// ---------------------------------------------------------------------------
// CLI — only executed when run directly (not when imported)
// ---------------------------------------------------------------------------

const isMain = process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));

if (isMain) {
  const sourceFiles = [
    { key: 'yelp', file: 'yelp.json' },
    { key: 'datasf', file: 'datasf.json' },
    { key: 'osm', file: 'osm.json' },
  ];

  const sourceCounts = { yelp: 0, datasf: 0, osm: 0 };
  let allCandidates = [];

  for (const { key, file } of sourceFiles) {
    const filePath = path.join(__dirname, file);
    if (!fs.existsSync(filePath)) {
      console.log(`Skipping ${file} (not found)`);
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (err) {
      console.warn(`Warning: could not parse ${file}: ${err.message}`);
      continue;
    }

    const candidates = parsed.candidates || [];
    sourceCounts[key] = candidates.length;
    console.log(`${file}: ${candidates.length} candidates`);

    // Attach normalizedName and ensure sources/categories arrays before merging
    for (const c of candidates) {
      c.normalizedName = normalizeName(c.name);
      if (!c.sources) c.sources = [c.source];
      if (!c.categories) c.categories = [c.category].filter(Boolean);
    }

    allCandidates = allCandidates.concat(candidates);
  }

  console.log(`\nTotal before dedup: ${allCandidates.length}`);

  const deduped = deduplicateCandidates(allCandidates);
  console.log(`After dedup: ${deduped.length}`);

  const filtered = deduped.filter(c => !shouldFilter(c));
  console.log(`After stoplist filter: ${filtered.length}`);

  // Sort alphabetically by normalizedName
  filtered.sort((a, b) => a.normalizedName.localeCompare(b.normalizedName));

  const output = {
    candidates: filtered,
    merged_at: new Date().toISOString(),
    source_counts: sourceCounts,
  };

  const outPath = path.join(__dirname, 'all.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nSaved ${filtered.length} candidates to ${outPath}`);
}
