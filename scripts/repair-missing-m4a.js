#!/usr/bin/env node

/**
 * Repair episodes whose D1 row exists but whose {id}.m4a is missing from R2.
 *
 * Cause: the post-March-2026 ingest flow uploaded the raw MP3 to R2 and set
 * episodes.audio_file to the raw-MP3 URL, which made the pipeline's
 * "already uploaded" check skip the remux → m4a upload. The player only ever
 * requests /audio/{id}.m4a, so those episodes 404 on Play.
 *
 * For each affected episode this script:
 *   1. Finds a source MP3: the one in R2 that the episode's audio_file names
 *      (the upload, or a show roe-pipeline joined from parts), else the
 *      archive's "Roll Over Easy YYYY-MM-DD.mp3" (ARCHIVE_DIR in lib.js), else
 *      that name in R2.
 *   2. Remuxes to M4A (AAC 128k, faststart).
 *   3. Uploads {id}.m4a to R2 and points audio_file at it.
 *   4. Verifies the live /audio/{id}.m4a URL answers a Range request.
 *
 * Usage:
 *   node scripts/repair-missing-m4a.js [--dry-run] [--only id1,id2]
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
	loadEnv, escapeSQL, wranglerExec, runSQL, queryJSON, parseEpisodeDate, convertAudio, parseFlags,
	ARCHIVE_DIR, R2_BUCKET, R2_PUBLIC_URL,
} from './lib.js';

const SITE_URL = 'https://rollovereasy.org';
const USAGE = 'Usage: node scripts/repair-missing-m4a.js [--dry-run] [--only id1,id2]';

/** The R2 key an audio_file URL points at, if it's an MP3 in our bucket. */
function recordedMp3Key(audioFile) {
	if (!audioFile?.startsWith(`${R2_PUBLIC_URL}/`) || !/\.mp3$/i.test(audioFile)) return null;
	try {
		return audioFile.slice(R2_PUBLIC_URL.length + 1).split('/').map(decodeURIComponent).join('/');
	} catch {
		return null;
	}
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

async function verifyLive(episodeId) {
	const res = await fetch(`${SITE_URL}/audio/${episodeId}.m4a`, {
		headers: { Range: 'bytes=0-1023' },
	});
	return res.status === 206 || res.status === 200;
}

async function main() {
	const { flags, rest } = parseFlags(process.argv.slice(2), { '--dry-run': 'flag', '--only': 'value' }, USAGE);
	if (rest.length > 0) {
		console.error(`Unexpected argument: ${rest.join(' ')}\n\n${USAGE}`);
		process.exit(1);
	}
	const dryRun = !!flags['dry-run'];
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
		console.log('\n--dry-run: no uploads or DB writes performed.');
		return;
	}

	const runnable = jobs.filter((j) => j.source);
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
				runSQL(`UPDATE episodes SET audio_file = '${escapeSQL(`${R2_PUBLIC_URL}/${r2Key}`)}' WHERE id = '${escapeSQL(job.id)}'`);

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
