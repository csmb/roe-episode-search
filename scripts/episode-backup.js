#!/usr/bin/env node

/**
 * Back up one episode before it is deleted or merged: its D1 rows (the
 * episode, transcript lines, guests and place links), its search vectors, the
 * local transcript file if there is one, and with --with-audio its .m4a from
 * R2. Writes restore SQL and a README that says how to put everything back.
 * delete-episode.js and merge-episode.js call it first (with the audio when
 * they delete or replace it); it can also be run on its own.
 *
 * The vector IDs are worked out from the transcript lines in D1 (and from the
 * local file, when there is one), so an episode that came in by drag and drop,
 * with no local files, is covered too.
 *
 * Usage:
 *   node scripts/episode-backup.js <episode-id> [--with-audio] [--local]
 *
 * Backups go to transcripts/.backups/<date>-<episode-id>/ (git ignores transcripts/).
 */

import fs from 'node:fs';
import path from 'node:path';

import { escapeSQL, queryJSON, wranglerExec, transcriptsDir, R2_BUCKET, VECTORIZE_INDEX } from './lib.js';
import { inlineParams } from './remote-d1.js';
import { chunkEpisode } from './generate-embeddings.js';

const GET_BATCH_SIZE = 20; // wrangler vectorize get-vectors takes at most 20 IDs
const backupsDir = path.join(transcriptsDir, '.backups');

/** Every ID a vector of this episode can have: chunk the D1 lines, and the local file (which can differ). */
function candidateVectorIds(episodeId, lines, localTranscript) {
	const ids = new Set(chunkEpisode({ episode_id: episodeId, title: episodeId, segments: lines }).map((c) => c.id));
	if (localTranscript) {
		for (const c of chunkEpisode({ ...localTranscript, episode_id: episodeId })) ids.add(c.id);
	}
	return [...ids];
}

/** Read the vectors that exist for these IDs (a read; missing IDs are left out). */
function getVectors(ids) {
	const found = [];
	for (let i = 0; i < ids.length; i += GET_BATCH_SIZE) {
		const out = wranglerExec(['vectorize', 'get-vectors', VECTORIZE_INDEX, '--ids', ...ids.slice(i, i + GET_BATCH_SIZE)]);
		// A banner, then the vectors as a JSON array (nothing when none match)
		const start = out.indexOf('\n[');
		if (start !== -1) found.push(...JSON.parse(out.slice(start)));
	}
	return found.map(({ id, values, metadata }) => ({ id, values, metadata }));
}

/** Download the episode's .m4a from R2 into the backup folder (null if R2 has none). */
function backupAudio(episodeId, dir, isLocal) {
	const file = path.join(dir, `${episodeId}.m4a`);
	try {
		wranglerExec(['r2', 'object', 'get', `${R2_BUCKET}/${episodeId}.m4a`, isLocal ? '--local' : '--remote', `--file=${file}`]);
		return file;
	} catch (err) {
		if (/The specified key does not exist/.test(err.message)) return null;
		throw err;
	}
}

/** An INSERT (or `INSERT OR IGNORE`) that puts back one row exactly, every column as it was. */
export function insertStatement(table, row, verb = 'INSERT') {
	const cols = Object.keys(row);
	return inlineParams(`${verb} INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')});`, cols.map((c) => row[c]));
}

/** SQL that puts the episode's rows back exactly, after removing whatever it has now. */
function restoreSQL(episodeId, rows) {
	const id = escapeSQL(episodeId);
	const placeNames = new Map(rows.places.map((p) => [p.id, p.name]));
	const sql = [
		`-- Puts ${episodeId} back as it was when the backup was taken.`,
		'-- It first removes whatever the database holds for the episode now.',
		`DELETE FROM place_mentions WHERE episode_id = '${id}';`,
		`DELETE FROM episode_guests WHERE episode_id = '${id}';`,
		`DELETE FROM transcript_segments WHERE episode_id = '${id}';`,
		`DELETE FROM episodes WHERE id = '${id}';`,
		...rows.episodes.map((r) => insertStatement('episodes', r)),
		...rows.transcript_segments.map((r) => insertStatement('transcript_segments', r)),
		...rows.episode_guests.map((r) => insertStatement('episode_guests', r)),
		'-- Place links find their place by name; a place deleted since then is not brought back.',
	];
	for (const mention of rows.place_mentions) {
		const cols = Object.keys(mention).filter((c) => c !== 'place_id');
		sql.push(inlineParams(
			`INSERT INTO place_mentions (place_id, ${cols.join(', ')}) SELECT id, ${cols.map(() => '?').join(', ')} FROM places WHERE name = ?;`,
			[...cols.map((c) => mention[c]), placeNames.get(mention.place_id)]
		));
	}
	return sql.join('\n') + '\n';
}

