#!/usr/bin/env node

/**
 * Make the {id}.m4a of episodes that have none in R2. Run it after each
 * Thursday's show: roe-pipeline (drag and drop) can't convert audio, so a new
 * show has only its raw MP3 in R2, and the site plays that (/audio/{id}.m4a
 * falls back to the MP3 audio_file names) until this runs: a file about 30%
 * bigger, never cached, and a slower lookup on every request.
 *
 * For each episode without its .m4a it:
 *   1. Finds a source MP3: the one in R2 that the episode's audio_file names
 *      (the upload, or a show roe-pipeline joined from parts), else the
 *      archive's "Roll Over Easy YYYY-MM-DD.mp3" (ARCHIVE_DIR in lib.js), else
 *      that name in R2.
 *   2. Converts it to M4A (AAC 128k, faststart).
 *   3. Uploads {id}.m4a to R2 and points audio_file at it (only where audio_file
 *      is still the value read).
 *   4. Checks that the live /audio/{id}.m4a answers a Range request with the .m4a.
 *
 * A dry run (the list) unless --yes. With --yes it first backs up every
 * episode's audio_file to transcripts/.backups/<date>-m4a/ (before.json,
 * restore.sql, README.txt with the undo).
 *
 * Usage:
 *   node scripts/repair-missing-m4a.js [--only id1,id2] [--yes]
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
	loadEnv, escapeSQL, wranglerExec, runSQL, queryJSON, parseEpisodeDate, convertAudio, parseFlags,
	ARCHIVE_DIR, R2_BUCKET, R2_PUBLIC_URL,
} from './lib.js';
import { newBackupDir } from './episode-backup.js';

const SITE_URL = 'https://rollovereasy.org';
const USAGE = 'Usage: node scripts/repair-missing-m4a.js [--only id1,id2] [--yes]';

/** The R2 key an audio_file URL points at, if it's an MP3 in our bucket. */
export function recordedMp3Key(audioFile) {
	if (!audioFile?.startsWith(`${R2_PUBLIC_URL}/`) || !/\.mp3$/i.test(audioFile)) return null;
	try {
		return audioFile.slice(R2_PUBLIC_URL.length + 1).split('/').map(decodeURIComponent).join('/');
	} catch {
		return null;
	}
}

const sqlValue = (v) => (v == null ? 'NULL' : `'${escapeSQL(v)}'`);

/** Points the episode's audio_file at its .m4a, only where it is still the value read. */
export function audioFileUpdate({ id, audio_file }) {
	return `UPDATE episodes SET audio_file = ${sqlValue(`${R2_PUBLIC_URL}/${id}.m4a`)} WHERE id = ${sqlValue(id)} AND audio_file IS ${sqlValue(audio_file)};`;
}

/** Puts the value read back, only where audio_file is still the .m4a this run set. */
export function audioFileRestore({ id, audio_file }) {
	return `UPDATE episodes SET audio_file = ${sqlValue(audio_file)} WHERE id = ${sqlValue(id)} AND audio_file IS ${sqlValue(`${R2_PUBLIC_URL}/${id}.m4a`)};`;
}

function writeBackup(dir, jobs) {
	fs.writeFileSync(path.join(dir, 'before.json'), JSON.stringify(jobs.map(({ id, audio_file }) => ({ id, audio_file })), null, 1));
	fs.writeFileSync(path.join(dir, 'restore.sql'), [
		'-- Puts back each episode\'s audio_file as it was before repair-missing-m4a.js,',
		'-- only where it is still the .m4a that run set.',
		...jobs.map(audioFileRestore),
	].join('\n') + '\n');
	fs.writeFileSync(path.join(dir, 'README.txt'), [
		`audio_file values before repair-missing-m4a.js --yes, ${new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}, production D1.`,
		'',
		'  before.json   each episode\'s audio_file as it was',
		'  restore.sql   puts them back (only where still the .m4a this run set)',
		'',
		'To undo: restore.sql, then delete the .m4a files it made (the site plays a show\'s',
		'.m4a whenever one is in R2, whatever audio_file says):',
		'  cd roe-search',
		`  env -u CLOUDFLARE_API_TOKEN npx wrangler d1 execute roe-episodes --remote --file "${path.join(dir, 'restore.sql')}"`,
		...jobs.map((j) => `  npx wrangler r2 object delete "${R2_BUCKET}/${j.id}.m4a" --remote`),
		'',
	].join('\n'));
}

function apiBase(env) {
	return `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${R2_BUCKET}`;
}

async function listR2Keys(env) {
	const keys = new Set();
	let cursor = '';
	while (true) {
		const url = `${apiBase(env)}/objects?per_page=1000${cursor ? `&cursor=${cursor}` : ''}`;
		const res = await fetch(url, { headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` } });
		const j = await res.json();
		if (!j.success) throw new Error(`R2 list failed: ${JSON.stringify(j.errors)}`);
		for (const o of j.result) keys.add(o.key);
		cursor = j.result_info?.cursor;
		if (!cursor || j.result.length === 0) break;
	}
	return keys;
}

async function downloadR2Object(env, key, destPath) {
	const url = `${apiBase(env)}/objects/${encodeURIComponent(key)}`;
	const res = await fetch(url, { headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` } });
	if (!res.ok) throw new Error(`R2 download of "${key}" failed: HTTP ${res.status}`);
	const buf = Buffer.from(await res.arrayBuffer());
	fs.writeFileSync(destPath, buf);
	return buf.length;
}

