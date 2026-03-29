#!/usr/bin/env node

/**
 * Backfill guest_start_ms for episodes by analyzing transcripts.
 *
 * Detection algorithm:
 *   1. Only look at segments after 50 minutes (3,000,000ms)
 *   2. Find the last "song break" — a segment >=180s or a gap >=60s between segments
 *   3. After that break, find the first mention of any guest name
 *   4. Fallback A: first guest name mention after 50min (no song break found)
 *   5. Fallback B: first speech segment after the last song break
 *   6. Fallback C: 3,600,000ms (1 hour)
 *
 * Usage:
 *   node scripts/backfill-guest-start.js [--local] [--force] [--dry-run]
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// ── Load .env ─────────────────────────────────────────────────────────

const scriptDir = path.dirname(decodeURIComponent(new URL(import.meta.url).pathname));
const envPath = path.resolve(scriptDir, '..', '.env');
if (fs.existsSync(envPath)) {
	for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const eq = trimmed.indexOf('=');
		if (eq === -1) continue;
		const key = trimmed.slice(0, eq);
		const val = trimmed.slice(eq + 1);
		if (!process.env[key]) process.env[key] = val;
	}
}

const DB_NAME = 'roe-episodes';
const MIN_START_MS = 3_000_000; // 50 minutes
const SONG_DURATION_MS = 180_000; // 3 minutes — segments this long are songs
const GAP_THRESHOLD_MS = 60_000; // 1 minute gap between segments
const FALLBACK_MS = 3_600_000; // 1 hour

function workerCwd() {
	return path.resolve(scriptDir, '..', 'roe-search');
}

function escapeSQL(str) {
	return str.replace(/'/g, "''");
}

function wranglerEnv() {
	const env = { ...process.env };
	delete env.CLOUDFLARE_API_TOKEN;
	return env;
}

function runSQL(sql, isLocal) {
	const flag = isLocal ? '--local' : '--remote';
	const cmd = `npx wrangler d1 execute ${DB_NAME} ${flag} --command="${sql.replace(/"/g, '\\"')}"`;
	return execSync(cmd, {
		cwd: workerCwd(),
		encoding: 'utf-8',
		stdio: 'pipe',
		env: wranglerEnv(),
	});
}

function queryJSON(sql, isLocal) {
	const flag = isLocal ? '--local' : '--remote';
	const cmd = `npx wrangler d1 execute ${DB_NAME} ${flag} --json --command="${sql.replace(/"/g, '\\"')}"`;
	const result = execSync(cmd, {
		cwd: workerCwd(),
		encoding: 'utf-8',
		stdio: 'pipe',
		env: wranglerEnv(),
	});
	const parsed = JSON.parse(result);
	return parsed[0]?.results ?? [];
}

/**
 * Detect the guest interview start timestamp from transcript segments.
 * Returns start_ms or null if detection fails.
 */
function detectGuestStart(segments, guestNames) {
	if (guestNames.length === 0) return null;

	// Only consider segments after 50 minutes
	const late = segments.filter(s => s.start_ms >= MIN_START_MS);
	if (late.length === 0) return null;

	// Find song breaks: segments with duration >= 180s, or gaps >= 60s
	const breaks = [];
	for (let i = 0; i < late.length; i++) {
		const seg = late[i];
		const duration = seg.end_ms - seg.start_ms;
		if (duration >= SONG_DURATION_MS) {
			breaks.push({ type: 'song', index: i, end_ms: seg.end_ms });
		}
		if (i > 0) {
			const gap = seg.start_ms - late[i - 1].end_ms;
			if (gap >= GAP_THRESHOLD_MS) {
				breaks.push({ type: 'gap', index: i, end_ms: late[i - 1].end_ms });
			}
		}
	}

	// Build lowercase guest name list for matching
	const lowerNames = guestNames.map(n => n.toLowerCase());

	function segmentMentionsGuest(seg) {
		const text = seg.text.toLowerCase();
		return lowerNames.some(name => text.includes(name));
	}

	// Strategy 1: After the last song break, find first guest name mention
	if (breaks.length > 0) {
		// Sort breaks by position, take the last one
		breaks.sort((a, b) => a.end_ms - b.end_ms);
		const lastBreak = breaks[breaks.length - 1];
		const afterBreak = late.filter(s => s.start_ms >= lastBreak.end_ms);

		for (const seg of afterBreak) {
			if (segmentMentionsGuest(seg)) {
				return seg.start_ms;
			}
		}

		// Fallback B: first speech segment after the last song break
		if (afterBreak.length > 0) {
			return afterBreak[0].start_ms;
		}
	}

	// Fallback A: first guest name mention after 50 minutes (no song break)
	for (const seg of late) {
		if (segmentMentionsGuest(seg)) {
			return seg.start_ms;
		}
	}

	// Fallback C: 1 hour
	return FALLBACK_MS;
}

