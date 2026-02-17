#!/usr/bin/env node

/**
 * Process a single episode through the full pipeline:
 *   1. Transcribe locally with whisper.cpp
 *   2. Seed D1 database
 *   3. Generate embeddings → Vectorize
 *   4. Generate AI summary
 *   5. Upload audio → R2
 *
 * Usage:
 *   node scripts/process-episode.js /path/to/roll-over-easy_2026-02-16_07-30-00.mp3
 *
 * Options:
 *   --episode-id ID          Override auto-parsed episode ID
 *   --force                  Re-run all steps even if already done
 *   --skip step1,step2       Skip specific steps (transcribe, seed-db, embeddings, summary, upload-audio)
 */

import { execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── Load .env ─────────────────────────────────────────────────────────

const envPath = path.resolve(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)), '..', '.env');
if (fs.existsSync(envPath)) {
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

// ── Constants ──────────────────────────────────────────────────────────

const DB_NAME = 'roe-episodes';
const R2_BUCKET = 'roe-audio';
const R2_PUBLIC_URL = 'https://pub-e95bd2be3f9d4147b2955503d75e50c1.r2.dev';
const VECTORIZE_INDEX = 'roe-transcripts';
const EMBED_MODEL = '@cf/baai/bge-base-en-v1.5';

const WINDOW_SEC = 45;
const STEP_SEC = 35;
const EMBED_BATCH_SIZE = 100;
const UPSERT_BATCH_SIZE = 1000;
const DB_BATCH_SIZE = 50;

const WHISPER_MODEL_CANDIDATES = [
	path.join(os.homedir(), '.cache', 'whisper-cpp', 'ggml-large-v3.bin'),
	path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'code', 'transcribe_audio', 'whisper-env', 'ggml-large-v3.bin'),
];
const WHISPER_MODEL_PATH = WHISPER_MODEL_CANDIDATES.find((p) => fs.existsSync(p)) || WHISPER_MODEL_CANDIDATES[0];

const VAD_MODEL_PATH = path.join(os.homedir(), '.cache', 'whisper-cpp', 'ggml-silero-v6.2.0.bin');

// Whisper prompt: ~224 token limit. Prioritize proper nouns whisper would mishear.
const SF_VOCAB_PROMPT = [
	// Show & station
	'Roll Over Easy, BFF.fm, Stroll Over Easy,',
	// Neighborhoods (compact)
	'SoMa, the Tenderloin, Dogpatch, Bernal Heights, Japantown, Visitacion Valley,',
	'Haight-Ashbury, Pac Heights, Noe Valley, Potrero Hill, the Fillmore, Bayview,',
	// Landmarks & places
	'the Ferry Building, Golden Gate Park, Sutro Baths, Lands End, McLaren Park,',
	'JFK Promenade, Crosstown Trail, Pier 70, Wave Organ, Transamerica Pyramid,',
	'Conservatory of Flowers, the Botanical Garden, Salesforce Park,',
	// Venues & businesses
	'Hamburger Haven, Club Fugazi, Manny\'s, The Lab, Spin City, Parklab,',
	'La Cocina, Bi-Rite, Tartine, Humphry Slocombe, Lazy Bear, Toronado,',
	'Wesburger, Lady Falcon Coffee Club, The New Wheel, Laughing Monk,',
	// People & characters
	'Emperor Norton, Herb Caen, Cosmic Amanda, Dr. Guacamole,',
	// Organizations & media
	'Muni Diaries, Noise Pop, Litquake, Litcrawl, KQED, KALW, Hoodline,',
	'Mission Local, SFGate, Tablehopper, Total SF, Bay City Beacon,',
	'BAYCAT, ODC, YBCA, Gray Area, SFMOMA, the Exploratorium,',
	'Sisters of Perpetual Indulgence, Cacophony Society,',
	// Transit
	'Muni, BART, Caltrain, the N-Judah, the F-Market,',
	// Culture & SF-specific
	'Eichler Homes, Compton\'s Cafeteria, Critical Mass, Sketch Fest, Karl the Fog,',
	'NIMBYism, YIMBYism, Dungeness crab, cioppino, dim sum, sourdough,',
].join(' ');

