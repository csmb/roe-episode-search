#!/usr/bin/env node
/**
 * seed-business-places.js
 *
 * Reads business_matches.json and merges confirmed matches into
 * the existing D1 places + place_mentions tables.
 *
 * Geocodes addresses via Nominatim (OSM) for businesses missing lat/lng.
 *
 * Usage:
 *   node scripts/seed-business-places.js [--dry-run]
 */

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { escapeSQL, runSQL, queryJSON } from './lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MATCHES_PATH = path.join(__dirname, 'business_matches.json');
const DRY_RUN = process.argv.includes('--dry-run');

function run(sql) {
	if (DRY_RUN) { console.log('  [dry-run] SQL:', sql.substring(0, 120)); return; }
	runSQL(sql);
}

function query(sql) {
	if (DRY_RUN) { console.log('  [dry-run] SQL:', sql.substring(0, 120)); return []; }
	return queryJSON(sql);
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

async function main() {
	if (!fs.existsSync(MATCHES_PATH)) {
		console.error('business_matches.json not found — run cross-reference.js first');
		process.exit(1);
	}

	const { matches } = JSON.parse(fs.readFileSync(MATCHES_PATH, 'utf8'));

	// Filter to high confidence and LLM-verified matches
	const confirmed = matches.filter(m =>
		m.confidence === 'high' || m.confidence === 'llm_verified'
	);
	console.log(`${confirmed.length} confirmed matches (${matches.length} total)`);

	// Fetch existing places from D1
	const existingRows = query('SELECT id, name, LOWER(name) as lower_name FROM places');
	const existingNames = new Map();
	for (const row of existingRows) {
		existingNames.set(row.lower_name, row.id);
	}
	console.log(`${existingNames.size} existing places in D1`);

	const toInsert = [];
	const toLink = []; // { placeId (or name for new), episodeIds }
	let alreadyExisted = 0;

	for (const match of confirmed) {
		const lowerName = match.normalized_name;
		const episodeIds = match.episodes.map(e => e.episode_id);

		if (existingNames.has(lowerName)) {
			// Place already exists — just add new mentions
			alreadyExisted++;
			toLink.push({ placeId: existingNames.get(lowerName), episodeIds });
		} else {
			// Need to geocode and insert
			toInsert.push(match);
		}
	}

	console.log(`${alreadyExisted} already in places, ${toInsert.length} new to insert`);

	// Geocode new places. Anything we can't geocode is skipped — never seed
	// fake city-center coordinates.
	const geocoded = [];
	let skipped = 0;
	if (DRY_RUN) {
		console.log('\n[dry-run] Skipping geocoding');
		for (const match of toInsert) {
			geocoded.push({
				name: match.dba_name,
				lat: 0, lng: 0,
				episodeIds: match.episodes.map(e => e.episode_id),
			});
		}
	} else {
		console.log(`\nGeocoding ${toInsert.length} new places (1 req/sec for Nominatim)...`);
		for (let i = 0; i < toInsert.length; i++) {
			const match = toInsert[i];
			let coords = null;

			if (match.address) {
				try {
					coords = await geocode(match.address);
					await new Promise(r => setTimeout(r, 1100));
				} catch (err) {
					console.error(`  Geocode error for ${match.dba_name}: ${err.message}`);
				}
			}

			if (!coords) {
				skipped++;
				console.log(`  Skipping ${match.dba_name} (${match.address ? 'geocode failed' : 'no address'})`);
				continue;
			}

			geocoded.push({
				name: match.dba_name,
				lat: coords.lat,
				lng: coords.lng,
				episodeIds: match.episodes.map(e => e.episode_id),
			});

			if ((i + 1) % 10 === 0 || i === toInsert.length - 1) {
				process.stdout.write(`\r  Geocoded: ${i + 1}/${toInsert.length} (${geocoded.length} found, ${skipped} skipped)`);
			}
		}
		console.log('');
		if (skipped > 0) {
			console.log(`  ${skipped} places skipped (no address or geocode failure) — not inserted`);
		}
	}

	if (DRY_RUN) {
		console.log('\n[dry-run] Would insert:');
		for (const g of geocoded.slice(0, 20)) {
			console.log(`  ${g.name} (${g.lat}, ${g.lng}) — ${g.episodeIds.length} episodes`);
		}
		console.log(`  ... and ${Math.max(0, geocoded.length - 20)} more`);
		return;
	}

	// Insert new places in batches
	console.log('\nInserting new places into D1...');
	const BATCH = 20;
	let inserted = 0;
	for (let i = 0; i < geocoded.length; i += BATCH) {
		const chunk = geocoded.slice(i, i + BATCH);
		const values = chunk.map(p =>
			`('${escapeSQL(p.name)}', ${p.lat}, ${p.lng})`
		).join(', ');
		try {
			run(`INSERT OR IGNORE INTO places (name, lat, lng) VALUES ${values}`);
		} catch (err) {
			console.error(`  Insert error: ${err.message}`);
		}
		inserted += chunk.length;
		process.stdout.write(`\r  Places: ${inserted}/${geocoded.length}`);
	}
	console.log('');

	// Fetch all place IDs (existing + new)
	const allRows = query('SELECT id, LOWER(name) as lower_name FROM places');
	const nameToId = new Map();
	for (const row of allRows) {
		nameToId.set(row.lower_name, row.id);
	}

	// Build all mention pairs (existing links + new links)
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

	console.log(`\nInserting ${mentionPairs.length} place_mentions...`);
	let mInserted = 0;
	for (let i = 0; i < mentionPairs.length; i += BATCH) {
		const chunk = mentionPairs.slice(i, i + BATCH);
		const values = chunk.map(([pid, eid]) =>
			`(${pid}, '${escapeSQL(eid)}')`
		).join(', ');
		try {
			run(`INSERT OR IGNORE INTO place_mentions (place_id, episode_id) VALUES ${values}`);
		} catch {
			// episode may not exist in DB yet; skip
		}
		mInserted += chunk.length;
		process.stdout.write(`\r  Mentions: ${mInserted}/${mentionPairs.length}`);
	}
	console.log('\nDone!');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
