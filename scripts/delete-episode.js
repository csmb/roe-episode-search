#!/usr/bin/env node

/**
 * Remove an episode from D1 and Vectorize, after backing it up with
 * episode-backup.js (transcripts/.backups/). Without --yes it only shows what
 * it would remove.
 *
 * Its search vectors are every ID in the index that starts with
 * "<episode_id>:" (the backup lists the index to find them), so the ones an
 * older transcript left go too. With --local, Vectorize is neither read nor
 * changed.
 *
 * The local transcript file is moved into the backup. The episode's .m4a in R2
 * is kept unless --delete-audio is given (then it is backed up first); raw MP3
 * uploads are never touched.
 *
 * Usage:
 *   node scripts/delete-episode.js <episode_id>                          # dry run
 *   node scripts/delete-episode.js <episode_id> --yes [--delete-audio] [--local]
 */

import fs from 'node:fs';
import path from 'node:path';

import {
	loadEnv, escapeSQL, queryJSON, runSQL, wranglerExec,
	transcriptsDir, R2_BUCKET,
} from './lib.js';
import { deleteEpisodeVectors } from '../roe-pipeline/src/embeddings.js';
import { backupEpisode } from './episode-backup.js';
import { remoteVectorize } from './remote-cloudflare.js';

loadEnv();

function rowCounts(episodeId, target) {
	const id = escapeSQL(episodeId);
	return queryJSON(
		`SELECT
			(SELECT COUNT(*) FROM episodes WHERE id = '${id}') AS episodes,
			(SELECT COUNT(*) FROM transcript_segments WHERE episode_id = '${id}') AS segments,
			(SELECT COUNT(*) FROM episode_guests WHERE episode_id = '${id}') AS guests,
			(SELECT COUNT(*) FROM place_mentions WHERE episode_id = '${id}') AS places`,
		target
	)[0];
}

/**
 * Back up an episode, then delete it. Returns the backup (see episode-backup.js).
 * @param {string} episodeId
 * @param {{isLocal?: boolean, deleteAudio?: boolean, backup?: object, reason?: string, vectorize?: object}} [opts]
 *   backup: one taken since the episode last changed (merge-episode.js has one already).
 */
export async function deleteEpisode(episodeId, { isLocal = false, deleteAudio = false, backup = null, reason, vectorize = null } = {}) {
	const target = { isLocal };
	const id = escapeSQL(episodeId);

	// ── Step 1: Back up (nothing is deleted if this fails) ───────────────
	console.log('\n=== Step 1/5: Back up ===');
	if (backup) console.log(`  Already backed up: ${backup.dir}`);
	// The .m4a goes into the backup too when it is about to be deleted
	backup ??= await backupEpisode(episodeId, { isLocal, withAudio: deleteAudio, reason: reason ?? 'before delete-episode.js deleted it', vectorize });

	// ── Step 2: Delete from Vectorize ────────────────────────────────────
	// Every vector the backup's listing has under the episode's ID
	console.log('\n=== Step 2/5: Delete Vectorize embeddings ===');
	if (isLocal) {
		console.log('  --local: Vectorize has no local copy, so it was neither read nor changed');
	} else if (backup.vectorIds.length > 0) {
		await deleteEpisodeVectors(vectorize ?? remoteVectorize(), episodeId, backup.vectorIds);
	} else {
		console.log('  The index has no vectors for this episode');
	}

	// ── Step 3: Delete D1 rows ───────────────────────────────────────────
	console.log('\n=== Step 3/5: Delete D1 rows ===');
	// transcript_segments (triggers transcript_fts cleanup via segments_ad)
	console.log('  Deleting transcript_segments (and FTS via trigger)...');
	runSQL(`DELETE FROM transcript_segments WHERE episode_id = '${id}'`, target);
	console.log('  Deleting episode_guests...');
	runSQL(`DELETE FROM episode_guests WHERE episode_id = '${id}'`, target);
	console.log('  Deleting place_mentions...');
	runSQL(`DELETE FROM place_mentions WHERE episode_id = '${id}'`, target);
	console.log('  Deleting episodes row...');
	runSQL(`DELETE FROM episodes WHERE id = '${id}'`, target);

	// ── Step 4: Audio (only with --delete-audio) and the local transcript ─
	console.log('\n=== Step 4/5: Audio and local transcript ===');
	const r2Key = `${episodeId}.m4a`;
	if (deleteAudio) {
		try {
			wranglerExec(['r2', 'object', 'delete', isLocal ? '--local' : '--remote', `${R2_BUCKET}/${r2Key}`], { stdio: 'pipe' });
			console.log(`  Deleted R2 object: ${r2Key}`);
		} catch (err) {
			console.log(`  No R2 object to delete (or delete failed): ${err.message.split('\n')[0]}`);
		}
	} else {
		console.log(`  Kept ${r2Key} in R2. If the episode is redone from different audio, delete it too`);
		console.log('  (--delete-audio), or the site keeps playing the old recording.');
	}
	const transcriptPath = path.join(transcriptsDir, `${episodeId}.json`);
	if (backup.transcriptFile && fs.existsSync(transcriptPath)) {
		fs.renameSync(transcriptPath, backup.transcriptFile);
		console.log(`  Moved ${path.basename(transcriptPath)} into the backup`);
	} else {
		console.log('  No local transcript file');
	}

	// ── Step 5: Verify ───────────────────────────────────────────────────
	console.log('\n=== Step 5/5: Verify ===');
	console.log(`  Remaining rows: ${JSON.stringify(rowCounts(episodeId, target))}`);
	console.log(`  Backup: ${backup.dir}`);
	return backup;
}

