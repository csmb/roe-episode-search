#!/usr/bin/env node
/**
 * build-transcript-index.js
 *
 * Reads all transcript JSON files and builds a local FTS5 index
 * of windowed text for fast phrase matching against business names.
 *
 * Usage:
 *   node --experimental-sqlite scripts/build-transcript-index.js
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRANSCRIPTS_DIR = path.join(__dirname, '..', 'transcripts');
const DB_PATH = path.join(__dirname, 'transcript_index.db');

// Window params: concatenate WINDOW_SIZE consecutive segments, slide by STRIDE
const WINDOW_SIZE = 6;
const STRIDE = 3;

function main() {
	// Remove old DB if it exists (always rebuild fresh)
	if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

	const db = new DatabaseSync(DB_PATH);
	db.exec(`
		CREATE TABLE windows (
			id INTEGER PRIMARY KEY,
			episode_id TEXT NOT NULL,
			start_ms INTEGER,
			end_ms INTEGER,
			text TEXT NOT NULL
		);
		CREATE INDEX idx_windows_episode ON windows(episode_id);
	`);

	const files = fs.readdirSync(TRANSCRIPTS_DIR).filter(f => f.endsWith('.json'));
	console.log(`Processing ${files.length} transcript files...`);

	const insert = db.prepare(
		'INSERT INTO windows (episode_id, start_ms, end_ms, text) VALUES (?, ?, ?, ?)'
	);

	let totalWindows = 0;
	let totalSegments = 0;

	for (let fi = 0; fi < files.length; fi++) {
		const filePath = path.join(TRANSCRIPTS_DIR, files[fi]);
		const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
		const segments = data.segments || [];
		totalSegments += segments.length;

		for (let i = 0; i <= segments.length - WINDOW_SIZE; i += STRIDE) {
			const window = segments.slice(i, i + WINDOW_SIZE);
			const text = window.map(s => s.text).join(' ');
			const startMs = window[0].start_ms;
			const endMs = window[window.length - 1].end_ms;
			insert.run(data.episode_id, startMs, endMs, text);
			totalWindows++;
		}

		// Handle trailing segments that don't fill a full window
		const remainder = segments.length % STRIDE;
		if (segments.length >= WINDOW_SIZE && remainder > 0) {
			const lastStart = segments.length - WINDOW_SIZE;
			const alreadyCovered = Math.floor((segments.length - WINDOW_SIZE) / STRIDE) * STRIDE;
			if (lastStart > alreadyCovered) {
				const window = segments.slice(lastStart);
				const text = window.map(s => s.text).join(' ');
				insert.run(data.episode_id, window[0].start_ms, window[window.length - 1].end_ms, text);
				totalWindows++;
			}
		}

		if ((fi + 1) % 50 === 0 || fi === files.length - 1) {
			process.stdout.write(`\r  Files: ${fi + 1}/${files.length} | Windows: ${totalWindows}`);
		}
	}

	console.log(`\n  Total segments: ${totalSegments}`);
	console.log(`  Total windows: ${totalWindows}`);

	// Build FTS5 index
	console.log('Building FTS5 index...');
	db.exec(`
		CREATE VIRTUAL TABLE windows_fts USING fts5(text, content='windows', content_rowid='id');
		INSERT INTO windows_fts(windows_fts) VALUES('rebuild');
	`);

	// Quick sanity check
	const testResults = db.prepare(
		"SELECT episode_id, substr(text, 1, 80) as snippet FROM windows WHERE id IN (SELECT rowid FROM windows_fts WHERE windows_fts MATCH '\"tartine\"') LIMIT 3"
	).all();
	console.log(`\nSanity check - "tartine" matches: ${testResults.length}`);
	for (const r of testResults) {
		console.log(`  ${r.episode_id}: ${r.snippet}...`);
	}

	db.close();
	console.log(`\nDone. Index saved to ${DB_PATH}`);
}

main();