const projectRoot = path.resolve(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)), '..');
const workerDir = path.join(projectRoot, 'my-first-worker');
const transcriptsDir = path.join(projectRoot, 'transcripts');

// ── Helpers ────────────────────────────────────────────────────────────

function escapeSQL(str) {
	return str.replace(/'/g, "''");
}

function isAscii(text) {
	// eslint-disable-next-line no-control-regex
	return /^[\x00-\x7F]*$/.test(text);
}

function wranglerExec(args, opts = {}) {
	// Strip CLOUDFLARE_API_TOKEN so wrangler uses its OAuth login instead
	const env = { ...process.env };
	delete env.CLOUDFLARE_API_TOKEN;
	return execSync(`npx wrangler ${args}`, {
		cwd: workerDir,
		encoding: 'utf-8',
		stdio: opts.stdio || 'pipe',
		env,
		...opts,
	});
}

function queryJSON(sql) {
	const cmd = `d1 execute ${DB_NAME} --remote --json --command="${sql.replace(/"/g, '\\"')}"`;
	const result = wranglerExec(cmd);
	const parsed = JSON.parse(result);
	return parsed[0]?.results ?? [];
}

function runSQL(sql) {
	const cmd = `d1 execute ${DB_NAME} --remote --command="${sql.replace(/"/g, '\\"')}"`;
	wranglerExec(cmd);
}

function stepTimer(name) {
	const start = Date.now();
	console.log(`\n[${name}] Starting...`);
	return {
		done(msg) {
			const elapsed = ((Date.now() - start) / 1000).toFixed(1);
			console.log(`[${name}] Complete (${elapsed}s)${msg ? ' — ' + msg : ''}`);
		},
	};
}

// ── Step 1: Prerequisite checks ────────────────────────────────────────

function checkPrerequisites() {
	const timer = stepTimer('PREREQUISITES');
	const missing = [];

	try {
		execSync('which whisper-cli', { stdio: 'pipe' });
	} catch {
		missing.push('whisper-cli — install with: brew install whisper-cpp');
	}

	try {
		execSync('which ffmpeg', { stdio: 'pipe' });
	} catch {
		missing.push('ffmpeg — install with: brew install ffmpeg');
	}

	if (!fs.existsSync(WHISPER_MODEL_PATH)) {
		missing.push(
			`Whisper model not found at ${WHISPER_MODEL_PATH}\n` +
			'  Download with: whisper-cli --model large-v3 --download-model'
		);
	}

	if (!fs.existsSync(VAD_MODEL_PATH)) {
		missing.push(
			`Silero VAD model not found at ${VAD_MODEL_PATH}\n` +
			'  Download with: curl -L https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin -o ' + VAD_MODEL_PATH
		);
	}

	if (missing.length > 0) {
		console.error('\nMissing prerequisites:\n');
		missing.forEach((m) => console.error(`  - ${m}`));
		console.error('');
		process.exit(1);
	}

	timer.done();
}

// ── Step 2: Episode ID parsing ─────────────────────────────────────────

// Month-day-only files from 2014 — hardcoded lookup
const MONTH_DAY_2014 = {
	'jan 30': '2014-01-30',
	'feb 6': '2014-02-06',
	'march 6': '2014-03-06',
	'march 13': '2014-03-13',
	'march 20': '2014-03-20',
	'april 17': '2014-04-17',
	'april 24': '2014-04-24',
};

export function parseEpisodeId(mp3Path) {
	const stem = path.basename(mp3Path, path.extname(mp3Path));

	// Already in canonical format: roll-over-easy_2026-02-16_07-30-00 (with optional " copy" suffix)
	const canonicalMatch = stem.match(/^(roll-over-easy_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})(\s+copy)?$/);
	if (canonicalMatch) {
		return canonicalMatch[1];
	}

	// App Recording format: "App Recording 20260216 0730" or "App_Recording_20200730_0730"
	const appMatch = stem.match(/App[_ ]Recording[_ ]+(\d{4})(\d{2})(\d{2})[_ ]+(\d{2})(\d{2})/i);
	if (appMatch) {
		const [, y, m, d, hh, mm] = appMatch;
		return `roll-over-easy_${y}-${m}-${d}_${hh}-${mm}-00`;
	}

	// Input Device Recording format: "Input Device Recording 20220815 2051"
	const inputMatch = stem.match(/Input Device Recording\s+(\d{4})(\d{2})(\d{2})\s+(\d{2})(\d{2})/i);
	if (inputMatch) {
		const [, y, m, d, hh, mm] = inputMatch;
		return `roll-over-easy_${y}-${m}-${d}_${hh}-${mm}-00`;
	}

	// Podcast Roll Over Easy YYYYMMDD
	const podcastMatch = stem.match(/Podcast Roll Over Easy\s+(\d{4})(\d{2})(\d{2})/i);
	if (podcastMatch) {
		const [, y, m, d] = podcastMatch;
		return `roll-over-easy_${y}-${m}-${d}_07-30-00`;
	}

	// Roll Over Easy YYYYMMDD (with optional suffix like "final", "2", "_full")
	const roeYMDMatch = stem.match(/^Roll Over Easy\s+(\d{4})(\d{2})(\d{2})/i);
	if (roeYMDMatch) {
		const [, y, m, d] = roeYMDMatch;
		return `roll-over-easy_${y}-${m}-${d}_07-30-00`;
	}

	// Roll Over Easy - YYYY-MM-DD (with optional "(1)" duplicate suffix)
	const roeDashMatch = stem.match(/^Roll Over Easy\s*-\s*(\d{4})-(\d{2})-(\d{2})/i);
	if (roeDashMatch) {
		const [, y, m, d] = roeDashMatch;
		return `roll-over-easy_${y}-${m}-${d}_07-30-00`;
	}

	// Roll_Over_Easy_-_YYYY-MM-DD
	const roeUnderscoreDashMatch = stem.match(/^Roll_Over_Easy_-_(\d{4})-(\d{2})-(\d{2})/i);
	if (roeUnderscoreDashMatch) {
		const [, y, m, d] = roeUnderscoreDashMatch;
		return `roll-over-easy_${y}-${m}-${d}_07-30-00`;
	}

	// roll_over_easy-YYYY-MM-DD
	const roeUnderscoreMatch = stem.match(/^roll_over_easy-(\d{4})-(\d{2})-(\d{2})/i);
	if (roeUnderscoreMatch) {
		const [, y, m, d] = roeUnderscoreMatch;
		return `roll-over-easy_${y}-${m}-${d}_07-30-00`;
	}

	// roll-over-easy YYYY-MM-DD (space instead of underscore)
	const roeSpaceMatch = stem.match(/^roll-over-easy\s+(\d{4})-(\d{2})-(\d{2})/i);
	if (roeSpaceMatch) {
		const [, y, m, d] = roeSpaceMatch;
		return `roll-over-easy_${y}-${m}-${d}_07-30-00`;
	}

	// rec_(YYYY_MM_DD)_N
	const recYMDMatch = stem.match(/^rec_\((\d{4})_(\d{2})_(\d{2})\)_/);
	if (recYMDMatch) {
		const [, y, m, d] = recYMDMatch;
		return `roll-over-easy_${y}-${m}-${d}_07-30-00`;
	}

	// rec_(MM_DD_YYYY)_N
	const recMDYMatch = stem.match(/^rec_\((\d{2})_(\d{2})_(\d{4})\)_/);
	if (recMDYMatch) {
		const [, m, d, y] = recMDYMatch;
		return `roll-over-easy_${y}-${m}-${d}_07-30-00`;
	}

	// Month-day-only files: "Feb 6 - Roll Over Easy", "Roll Over Easy March 20", etc.
	const monthDayPrefix = stem.match(/^(Jan|Feb|March|April)\s+(\d{1,2})\s*-\s*Roll Over Easy/i);
	if (monthDayPrefix) {
		const key = `${monthDayPrefix[1].toLowerCase()} ${monthDayPrefix[2]}`;
		if (MONTH_DAY_2014[key]) {
			return `roll-over-easy_${MONTH_DAY_2014[key]}_07-30-00`;
		}
	}

	const monthDaySuffix = stem.match(/^Roll Over Easy\s+(Jan|Feb|March|April)\s+(\d{1,2})/i);
	if (monthDaySuffix) {
		const key = `${monthDaySuffix[1].toLowerCase()} ${monthDaySuffix[2]}`;
		if (MONTH_DAY_2014[key]) {
			return `roll-over-easy_${MONTH_DAY_2014[key]}_07-30-00`;
		}
	}

	// Fallback: use filename stem, warn user
	console.warn(`  Warning: Could not parse episode ID from filename "${stem}". Using as-is.`);
	console.warn('  Use --episode-id to override.');
	return stem;
}

