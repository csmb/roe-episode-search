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

function geocodeOnce(address) {
	return new Promise((resolve, reject) => {
		const q = encodeURIComponent(address + ', San Francisco, CA');
		const urlPath = `/search?format=json&q=${q}&viewbox=${SF_BOUNDS.west},${SF_BOUNDS.north},${SF_BOUNDS.east},${SF_BOUNDS.south}&bounded=1&limit=1`;
		https.get(`https://nominatim.openstreetmap.org${urlPath}`, { headers: { 'User-Agent': 'roe-episode-search/1.0' } }, res => {
			let data = '';
			res.on('data', chunk => data += chunk);
			res.on('end', () => {
				if (res.statusCode === 429 || res.statusCode >= 500) {
					resolve({ rateLimited: true });
					return;
				}
				try {
					const results = JSON.parse(data);
					if (results.length > 0) {
						resolve({ lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) });
					} else {
						resolve(null);
					}
				} catch {
					// XML/HTML error page = rate limited
					resolve({ rateLimited: true });
				}
			});
		}).on('error', reject);
	});
}

async function geocode(address) {
	const delays = [2000, 5000, 10000];
	for (let attempt = 0; attempt <= delays.length; attempt++) {
		const result = await geocodeOnce(address);
		if (result && result.rateLimited) {
			if (attempt < delays.length) {
				await new Promise(r => setTimeout(r, delays[attempt]));
				continue;
			}
			return null; // exhausted retries
		}
		return result;
	}
	return null;
}

// False positives the LLM verification missed — generic words, person names, etc.
const SEED_STOPLIST = new Set([
	'san francisco', 'mission', 'market', 'the mission', 'restaurant',
	'square', 'fresh', 'treasure', 'phil', 'steps', 'my house', 'hayes',
	'soma', 'jesse', 'real estate', 'property', 'bakery', 'edition',
	'fillmore', 'balboa', 'guerrero', 'patricia', 'recreation', 'masonic',
	'the garden', 'the cafe', 'corner store', 'headquarters', 'cafe in',
	'cantina', 'omar', 'the examiner', 'pack heights', 'spin city',
	'sfo', 'san bruno', 'sfmta', 'sf weekly', 'gia', 'linkedin',
	'san francisco, california', 'san francisco bay area',
	'golden state warriors', 'san francisco giants', 'candlestick',
	'sam\'s', 'joe\'s', 'levi\'s', 'bay city beacon',
]);

function insertPlaces(places) {
	const BATCH = 20;
	let inserted = 0;
	for (let i = 0; i < places.length; i += BATCH) {
		const chunk = places.slice(i, i + BATCH);
		const values = chunk.map(p =>
			`(${JSON.stringify(p.name)}, ${p.lat}, ${p.lng})`
		).join(', ');
		try {
			d1(`INSERT OR IGNORE INTO places (name, lat, lng) VALUES ${values}`);
		} catch (err) {
			console.error(`  Insert error: ${err.message}`);
		}
		inserted += chunk.length;
		process.stdout.write(`\r  Places: ${inserted}/${places.length}`);
	}
	console.log('');
}

function insertMentions(pairs) {
	const BATCH = 20;
	let inserted = 0;
	for (let i = 0; i < pairs.length; i += BATCH) {
		const chunk = pairs.slice(i, i + BATCH);
		const values = chunk.map(([pid, eid]) =>
			`(${pid}, ${JSON.stringify(eid)})`
		).join(', ');
		try {
			d1(`INSERT OR IGNORE INTO place_mentions (place_id, episode_id) VALUES ${values}`);
		} catch {
			// episode may not exist in DB yet; skip
		}
		inserted += chunk.length;
		process.stdout.write(`\r  Mentions: ${inserted}/${pairs.length}`);
	}
	console.log('');
}

