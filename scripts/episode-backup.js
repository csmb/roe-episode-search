#!/usr/bin/env node

/**
 * Back up one episode before it is deleted or merged: its D1 rows (the
 * episode, transcript lines, guests and place links), its search vectors, the
 * local transcript file if there is one, and with --with-audio its .m4a from
 * R2. Writes restore SQL and a README that says how to put everything back.
 * delete-episode.js and merge-episode.js call it first (with the audio when
 * they delete or replace it); it can also be run on its own.
 *
 * Its search vectors are every ID in the index that starts with
 * "<episode-id>:", found by listing the index (vector-ids.js, about half a
 * minute), so a drag-and-drop episode with no local files is covered, and so
 * are entries an older transcript left. With --local, Vectorize is neither
 * read nor changed.
 *
 * Usage:
 *   node scripts/episode-backup.js <episode-id> [--with-audio] [--local]
 *
 * Backups go to transcripts/.backups/<date>-<episode-id>/ (git ignores transcripts/).
 */

import fs from 'node:fs';
import path from 'node:path';

import { loadEnv, escapeSQL, queryJSON, wranglerExec, transcriptsDir, R2_BUCKET, VECTORIZE_INDEX } from './lib.js';
import { inlineParams } from './remote-d1.js';
import { remoteVectorize } from './remote-cloudflare.js';
import { vectorIdSnapshot, vectorsNdjson } from './vector-ids.js';

const backupsDir = path.join(transcriptsDir, '.backups');

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

function readme({ episodeId, dir, rows, vectors, listed, hasTranscript, audioFile, isLocal, reason }) {
	const where = isLocal ? '--local' : '--remote';
	const audio = rows.episodes[0].audio_file ?? '(none)';
	let vectorLine = `  (no search vectors: no ID in the index starts with "${episodeId}:")`;
	if (isLocal) {
		vectorLine = '  (no search vectors: a --local backup doesn\'t read Vectorize, and --local never changes it)';
	} else if (vectors.length > 0) {
		vectorLine = `  vectors.ndjson  its ${vectors.length} search vectors: every ID in the index starting "${episodeId}:"` +
			(listed > vectors.length ? ` (${listed} were listed; ${listed - vectors.length} went before they could be read)` : '');
	} else if (listed > 0) {
		vectorLine = `  (no search vectors saved: ${listed} were listed under "${episodeId}:", but all went before they could be read)`;
	}
	return [
		`Backup of ${episodeId}, taken ${new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })} ${reason}.`,
		`Rows from the ${isLocal ? 'local D1 copy (--local)' : 'production D1 database'}.`,
		'',
		`  d1-rows.json    the rows as they were: the episode, ${rows.transcript_segments.length} transcript lines,`,
		`                  ${rows.episode_guests.length} guests, ${rows.place_mentions.length} place links and the places they point to`,
		'  restore.sql     puts those rows back exactly (first removing the rows the episode has',
		'                  when you run it)',
		vectorLine,
		hasTranscript ? `  ${episodeId}.json  the local transcript file` : '  (there was no local transcript file)',
		...(audioFile ? [`  ${episodeId}.m4a  its audio from R2, as it was`] : []),
		'',
		'To put it back:',
		'  cd roe-search',
		`  env -u CLOUDFLARE_API_TOKEN npx wrangler d1 execute roe-episodes ${where} --file "${path.join(dir, 'restore.sql')}"`,
		...(isLocal ? [] : [`  node ../scripts/generate-embeddings.js --only ${episodeId} --yes`]),
		...(hasTranscript ? [`  cp "${path.join(dir, `${episodeId}.json`)}" ../transcripts/`] : []),
		...(audioFile
			? [`  env -u CLOUDFLARE_API_TOKEN npx wrangler r2 object put ${R2_BUCKET}/${episodeId}.m4a ${where} --file "${audioFile}" --content-type audio/mp4`]
			: []),
		...(isLocal ? [] : [
			'',
			'generate-embeddings.js makes the episode\'s search vectors again from the restored lines, then',
			'deletes any it has that those lines don\'t make (a merge\'s, or a later run\'s), backed up first.',
			'Upserting vectors.ndjson alone would leave those next to the old ones.',
			...(vectors.length > 0 ? [
				'To have exactly the vectors saved here as well (any the lines don\'t make included), upsert',
				'them after that step:',
				`  env -u CLOUDFLARE_API_TOKEN npx wrangler vectorize upsert ${VECTORIZE_INDEX} --file "${path.join(dir, 'vectors.ndjson')}"`,
			] : []),
		]),
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
 * @param {{isLocal?: boolean, reason?: string, withAudio?: boolean, snapshot?: object, vectorize?: object}} [opts] -
 *   reason completes "taken <time> …" in the README; withAudio also saves the .m4a (for a delete
 *   or merge that replaces it); snapshot: a listing of the index the caller has already taken
 *   (vector-ids.js), so a script lists once
 * @returns {Promise<{dir: string, rows: object, vectorIds: string[], transcriptFile: string|null, audioFile: string|null}>}
 *   vectorIds: every vector the listing has for the episode (what a delete should remove); none with isLocal
 */
export async function backupEpisode(episodeId, { isLocal = false, reason = 'by hand', withAudio = false, snapshot = null, vectorize = null } = {}) {
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
	const hasTranscript = fs.existsSync(transcriptPath);

	// Its search vectors: every ID in the index that starts with "<episode-id>:" (reads)
	let vectorIds = [];
	let vectors = [];
	if (!isLocal) {
		vectorize ??= remoteVectorize();
		snapshot ??= await vectorIdSnapshot(vectorize);
		vectorIds = snapshot.forEpisode(episodeId);
		vectors = await vectorize.getByIds(vectorIds);
	}

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
	if (vectors.length > 0) fs.writeFileSync(path.join(dir, 'vectors.ndjson'), vectorsNdjson(vectors));
	const transcriptFile = hasTranscript ? path.join(dir, `${episodeId}.json`) : null;
	if (transcriptFile) fs.copyFileSync(transcriptPath, transcriptFile);
	fs.writeFileSync(path.join(dir, 'README.txt'), readme({
		episodeId, dir, rows, vectors, listed: vectorIds.length, hasTranscript, audioFile, isLocal, reason,
	}));

	console.log(`  Backed up ${episodeId} to ${dir}`);
	console.log(`    ${rows.transcript_segments.length} transcript lines, ${rows.episode_guests.length} guests, ` +
		`${rows.place_mentions.length} place links, ${isLocal ? 'no vectors (--local: Vectorize not read)' : `${vectors.length} vectors`}, ` +
		`${transcriptFile ? 'the local transcript' : 'no local transcript'}` +
		(withAudio ? `, ${audioFile ? 'the .m4a' : 'no .m4a in R2'}` : ''));
	return { dir, rows, vectorIds, transcriptFile, audioFile };
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
	loadEnv(); // the Cloudflare keys, to list and read the index
	try {
		await backupEpisode(ids[0], {
			isLocal: args.includes('--local'), withAudio: args.includes('--with-audio'), reason: 'by hand (episode-backup.js)',
		});
	} catch (err) {
		console.error(`Error: ${err.message}`);
		process.exit(1);
	}
}