// ── Transcript cleanup ─────────────────────────────────────────────────

/**
 * Clean whisper.cpp artifacts from parsed segments:
 *  - Drop zero-duration segments (start_ms == end_ms)
 *  - Deduplicate consecutive identical text
 *  - Drop segments with internal phrase looping (same phrase 4+ times)
 */
function cleanSegments(segments) {
	const cleaned = [];

	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];

		// Drop zero-duration segments
		if (seg.start_ms === seg.end_ms) continue;

		// Drop consecutive duplicates (same text as previous kept segment)
		if (cleaned.length > 0 && seg.text === cleaned[cleaned.length - 1].text) continue;

		// Drop segments with internal phrase looping
		if (hasInternalLoop(seg.text)) continue;

		cleaned.push(seg);
	}

	return cleaned;
}

/**
 * Detect internal looping: a phrase of 3+ words repeating 4+ times in a row.
 * E.g. "I think that I think that I think that I think that"
 */
function hasInternalLoop(text) {
	const words = text.toLowerCase().split(/\s+/);
	if (words.length < 12) return false;

	// Check phrase lengths from 3 to 8 words
	for (let phraseLen = 3; phraseLen <= 8 && phraseLen <= words.length / 4; phraseLen++) {
		// Slide through the text looking for repeating phrases
		for (let start = 0; start <= words.length - phraseLen * 4; start++) {
			const phrase = words.slice(start, start + phraseLen).join(' ');
			let repeats = 1;
			let pos = start + phraseLen;
			while (pos + phraseLen <= words.length) {
				const next = words.slice(pos, pos + phraseLen).join(' ');
				if (next === phrase) {
					repeats++;
					pos += phraseLen;
				} else {
					break;
				}
			}
			if (repeats >= 4) return true;
		}
	}

	return false;
}