async function main() {
	if (process.argv.includes('--help') || process.argv.includes('-h')) {
		console.log('Usage: node scripts/backfill-guest-start.js [--local] [--force] [--dry-run]');
		console.log('');
		console.log('Detects guest interview start times from transcripts and updates episodes.guest_start_ms.');
		console.log('  --local    Target local D1 database');
		console.log('  --force    Re-detect for all episodes, even if guest_start_ms is already set');
		console.log('  --dry-run  Print detected timestamps without writing to D1');
		process.exit(0);
	}

	const isLocal = process.argv.includes('--local');
	const force = process.argv.includes('--force');
	const dryRun = process.argv.includes('--dry-run');

	const transcriptsDir = path.resolve(scriptDir, '..', 'transcripts');
	if (!fs.existsSync(transcriptsDir)) {
		console.error('No transcripts/ directory found.');
		process.exit(1);
	}

	// Get all episode IDs and their current guest_start_ms
	const episodes = queryJSON('SELECT id, duration_ms, guest_start_ms FROM episodes', isLocal);
	const episodeMap = new Map(episodes.map(e => [e.id, e]));

	// Get all guest names per episode
	const guestRows = queryJSON('SELECT episode_id, guest_name FROM episode_guests', isLocal);
	const guestsByEpisode = new Map();
	for (const row of guestRows) {
		if (!guestsByEpisode.has(row.episode_id)) {
			guestsByEpisode.set(row.episode_id, []);
		}
		guestsByEpisode.get(row.episode_id).push(row.guest_name);
	}

	const files = fs.readdirSync(transcriptsDir).filter(f => f.endsWith('.json')).sort();

	console.log(`Found ${episodeMap.size} episodes in DB, ${guestsByEpisode.size} with guests`);
	console.log(`Target: ${isLocal ? 'local' : 'remote'} D1 database${dryRun ? ' (DRY RUN)' : ''}`);
	console.log();

	let processed = 0;
	let skipped = 0;
	let updated = 0;

	for (const file of files) {
		const transcript = JSON.parse(fs.readFileSync(path.join(transcriptsDir, file), 'utf-8'));
		const { episode_id, segments } = transcript;

		const ep = episodeMap.get(episode_id);
		if (!ep) continue;

		// Skip episodes with no guests
		const guests = guestsByEpisode.get(episode_id);
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

		const startMs = detectGuestStart(segments, guests);
		if (startMs == null) {
			skipped++;
			continue;
		}

		// Sanity check: some older transcripts have inflated timestamps
		if (ep.duration_ms && startMs > ep.duration_ms) {
			console.log(`  ${episode_id}: SKIPPED — detected ${startMs}ms exceeds duration ${ep.duration_ms}ms`);
			skipped++;
			continue;
		}

		const minutes = Math.floor(startMs / 60000);
		const seconds = Math.floor((startMs % 60000) / 1000);
		const timestamp = `${minutes}:${String(seconds).padStart(2, '0')}`;

		console.log(`  ${episode_id}: guest_start_ms=${startMs} (${timestamp}) — guests: ${guests.join(', ')}`);

		if (!dryRun) {
			runSQL(`UPDATE episodes SET guest_start_ms = ${startMs} WHERE id = '${escapeSQL(episode_id)}'`, isLocal);
		}

		updated++;
		processed++;
	}

	console.log();
	console.log('=== Backfill Complete ===');
	console.log(`Processed: ${processed}, Updated: ${updated}, Skipped: ${skipped}`);
}

main().catch(err => {
	console.error('Error:', err.message);
	process.exit(1);
});
