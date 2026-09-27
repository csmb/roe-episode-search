#!/usr/bin/env node
/**
 * harvest-businesses.js
 *
 * Paginates through the DataSF business registrations API and stores
 * every SF business registered since 2013 in a local SQLite database.
 *
 * Usage:
 *   node --experimental-sqlite scripts/harvest-businesses.js
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'sf_businesses.db');

const API_BASE = 'https://data.sfgov.org/resource/g8m3-pdis.json';
const PAGE_SIZE = 1000;

function initDb() {
	const db = new DatabaseSync(DB_PATH);
	db.exec(`
		CREATE TABLE IF NOT EXISTS businesses (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			dba_name TEXT NOT NULL,
			normalized_name TEXT NOT NULL,
			address TEXT,
			city TEXT,
			zip TEXT,
			start_date TEXT,
			end_date TEXT,
			source TEXT DEFAULT 'datasf',
			source_id TEXT,
			UNIQUE(source, source_id)
		);
		CREATE INDEX IF NOT EXISTS idx_biz_normalized ON businesses(normalized_name);
		CREATE TABLE IF NOT EXISTS harvest_state (
			key TEXT PRIMARY KEY,
			value TEXT
		);
	`);
	return db;
}

function getState(db, key) {
	const row = db.prepare('SELECT value FROM harvest_state WHERE key = ?').get(key);
	return row ? row.value : null;
}

function setState(db, key, value) {
	db.prepare('INSERT OR REPLACE INTO harvest_state (key, value) VALUES (?, ?)').run(key, String(value));
}

async function fetchPage(offset) {
	const params = new URLSearchParams({
		'$limit': String(PAGE_SIZE),
		'$offset': String(offset),
		'$where': "location_start_date >= '2013-01-01' AND city = 'San Francisco'",
		'$order': 'uniqueid',
	});
	const url = `${API_BASE}?${params}`;
	const res = await fetch(url);
	if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
	return res.json();
}

async function main() {
	const db = initDb();

	const insert = db.prepare(`
		INSERT OR IGNORE INTO businesses (dba_name, normalized_name, address, city, zip, start_date, end_date, source, source_id)
		VALUES (?, ?, ?, ?, ?, ?, ?, 'datasf', ?)
	`);

	let offset = parseInt(getState(db, 'last_offset') || '0', 10);
	let totalInserted = parseInt(getState(db, 'total_inserted') || '0', 10);

	console.log(`Starting harvest from offset ${offset} (${totalInserted} previously inserted)`);

	while (true) {
		const rows = await fetchPage(offset);
		if (!rows.length) {
			console.log(`\nNo more results at offset ${offset}. Done.`);
			break;
		}

		let pageInserted = 0;
		for (const row of rows) {
			const dbaName = (row.dba_name || '').trim();
			if (!dbaName) continue;

			const result = insert.run(
				dbaName,
				dbaName.toLowerCase(),
				row.full_business_address || null,
				row.city || null,
				row.business_zip || null,
				row.dba_start_date || null,
				row.dba_end_date || null,
				row.uniqueid || null
			);
			if (result.changes > 0) pageInserted++;
		}

		totalInserted += pageInserted;
		offset += rows.length;

		setState(db, 'last_offset', offset);
		setState(db, 'total_inserted', totalInserted);

		process.stdout.write(`\r  Offset: ${offset} | Inserted: ${totalInserted} | Page: +${pageInserted}`);

		// Small delay to be polite to the API
		await new Promise(r => setTimeout(r, 100));
	}

	// Print stats
	const count = db.prepare('SELECT COUNT(*) as n FROM businesses').get();
	console.log(`\nTotal businesses in DB: ${count.n}`);
	db.close();
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