// ── Step 3: Transcribe (whisper.cpp) ───────────────────────────────────

function transcribe(mp3Path, episodeId, force) {
	const timer = stepTimer('TRANSCRIBE');

	const outputPath = path.join(transcriptsDir, `${episodeId}.json`);

	if (!force && fs.existsSync(outputPath)) {
		timer.done('transcript already exists, skipping');
		return;
	}

	fs.mkdirSync(transcriptsDir, { recursive: true });

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roe-whisper-'));

	try {
		// Convert MP3 → WAV (16kHz mono)
		const wavPath = path.join(tmpDir, 'audio.wav');
		console.log('  Converting to WAV (16kHz mono)...');
		execFileSync('ffmpeg', ['-y', '-i', mp3Path, '-ar', '16000', '-ac', '1', wavPath], {
			encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'],
		});

		// Run whisper.cpp
		const whisperOutput = path.join(tmpDir, 'output');
		console.log('  Running whisper.cpp (this will take a while)...');
		execFileSync('whisper-cli', [
			'-m', WHISPER_MODEL_PATH,
			'--language', 'en',
			'--output-json-full',
			'--output-file', whisperOutput,
			'--prompt', SF_VOCAB_PROMPT,
			'--vad',
			'--vad-model', VAD_MODEL_PATH,
			'--suppress-nst',
			wavPath,
		], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'inherit'], timeout: 0, maxBuffer: 50 * 1024 * 1024 });

		// Parse whisper.cpp JSON
		const whisperJsonPath = `${whisperOutput}.json`;
		if (!fs.existsSync(whisperJsonPath)) {
			throw new Error(`Whisper output not found at ${whisperJsonPath}`);
		}

		const whisperData = JSON.parse(fs.readFileSync(whisperJsonPath, 'utf-8'));
		const rawSegments = whisperData.transcription || [];

		// Convert to our format, filtering obvious bad segments
		const parsed = [];
		for (const seg of rawSegments) {
			const text = (seg.text || '').trim();

			// Filter non-ASCII (Whisper hallucinations on music)
			if (!isAscii(text)) continue;

			// Filter very short segments
			if (text.length < 3) continue;

			// offsets.from and offsets.to are in centiseconds (10ms units)
			parsed.push({
				start_ms: seg.offsets.from * 10,
				end_ms: seg.offsets.to * 10,
				text,
			});
		}

		// Clean up whisper artifacts
		const segments = cleanSegments(parsed);

		const transcript = {
			episode_id: episodeId,
			title: episodeId,
			segments,
		};

		fs.writeFileSync(outputPath, JSON.stringify(transcript, null, 2));
		timer.done(`${segments.length} segments (${parsed.length - segments.length} removed by cleanup)`);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

