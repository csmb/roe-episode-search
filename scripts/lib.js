import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// ── Path constants ────────────────────────────────────────────────────

export const projectRoot = path.resolve(
	path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)),
	'..'
);
export const workerDir = path.join(projectRoot, 'roe-search');
export const transcriptsDir = path.join(projectRoot, 'transcripts');
export const DB_NAME = 'roe-episodes';

const wranglerBin = path.join(workerDir, 'node_modules', '.bin', 'wrangler');

// ── Environment ───────────────────────────────────────────────────────

export function loadEnv() {
	const envPath = path.join(projectRoot, '.env');
	if (!fs.existsSync(envPath)) return;
	for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const eq = trimmed.indexOf('=');
		if (eq === -1) continue;
		const key = trimmed.slice(0, eq);
		const val = trimmed.slice(eq + 1);
		if (!process.env[key]) process.env[key] = val;
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
export const WORD_CORRECTIONS = {
	soldier: 'Suldrew',
};

export function applyWordCorrections(text) {
	for (const [wrong, right] of Object.entries(WORD_CORRECTIONS)) {
		text = text.replace(new RegExp(`\\b${wrong}\\b`, 'gi'), right);
	}
	return text;
}

// ── Wrangler / D1 helpers ─────────────────────────────────────────────

export function wranglerExec(args, opts = {}) {
	const env = { ...process.env };
	delete env.CLOUDFLARE_API_TOKEN;
	return execFileSync(wranglerBin, args, {
		cwd: workerDir,
		encoding: 'utf-8',
		stdio: opts.stdio || 'pipe',
		env,
		...opts,
	});
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

export function utcToPacific(isoString) {
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
