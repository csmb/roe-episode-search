#!/usr/bin/env node

/**
 * Seed the D1 database with transcript JSON files.
 *
 * Prerequisites:
 *   1. Create the D1 database:  npx wrangler d1 create roe-episodes
 *   2. Paste the database_id into wrangler.jsonc
 *   3. Apply the schema:  npx wrangler d1 execute roe-episodes --remote --file=../schema.sql
 *
 * Usage:
 *   node scripts/seed-db.js [--local]
 *
 * By default seeds the remote D1 database. Use --local for local dev database.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BATCH_SIZE = 50; // segments per SQL batch (D1 has statement size limits)

function usage() {
	console.log('Usage: node scripts/seed-db.js [--local]');
	console.log('');
	console.log('Seeds the D1 database from transcript JSON files in transcripts/.');
	console.log('Use --local to seed the local dev database instead of remote.');
	process.exit(0);
}

function escapeSQL(str) {
	return str.replace(/'/g, "''");
}

function runSQL(dbName, sql, isLocal) {
	const flag = isLocal ? '--local' : '--remote';
	const cmd = `npx wrangler d1 execute ${dbName} ${flag} --command="${sql.replace(/"/g, '\\"')}"`;
	execSync(cmd, {
		cwd: path.resolve(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)), '..', 'roe-search'),
		encoding: 'utf-8',
		stdio: 'pipe',
	});
}

async function main() {
	if (process.argv.includes('--help') || process.argv.includes('-h')) usage();

	const isLocal = process.argv.includes('--local');
	const dbName = 'roe-episodes';

	const transcriptsDir = path.resolve(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)), '..', 'transcripts');
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
	console.log(`Target: ${isLocal ? 'local' : 'remote'} D1 database "${dbName}"`);
	console.log();

	// Check which episodes already exist
	let existingIds = new Set();
	try {
		const result = execSync(
			`npx wrangler d1 execute ${dbName} ${isLocal ? '--local' : '--remote'} --json --command="SELECT id FROM episodes"`,
			{
				cwd: path.resolve(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)), '..', 'roe-search'),
				encoding: 'utf-8',
				stdio: 'pipe',
			}
		);
		const parsed = JSON.parse(result);
		if (parsed[0]?.results) {
			existingIds = new Set(parsed[0].results.map((r) => r.id));
		}
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
			dbName,
			`INSERT INTO episodes (id, title, duration_ms) VALUES ('${escapeSQL(episode_id)}', '${escapeSQL(title)}', ${durationMs})`,
			isLocal
		);

		// Insert segments in batches
		for (let i = 0; i < segments.length; i += BATCH_SIZE) {
			const batch = segments.slice(i, i + BATCH_SIZE);
			const values = batch
				.map(
					(s) =>
						`('${escapeSQL(episode_id)}', ${s.start_ms}, ${s.end_ms}, '${escapeSQL(s.text)}')`
				)
				.join(', ');

			runSQL(
				dbName,
				`INSERT INTO transcript_segments (episode_id, start_ms, end_ms, text) VALUES ${values}`,
				isLocal
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