/** A new folder transcripts/.backups/<date>-<label>/ (…-2, …-3 when that is taken). */
export function newBackupDir(label) {
	const now = new Date();
	const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((n) => String(n).padStart(2, '0')).join('-');
	fs.mkdirSync(backupsDir, { recursive: true });
	for (let n = 1; ; n++) {
		const dir = path.join(backupsDir, `${date}-${label}${n > 1 ? `-${n}` : ''}`);
		try {
			fs.mkdirSync(dir);
			return dir;
		} catch (err) {
			if (err.code !== 'EEXIST') throw err;
		}
	}
}

function readme({ episodeId, dir, rows, vectors, candidates, hasTranscript, audioFile, isLocal, reason }) {
	const where = isLocal ? '--local' : '--remote';
	const audio = rows.episodes[0].audio_file ?? '(none)';
	return [
		`Backup of ${episodeId}, taken ${new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })} ${reason}.`,
		`Rows from the ${isLocal ? 'local D1 copy (--local)' : 'production D1 database'}.`,
		'',
		`  d1-rows.json    the rows as they were: the episode, ${rows.transcript_segments.length} transcript lines,`,
		`                  ${rows.episode_guests.length} guests, ${rows.place_mentions.length} place links and the places they point to`,
		'  restore.sql     puts those rows back exactly (first removing the rows the episode has',
		'                  when you run it)',
		vectors.length > 0
			? `  vectors.ndjson  its ${vectors.length} search vectors (of ${candidates} possible IDs from the transcript)`
			: `  (no search vectors found for the ${candidates} possible IDs from the transcript)`,
		hasTranscript ? `  ${episodeId}.json  the local transcript file` : '  (there was no local transcript file)',
		...(audioFile ? [`  ${episodeId}.m4a  its audio from R2, as it was`] : []),
		'',
		'To put it back:',
		'  cd roe-search',
		`  env -u CLOUDFLARE_API_TOKEN npx wrangler d1 execute roe-episodes ${where} --file "${path.join(dir, 'restore.sql')}"`,
		...(vectors.length > 0 && !isLocal
			? [`  env -u CLOUDFLARE_API_TOKEN npx wrangler vectorize upsert ${VECTORIZE_INDEX} --file "${path.join(dir, 'vectors.ndjson')}"`]
			: []),
		...(hasTranscript ? [`  cp "${path.join(dir, `${episodeId}.json`)}" ../transcripts/`] : []),
		...(audioFile
			? [`  env -u CLOUDFLARE_API_TOKEN npx wrangler r2 object put ${R2_BUCKET}/${episodeId}.m4a ${where} --file "${audioFile}" --content-type audio/mp4`]
			: []),
		...(isLocal && vectors.length > 0 ? ['(The vectors are production\'s: a --local run never changes Vectorize.)'] : []),
		'',
		...(audioFile ? [] : [
			`The audio is not in the backup: ${audio}`,
			`Raw MP3 uploads are never deleted. If ${episodeId}.m4a was, remake it with`,
			`  node scripts/repair-missing-m4a.js --only ${episodeId}`,
			'',
		]),
	].join('\n');
}

/**
 * Back up an episode. Throws (writing nothing) if it isn't in the database or a read fails.
 * @param {string} episodeId
 * @param {{isLocal?: boolean, reason?: string, withAudio?: boolean}} [opts] - reason completes
 *   "taken <time> …" in the README; withAudio also saves the .m4a (for a delete or merge that replaces it)
 * @returns {{dir: string, rows: object, vectorIds: string[], transcriptFile: string|null, audioFile: string|null}}
 *   vectorIds are the vectors that exist (what a delete should remove).
 */