// The .m4a itself, not the MP3 the site falls back to (audio/mpeg)
async function verifyLive(episodeId) {
	const res = await fetch(`${SITE_URL}/audio/${episodeId}.m4a`, {
		headers: { Range: 'bytes=0-1023' },
	});
	await res.body?.cancel();
	return (res.status === 206 || res.status === 200) && res.headers.get('content-type') === 'audio/mp4';
}

async function main() {
	// --dry-run is still accepted: a dry run is what it does without --yes
	const { flags, rest } = parseFlags(process.argv.slice(2), { '--dry-run': 'flag', '--yes': 'flag', '--only': 'value' }, USAGE);
	if (rest.length > 0 || (flags.yes && flags['dry-run'])) {
		console.error(`${rest.length > 0 ? `Unexpected argument: ${rest.join(' ')}` : '--yes and --dry-run together'}\n\n${USAGE}`);
		process.exit(1);
	}
	const dryRun = !flags.yes;
	const only = flags.only ? new Set(flags.only.split(',').map((s) => s.trim())) : null;

	// .env wins over a stale key in the shell (see loadEnv)
	loadEnv();
	const env = process.env;
	if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
		console.error('Missing CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN in .env');
		process.exit(1);
	}

	console.log('Listing R2 objects...');
	const r2Keys = await listR2Keys(env);
	console.log(`  ${r2Keys.size} objects`);

	console.log('Querying D1 episodes...');
	const episodes = queryJSON('SELECT id, audio_file FROM episodes ORDER BY id');
	console.log(`  ${episodes.length} episodes`);

	let broken = episodes.filter((e) => !r2Keys.has(`${e.id}.m4a`));
	if (only) broken = broken.filter((e) => only.has(e.id));

	if (broken.length === 0) {
		console.log('\nNothing to repair — every episode has its .m4a in R2.');
		return;
	}

	console.log(`\nEpisodes missing {id}.m4a in R2: ${broken.length}`);

	// Resolve a source MP3 for each broken episode
	const jobs = [];
	for (const ep of broken) {
		const date = parseEpisodeDate(ep.id);
		const rawName = `Roll Over Easy ${date}.mp3`;
		const localPath = path.join(ARCHIVE_DIR, rawName);
		// The MP3 the pipeline recorded as the episode's audio is the one it
		// transcribed. A show that came in parts was joined by roe-pipeline, and only
		// the joined file has all of it (a local file of that name may be part 1 alone).
		const recorded = recordedMp3Key(ep.audio_file);
		const joinedKey = `joined/${rawName}`;
		if (recorded && r2Keys.has(recorded)) {
			jobs.push({ ...ep, source: 'r2', r2Key: recorded });
		} else if (r2Keys.has(joinedKey)) {
			jobs.push({ ...ep, source: 'r2', r2Key: joinedKey });
		} else if (fs.existsSync(localPath)) {
			jobs.push({ ...ep, source: 'local', localPath });
		} else if (r2Keys.has(rawName)) {
			jobs.push({ ...ep, source: 'r2', r2Key: rawName });
		} else {
			jobs.push({ ...ep, source: null });
		}
	}

	for (const j of jobs) {
		console.log(`  ${j.id}  source: ${j.source ?? 'NONE FOUND — skipping'}`);
	}

	if (dryRun) {
		console.log('\nDry run: nothing uploaded or changed. Add --yes to make them.');
		return;
	}

	const runnable = jobs.filter((j) => j.source);
	if (runnable.length === 0) return;
	const backup = newBackupDir('m4a');
	writeBackup(backup, runnable);
	console.log(`\naudio_file backed up to ${backup}`);
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roe-repair-'));
	let repaired = 0;
	let failed = 0;

	try {
		for (let i = 0; i < runnable.length; i++) {
			const job = runnable[i];
			console.log(`\n[${i + 1}/${runnable.length}] ${job.id}`);
			try {
				let mp3Path = job.localPath;
				if (job.source === 'r2') {
					console.log(`  Downloading "${job.r2Key}" from R2...`);
					mp3Path = path.join(tmpDir, 'source.mp3');
					const bytes = await downloadR2Object(env, job.r2Key, mp3Path);
					console.log(`  ${(bytes / 1048576).toFixed(1)} MB`);
				}

				console.log('  Converting to M4A...');
				const m4aPath = convertAudio(mp3Path, tmpDir);

				const r2Key = `${job.id}.m4a`;
				console.log('  Uploading to R2...');
				wranglerExec(['r2', 'object', 'put', '--remote', `${R2_BUCKET}/${r2Key}`, `--file=${m4aPath}`, '--content-type=audio/mp4']);

				console.log('  Updating database...');
				runSQL(audioFileUpdate(job));

				console.log('  Verifying live URL...');
				const ok = await verifyLive(job.id);
				console.log(ok ? '  ✓ live' : '  ✗ LIVE CHECK FAILED');
				if (!ok) throw new Error('live verification failed');

				fs.rmSync(m4aPath, { force: true });
				if (job.source === 'r2') fs.rmSync(mp3Path, { force: true });
				repaired++;
			} catch (err) {
				console.error(`  FAILED: ${err.message}`);
				failed++;
			}
		}
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}

	console.log('\n=== Summary ===');
	console.log(`Repaired: ${repaired}`);
	console.log(`Failed: ${failed}`);
	console.log(`No source found: ${jobs.length - runnable.length}`);
}

if (import.meta.main) {
	main().catch((err) => {
		console.error('Fatal error:', err.message);
		process.exit(1);
	});
}
