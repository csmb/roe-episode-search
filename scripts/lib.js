import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// ── Path constants ────────────────────────────────────────────────────

export const projectRoot = path.resolve(
	path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)),
	'..'
);
const workerDir = path.join(projectRoot, 'roe-search');
// A test run (ROE_PERSIST_TO, see wranglerExec) keeps its transcripts and backups in its own folder
export const transcriptsDir = process.env.ROE_PERSIST_TO
	? path.join(path.resolve(process.env.ROE_PERSIST_TO), 'transcripts')
	: path.join(projectRoot, 'transcripts');
const DB_NAME = 'roe-episodes';

const wranglerBin = path.join(workerDir, 'node_modules', '.bin', 'wrangler');

// ── Environment ───────────────────────────────────────────────────────

// Keys the project .env decides even when the shell has its own: a stale
// CLOUDFLARE_API_TOKEN exported from a shell profile once made every R2 and D1
// call fail with an authentication error. In a test run (ROE_PERSIST_TO) the
// shell still wins, so a test can pass a dummy key instead of the real one.
const DOTENV_WINS = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'OPENAI_API_KEY', 'PIPELINE_TOKEN'];

export function loadEnv() {
	const envPath = path.join(projectRoot, '.env');
	if (!fs.existsSync(envPath)) return;
	const overrideShell = !process.env.ROE_PERSIST_TO;
	for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const eq = trimmed.indexOf('=');
		if (eq === -1) continue;
		const key = trimmed.slice(0, eq);
		const val = trimmed.slice(eq + 1);
		if (!process.env[key]) {
			process.env[key] = val;
		} else if (overrideShell && DOTENV_WINS.includes(key) && process.env[key] !== val) {
			console.warn(`Using ${key} from .env; your shell has a different one (remove it from your shell profile).`);
			process.env[key] = val;
		}
	}
}

// ── Text utilities ────────────────────────────────────────────────────

export function escapeSQL(str) {
	return str.replace(/'/g, "''");
}

export function isAscii(text) {
	// eslint-disable-next-line no-control-regex
	return /^[\x00-\x7F]*$/.test(text);
}

// Word corrections: whisper consistently mishears these proper nouns.
// Keys are lowercase; replacements are case-sensitive.
const WORD_CORRECTIONS = {
	soldier: 'Suldrew',
};

export function applyWordCorrections(text) {
	for (const [wrong, right] of Object.entries(WORD_CORRECTIONS)) {
		text = text.replace(new RegExp(`\\b${wrong}\\b`, 'gi'), right);
	}
	return text;
}

// ── Wrangler / D1 helpers ─────────────────────────────────────────────

// ROE_PERSIST_TO=<dir> is for tests. Every --local call (D1 and R2) uses the
// local state in <dir> instead of roe-search/.wrangler, transcripts (and
// backups) live in <dir>/transcripts, and wrangler may not reach production:
// --remote calls and Vectorize writes are refused. (process-episode.js and
// generate-embeddings.js check it too before their own Vectorize writes.)
const VECTORIZE_WRITES = new Set(['insert', 'upsert', 'delete-vectors']);

export function wranglerExec(args, opts = {}) {
	const persistTo = process.env.ROE_PERSIST_TO;
	if (persistTo) {
		if (args.includes('--remote') || (args[0] === 'vectorize' && VECTORIZE_WRITES.has(args[1]))) {
			throw new Error(`ROE_PERSIST_TO is set (a test run): refusing "wrangler ${args.slice(0, 3).join(' ')}" on production`);
		}
		if (args.includes('--local')) args = [...args, '--persist-to', path.resolve(persistTo)];
	}
	const env = { ...process.env };
	delete env.CLOUDFLARE_API_TOKEN;
	try {
		return execFileSync(wranglerBin, args, {
			cwd: workerDir,
			encoding: 'utf-8',
			stdio: opts.stdio || 'pipe',
			env,
			maxBuffer: 64 * 1024 * 1024, // a whole transcript as JSON can pass the 1 MB default
			...opts,
		});
	} catch (err) {
		// Say why it failed: Node's message already has wrangler's stderr, but with
		// --json wrangler prints its error (as JSON) on stdout
		const out = `${err.stdout ?? ''}`.trim();
		if (out && !err.message.includes(out)) err.message += `\n${out.slice(0, 2000)}`;
		throw err;
	}
}

export function queryJSON(sql, { isLocal = false } = {}) {
	const flag = isLocal ? '--local' : '--remote';
	const result = wranglerExec([
		'd1', 'execute', DB_NAME, flag, '--json', `--command=${sql}`,
	]);
	const parsed = JSON.parse(result);
	return parsed[0]?.results ?? [];
}

export function runSQL(sql, { isLocal = false } = {}) {
	const flag = isLocal ? '--local' : '--remote';
	wranglerExec([
		'd1', 'execute', DB_NAME, flag, `--command=${sql}`,
	]);
}

// ── Date / weather ────────────────────────────────────────────────────

export function parseEpisodeDate(episodeId) {
	const match = episodeId.match(/(\d{4}-\d{2}-\d{2})/);
	return match ? match[1] : null;
}

function utcToPacific(isoString) {
	const date = new Date(isoString);
	return date.toLocaleTimeString('en-US', {
		timeZone: 'America/Los_Angeles',
		hour: 'numeric',
		minute: '2-digit',
	});
}

export async function fetchSunriseSunset(dateStr) {
	const url = `https://api.sunrise-sunset.org/json?lat=37.7955&lng=-122.3937&date=${dateStr}&formatted=0`;
	try {
		const res = await fetch(url);
		const data = await res.json();
		if (data.status !== 'OK') return null;
		return {
			sunrise: utcToPacific(data.results.sunrise),
			sunset: utcToPacific(data.results.sunset),
		};
	} catch (err) {
		logWarn(`sunrise/sunset fetch failed for ${dateStr}: ${err.message}`);
		return null;
	}
}

// ── Logging ───────────────────────────────────────────────────────────

export function stepTimer(name) {
	const start = Date.now();
	console.log(`\n[${name}] Starting...`);
	return {
		done(msg) {
			const elapsed = ((Date.now() - start) / 1000).toFixed(1);
			console.log(`[${name}] Complete (${elapsed}s)${msg ? ' — ' + msg : ''}`);
		},
	};
}

export function logWarn(message) {
	const line = `[${new Date().toISOString()}] ${message}`;
	console.warn(`  ${message}`);
	fs.appendFileSync(path.join(projectRoot, 'scripts', 'pipeline-errors.log'), line + '\n');
}

// ── Audio ──────────────────────────────────────────────────────────────

/**
 * Convert an audio file to the .m4a the site streams (AAC 128k, faststart so
 * the browser can seek before the whole file downloads). Returns the path of
 * `converted.m4a` inside `tmpDir`. `-vn` drops embedded cover art, which ffmpeg
 * otherwise tries to put in the .m4a as video and fails on.
 */
export function convertAudio(inputPath, tmpDir) {
	const outPath = path.join(tmpDir, 'converted.m4a');
	execFileSync('ffmpeg', [
		'-nostdin', '-y', '-i', inputPath,
		'-vn', '-c:a', 'aac', '-b:a', '128k',
		'-movflags', '+faststart',
		outPath,
	], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
	return outPath;
}