// ── Step 4: Seed D1 database ───────────────────────────────────────────

function seedDB(episodeId, force) {
	const timer = stepTimer('SEED-DB');

	// Check if episode already exists
	if (!force) {
		try {
			const existing = queryJSON(`SELECT id FROM episodes WHERE id = '${escapeSQL(episodeId)}'`);
			if (existing.length > 0) {
				timer.done('episode already in DB, skipping');
				return;
			}
		} catch {
			// Table might not exist — proceed with insert
		}
	}

	// Read transcript
	const transcriptPath = path.join(transcriptsDir, `${episodeId}.json`);
	const transcript = JSON.parse(fs.readFileSync(transcriptPath, 'utf-8'));
	const { segments } = transcript;

	if (force) {
		// Delete existing data to re-insert (DELETE is a no-op if rows don't exist)
		runSQL(`DELETE FROM transcript_segments WHERE episode_id = '${escapeSQL(episodeId)}'`);
		runSQL(`DELETE FROM episodes WHERE id = '${escapeSQL(episodeId)}'`);
	}

	// Insert episode record
	const lastSegment = segments[segments.length - 1];
	const durationMs = lastSegment ? lastSegment.end_ms : 0;
	runSQL(
		`INSERT INTO episodes (id, title, duration_ms) VALUES ('${escapeSQL(episodeId)}', '${escapeSQL(episodeId)}', ${durationMs})`
	);

	// Insert segments in batches
	for (let i = 0; i < segments.length; i += DB_BATCH_SIZE) {
		const batch = segments.slice(i, i + DB_BATCH_SIZE);
		const values = batch
			.map((s) => `('${escapeSQL(episodeId)}', ${s.start_ms}, ${s.end_ms}, '${escapeSQL(s.text)}')`)
			.join(', ');
		runSQL(`INSERT INTO transcript_segments (episode_id, start_ms, end_ms, text) VALUES ${values}`);
	}

	timer.done(`${segments.length} segments inserted`);
}

// ── Step 5: Generate embeddings → Vectorize ────────────────────────────

