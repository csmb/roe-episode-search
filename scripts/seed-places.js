#!/usr/bin/env node
/**
 * seed-places.js
 *
 * Reads scripts/places.json and seeds the places + place_mentions tables in D1.
 *
 * Usage:
 *   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... node scripts/seed-places.js
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLACES_PATH = path.join(__dirname, 'places.json');

// Strip CLOUDFLARE_API_TOKEN so wrangler uses its OAuth login (the token lacks D1 permissions)
const wranglerEnv = { ...process.env };
delete wranglerEnv.CLOUDFLARE_API_TOKEN;

function d1(sql) {
	const result = execSync(
		`npx wrangler d1 execute roe-episodes --remote --json --command=${JSON.stringify(sql)}`,
		{ cwd: path.join(__dirname, '..', 'roe-search'), env: wranglerEnv }
	);
	return JSON.parse(result.toString());
}

async function main() {
	if (!fs.existsSync(PLACES_PATH)) {
		console.error('places.json not found — run extract-places.js first');
		process.exit(1);
	}

	const { places } = JSON.parse(fs.readFileSync(PLACES_PATH));
	console.log(`Seeding ${places.length} places into D1...`);

	// Create tables if not exist
	d1(`CREATE TABLE IF NOT EXISTS places (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, lat REAL NOT NULL, lng REAL NOT NULL)`);
	d1(`CREATE TABLE IF NOT EXISTS place_mentions (place_id INTEGER NOT NULL REFERENCES places(id), episode_id TEXT NOT NULL REFERENCES episodes(id), PRIMARY KEY (place_id, episode_id))`);

	// Clear existing data
	d1('DELETE FROM place_mentions');
	d1('DELETE FROM places');

	// Insert places in batches
	const BATCH = 20;
	let inserted = 0;
	for (let i = 0; i < places.length; i += BATCH) {
		const chunk = places.slice(i, i + BATCH);
		const values = chunk.map(p =>
			`(${JSON.stringify(p.name)}, ${p.lat}, ${p.lng})`
		).join(', ');
		d1(`INSERT OR IGNORE INTO places (name, lat, lng) VALUES ${values}`);
		inserted += chunk.length;
		process.stdout.write(`\r  Places: ${inserted}/${places.length}`);
	}
	console.log('\n  Places inserted.');

	// Fetch inserted place IDs
	const rows = d1('SELECT id, name FROM places')[0].results;

	const nameToId = {};
	for (const row of rows) nameToId[row.name] = row.id;

	// Insert place_mentions
	const mentionPairs = [];
	for (const place of places) {
		const placeId = nameToId[place.name];
		if (!placeId) continue;
		for (const episodeId of place.episodes) {
			mentionPairs.push([placeId, episodeId]);
		}
	}

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
	console.log('\n  Mentions inserted.');
	console.log('Done!');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
