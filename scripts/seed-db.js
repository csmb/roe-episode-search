#!/usr/bin/env node

/**
 * Seed the D1 database with transcript JSON files.
 *
 * Usage:
 *   node scripts/seed-db.js [--local]
 *
 * By default seeds the remote D1 database. Use --local for local dev database.
 */

import fs from 'node:fs';
import path from 'node:path';
import { escapeSQL, runSQL, queryJSON, transcriptsDir, applyWordCorrections } from './lib.js';

const BATCH_SIZE = 50;

function usage() {
	console.log('Usage: node scripts/seed-db.js [--local]');
	console.log('');
	console.log('Seeds the D1 database from transcript JSON files in transcripts/.');
	console.log('Use --local to seed the local dev database instead of remote.');
	process.exit(0);
}

async function main() {
	if (process.argv.includes('--help') || process.argv.includes('-h')) usage();

	const isLocal = process.argv.includes('--local');

	if (!fs.existsSync(transcriptsDir)) {
		console.error('No transcripts/ directory found. Run transcription first.');
		process.exit(1);
	}

	const files = fs.readdirSync(transcriptsDir).filter((f) => f.endsWith('.json')).sort();
	if (files.length === 0) {
		console.log('No transcript JSON files found in transcripts/.');
		process.exit(0);
	}

	console.log(`Found ${files.length} transcript files`);
	console.log(`Target: ${isLocal ? 'local' : 'remote'} D1 database`);
	console.log();

	// Check which episodes already exist
	let existingIds = new Set();
	try {
		const results = queryJSON('SELECT id FROM episodes', { isLocal });
		existingIds = new Set(results.map((r) => r.id));
	} catch {
		// Table might not exist yet — that's fine, we'll insert everything
	}

	let inserted = 0;
	let skipped = 0;

	for (const file of files) {
		const transcript = JSON.parse(fs.readFileSync(path.join(transcriptsDir, file), 'utf-8'));
		const { episode_id, title, segments } = transcript;

		if (existingIds.has(episode_id)) {
			console.log(`  Skipping ${episode_id} (already in DB)`);
			skipped++;
			continue;
		}

		console.log(`  Inserting ${episode_id} (${segments.length} segments)...`);

		// Insert episode
		const lastSegment = segments[segments.length - 1];
		const durationMs = lastSegment ? lastSegment.end_ms : 0;
		runSQL(
			`INSERT INTO episodes (id, title, duration_ms) VALUES ('${escapeSQL(episode_id)}', '${escapeSQL(title)}', ${durationMs})`,
			{ isLocal }
		);

		// Insert segments in batches, applying word corrections
		for (let i = 0; i < segments.length; i += BATCH_SIZE) {
			const batch = segments.slice(i, i + BATCH_SIZE);
			const values = batch
				.map(
					(s) =>
						`('${escapeSQL(episode_id)}', ${s.start_ms}, ${s.end_ms}, '${escapeSQL(applyWordCorrections(s.text))}')`
				)
				.join(', ');

			runSQL(
				`INSERT INTO transcript_segments (episode_id, start_ms, end_ms, text) VALUES ${values}`,
				{ isLocal }
			);
		}

		inserted++;
	}

	console.log();
	console.log('=== Summary ===');
	console.log(`Inserted: ${inserted} episodes`);
	console.log(`Skipped: ${skipped} (already existed)`);
}

main().catch((err) => {
	console.error('Error:', err.message);
	process.exit(1);
});