function usage(problem) {
	if (problem) console.error(`${problem}\n`);
	console.error('Usage: node scripts/delete-episode.js <episode_id> [--yes] [--delete-audio] [--local]');
	console.error('');
	console.error('  (no --yes)      Show what would be deleted, and change nothing');
	console.error('  --yes           Back the episode up, then delete it from D1 and Vectorize');
	console.error('  --delete-audio  Also delete its .m4a from R2 (raw MP3 uploads are never deleted)');
	console.error('  --local         Use the local D1 copy and R2 (Vectorize is neither read nor changed)');
	process.exit(1);
}

async function main() {
	const args = process.argv.slice(2);
	const options = new Set(['--yes', '--delete-audio', '--local']);
	const unknown = args.filter((a) => a.startsWith('-') && !options.has(a));
	const ids = args.filter((a) => !a.startsWith('-'));
	if (unknown.length > 0) usage(`Unknown option: ${unknown.join(' ')}`);
	if (ids.length !== 1) usage();
	const [episodeId] = ids;
	const yes = args.includes('--yes');
	const deleteAudio = args.includes('--delete-audio');
	const isLocal = args.includes('--local');

	console.log(`=== ${yes ? 'Deleting' : 'Dry run: would delete'} episode: ${episodeId}${isLocal ? ' (local D1 copy)' : ''} ===\n`);

	// ── Confirm episode exists ────────────────────────────────────────────
	const rows = queryJSON(
		`SELECT id, title, audio_file FROM episodes WHERE id = '${escapeSQL(episodeId)}'`,
		{ isLocal }
	);
	if (rows.length === 0) {
		console.error(`Episode not found in D1: ${episodeId}`);
		process.exit(1);
	}
	const counts = rowCounts(episodeId, { isLocal });
	const hasTranscript = fs.existsSync(path.join(transcriptsDir, `${episodeId}.json`));
	console.log(`Found: "${rows[0].title}"`);
	console.log(`  audio_file: ${rows[0].audio_file ?? '(null)'}`);
	console.log(`  ${counts.segments} transcript lines, ${counts.guests} guests, ${counts.places} place links`);
	console.log(`  search vectors: ${isLocal ? 'left alone (--local)' : `every one whose ID starts with "${episodeId}:" (the index is listed when it runs)`}`);
	console.log(`  local transcript: ${hasTranscript ? 'yes (moved into the backup)' : 'none'}`);
	console.log(`  ${episodeId}.m4a: ${deleteAudio ? 'deleted from R2' : 'kept in R2 (--delete-audio to delete it)'}`);

	if (!yes) {
		console.log('\nNothing was changed. Run again with --yes to back the episode up and delete it.');
		return;
	}

	await deleteEpisode(episodeId, { isLocal, deleteAudio });
	console.log('\n=== Done ===');
}

if (import.meta.main) {
	main().catch((err) => {
		console.error(`\nFATAL: ${err.message}`);
		process.exit(1);
	});
}
