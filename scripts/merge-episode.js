#!/usr/bin/env node

/**
 * Merge a duplicate episode (the source) into the canonical episode of the
 * same date. The canonical keeps its ID and place links; it gets the source's
 * transcript, new search vectors, and the --mp3 file as its audio. The source
 * is then deleted. Both episodes are backed up first (episode-backup.js).
 *
 * Reviewed guests are kept: if the canonical was reviewed, its title, summary,
 * guests and interview time stay; if only the source was, those are copied
 * from the source. Otherwise they are made again (process-episode.js). With
 * --include-reviewed they are always made again.
 *
 * The MP3 must be the recording the source transcript came from: it is refused
 * if the transcript runs past its end.
 *
 * Usage:
 *   node scripts/merge-episode.js --canonical <id> --source <id> --mp3 <path>
 *     [--include-reviewed] [--delete-audio] [--local]
 *
 *   --delete-audio  also delete the source's .m4a from R2
 *   --local         the local D1 copy and R2; Vectorize, embeddings and the summary are left alone
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
	loadEnv, escapeSQL, queryJSON, runSQL, wranglerExec,
	transcriptsDir, projectRoot, applyWordCorrections, parseEpisodeDate, convertAudio,
} from './lib.js';
import { purgeEpisode } from './clean-hallucinations.js';
import { backupEpisode } from './episode-backup.js';
import { deleteEpisode } from './delete-episode.js';

loadEnv();

const INDEX_NAME = 'roe-transcripts';
const R2_BUCKET = 'roe-audio';
const R2_PUBLIC_URL = 'https://pub-e95bd2be3f9d4147b2955503d75e50c1.r2.dev';
const DELETE_BATCH_SIZE = 100;
const DB_BATCH_SIZE = 50;
// Whisper's last line can end a little after the audio does; more than this and it's another recording
const LENGTH_TOLERANCE_MS = 30_000;

function usage(problem) {
	if (problem) console.error(`${problem}\n`);
	console.error('Usage: node scripts/merge-episode.js --canonical <id> --source <id> --mp3 <path>');
	console.error('         [--include-reviewed] [--delete-audio] [--local]');
	process.exit(1);
}

function parseArgs() {
	const args = process.argv.slice(2);
	const opts = { canonical: null, source: null, mp3: null, includeReviewed: false, deleteAudio: false, local: false };
	const flags = { '--include-reviewed': 'includeReviewed', '--delete-audio': 'deleteAudio', '--local': 'local' };
	for (let i = 0; i < args.length; i++) {
		const name = args[i].replace(/^--/, '');
		if (['--canonical', '--source', '--mp3'].includes(args[i])) {
			if (!args[i + 1] || args[i + 1].startsWith('--')) usage(`${args[i]} needs a value`);
			opts[name] = args[++i];
		} else if (flags[args[i]]) {
			opts[flags[args[i]]] = true;
		} else {
			usage(`Unknown option: ${args[i]}`);
		}
	}
	if (!opts.canonical || !opts.source || !opts.mp3) usage();
	return opts;
}

function formatMs(ms) {
	const s = Math.round(ms / 1000);
	return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function audioDurationMs(file) {
	const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf-8' });
	const seconds = parseFloat(out);
	if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`ffprobe could not read the length of ${file}`);
	return Math.round(seconds * 1000);
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

function insertSegments(episodeId, segments, target) {
	for (let i = 0; i < segments.length; i += DB_BATCH_SIZE) {
		const batch = segments.slice(i, i + DB_BATCH_SIZE);
		const values = batch
			.map((s) => `('${escapeSQL(episodeId)}', ${s.start_ms}, ${s.end_ms}, '${escapeSQL(applyWordCorrections(s.text))}')`)
			.join(', ');
		runSQL(`INSERT INTO transcript_segments (episode_id, start_ms, end_ms, text) VALUES ${values}`, target);
	}
}

async function main() {
	const { canonical, source, mp3, includeReviewed, deleteAudio, local } = parseArgs();
	const target = { isLocal: local };

	// ── Refuse what can't be a merge ──────────────────────────────────────
	if (canonical === source) usage('--canonical and --source are the same episode: that would delete it');
	const date = parseEpisodeDate(canonical);
	if (!date || parseEpisodeDate(source) !== date) {
		usage(`${canonical} and ${source} are not from the same date: only a same-date duplicate can be merged`);
	}
	if (!fs.existsSync(mp3)) usage(`MP3 not found: ${mp3}`);
	const sourceTranscript = path.join(transcriptsDir, `${source}.json`);
	if (!fs.existsSync(sourceTranscript)) usage(`Source transcript not found: ${sourceTranscript}`);

	const select = (id) => queryJSON(
		`SELECT id, title, summary, audio_file, duration_ms, guests_reviewed, guest_start_ms FROM episodes WHERE id = '${escapeSQL(id)}'`,
		target
	)[0];
	const canonicalRow = select(canonical);
	const sourceRow = select(source);
	if (!canonicalRow) usage(`Canonical episode not found in D1: ${canonical}`);
	if (!sourceRow) usage(`Source episode not found in D1: ${source}`);

	// The audio must be the recording the transcript came from
	const sourceData = JSON.parse(fs.readFileSync(sourceTranscript, 'utf-8'));
	const transcriptEndMs = sourceData.segments.reduce((end, s) => Math.max(end, s.end_ms), 0);
	const audioMs = audioDurationMs(mp3);
	if (transcriptEndMs > audioMs + LENGTH_TOLERANCE_MS) {
		usage(`The source transcript runs to ${formatMs(transcriptEndMs)} but ${path.basename(mp3)} is ${formatMs(audioMs)} long: ` +
			'it is not the recording the transcript came from');
	}

	console.log(`=== Merging episode${local ? ' (local D1 copy)' : ''} ===`);
	console.log(`  Canonical:  ${canonical}  "${canonicalRow.title}"${canonicalRow.guests_reviewed ? ' (reviewed)' : ''}`);
	console.log(`  Source:     ${source}  "${sourceRow.title}"${sourceRow.guests_reviewed ? ' (reviewed)' : ''}`);
	console.log(`  Audio:      ${path.basename(mp3)} (${formatMs(audioMs)}; the transcript ends at ${formatMs(transcriptEndMs)})`);

	// Convert the audio before changing anything, in case ffmpeg can't
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roe-merge-'));
	try {
		console.log('  Converting the MP3 to M4A...');
		const m4aPath = convertAudio(mp3, tmpDir);
		await merge({ canonical, source, mp3, m4aPath, audioMs, sourceData, canonicalRow, sourceRow, includeReviewed, deleteAudio, local });
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

async function merge({ canonical, source, mp3, m4aPath, audioMs, sourceData, canonicalRow, sourceRow, includeReviewed, deleteAudio, local }) {
	const target = { isLocal: local };
	const canonicalTranscript = path.join(transcriptsDir, `${canonical}.json`);

	// ── Step 1: Back up both episodes (nothing changes if this fails) ────
	console.log('\n=== Step 1/7: Back up both episodes ===');
	const canonicalBackup = backupEpisode(canonical, { isLocal: local, reason: `before merge-episode.js merged ${source} into it` });
	const sourceBackup = backupEpisode(source, { isLocal: local, reason: `before merge-episode.js merged it into ${canonical} and deleted it` });

	// ── Step 2: Delete the canonical's old vectors ───────────────────────
	// Vector IDs are `${episode_id}:${chunkStartMs}` on the OLD timeline, so
	// they are taken from the backup before anything else changes. That also
	// makes a merge that stopped partway safe to run again.
	console.log('\n=== Step 2/7: Delete the canonical\'s old vectors ===');
	if (local) {
		console.log(`  --local: Vectorize has no local copy, so its ${canonicalBackup.vectorIds.length} vectors are left alone`);
	} else if (canonicalBackup.vectorIds.length > 0) {
		deleteVectors(canonicalBackup.vectorIds);
	} else {
		console.log('  No old vectors found');
	}

	// ── Step 3: Swap transcript file, set internal episode_id ────────────
	console.log('\n=== Step 3/7: Swap transcript file ===');
	sourceData.episode_id = canonical;
	fs.writeFileSync(canonicalTranscript, JSON.stringify(sourceData, null, 2));
	console.log(`  Wrote ${path.basename(canonicalTranscript)} (${sourceData.segments.length} segments)`);

	// ── Step 4: Replace segments in D1 ───────────────────────────────────
	console.log('\n=== Step 4/7: Replace transcript_segments ===');
	console.log('  Deleting old segments (FTS auto-cleans via trigger)...');
	runSQL(`DELETE FROM transcript_segments WHERE episode_id = '${escapeSQL(canonical)}'`, target);
	console.log(`  Inserting ${sourceData.segments.length} new segments...`);
	insertSegments(canonical, sourceData.segments, target);
	console.log('  Purging hallucinated segments...');
	purgeEpisode(canonical, target);

	// ── Step 5: Title, summary, guests and interview time ────────────────
	console.log('\n=== Step 5/7: Title, summary, guests and interview time ===');
	const id = escapeSQL(canonical);
	let remake = false;
	if (canonicalRow.guests_reviewed && !includeReviewed) {
		console.log('  The canonical was reviewed: its title, summary, guests and interview time are kept.');
		if (canonicalRow.guest_start_ms > audioMs) {
			console.warn(`  WARNING: the interview time (${formatMs(canonicalRow.guest_start_ms)}) is past the end of the new audio. Set it again`);
			console.warn('  by hand, or with process-episode.js … --force guest-start --include-reviewed.');
		} else if (canonicalRow.guest_start_ms != null) {
			console.log(`  Check the interview time (${formatMs(canonicalRow.guest_start_ms)}) against the new audio.`);
		}
	} else if (sourceRow.guests_reviewed && !includeReviewed) {
		console.log('  The source was reviewed: copying its title, summary, guests and interview time.');
		const guests = queryJSON(`SELECT guest_name FROM episode_guests WHERE episode_id = '${escapeSQL(source)}'`, target);
		const title = sourceRow.title !== source ? sourceRow.title : canonicalRow.title; // an untitled source keeps the canonical's
		runSQL(
			`UPDATE episodes SET title = '${escapeSQL(title)}', summary = ${sourceRow.summary == null ? 'NULL' : `'${escapeSQL(sourceRow.summary)}'`},
				guest_start_ms = ${sourceRow.guest_start_ms ?? 'NULL'}, guests_reviewed = 1 WHERE id = '${id}'`,
			target
		);
		runSQL(`DELETE FROM episode_guests WHERE episode_id = '${id}'`, target);
		for (const { guest_name } of guests) {
			runSQL(`INSERT OR IGNORE INTO episode_guests (episode_id, guest_name) VALUES ('${id}', '${escapeSQL(guest_name)}')`, target);
		}
	} else {
		// Made again by process-episode.js below, from the new transcript
		remake = true;
		console.log('  Clearing guests and the interview time (made again from the new transcript)...');
		runSQL(`DELETE FROM episode_guests WHERE episode_id = '${id}'`, target);
		runSQL(`UPDATE episodes SET guest_start_ms = NULL, guests_reviewed = 0 WHERE id = '${id}'`, target);
	}
	const mentionCount = queryJSON(`SELECT COUNT(*) AS n FROM place_mentions WHERE episode_id = '${id}'`, target)[0]?.n ?? 0;
	if (mentionCount > 0) {
		console.warn(`  WARNING: ${mentionCount} place_mentions row(s) keep quotes and times from the OLD transcript.`);
	}

	// ── Step 6: The MP3 becomes the audio ────────────────────────────────
	console.log('\n=== Step 6/7: Upload the audio ===');
	const r2Key = `${canonical}.m4a`;
	console.log(`  Uploading ${r2Key} to R2${local ? ' (local)' : ''}...`);
	wranglerExec(['r2', 'object', 'put', local ? '--local' : '--remote', `${R2_BUCKET}/${r2Key}`, `--file=${m4aPath}`, '--content-type=audio/mp4']);
	runSQL(`UPDATE episodes SET audio_file = '${escapeSQL(`${R2_PUBLIC_URL}/${r2Key}`)}', duration_ms = ${audioMs} WHERE id = '${id}'`, target);

	// ── Step 7: Embeddings (and the summary, if it's made again) ─────────
	console.log('\n=== Step 7/7: Regenerate embeddings' + (remake ? ' + title/summary/guests + interview time' : '') + ' ===');
	if (local) {
		console.log('  --local: skipped (Vectorize and OpenAI have no local copy)');
	} else {
		execFileSync(
			process.execPath,
			[
				path.join(projectRoot, 'scripts', 'process-episode.js'),
				mp3,
				'--episode-id', canonical,
				'--skip', remake ? 'transcribe,seed-db,upload-audio' : 'transcribe,seed-db,summary,guest-start,upload-audio',
				...(remake ? ['--force', 'summary,guest-start'] : []),
			],
			{ cwd: projectRoot, stdio: 'inherit' }
		);
	}

	// ── Delete the source (already backed up) ────────────────────────────
	console.log('\n=== Delete the source duplicate ===');
	deleteEpisode(source, { isLocal: local, deleteAudio, backup: sourceBackup });

	// ── Verify ────────────────────────────────────────────────────────────
	console.log('\n=== Verify canonical ===');
	const after = queryJSON(
		`SELECT id, title, audio_file, duration_ms, guests_reviewed, guest_start_ms,
			(SELECT COUNT(*) FROM transcript_segments WHERE episode_id = e.id) AS segments,
			(SELECT COUNT(*) FROM episode_guests WHERE episode_id = e.id) AS guests
		 FROM episodes e WHERE id = '${id}'`,
		target
	);
	console.log(`  ${JSON.stringify(after[0])}`);
	console.log(`  Backups: ${canonicalBackup.dir}`);
	console.log(`           ${sourceBackup.dir}`);
	if (mentionCount > 0) {
		console.warn(`  REMINDER: redo the canonical's places (node scripts/redo-places.js ${canonical}): ` +
			`${mentionCount} quote(s) still come from the old transcript.`);
	}

	console.log('\n=== Done ===');
}

main().catch((err) => {
	console.error(`\nFATAL: ${err.message}`);
	process.exit(1);
});