async function generateEmbeddings(episodeId) {
	const timer = stepTimer('EMBEDDINGS');

	const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
	const apiToken = process.env.CLOUDFLARE_API_TOKEN;
	if (!accountId || !apiToken) {
		throw new Error('Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN environment variables');
	}

	const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;

	// Read transcript
	const transcriptPath = path.join(transcriptsDir, `${episodeId}.json`);
	const transcript = JSON.parse(fs.readFileSync(transcriptPath, 'utf-8'));
	const { segments } = transcript;

	if (!segments || segments.length === 0) {
		timer.done('no segments, skipping');
		return;
	}

	// Chunk transcript into windows
	const lastSegment = segments[segments.length - 1];
	const episodeDurationMs = lastSegment.end_ms;
	const windowMs = WINDOW_SEC * 1000;
	const stepMs = STEP_SEC * 1000;

	const chunks = [];
	for (let windowStart = 0; windowStart < episodeDurationMs; windowStart += stepMs) {
		const windowEnd = windowStart + windowMs;
		const windowSegments = segments.filter((s) => s.end_ms > windowStart && s.start_ms < windowEnd);
		if (windowSegments.length === 0) continue;

		const text = windowSegments.map((s) => s.text).join(' ');
		if (!isAscii(text)) continue;
		if (text.trim().length < 20) continue;

		const chunkStartMs = windowSegments[0].start_ms;
		const chunkEndMs = windowSegments[windowSegments.length - 1].end_ms;

		chunks.push({
			id: `${episodeId}:${chunkStartMs}`,
			episode_id: episodeId,
			title: episodeId,
			start_ms: chunkStartMs,
			end_ms: chunkEndMs,
			text: text.trim(),
		});
	}

	console.log(`  ${chunks.length} chunks to embed`);

	// Embed in batches
	const vectors = [];
	for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
		const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
		const texts = batch.map((c) => c.text);

		const res = await fetch(`${baseUrl}/ai/run/${EMBED_MODEL}`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${apiToken}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ text: texts }),
		});

		if (!res.ok) {
			const body = await res.text();
			throw new Error(`Embedding API error ${res.status}: ${body}`);
		}

		const json = await res.json();
		const embeddings = json.result.data;

		for (let j = 0; j < batch.length; j++) {
			vectors.push({
				id: batch[j].id,
				values: embeddings[j],
				metadata: {
					episode_id: batch[j].episode_id,
					title: batch[j].title,
					start_ms: batch[j].start_ms,
					end_ms: batch[j].end_ms,
					text: batch[j].text,
				},
			});
		}

		console.log(`  Embedded ${Math.min(i + EMBED_BATCH_SIZE, chunks.length)}/${chunks.length}`);
	}

	// Upsert to Vectorize in batches
	for (let i = 0; i < vectors.length; i += UPSERT_BATCH_SIZE) {
		const batch = vectors.slice(i, i + UPSERT_BATCH_SIZE);
		const ndjson = batch.map((v) => JSON.stringify(v)).join('\n');

		const res = await fetch(`${baseUrl}/vectorize/v2/indexes/${VECTORIZE_INDEX}/upsert`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${apiToken}`,
				'Content-Type': 'application/x-ndjson',
			},
			body: ndjson,
		});

		if (!res.ok) {
			const body = await res.text();
			throw new Error(`Vectorize upsert error ${res.status}: ${body}`);
		}

		console.log(`  Upserted ${Math.min(i + UPSERT_BATCH_SIZE, vectors.length)}/${vectors.length}`);
	}

	timer.done(`${vectors.length} vectors`);
}

// ── Step 6: Generate summary ───────────────────────────────────────────

function parseEpisodeDate(episodeId) {
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

async function fetchSunriseSunset(dateStr) {
	const url = `https://api.sunrise-sunset.org/json?lat=37.7955&lng=-122.3937&date=${dateStr}&formatted=0`;
	try {
		const res = await fetch(url);
		const data = await res.json();
		if (data.status !== 'OK') return null;
		return {
			sunrise: utcToPacific(data.results.sunrise),
			sunset: utcToPacific(data.results.sunset),
		};
	} catch {
		return null;
	}
}

async function generateSummary(episodeId, force) {
	const timer = stepTimer('SUMMARY');

	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) {
		throw new Error('Missing OPENAI_API_KEY environment variable');
	}

	// Check if summary already exists
	if (!force) {
		try {
			const existing = queryJSON(
				`SELECT summary FROM episodes WHERE id = '${escapeSQL(episodeId)}' AND summary IS NOT NULL AND summary != ''`
			);
			if (existing.length > 0) {
				timer.done('summary already exists, skipping');
				return;
			}
		} catch {
			// Proceed
		}
	}

	// Read transcript
	const transcriptPath = path.join(transcriptsDir, `${episodeId}.json`);
	const transcript = JSON.parse(fs.readFileSync(transcriptPath, 'utf-8'));
	const transcriptText = transcript.segments.map((s) => s.text).join('\n');

	// Fetch sunrise/sunset
	const dateStr = parseEpisodeDate(episodeId);
	let sunData = null;
	if (dateStr) {
		console.log(`  Fetching sunrise/sunset for ${dateStr}...`);
		sunData = await fetchSunriseSunset(dateStr);
		if (sunData) {
			console.log(`  Sunrise: ${sunData.sunrise} PT, Sunset: ${sunData.sunset} PT`);
		}
	}

	// Build system prompt
	const systemLines = [
		'You summarize transcripts from "Roll Over Easy," a live morning radio show on BFF.fm broadcast from the Ferry Building in San Francisco.',
		'Write a concise summary in this format:',
		'',
		'Line 1: The weather/vibe that morning (if mentioned — fog, sun, rain, cold, etc.). If not mentioned, skip this line.',
		'Line 2: Who joined the show — name guests and briefly note who they are.',
		'Line 3-4: What stories and topics came up — San Francisco news, local culture, neighborhood happenings, food, music, etc.',
		'',
		'Keep a warm, San Francisco tone. Use 2-4 sentences total. Do not use bullet points or labels like "Weather:" — just weave it naturally.',
	];

	if (dateStr || sunData) {
		systemLines.push('');
		systemLines.push('Additional context for this episode:');
		if (dateStr) {
			const formatted = new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', {
				year: 'numeric', month: 'long', day: 'numeric',
			});
			systemLines.push(`- Date: ${formatted}`);
		}
		if (sunData) {
			systemLines.push(`- Sunrise: ${sunData.sunrise} PT`);
			systemLines.push(`- Sunset: ${sunData.sunset} PT`);
		}
		systemLines.push('Include the weather and temperature explicitly in your summary (pull temperature from what the hosts mention in the transcript). Also mention what time sunrise and sunset were that day.');
	}

	// Call OpenAI
	console.log('  Generating summary...');
	const res = await fetch('https://api.openai.com/v1/chat/completions', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model: 'gpt-4o-mini',
			messages: [
				{ role: 'system', content: systemLines.join('\n') },
				{ role: 'user', content: `Summarize this Roll Over Easy episode transcript:\n\n${transcriptText}` },
			],
			temperature: 0.5,
			max_tokens: 300,
		}),
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`OpenAI API error ${res.status}: ${body}`);
	}

	const data = await res.json();
	const summary = data.choices[0].message.content.trim();
	console.log(`  Summary: ${summary.slice(0, 100)}...`);

	// Update D1
	runSQL(`UPDATE episodes SET summary = '${escapeSQL(summary)}' WHERE id = '${escapeSQL(episodeId)}'`);

	timer.done();
}

