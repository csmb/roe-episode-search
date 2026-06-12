#!/usr/bin/env node

/**
 * Fully remove an episode from all stores: Vectorize, D1, local transcript, R2.
 *
 * Usage: node scripts/delete-episode.js <episode_id>
 */

import fs from 'node:fs';
import path from 'node:path';

import {
	loadEnv, escapeSQL, queryJSON, runSQL, wranglerExec,
	transcriptsDir,
} from './lib.js';
import { chunkEpisode } from './generate-embeddings.js';

loadEnv();

const INDEX_NAME = 'roe-transcripts';
const R2_BUCKET = 'roe-audio';
const DELETE_BATCH_SIZE = 100;

function deleteVectors(ids) {
	for (let i = 0; i < ids.length; i += DELETE_BATCH_SIZE) {
		const batch = ids.slice(i, i + DELETE_BATCH_SIZE);
		wranglerExec(
			['vectorize', 'delete-vectors', INDEX_NAME, '--ids', ...batch],
			{ stdio: 'pipe' }
		);
		console.log(`  Deleted ${batch.length} vectors (${i + batch.length}/${ids.length})`);
	}
}

async function main() {
	const episodeId = process.argv[2];
	if (!episodeId) {
		console.error('Usage: node scripts/delete-episode.js <episode_id>');
		process.exit(1);
	}

	console.log(`=== Deleting episode: ${episodeId} ===\n`);

	// ── Confirm episode exists ────────────────────────────────────────────
	const rows = queryJSON(
		`SELECT id, title, audio_file FROM episodes WHERE id = '${escapeSQL(episodeId)}'`
	);
	if (rows.length === 0) {
		console.error(`Episode not found in D1: ${episodeId}`);
		process.exit(1);
	}
	console.log(`Found: "${rows[0].title}"`);
	console.log(`  audio_file: ${rows[0].audio_file ?? '(null)'}\n`);

	// ── Step 1: Delete from Vectorize ────────────────────────────────────
	console.log('=== Step 1/5: Delete Vectorize embeddings ===');
	const transcriptPath = path.join(transcriptsDir, `${episodeId}.json`);
	if (fs.existsSync(transcriptPath)) {
		const transcript = JSON.parse(fs.readFileSync(transcriptPath, 'utf-8'));
		const chunks = chunkEpisode(transcript);
		const ids = [...new Set(chunks.map((c) => c.id))];
		console.log(`  Computed ${ids.length} unique vector ids from transcript`);
		if (ids.length > 0) {
			deleteVectors(ids);
		}
	} else {
		console.log(`  No transcript file at ${transcriptPath}, skipping vector delete`);
	}

	// ── Step 2: Delete D1 rows ───────────────────────────────────────────
	console.log('\n=== Step 2/5: Delete D1 rows ===');
	// transcript_segments (triggers transcript_fts cleanup via segments_ad)
	console.log('  Deleting transcript_segments (and FTS via trigger)...');
	runSQL(`DELETE FROM transcript_segments WHERE episode_id = '${escapeSQL(episodeId)}'`);
	// episode_guests
	console.log('  Deleting episode_guests...');
	runSQL(`DELETE FROM episode_guests WHERE episode_id = '${escapeSQL(episodeId)}'`);
	// place_mentions
	console.log('  Deleting place_mentions...');
	runSQL(`DELETE FROM place_mentions WHERE episode_id = '${escapeSQL(episodeId)}'`);
	// episodes
	console.log('  Deleting episodes row...');
	runSQL(`DELETE FROM episodes WHERE id = '${escapeSQL(episodeId)}'`);

	// ── Step 3: Delete R2 object (if any) ────────────────────────────────
	console.log('\n=== Step 3/5: Delete R2 audio (if present) ===');
	const r2Key = `${episodeId}.m4a`;
	try {
		wranglerExec(['r2', 'object', 'delete', `${R2_BUCKET}/${r2Key}`], { stdio: 'pipe' });
		console.log(`  Deleted R2 object: ${r2Key}`);
	} catch (err) {
		console.log(`  No R2 object to delete (or delete failed): ${err.message.split('\n')[0]}`);
	}

	// ── Step 4: Delete local transcript file ─────────────────────────────
	console.log('\n=== Step 4/5: Delete local transcript ===');
	if (fs.existsSync(transcriptPath)) {
		fs.unlinkSync(transcriptPath);
		console.log(`  Deleted ${transcriptPath}`);
	} else {
		console.log(`  No local transcript file`);
	}

	// ── Step 5: Verify ───────────────────────────────────────────────────
	console.log('\n=== Step 5/5: Verify ===');
	const after = queryJSON(
		`SELECT
			(SELECT COUNT(*) FROM episodes WHERE id = '${escapeSQL(episodeId)}') AS episodes,
			(SELECT COUNT(*) FROM transcript_segments WHERE episode_id = '${escapeSQL(episodeId)}') AS segments,
			(SELECT COUNT(*) FROM episode_guests WHERE episode_id = '${escapeSQL(episodeId)}') AS guests,
			(SELECT COUNT(*) FROM place_mentions WHERE episode_id = '${escapeSQL(episodeId)}') AS places`
	);
	console.log(`  Remaining rows: ${JSON.stringify(after[0])}`);

	console.log('\n=== Done ===');
}

main().catch((err) => {
	console.error(`\nFATAL: ${err.message}`);
	process.exit(1);
});