export function backupEpisode(episodeId, { isLocal = false, reason = 'by hand', withAudio = false } = {}) {
	const target = { isLocal };
	const id = escapeSQL(episodeId);
	const episodes = queryJSON(`SELECT * FROM episodes WHERE id = '${id}'`, target);
	if (episodes.length === 0) throw new Error(`${episodeId} is not in the ${isLocal ? 'local' : 'production'} database`);
	const rows = {
		episodes,
		transcript_segments: queryJSON(`SELECT * FROM transcript_segments WHERE episode_id = '${id}' ORDER BY id`, target),
		episode_guests: queryJSON(`SELECT * FROM episode_guests WHERE episode_id = '${id}' ORDER BY guest_name`, target),
		place_mentions: queryJSON(`SELECT * FROM place_mentions WHERE episode_id = '${id}' ORDER BY place_id`, target),
		places: queryJSON(
			`SELECT p.* FROM places p JOIN place_mentions pm ON pm.place_id = p.id WHERE pm.episode_id = '${id}' ORDER BY p.id`,
			target
		),
	};

	const transcriptPath = path.join(transcriptsDir, `${episodeId}.json`);
	const localTranscript = fs.existsSync(transcriptPath) ? JSON.parse(fs.readFileSync(transcriptPath, 'utf-8')) : null;
	const lines = [...rows.transcript_segments].sort((a, b) => a.start_ms - b.start_ms || a.id - b.id);
	const candidates = candidateVectorIds(episodeId, lines, localTranscript);
	const vectors = getVectors(candidates);

	const dir = newBackupDir(episodeId);
	let audioFile = null;
	try {
		if (withAudio) audioFile = backupAudio(episodeId, dir, isLocal);
	} catch (err) {
		fs.rmSync(dir, { recursive: true, force: true });
		throw err;
	}
	fs.writeFileSync(path.join(dir, 'd1-rows.json'), JSON.stringify(rows, null, 1));
	fs.writeFileSync(path.join(dir, 'restore.sql'), restoreSQL(episodeId, rows));
	if (vectors.length > 0) {
		fs.writeFileSync(path.join(dir, 'vectors.ndjson'), vectors.map((v) => JSON.stringify(v)).join('\n') + '\n');
	}
	const transcriptFile = localTranscript ? path.join(dir, `${episodeId}.json`) : null;
	if (transcriptFile) fs.copyFileSync(transcriptPath, transcriptFile);
	fs.writeFileSync(path.join(dir, 'README.txt'), readme({
		episodeId, dir, rows, vectors, candidates: candidates.length, hasTranscript: !!transcriptFile, audioFile, isLocal, reason,
	}));

	console.log(`  Backed up ${episodeId} to ${dir}`);
	console.log(`    ${rows.transcript_segments.length} transcript lines, ${rows.episode_guests.length} guests, ` +
		`${rows.place_mentions.length} place links, ${vectors.length} vectors, ` +
		`${transcriptFile ? 'the local transcript' : 'no local transcript'}` +
		(withAudio ? `, ${audioFile ? 'the .m4a' : 'no .m4a in R2'}` : ''));
	return { dir, rows, vectorIds: vectors.map((v) => v.id), transcriptFile, audioFile };
}

// ── CLI ────────────────────────────────────────────────────────────────

if (import.meta.main) {
	const args = process.argv.slice(2);
	const ids = args.filter((a) => !a.startsWith('-'));
	const unknown = args.filter((a) => a.startsWith('-') && a !== '--local' && a !== '--with-audio');
	if (ids.length !== 1 || unknown.length > 0) {
		if (unknown.length > 0) console.error(`Unknown option: ${unknown.join(' ')}\n`);
		console.error('Usage: node scripts/episode-backup.js <episode-id> [--with-audio] [--local]');
		process.exit(1);
	}
	try {
		backupEpisode(ids[0], {
			isLocal: args.includes('--local'), withAudio: args.includes('--with-audio'), reason: 'by hand (episode-backup.js)',
		});
	} catch (err) {
		console.error(`Error: ${err.message}`);
		process.exit(1);
	}
}