// ── Step 7: Upload audio → R2 ─────────────────────────────────────────

function uploadAudio(mp3Path, episodeId, force) {
	const timer = stepTimer('UPLOAD-AUDIO');

	// Check if already uploaded
	if (!force) {
		try {
			const existing = queryJSON(
				`SELECT audio_file FROM episodes WHERE id = '${escapeSQL(episodeId)}' AND audio_file IS NOT NULL AND audio_file != ''`
			);
			if (existing.length > 0) {
				timer.done('audio already uploaded, skipping');
				return;
			}
		} catch {
			// Proceed
		}
	}

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roe-upload-'));

	try {
		// Convert MP3 → M4A (AAC 128k, faststart)
		console.log('  Converting to M4A...');
		const m4aPath = path.join(tmpDir, 'converted.m4a');
		execFileSync('ffmpeg', ['-y', '-i', mp3Path, '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', m4aPath], {
			encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'],
		});

		// Upload to R2
		const r2Key = `${episodeId}.m4a`;
		const publicUrl = `${R2_PUBLIC_URL}/${r2Key}`;
		console.log('  Uploading to R2...');
		wranglerExec(`r2 object put ${R2_BUCKET}/${r2Key} --file="${m4aPath}" --content-type="audio/mp4"`);

		// Update DB
		console.log('  Updating database...');
		runSQL(`UPDATE episodes SET audio_file = '${escapeSQL(publicUrl)}' WHERE id = '${escapeSQL(episodeId)}'`);

		timer.done();
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

// ── CLI ────────────────────────────────────────────────────────────────

function parseArgs() {
	const args = process.argv.slice(2);
	const opts = { force: false, skip: new Set(), episodeId: null, mp3Path: null };

	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--force') {
			opts.force = true;
		} else if (args[i] === '--skip' && args[i + 1]) {
			args[i + 1].split(',').forEach((s) => opts.skip.add(s.trim()));
			i++;
		} else if (args[i] === '--episode-id' && args[i + 1]) {
			opts.episodeId = args[i + 1];
			i++;
		} else if (!args[i].startsWith('--')) {
			opts.mp3Path = args[i];
		}
	}

	return opts;
}

