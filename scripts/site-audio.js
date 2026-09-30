/**
 * The audio the site plays, for the transcript repair tools: an episode's
 * <id>.m4a in R2 (or any other R2 object, such as a raw MP3 upload), read from
 * the bucket's public URL, or from the local R2 copy with --local. Reading
 * costs nothing and writes nothing.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { R2_BUCKET, R2_PUBLIC_URL, probeDurationMs, wranglerExec } from './lib.js';

const FETCH_TIMEOUT_MS = 30 * 60_000; // a two-hour show is about 115 MB
const LOCAL_BUSY_TRIES = 5;

export const siteAudioKey = (episodeId) => `${episodeId}.m4a`;
export const publicUrl = (key) => `${R2_PUBLIC_URL}/${key.split('/').map(encodeURIComponent).join('/')}`;

/**
 * Download an R2 object to `file`. Returns false if R2 has no such object.
 * @param {string} key - e.g. "roll-over-easy_2026-02-05_07-30-00.m4a" or "Roll Over Easy 2026-04-30.mp3"
 */
export async function downloadR2Object(key, file, { isLocal = false } = {}) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const part = `${file}.part`;
	try {
		if (isLocal) {
			// The local copy is SQLite files that other wrangler processes (a test run's parallel
			// jobs, or a publish) may hold for a moment: SQLITE_BUSY, or an "internal error"
			for (let attempt = 1; ; attempt++) {
				try {
					wranglerExec(['r2', 'object', 'get', `${R2_BUCKET}/${key}`, '--local', `--file=${part}`]);
					break;
				} catch (err) {
					if (/The specified key does not exist|not found/i.test(err.message)) return false;
					if (attempt >= LOCAL_BUSY_TRIES) throw err;
					await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
				}
			}
		} else {
			const res = await fetch(publicUrl(key), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
			if (res.status === 404) return false;
			if (!res.ok) throw new Error(`R2 ${key}: HTTP ${res.status}`);
			await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(part));
		}
		fs.renameSync(part, file);
		return true;
	} finally {
		fs.rmSync(part, { force: true });
	}
}

/** The length in ms of the episode's .m4a in R2, or null if there is none. */
export async function siteAudioMs(episodeId, { isLocal = false } = {}) {
	const key = siteAudioKey(episodeId);
	if (!isLocal) return probeUrlMs(publicUrl(key));
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roe-site-audio-'));
	try {
		const file = path.join(dir, key);
		return (await downloadR2Object(key, file, { isLocal })) ? probeDurationMs(file) : null;
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// On 2026-09-30 at 01:21 an ffprobe of 2019-07-18's .m4a hung until its time limit and stopped a
// repair run, while the same URL answered in a second a few minutes later. So each try has its
// own limit, and a failed one is made again after these waits. A missing object (404) is an
// answer, not a failure. Tests set these lower.
export const probing = { timeoutMs: 60_000, retryWaitsMs: [10_000, 30_000, 60_000] };

/** ffprobe a URL (it reads only the start of a faststart .m4a); null for a missing object. */
export async function probeUrlMs(url) {
	for (let attempt = 0; ; attempt++) {
		try {
			return await probeUrlOnce(url);
		} catch (err) {
			const wait = probing.retryWaitsMs[attempt];
			if (wait === undefined) throw err;
			console.warn(`  ${err.message}; trying again in ${wait / 1000} s`);
			await new Promise((resolve) => setTimeout(resolve, wait));
		}
	}
}

function probeUrlOnce(url) {
	return new Promise((resolve, reject) => {
		execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', url], { timeout: probing.timeoutMs }, (err, stdout, stderr) => {
			if (err) {
				if (/404|Not Found/i.test(`${stderr}`)) return resolve(null);
				const why = `${stderr}`.trim().split('\n').at(-1) || (err.killed ? `no answer in ${probing.timeoutMs / 1000} s` : err.message);
				return reject(new Error(`ffprobe ${url}: ${why}`));
			}
			const seconds = parseFloat(stdout);
			if (!Number.isFinite(seconds) || seconds <= 0) return reject(new Error(`ffprobe could not read the length of ${url}`));
			resolve(Math.round(seconds * 1000));
		});
	});
}
