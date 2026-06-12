#!/usr/bin/env node

/**
 * Merge a duplicate episode's transcript into a canonical episode.
 * Keeps canonical's row (and audio_file, place_mentions) intact.
 * Replaces: transcript_segments, vectors, title, summary, episode_guests.
 * Deletes source duplicate entirely.
 *
 * Usage:
 *   node scripts/merge-episode.js --canonical <id> --source <id> --mp3 <path>
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
	loadEnv, escapeSQL, queryJSON, runSQL, wranglerExec,
	transcriptsDir, projectRoot, applyWordCorrections,
} from './lib.js';
import { chunkEpisode } from './generate-embeddings.js';
import { purgeEpisode } from './clean-hallucinations.js';

loadEnv();

const INDEX_NAME = 'roe-transcripts';
const DELETE_BATCH_SIZE = 100;
const DB_BATCH_SIZE = 50;

function parseArgs() {
	const args = process.argv.slice(2);
	const opts = { canonical: null, source: null, mp3: null };
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--canonical' && args[i + 1]) { opts.canonical = args[++i]; }
		else if (args[i] === '--source' && args[i + 1]) { opts.source = args[++i]; }
		else if (args[i] === '--mp3' && args[i + 1]) { opts.mp3 = args[++i]; }
	}
	return opts;
}

function deleteVectors(ids) {
	for (let i = 0; i < ids.length; i += DELETE_BATCH_SIZE) {
		const batch = ids.slice(i, i + DELETE_BATCH_SIZE);
		wranglerExec(
			['vectorize', 'delete-vectors', INDEX_NAME, '--ids', ...batch],
			{ stdio: 'pipe' }
		);
		console.log(`    Deleted ${batch.length} vectors (${i + batch.length}/${ids.length})`);
	}
}

function insertSegments(episodeId, segments) {
	for (let i = 0; i < segments.length; i += DB_BATCH_SIZE) {
		const batch = segments.slice(i, i + DB_BATCH_SIZE);
		const values = batch
			.map((s) => `('${escapeSQL(episodeId)}', ${s.start_ms}, ${s.end_ms}, '${escapeSQL(applyWordCorrections(s.text))}')`)
			.join(', ');
		runSQL(`INSERT INTO transcript_segments (episode_id, start_ms, end_ms, text) VALUES ${values}`);
	}
}

async function main() {
	const { canonical, source, mp3 } = parseArgs();
	if (!canonical || !source || !mp3) {
		console.error('Usage: node scripts/merge-episode.js --canonical <id> --source <id> --mp3 <path>');
		process.exit(1);
	}
	if (!fs.existsSync(mp3)) {
		console.error(`MP3 not found: ${mp3}`);
		process.exit(1);
	}

	const canonicalTranscript = path.join(transcriptsDir, `${canonical}.json`);
	const sourceTranscript = path.join(transcriptsDir, `${source}.json`);
	if (!fs.existsSync(sourceTranscript)) {
		console.error(`Source transcript not found: ${sourceTranscript}`);
		process.exit(1);
	}

	console.log(`=== Merging episode ===`);
	console.log(`  Canonical:  ${canonical}`);
	console.log(`  Source:     ${source}\n`);

	// ── Step 1: Confirm canonical row exists (keep untouched) ────────────
	const canonicalRows = queryJSON(
		`SELECT id, audio_file FROM episodes WHERE id = '${escapeSQL(canonical)}'`
	);
	if (canonicalRows.length === 0) {
		console.error(`Canonical episode not found: ${canonical}`);
		process.exit(1);
	}
	console.log(`  Current audio_file: ${canonicalRows[0].audio_file ?? '(null)'}`);

	// ── Step 2: Back up original canonical transcript, delete old vectors ─
	// Vector chunk ids are `${episode_id}:${chunkStartMs}` — they depend on
	// the ORIGINAL canonical timeline. We must compute them from the
	// original transcript (never the swapped one), so back it up first.
	// If the backup already exists, a previous merge run crashed mid-way
	// and the canonical transcript may already be swapped: the backup is
	// the only trustworthy source of the old vector ids.
	console.log('\n=== Step 1/6: Back up canonical transcript + delete old vectors ===');
	const backupTranscript = `${canonicalTranscript}.pre-merge.bak`;
	if (fs.existsSync(backupTranscript)) {
		console.log(`  Found existing backup from an interrupted merge: ${backupTranscript}`);
		console.log('  Reusing it as the source of old vector ids (canonical transcript may already be swapped).');
	} else if (fs.existsSync(canonicalTranscript)) {
		fs.copyFileSync(canonicalTranscript, backupTranscript);
		console.log(`  Backed up original canonical transcript to ${backupTranscript}`);
	} else {
		console.log('  No canonical transcript on disk — nothing to back up, no old vectors to delete.');
	}
	if (fs.existsSync(backupTranscript)) {
		const oldTranscript = JSON.parse(fs.readFileSync(backupTranscript, 'utf-8'));
		const oldIds = [...new Set(chunkEpisode(oldTranscript).map((c) => c.id))];
		console.log(`  ${oldIds.length} old unique vector ids`);
		if (oldIds.length > 0) deleteVectors(oldIds);
	}

	// ── Step 3: Swap transcript file, set internal episode_id ────────────
	console.log('\n=== Step 2/6: Swap transcript file ===');
	const sourceData = JSON.parse(fs.readFileSync(sourceTranscript, 'utf-8'));
	sourceData.episode_id = canonical;
	fs.writeFileSync(canonicalTranscript, JSON.stringify(sourceData, null, 2));
	console.log(`  Wrote ${path.basename(canonicalTranscript)} (${sourceData.segments.length} segments)`);

	// ── Step 4: Replace segments in D1 ───────────────────────────────────
	// Preserve canonical's original duration_ms — the transcript may contain
	// trailing hallucinations past the real audio end.
	console.log('\n=== Step 3/6: Replace transcript_segments ===');
	console.log('  Deleting old segments (FTS auto-cleans via trigger)...');
	runSQL(`DELETE FROM transcript_segments WHERE episode_id = '${escapeSQL(canonical)}'`);
	console.log(`  Inserting ${sourceData.segments.length} new segments...`);
	insertSegments(canonical, sourceData.segments);
	console.log('  Purging hallucinated segments...');
	purgeEpisode(canonical);

	// ── Step 5: Clear episode_guests + stale timeline metadata ───────────
	console.log('\n=== Step 4/6: Clear episode_guests + stale timeline metadata ===');
	runSQL(`DELETE FROM episode_guests WHERE episode_id = '${escapeSQL(canonical)}'`);
	// guest_start_ms / guests_reviewed refer to the OLD canonical timeline;
	// reset so backfill-guest-start.js re-derives them and review redone.
	console.log('  Resetting guest_start_ms (NULL) and guests_reviewed (0)...');
	runSQL(
		`UPDATE episodes SET guest_start_ms = NULL, guests_reviewed = 0
		 WHERE id = '${escapeSQL(canonical)}'`
	);
	const mentionCount = queryJSON(
		`SELECT COUNT(*) AS n FROM place_mentions WHERE episode_id = '${escapeSQL(canonical)}'`
	)[0]?.n ?? 0;
	if (mentionCount > 0) {
		console.warn(
			`  WARNING: ${mentionCount} place_mentions row(s) for ${canonical} keep snippet/` +
			'snippet_start_ms from the OLD transcript timeline — re-run place analysis for this episode.'
		);
	}

	// ── Step 6: Regenerate embeddings + summary via process-episode.js ──
	console.log('\n=== Step 5/6: Regenerate embeddings + title/summary ===');
	execFileSync(
		process.execPath,
		[
			path.join(projectRoot, 'scripts', 'process-episode.js'),
			mp3,
			'--episode-id', canonical,
			'--force',
			'--skip', 'transcribe,seed-db,upload-audio',
		],
		{ cwd: projectRoot, stdio: 'inherit' }
	);

	// ── Step 7: Delete source duplicate entirely ─────────────────────────
	console.log('\n=== Step 6/6: Delete source duplicate ===');
	execFileSync(
		process.execPath,
		[path.join(projectRoot, 'scripts', 'delete-episode.js'), source],
		{ cwd: projectRoot, stdio: 'inherit' }
	);

	// ── Verify ────────────────────────────────────────────────────────────
	console.log('\n=== Verify canonical ===');
	const after = queryJSON(
		`SELECT id, title, audio_file, duration_ms,
			(SELECT COUNT(*) FROM transcript_segments WHERE episode_id = e.id) AS segments,
			(SELECT COUNT(*) FROM episode_guests WHERE episode_id = e.id) AS guests
		 FROM episodes e WHERE id = '${escapeSQL(canonical)}'`
	);
	console.log(`  ${JSON.stringify(after[0])}`);

	// Merge succeeded: archive the pre-merge backup so a future merge of
	// this episode doesn't mistake it for a crashed run, while keeping the
	// original transcript recoverable.
	if (fs.existsSync(backupTranscript)) {
		const backupsDir = path.join(transcriptsDir, '.backups');
		fs.mkdirSync(backupsDir, { recursive: true });
		const stamp = new Date().toISOString().replace(/[:.]/g, '-');
		const archived = path.join(backupsDir, `${canonical}.pre-merge.${stamp}.json`);
		fs.renameSync(backupTranscript, archived);
		console.log(`  Archived pre-merge transcript backup to ${archived}`);
	}
	if (mentionCount > 0) {
		console.warn(
			`  REMINDER: re-run place analysis for ${canonical} — ${mentionCount} place_mentions ` +
			'snippet(s) still reference the old transcript timeline.'
		);
	}

	console.log('\n=== Done ===');
}

main().catch((err) => {
	console.error(`\nFATAL: ${err.message}`);
	process.exit(1);
});