async function main() {
	if (!fs.existsSync(VERIFIED_PATH)) {
		console.error('verified_places.json not found — run cross-reference-candidates.js first');
		process.exit(1);
	}

	const raw = JSON.parse(fs.readFileSync(VERIFIED_PATH, 'utf8'));
	// Support both { matches: [...] } and a bare array
	const allMatches = Array.isArray(raw) ? raw : (raw.matches || []);
	console.log(`${allMatches.length} verified places loaded`);

	// Filter out false positives
	const matches = allMatches.filter(m => {
		const name = (m.name || '').toLowerCase();
		return !SEED_STOPLIST.has(name);
	});
	console.log(`${allMatches.length - matches.length} filtered by stoplist, ${matches.length} remaining`);

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

	// Separate new places by whether they already have coords
	const hasCoords = toInsert.filter(p => p.lat != null && p.lng != null);
	const needsGeocode = toInsert.filter(p => (p.lat == null || p.lng == null) && p.address);
	const cannotGeocode = toInsert.filter(p => (p.lat == null || p.lng == null) && !p.address);

	console.log(`  ${hasCoords.length} have coords, ${needsGeocode.length} need geocoding, ${cannotGeocode.length} have no address`);

	// --- Phase A: Insert places that already have coords (OSM data) ---
	const allReady = hasCoords.map(p => ({ name: p.name, lat: p.lat, lng: p.lng, episodeIds: p.episodeIds }));

	if (allReady.length > 0) {
		console.log(`\nInserting ${allReady.length} places with existing coords...`);
		insertPlaces(allReady);
	}

	// --- Phase B: Add mentions for existing places + just-inserted places ---
	// Fetch all place IDs after first insert
	let allRows = d1('SELECT id, LOWER(name) as lower_name FROM places');
	let nameToId = new Map();
	for (const row of (allRows[0]?.results || [])) {
		nameToId.set(row.lower_name, row.id);
	}

	// Build mention pairs for existing places and places just inserted
	let mentionPairs = [];
	for (const link of toLink) {
		for (const eid of link.episodeIds) {
			mentionPairs.push([link.placeId, eid]);
		}
	}
	for (const p of allReady) {
		const placeId = nameToId.get(p.name.toLowerCase());
		if (!placeId) continue;
		for (const eid of p.episodeIds) {
			mentionPairs.push([placeId, eid]);
		}
	}

	if (mentionPairs.length > 0) {
		console.log(`\nInserting ${mentionPairs.length} place_mentions (phase A)...`);
		insertMentions(mentionPairs);
	}

	// --- Phase C: Geocode remaining places ---
	if (cannotGeocode.length > 0) {
		console.log(`\nSkipping ${cannotGeocode.length} new places with no coords and no address`);
	}

	const geocoded = [];
	if (needsGeocode.length > 0) {
		console.log(`\nGeocoding ${needsGeocode.length} new places (1.5s rate limit, retries on rate-limit)...`);
		let skipped = 0;
		for (let i = 0; i < needsGeocode.length; i++) {
			const p = needsGeocode[i];
			let coords = null;
			try {
				coords = await geocode(p.address);
				await new Promise(r => setTimeout(r, 1500));
			} catch (err) {
				console.error(`  Geocode error for ${p.name}: ${err.message}`);
			}

			if (!coords) {
				skipped++;
				continue;
			}

			geocoded.push({ name: p.name, lat: coords.lat, lng: coords.lng, episodeIds: p.episodeIds });

			if ((i + 1) % 25 === 0 || i === needsGeocode.length - 1) {
				process.stdout.write(`\r  Geocoded: ${i + 1}/${needsGeocode.length} (${geocoded.length} found, ${skipped} skipped)`);
			}
		}
		console.log('');
	}

	// --- Phase D: Insert geocoded places + their mentions ---
	if (geocoded.length > 0) {
		console.log(`\nInserting ${geocoded.length} geocoded places...`);
		insertPlaces(geocoded);

		// Re-fetch IDs for mention linking
		allRows = d1('SELECT id, LOWER(name) as lower_name FROM places');
		nameToId = new Map();
		for (const row of (allRows[0]?.results || [])) {
			nameToId.set(row.lower_name, row.id);
		}

		mentionPairs = [];
		for (const g of geocoded) {
			const placeId = nameToId.get(g.name.toLowerCase());
			if (!placeId) continue;
			for (const eid of g.episodeIds) {
				mentionPairs.push([placeId, eid]);
			}
		}

		if (mentionPairs.length > 0) {
			console.log(`Inserting ${mentionPairs.length} place_mentions (phase D)...`);
			insertMentions(mentionPairs);
		}
	}

	// Final count
	const finalCount = d1('SELECT COUNT(*) as cnt FROM places');
	const mentionCount = d1('SELECT COUNT(*) as cnt FROM place_mentions');
	console.log(`\nDone! Places: ${finalCount[0]?.results?.[0]?.cnt}, Mentions: ${mentionCount[0]?.results?.[0]?.cnt}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
