#!/usr/bin/env node
/**
 * seed-verified-places.js
 *
 * Reads scripts/verified_places.json and seeds confirmed matches into the
 * D1 places + place_mentions tables.
 *
 * Geocodes addresses via Nominatim (OSM) for places missing lat/lng.
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

async function main() {
	if (!fs.existsSync(VERIFIED_PATH)) {
		console.error('verified_places.json not found — run cross-reference-candidates.js first');
		process.exit(1);
	}

	const raw = JSON.parse(fs.readFileSync(VERIFIED_PATH, 'utf8'));
	// Support both { matches: [...] } and a bare array
	const matches = Array.isArray(raw) ? raw : (raw.matches || []);
	console.log(`${matches.length} verified places loaded`);

	// Step 1: Fetch existing places from D1
	console.log('\nFetching existing places from D1...');
	const existingRows = d1('SELECT id, name, LOWER(name) as lower_name FROM places');
	const existingNames = new Map();
	for (const row of (existingRows[0]?.results || [])) {
		existingNames.set(row.lower_name, row.id);
	}
	console.log(`${existingNames.size} existing places in D1`);

	// Step 2: Separate into already-exists and new
	const toInsert = [];   // need geocode + insert + mentions
	const toLink = [];     // { placeId, episodeIds } — exists, just add mentions
	let alreadyExisted = 0;

	for (const match of matches) {
		const candidate = match.candidate || match;
		const name = candidate.name || candidate.normalized_name || '';
		const lowerName = name.toLowerCase();
		const episodeIds = (match.episodes || []).map(e => e.episode_id);

		if (existingNames.has(lowerName)) {
			alreadyExisted++;
			toLink.push({ placeId: existingNames.get(lowerName), episodeIds });
		} else {
			toInsert.push({
				name,
				lat: candidate.lat ?? null,
				lng: candidate.lng ?? null,
				address: candidate.address || null,
				episodeIds,
			});
		}
	}

	console.log(`${alreadyExisted} already in places table, ${toInsert.length} new to insert`);

	if (DRY_RUN) {
		console.log('\n[dry-run] Would insert:');
		for (const p of toInsert.slice(0, 20)) {
			const coordStr = (p.lat != null && p.lng != null)
				? `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`
				: (p.address ? `needs geocode: ${p.address}` : 'no coords/address');
			console.log(`  ${p.name} (${coordStr}) — ${p.episodeIds.length} episodes`);
		}
		if (toInsert.length > 20) {
			console.log(`  ... and ${toInsert.length - 20} more`);
		}
		console.log(`\n[dry-run] Would add mentions for ${toLink.length} existing places`);
		return;
	}

	// Step 3: Geocode new places missing coords
	const geocoded = [];
	const hasCoords = toInsert.filter(p => p.lat != null && p.lng != null);
	const needsGeocode = toInsert.filter(p => (p.lat == null || p.lng == null) && p.address);
	const cannotGeocode = toInsert.filter(p => (p.lat == null || p.lng == null) && !p.address);

	// Places with coords already — no geocoding needed
	for (const p of hasCoords) {
		geocoded.push({ name: p.name, lat: p.lat, lng: p.lng, episodeIds: p.episodeIds });
	}

	if (needsGeocode.length > 0) {
		console.log(`\nGeocoding ${needsGeocode.length} new places (1100ms rate limit)...`);
		for (let i = 0; i < needsGeocode.length; i++) {
			const p = needsGeocode[i];
			let coords = null;
			try {
				coords = await geocode(p.address);
				await new Promise(r => setTimeout(r, 1100));
			} catch (err) {
				console.error(`  Geocode error for ${p.name}: ${err.message}`);
			}

			if (!coords) {
				console.warn(`  Skipping ${p.name} — geocode returned no results`);
				continue;
			}

			geocoded.push({ name: p.name, lat: coords.lat, lng: coords.lng, episodeIds: p.episodeIds });

			if ((i + 1) % 10 === 0 || i === needsGeocode.length - 1) {
				process.stdout.write(`\r  Geocoded: ${i + 1}/${needsGeocode.length}`);
			}
		}
		if (needsGeocode.length > 0) console.log('');
	}

	// Places with no address and no coords cannot be placed on the map — skip
	if (cannotGeocode.length > 0) {
		console.log(`Skipping ${cannotGeocode.length} new places with no coords and no address`);
	}

	// Step 4: Insert new places in batches of 20
	if (geocoded.length > 0) {
		console.log(`\nInserting ${geocoded.length} new places into D1...`);
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
	}

	// Step 5: Fetch all place IDs (existing + newly inserted)
	const allRows = d1('SELECT id, LOWER(name) as lower_name FROM places');
	const nameToId = new Map();
	for (const row of (allRows[0]?.results || [])) {
		nameToId.set(row.lower_name, row.id);
	}

	// Step 6: Build mention pairs for both existing and new places
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

	// Step 7: Insert place_mentions in batches of 20
	console.log(`\nInserting ${mentionPairs.length} place_mentions...`);
	const BATCH = 20;
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