async function main() {
	const opts = parseArgs();

	if (!opts.mp3Path) {
		console.error('Usage: node scripts/process-episode.js <mp3-file> [options]');
		console.error('');
		console.error('Options:');
		console.error('  --episode-id ID          Override auto-parsed episode ID');
		console.error('  --force                  Re-run all steps even if already done');
		console.error('  --skip step1,step2       Skip steps (transcribe, seed-db, embeddings, summary, upload-audio)');
		process.exit(1);
	}

	const mp3Path = path.resolve(opts.mp3Path);
	if (!fs.existsSync(mp3Path)) {
		console.error(`File not found: ${mp3Path}`);
		process.exit(1);
	}

	const episodeId = opts.episodeId || parseEpisodeId(mp3Path);
	const skip = opts.skip;
	const force = opts.force;

	console.log('=== Roll Over Easy — Episode Processing Pipeline ===');
	console.log(`  File:       ${path.basename(mp3Path)}`);
	console.log(`  Episode ID: ${episodeId}`);
	console.log(`  Force:      ${force}`);
	if (skip.size > 0) console.log(`  Skipping:   ${[...skip].join(', ')}`);

	const totalStart = Date.now();

	// Step 1: Prerequisites
	checkPrerequisites();

	// Step 2: Transcribe
	if (!skip.has('transcribe')) {
		transcribe(mp3Path, episodeId, force);
	} else {
		console.log('\n[TRANSCRIBE] Skipped');
	}

	// Step 3: Seed D1
	if (!skip.has('seed-db')) {
		seedDB(episodeId, force);
	} else {
		console.log('\n[SEED-DB] Skipped');
	}

	// Step 4: Embeddings
	if (!skip.has('embeddings')) {
		await generateEmbeddings(episodeId);
	} else {
		console.log('\n[EMBEDDINGS] Skipped');
	}

	// Step 5: Summary
	if (!skip.has('summary')) {
		await generateSummary(episodeId, force);
	} else {
		console.log('\n[SUMMARY] Skipped');
	}

	// Step 6: Upload audio
	if (!skip.has('upload-audio')) {
		uploadAudio(mp3Path, episodeId, force);
	} else {
		console.log('\n[UPLOAD-AUDIO] Skipped');
	}

	const totalElapsed = ((Date.now() - totalStart) / 1000).toFixed(1);
	console.log(`\n=== All done! (${totalElapsed}s total) ===`);
	console.log(`  Episode "${episodeId}" is now live.`);
}

// Only run main() when executed directly (not when imported)
const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(decodeURIComponent(new URL(import.meta.url).pathname));
if (isMainModule) {
	main().catch((err) => {
		console.error(`\nFATAL: ${err.message}`);
		process.exit(1);
	});
}
