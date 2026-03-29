#!/usr/bin/env node

/**
 * Process a single episode through the full pipeline:
 *   1. Transcribe locally with whisper.cpp
 *   2. Seed D1 database
 *   3. Generate embeddings → Vectorize
 *   4. Generate AI summary
 *   5. Extract & seed SF places
 *   6. Upload audio → R2
 *
 * Usage:
 *   node scripts/process-episode.js /path/to/roll-over-easy_2026-02-16_07-30-00.mp3
 *
 * Options:
 *   --episode-id ID          Override auto-parsed episode ID
 *   --force                  Re-run all steps even if already done
 *   --skip step1,step2       Skip specific steps (transcribe, seed-db, embeddings, summary, extract-places, upload-audio)
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
	'Wesburger, The New Wheel, Laughing Monk,',
	// Hosts
	'Sequoia, The Early Bird,',
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
const workerDir = path.join(projectRoot, 'roe-search');
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

function logWarn(message) {
	const line = `[${new Date().toISOString()}] ${message}`;
	console.warn(`  ${message}`);
	fs.appendFileSync(path.join(projectRoot, 'scripts', 'pipeline-errors.log'), line + '\n');
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

	// Roll Over Easy YYYY-MM-DD (space-separated, dashes in date — post-rename canonical form)
	const roeSpaceDashMatch = stem.match(/^Roll Over Easy\s+(\d{4})-(\d{2})-(\d{2})(?:\s|$)/i);
	if (roeSpaceDashMatch) {
		const [, y, m, d] = roeSpaceDashMatch;
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

	// Remove non-consecutive repeated hallucinations (e.g. "coffee." 500+ times)
	const freq = new Map();
	for (const seg of cleaned) {
		const words = seg.text.trim().split(/\s+/);
		if (words.length <= 3) {
			const key = seg.text.trim().toLowerCase();
			freq.set(key, (freq.get(key) || 0) + 1);
		}
	}
	const threshold = Math.max(10, Math.floor(cleaned.length * 0.02));
	const hallucinated = new Set();
	for (const [text, count] of freq) {
		if (count > threshold) hallucinated.add(text);
	}
	const result = hallucinated.size > 0
		? cleaned.filter(seg => !hallucinated.has(seg.text.trim().toLowerCase()))
		: cleaned;

	// Fix common Whisper mishearings of host name "Early Bird"
	for (const seg of result) {
		seg.text = seg.text.replace(
			/\b(nearly|yearly|really|eerily|dearly)\s+(bird|beard)\b/gi,
			'Early Bird'
		);
	}

	return result;
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
			'--max-context', '0',
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

			// offsets.from and offsets.to are in milliseconds (with VAD + --output-json-full)
			parsed.push({
				start_ms: seg.offsets.from,
				end_ms: seg.offsets.to,
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

// ── Step 3b: Transcribe (OpenAI Whisper API) ───────────────────────────

async function transcribeOpenAI(mp3Path, episodeId, force) {
	const timer = stepTimer('TRANSCRIBE (OpenAI Whisper)');
	const outputPath = path.join(transcriptsDir, `${episodeId}.json`);

	if (!force && fs.existsSync(outputPath)) {
		timer.done('transcript already exists, skipping');
		return;
	}

	const { transcribeFile } = await import('./transcribe.js');
	const transcript = await transcribeFile(mp3Path, episodeId, episodeId);

	fs.mkdirSync(transcriptsDir, { recursive: true });
	fs.writeFileSync(outputPath, JSON.stringify(transcript, null, 2));
	timer.done(`${transcript.segments.length} segments`);
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
		} catch (err) {
			logWarn(`[${episodeId}] DB check failed in seedDB: ${err.message}`);
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

	// Get actual audio duration via ffprobe
	let durationMs = 0;
	try {
		const probe = execFileSync('ffprobe', [
			'-v', 'quiet', '-show_entries', 'format=duration',
			'-of', 'csv=p=0', mp3Path,
		], { encoding: 'utf-8' }).trim();
		durationMs = Math.round(parseFloat(probe) * 1000);
	} catch {
		const lastSegment = segments[segments.length - 1];
		durationMs = lastSegment ? lastSegment.end_ms : 0;
	}
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
	purgeHallucinations(episodeId);
}

function purgeHallucinations(episodeId) {
	const hallucinations = queryJSON(
		`SELECT text, COUNT(*) as cnt FROM transcript_segments
		 WHERE episode_id = '${escapeSQL(episodeId)}'
		 GROUP BY text HAVING cnt > 20 AND length(text) > 20`
	);
	if (!hallucinations || hallucinations.length === 0) return;
	const phrases = hallucinations.map((r) => `'${escapeSQL(r.text)}'`).join(', ');
	runSQL(
		`DELETE FROM transcript_segments
		 WHERE episode_id = '${escapeSQL(episodeId)}'
		   AND text IN (${phrases})`
	);
	const totalDeleted = hallucinations.reduce((sum, r) => sum + r.cnt, 0);
	logWarn(`Purged ${totalDeleted} hallucinated segments (${hallucinations.length} unique phrase(s)) from ${episodeId}`);
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

// ── Guest interview start detection ───────────────────────────────────

function detectGuestStart(segments, guestNames) {
	const MIN_START_MS = 3_000_000;
	const SONG_DURATION_MS = 180_000;
	const GAP_THRESHOLD_MS = 60_000;
	const FALLBACK_MS = 3_600_000;

	if (guestNames.length === 0) return null;

	const late = segments.filter(s => s.start_ms >= MIN_START_MS);
	if (late.length === 0) return null;

	const breaks = [];
	for (let i = 0; i < late.length; i++) {
		const seg = late[i];
		const duration = seg.end_ms - seg.start_ms;
		if (duration >= SONG_DURATION_MS) {
			breaks.push({ type: 'song', index: i, end_ms: seg.end_ms });
		}
		if (i > 0) {
			const gap = seg.start_ms - late[i - 1].end_ms;
			if (gap >= GAP_THRESHOLD_MS) {
				breaks.push({ type: 'gap', index: i, end_ms: late[i - 1].end_ms });
			}
		}
	}

	const lowerNames = guestNames.map(n => n.toLowerCase());
	function segmentMentionsGuest(seg) {
		const text = seg.text.toLowerCase();
		return lowerNames.some(name => text.includes(name));
	}

	if (breaks.length > 0) {
		breaks.sort((a, b) => a.end_ms - b.end_ms);
		const lastBreak = breaks[breaks.length - 1];
		const afterBreak = late.filter(s => s.start_ms >= lastBreak.end_ms);
		for (const seg of afterBreak) {
			if (segmentMentionsGuest(seg)) return seg.start_ms;
		}
		if (afterBreak.length > 0) return afterBreak[0].start_ms;
	}

	for (const seg of late) {
		if (segmentMentionsGuest(seg)) return seg.start_ms;
	}

	return FALLBACK_MS;
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
	} catch (err) {
		logWarn(`sunrise/sunset fetch failed for ${dateStr}: ${err.message}`);
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
		} catch (err) {
			logWarn(`[${episodeId}] DB check failed in generateSummary: ${err.message}`);
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
		'',
		'Respond with a JSON object containing three fields:',
		'',
		'1. "title": A short, catchy episode title (3-8 words). Highlight the main guest or topic. Use an exclamation point for energy. Examples: "Super Bowl Thursday!", "Jane Natoli\'s San Francisco!", "Tree Twins and Muni Diaries".',
		'',
		'2. "summary": A concise summary in this format:',
		'   Line 1: The weather/vibe that morning (if mentioned — fog, sun, rain, cold, etc.). If not mentioned, skip this line.',
		'   Line 2: Who joined the show — name any guests who came on for a segment and briefly note who they are. The show is live on location, so random passersby sometimes hop on the mic for a few seconds to a few minutes — mention these folks too if they say something memorable or funny.',
		'   Line 3-4: What stories and topics came up — San Francisco news, local culture, neighborhood happenings, food, music, etc.',
		'   Keep a warm, San Francisco tone. Use 2-5 sentences total. Do not use bullet points or labels like "Weather:" — just weave it naturally.',
		'',
		'3. "guests": An array of guest full names mentioned in the episode. Exclude the hosts Sequoia and The Early Bird. Return an empty array if there are no guests.',
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
	console.log('  Generating title + summary...');
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
			max_tokens: 400,
			response_format: { type: 'json_object' },
		}),
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`OpenAI API error ${res.status}: ${body}`);
	}

	const data = await res.json();
	const content = data.choices[0].message.content.trim();
	let title, summary, guests = [];
	try {
		const parsed = JSON.parse(content);
		title = parsed.title?.trim();
		summary = parsed.summary?.trim();
		guests = Array.isArray(parsed.guests) ? parsed.guests : [];
	} catch (err) {
		logWarn(`[${episodeId}] JSON parse failed in summary: ${err.message}`);
		title = null;
		summary = content;
	}

	if (title) {
		console.log(`  Title: ${title}`);
	}
	console.log(`  Summary: ${(summary || '').slice(0, 100)}...`);
	if (guests.length > 0) {
		console.log(`  Guests: ${guests.join(', ')}`);
	}

	// Update D1
	if (title) {
		runSQL(`UPDATE episodes SET title = '${escapeSQL(title)}', summary = '${escapeSQL(summary)}' WHERE id = '${escapeSQL(episodeId)}'`);
	} else {
		runSQL(`UPDATE episodes SET summary = '${escapeSQL(summary)}' WHERE id = '${escapeSQL(episodeId)}'`);
	}

	// Insert guests (idempotent: clear first, then insert)
	if (guests.length > 0) {
		runSQL(`DELETE FROM episode_guests WHERE episode_id = '${escapeSQL(episodeId)}'`);
		for (const guest of guests) {
			const name = guest.trim();
			if (name) {
				runSQL(`INSERT OR IGNORE INTO episode_guests (episode_id, guest_name) VALUES ('${escapeSQL(episodeId)}', '${escapeSQL(name)}')`);
			}
		}
	}

	// Detect guest interview start time
	if (guests.length > 0) {
		const transcriptPath = path.join(transcriptsDir, `${episodeId}.json`);
		if (fs.existsSync(transcriptPath)) {
			const transcriptData = JSON.parse(fs.readFileSync(transcriptPath, 'utf-8'));
			const guestStartMs = detectGuestStart(transcriptData.segments, guests);
			if (guestStartMs != null) {
				runSQL(`UPDATE episodes SET guest_start_ms = ${guestStartMs} WHERE id = '${escapeSQL(episodeId)}'`);
				const mins = Math.floor(guestStartMs / 60000);
				const secs = Math.floor((guestStartMs % 60000) / 1000);
				console.log(`  Guest interview starts at ${mins}:${String(secs).padStart(2, '0')}`);
			}
		}
	}

	timer.done();
}

// ── Step 6.5: Extract & seed places ────────────────────────────────────

const NOMINATIM_DELAY_MS = 1100;
const SF_VIEWBOX = '-122.517,37.833,-122.355,37.708';
const PLACES_JSON_PATH = path.join(projectRoot, 'scripts', 'places.json');

const PLACES_SYSTEM_PROMPT = `You extract San Francisco place names from a local radio show transcript.
This is "Roll Over Easy," a show deeply rooted in SF culture — hosts frequently mention restaurants, cafes, bars, taquerias, bakeries, bookstores, music venues, record shops, community spaces, murals, parks, plazas, beaches, hilltops, streets, intersections, neighborhoods, landmarks, schools, libraries, transit stops, and local businesses.

Return ONLY a JSON array of strings. Be thorough — capture every SF place mentioned, including:
- Restaurants & food: taquerias, dim sum spots, bakeries, coffee shops, ice cream parlors, breweries
- Nightlife & culture: bars, dive bars, music venues, theaters, galleries, bookstores, record shops
- Neighborhoods: Mission, Castro, Sunset, Richmond, Tenderloin, SoMa, Dogpatch, Excelsior, etc.
- Parks & outdoor: Dolores Park, Golden Gate Park, Ocean Beach, Bernal Hill, Twin Peaks, etc.
- Landmarks: Ferry Building, Transamerica Pyramid, Sutro Tower, Coit Tower, City Hall, etc.
- Streets & intersections: Market Street, Valencia Street, 24th & Mission, etc.
- Transit: Muni stops, BART stations, cable car lines
- Community spaces: Manny's, BFF.fm Studios, libraries, rec centers

Only include places in San Francisco proper (not Oakland, Berkeley, Marin, or other Bay Area cities unless the place is an SF icon like the Golden Gate Bridge).
Normalise names to how they'd appear on a map:
- "17th and valencia" → "17th Street & Valencia Street"
- "dolores park" → "Dolores Park"
- "the mission" → "Mission District"
If nothing qualifies, return [].`;

function sampleTranscript(segments) {
	const total = segments.length;
	if (total < 50) return segments.map(s => s.text).join(' ');

	const start = Math.min(40, Math.floor(total * 0.05));
	const usable = total - start;
	const windowSize = Math.min(200, Math.floor(usable / 5));
	const windows = [];
	for (let i = 0; i < 5; i++) {
		const offset = start + Math.floor((usable / 5) * i);
		windows.push(segments.slice(offset, offset + windowSize));
	}
	return windows.flat().map(s => s.text).join(' ').slice(0, 12000);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function nominatimSearch(url) {
	const res = await fetch(url, { headers: { 'User-Agent': 'roe-episode-search/1.0' } });
	if (!res.ok) return [];
	return res.json();
}

async function geocodePlace(placeName) {
	// Strategy 1: Bounded SF search
	const q1 = encodeURIComponent(placeName + ' San Francisco CA');
	try {
		const results = await nominatimSearch(`https://nominatim.openstreetmap.org/search?q=${q1}&format=json&limit=1&viewbox=${SF_VIEWBOX}&bounded=1`);
		if (results.length > 0) return { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) };
	} catch {}

	await sleep(NOMINATIM_DELAY_MS);

	// Strategy 2: Intersection handling
	if (placeName.includes('&') || placeName.includes(' and ')) {
		const parts = placeName.split(/\s*[&]\s*|\s+and\s+/i);
		if (parts.length === 2) {
			const q2 = encodeURIComponent(parts[0].trim() + ' and ' + parts[1].trim() + ', San Francisco');
			try {
				const results = await nominatimSearch(`https://nominatim.openstreetmap.org/search?q=${q2}&format=json&limit=1&viewbox=${SF_VIEWBOX}&bounded=1`);
				if (results.length > 0) return { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) };
			} catch {}
			await sleep(NOMINATIM_DELAY_MS);

			// Strategy 3: First street only
			const q3 = encodeURIComponent(parts[0].trim() + ', San Francisco CA');
			try {
				const results = await nominatimSearch(`https://nominatim.openstreetmap.org/search?q=${q3}&format=json&limit=1&viewbox=${SF_VIEWBOX}&bounded=1`);
				if (results.length > 0) return { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) };
			} catch {}
			await sleep(NOMINATIM_DELAY_MS);
		}
	}

	// Strategy 4: Unbounded but verify SF area
	const q4 = encodeURIComponent(placeName + ' San Francisco CA');
	try {
		const results = await nominatimSearch(`https://nominatim.openstreetmap.org/search?q=${q4}&format=json&limit=1&viewbox=${SF_VIEWBOX}&bounded=0`);
		if (results.length > 0) {
			const lat = parseFloat(results[0].lat);
			const lng = parseFloat(results[0].lon);
			if (lat >= 37.7 && lat <= 37.84 && lng >= -122.52 && lng <= -122.35) {
				return { lat, lng };
			}
		}
	} catch {}

	return null;
}

async function extractAndSeedPlaces(episodeId, force) {
	const timer = stepTimer('EXTRACT-PLACES');

	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) {
		logWarn('Missing OPENAI_API_KEY — skipping place extraction');
		timer.done('skipped (no API key)');
		return;
	}

	// Read transcript
	const transcriptPath = path.join(transcriptsDir, `${episodeId}.json`);
	const transcript = JSON.parse(fs.readFileSync(transcriptPath, 'utf-8'));
	const text = sampleTranscript(transcript.segments);

	// Extract places via GPT-4o-mini
	console.log('  Extracting SF places from transcript...');
	const res = await fetch('https://api.openai.com/v1/chat/completions', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model: 'gpt-4o-mini',
			messages: [
				{ role: 'system', content: PLACES_SYSTEM_PROMPT },
				{ role: 'user', content: text },
			],
			temperature: 0,
			max_tokens: 1000,
		}),
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`OpenAI API error ${res.status}: ${body}`);
	}

	const data = await res.json();
	const content = data.choices[0].message.content.trim();
	let places;
	try {
		const cleaned = content.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
		places = JSON.parse(cleaned);
	} catch {
		places = [];
	}

	if (places.length === 0) {
		timer.done('no SF places found');
		return;
	}

	console.log(`  Found ${places.length} places: ${places.slice(0, 5).join(', ')}${places.length > 5 ? '...' : ''}`);

	// Load existing places.json
	let placesData = { episodeResults: {}, places: [] };
	if (fs.existsSync(PLACES_JSON_PATH)) {
		try { placesData = JSON.parse(fs.readFileSync(PLACES_JSON_PATH)); } catch {}
	}

	// Update episodeResults for this episode
	placesData.episodeResults[episodeId] = places;

	// Build set of already-geocoded place names
	const existingCoords = {};
	for (const p of (placesData.places || [])) {
		existingCoords[p.name] = { lat: p.lat, lng: p.lng };
	}

	// Find new places that need geocoding
	const newPlaceNames = places.filter(name => !existingCoords[name]);
	if (newPlaceNames.length > 0) {
		console.log(`  Geocoding ${newPlaceNames.length} new places...`);
	}

	const newGeocoded = [];
	for (const name of newPlaceNames) {
		const coords = await geocodePlace(name);
		if (coords) {
			newGeocoded.push({ name, lat: coords.lat, lng: coords.lng });
			existingCoords[name] = coords;
		}
		await sleep(NOMINATIM_DELAY_MS);
	}

	// Rebuild places array: update episode lists for existing places, add new ones
	const placeMap = new Map();
	for (const p of (placesData.places || [])) {
		placeMap.set(p.name, { ...p, episodes: new Set(p.episodes || []) });
	}
	for (const ng of newGeocoded) {
		placeMap.set(ng.name, { ...ng, episodes: new Set() });
	}
	// Add this episode to all its places
	for (const name of places) {
		if (placeMap.has(name)) {
			placeMap.get(name).episodes.add(episodeId);
		}
	}
	// Convert back to arrays
	placesData.places = [...placeMap.values()].map(p => ({
		name: p.name, lat: p.lat, lng: p.lng, episodes: [...p.episodes],
	}));

	fs.writeFileSync(PLACES_JSON_PATH, JSON.stringify(placesData, null, 2));

	// Seed to D1 incrementally
	console.log('  Seeding places to D1...');

	// Clear this episode's mentions first (idempotent re-run)
	runSQL(`DELETE FROM place_mentions WHERE episode_id = '${escapeSQL(episodeId)}'`);

	// Insert any new places
	const geocodedForThisEpisode = places
		.map(name => existingCoords[name] ? { name, ...existingCoords[name] } : null)
		.filter(Boolean);

	for (const p of geocodedForThisEpisode) {
		runSQL(`INSERT OR IGNORE INTO places (name, lat, lng) VALUES ('${escapeSQL(p.name)}', ${p.lat}, ${p.lng})`);
	}

	// Get place IDs and insert mentions
	const placeRows = queryJSON('SELECT id, name FROM places');
	const nameToId = {};
	for (const row of placeRows) nameToId[row.name] = row.id;

	const mentionValues = geocodedForThisEpisode
		.filter(p => nameToId[p.name])
		.map(p => `(${nameToId[p.name]}, '${escapeSQL(episodeId)}')`)
		.join(', ');

	if (mentionValues) {
		runSQL(`INSERT OR IGNORE INTO place_mentions (place_id, episode_id) VALUES ${mentionValues}`);
	}

	const seededCount = geocodedForThisEpisode.filter(p => nameToId[p.name]).length;
	timer.done(`${places.length} extracted, ${newGeocoded.length} newly geocoded, ${seededCount} seeded to D1`);
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
		} catch (err) {
			logWarn(`[${episodeId}] DB check failed in uploadAudio: ${err.message}`);
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
	const opts = { force: false, skip: new Set(), episodeId: null, mp3Path: null, openaiWhisper: false };

	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--force') {
			opts.force = true;
		} else if (args[i] === '--skip' && args[i + 1]) {
			args[i + 1].split(',').forEach((s) => opts.skip.add(s.trim()));
			i++;
		} else if (args[i] === '--episode-id' && args[i + 1]) {
			opts.episodeId = args[i + 1];
			i++;
		} else if (args[i] === '--openai-whisper') {
			opts.openaiWhisper = true;
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
		console.error('  --openai-whisper         Use OpenAI Whisper API instead of local whisper.cpp');
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
	console.log(`  Transcribe: ${opts.openaiWhisper ? 'OpenAI Whisper API' : 'local whisper.cpp'}`);
	if (skip.size > 0) console.log(`  Skipping:   ${[...skip].join(', ')}`);

	const totalStart = Date.now();

	// Step 1: Prerequisites (only needed for local whisper)
	if (!opts.openaiWhisper) {
		checkPrerequisites();
	}

	// Step 2: Transcribe
	if (!skip.has('transcribe')) {
		if (opts.openaiWhisper) {
			await transcribeOpenAI(mp3Path, episodeId, force);
		} else {
			transcribe(mp3Path, episodeId, force);
		}
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

	// Step 6: Extract & seed places
	if (!skip.has('extract-places')) {
		await extractAndSeedPlaces(episodeId, force);
	} else {
		console.log('\n[EXTRACT-PLACES] Skipped');
	}

	// Step 7: Upload audio
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
