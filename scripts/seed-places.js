#!/usr/bin/env node
/**
 * seed-places.js
 *
 * Reads scripts/places.json and seeds the places + place_mentions tables in D1.
 *
 * Usage:
 *   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... node scripts/seed-places.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeSQL, runSQL, queryJSON } from './lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLACES_PATH = path.join(__dirname, 'places.json');

async function main() {
	if (!fs.existsSync(PLACES_PATH)) {
		console.error('places.json not found — run extract-places.js first');
		process.exit(1);
	}

	const { places } = JSON.parse(fs.readFileSync(PLACES_PATH));
	console.log(`Seeding ${places.length} places into D1...`);

	// Create tables if not exist
	runSQL(`CREATE TABLE IF NOT EXISTS places (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, lat REAL NOT NULL, lng REAL NOT NULL)`);
	runSQL(`CREATE TABLE IF NOT EXISTS place_mentions (place_id INTEGER NOT NULL REFERENCES places(id), episode_id TEXT NOT NULL REFERENCES episodes(id), PRIMARY KEY (place_id, episode_id))`);
	runSQL(`CREATE TABLE IF NOT EXISTS place_narratives (place_id INTEGER PRIMARY KEY REFERENCES places(id), early_text TEXT, recent_text TEXT, arc_text TEXT, episode_count INTEGER, year_min INTEGER, year_max INTEGER, generated_at TEXT)`);

	// Clear existing data. place IDs are AUTOINCREMENT and get reassigned on
	// reseed, so anything keyed by place_id must be wiped too — otherwise
	// surviving rows point at the wrong places.
	console.warn('WARNING: full reseed wipes place_narratives and all place_mentions');
	console.warn('         sentiment/snippet analysis. Regenerate them after seeding');
	console.warn('         (narratives + mention analysis scripts).');
	runSQL('DELETE FROM place_narratives');
	runSQL('DELETE FROM place_mentions');
	runSQL('DELETE FROM places');

	// Insert places in batches
	const BATCH = 20;
	let inserted = 0;
	for (let i = 0; i < places.length; i += BATCH) {
		const chunk = places.slice(i, i + BATCH);
		const values = chunk.map(p =>
			`('${escapeSQL(p.name)}', ${p.lat}, ${p.lng})`
		).join(', ');
		runSQL(`INSERT OR IGNORE INTO places (name, lat, lng) VALUES ${values}`);
		inserted += chunk.length;
		process.stdout.write(`\r  Places: ${inserted}/${places.length}`);
	}
	console.log('\n  Places inserted.');

	// Fetch inserted place IDs
	const rows = queryJSON('SELECT id, name FROM places');

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
			`(${pid}, '${escapeSQL(eid)}')`
		).join(', ');
		try {
			runSQL(`INSERT OR IGNORE INTO place_mentions (place_id, episode_id) VALUES ${values}`);
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
