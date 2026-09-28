#!/usr/bin/env node

/**
 * Backfill guest_start_ms for episodes by analyzing transcripts.
 *
 * The detection algorithm lives in ./guest-start.js (shared with the ingest
 * pipeline). This script is the catch-up tool: it walks every episode in D1
 * that has guests but no guest_start_ms and fills it in.
 *
 * Segments come from the local transcripts/<id>.json when present, otherwise
 * from D1 (transcript_segments) — so episodes whose local transcript was lost
 * (e.g. ingested from a since-deleted checkout) are still handled.
 *
 * Usage:
 *   node scripts/backfill-guest-start.js [--local] [--force] [--include-reviewed] [--dry-run]
 *
 * Only empty interview times are filled in, unless --force. Episodes whose
 * guests were reviewed by hand keep theirs (even an empty one, and even with
 * --force) unless --include-reviewed is given.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
	loadEnv, escapeSQL, queryJSON, runSQL, transcriptsDir,
} from './lib.js';
import { detectGuestStart, MIN_START_MS } from './guest-start.js';

loadEnv();

/**
 * Load transcript segments for an episode: prefer the local JSON, fall back
 * to D1 when the local file is missing.
 * @returns {{segments: Array, source: 'local'|'d1'}|null}
 */
function loadSegments(episodeId, isLocal) {
	const localPath = path.join(transcriptsDir, `${episodeId}.json`);
	if (fs.existsSync(localPath)) {
		const transcript = JSON.parse(fs.readFileSync(localPath, 'utf-8'));
		return { segments: transcript.segments || [], source: 'local' };
	}
	const segments = queryJSON(
		`SELECT start_ms, end_ms, text FROM transcript_segments WHERE episode_id = '${escapeSQL(episodeId)}' ORDER BY start_ms, id`,
		{ isLocal }
	);
	return segments.length > 0 ? { segments, source: 'd1' } : null;
}

const OPTIONS = new Set(['--local', '--force', '--include-reviewed', '--dry-run', '--help', '-h']);

function usage(exitCode = 0) {
	const log = exitCode ? console.error : console.log;
	log('Usage: node scripts/backfill-guest-start.js [--local] [--force] [--include-reviewed] [--dry-run]');
	log('');
	log('Detects guest interview start times from transcripts and updates episodes.guest_start_ms.');
	log('  --local             Target local D1 database');
	log('  --force             Re-detect for all episodes, even if guest_start_ms is already set');
	log('  --include-reviewed  Include episodes whose guests were reviewed by hand');
	log('                      (left alone otherwise, even with --force)');
	log('  --dry-run           Print detected timestamps without writing to D1');
	process.exit(exitCode);
}

async function main() {
	const args = process.argv.slice(2);
	const unknown = args.filter((a) => !OPTIONS.has(a));
	if (unknown.length > 0) {
		console.error(`Unknown option: ${unknown.join(' ')}\n`);
		usage(1);
	}
	if (args.includes('--help') || args.includes('-h')) usage();

	const isLocal = args.includes('--local');
	const force = args.includes('--force');
	const includeReviewed = args.includes('--include-reviewed');
	const dryRun = args.includes('--dry-run');

	// Episodes and their current guest_start_ms
	const episodes = queryJSON('SELECT id, duration_ms, guest_start_ms, guests_reviewed FROM episodes ORDER BY id', { isLocal });

	// Guest names per episode
	const guestRows = queryJSON('SELECT episode_id, guest_name FROM episode_guests', { isLocal });
	const guestsByEpisode = new Map();
	for (const row of guestRows) {
		if (!guestsByEpisode.has(row.episode_id)) guestsByEpisode.set(row.episode_id, []);
		guestsByEpisode.get(row.episode_id).push(row.guest_name);
	}

	console.log(`Found ${episodes.length} episodes in DB, ${guestsByEpisode.size} with guests`);
	console.log(`Target: ${isLocal ? 'local' : 'remote'} D1 database${dryRun ? ' (DRY RUN)' : ''}`);
	console.log();

	let updated = 0;
	let skipped = 0;
	let reviewed = 0;

	for (const ep of episodes) {
		// Reviewed by hand: hands off
		if (ep.guests_reviewed && !includeReviewed) {
			reviewed++;
			continue;
		}

		// Skip episodes with no guests
		const guests = guestsByEpisode.get(ep.id);
		if (!guests || guests.length === 0) {
			skipped++;
			continue;
		}

		// Skip episodes shorter than 50 minutes
		if (ep.duration_ms && ep.duration_ms < MIN_START_MS) {
			skipped++;
			continue;
		}

		// Skip if already set (unless --force)
		if (!force && ep.guest_start_ms != null) {
			skipped++;
			continue;
		}

		const loaded = loadSegments(ep.id, isLocal);
		if (!loaded) {
			console.log(`  ${ep.id}: SKIPPED — no transcript (local or D1)`);
			skipped++;
			continue;
		}

		const startMs = detectGuestStart(loaded.segments, guests);
		if (startMs == null) {
			skipped++;
			continue;
		}

		// Sanity check: some older transcripts have inflated timestamps
		if (ep.duration_ms && startMs > ep.duration_ms) {
			console.log(`  ${ep.id}: SKIPPED — detected ${startMs}ms exceeds duration ${ep.duration_ms}ms`);
			skipped++;
			continue;
		}

		const minutes = Math.floor(startMs / 60000);
		const seconds = Math.floor((startMs % 60000) / 1000);
		const timestamp = `${minutes}:${String(seconds).padStart(2, '0')}`;

		console.log(`  ${ep.id}: guest_start_ms=${startMs} (${timestamp}) [${loaded.source}] — guests: ${guests.join(', ')}`);

		if (!dryRun) {
			// Unless --force, the write also only lands on an empty value
			runSQL(
				`UPDATE episodes SET guest_start_ms = ${startMs} WHERE id = '${escapeSQL(ep.id)}'${force ? '' : ' AND guest_start_ms IS NULL'}`,
				{ isLocal }
			);
		}

		updated++;
	}

	console.log();
	console.log('=== Backfill Complete ===');
	console.log(`Updated: ${updated}, Skipped: ${skipped}, Reviewed (left alone): ${reviewed}`);
}

main().catch(err => {
	console.error('Error:', err.message);
	process.exit(1);
});
