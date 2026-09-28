#!/usr/bin/env node

/**
 * Process a single episode through the full pipeline:
 *   1. Transcribe: locally with whisper.cpp, or with OpenAI Whisper (--engine
 *      openai, the Cloudflare pipeline's own code, about $0.72 a show)
 *   2. Seed D1 database (only a transcript that covers the recording)
 *   3. Generate embeddings → Vectorize
 *   4. Generate AI summary
 *   5. Detect guest-interview start (guest_start_ms)
 *   6. Upload audio → R2
 *
 * Usage:
 *   node scripts/process-episode.js /path/to/roll-over-easy_2026-02-16_07-30-00.mp3
 *
 * Options:
 *   --episode-id ID          Override auto-parsed episode ID
 *   --force step1,step2      Redo these steps even if already done
 *   --skip step1,step2       Skip specific steps (transcribe, seed-db, embeddings, summary, guest-start, upload-audio)
 *   --include-reviewed       Also redo a reviewed episode's title, summary, guests and interview time
 *   --local                  Use the local D1 copy and R2 instead of production (no embeddings)
 *   --engine whisper.cpp|openai  How to transcribe (default whisper.cpp)
 *   --accept-short           Seed a transcript that stops early (e.g. a recording that was lost)
 *
 * An episode whose guests were reviewed by hand (guests_reviewed = 1) keeps its
 * title, summary, guests and interview time, even with --force, unless
 * --include-reviewed is given (new guests then go back to the review queue).
 * The interview time is only filled in when empty, unless guest-start is
 * forced. Forcing transcribe also forces seed-db, so D1 gets the new
 * transcript. A mistyped option or step name stops the run.
 *
 * Transcripts are written by transcript-file.js for both engines (spelling
 * fixes and loop removal before saving, a meta block, the re-transcribe list).
 * The seed step refuses a transcript that ends past its recording or before 90%
 * of it, re-seeds when D1 holds a different version of the transcript, and
 * gives the episode the recording's real length. The embeddings step deletes
 * the vectors a replaced transcript had and the new one doesn't.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
	loadEnv, escapeSQL, wranglerExec, queryJSON, runSQL,
	stepTimer, logWarn, transcriptsDir, applyWordCorrections, convertAudio, probeDurationMs,
	R2_BUCKET, R2_PUBLIC_URL,
} from './lib.js';
import { SF_VOCAB_PROMPT } from '../roe-pipeline/src/whisper-prompt.js';
import { cleanSegments } from '../roe-pipeline/src/clean-segments.js';
import { checkCoverage } from '../roe-pipeline/src/coverage.js';
import { chunkSegments, generateEmbeddings as embedEpisode } from '../roe-pipeline/src/embeddings.js';
import { summarizeEpisode, saveSummary } from './generate-summaries.js';
import { chunkEpisode } from './generate-embeddings.js';
import { detectGuestStart, MIN_START_MS } from './guest-start.js';
import { transcribeAndSave } from './transcribe.js';
import { remoteAI, remoteVectorize } from './remote-cloudflare.js';
import {
	buildTranscript, writeTranscript, readTranscript, transcriptPath, PROMPT_SHA1,
	rememberStaleVectors, staleVectors, forgetStaleVectors,
} from './transcript-file.js';

loadEnv();

// ── Constants ──────────────────────────────────────────────────────────

const DB_BATCH_SIZE = 50;
const DELETE_BATCH_SIZE = 100;
const RESEED_IF_OFF_MS = 60_000; // D1 and the disk file differ by more than this at the end…
const RESEED_IF_OFF_SHARE = 0.2; // …or by this share of their lines: re-seed

// Which D1 (and R2) every step uses: production, or the local copy with --local.
const db = { isLocal: false };

const WHISPER_MODEL_CANDIDATES = [
	path.join(os.homedir(), '.cache', 'whisper-cpp', 'ggml-large-v3.bin'),
	path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'code', 'transcribe_audio', 'whisper-env', 'ggml-large-v3.bin'),
];
const WHISPER_MODEL_PATH = WHISPER_MODEL_CANDIDATES.find((p) => fs.existsSync(p)) || WHISPER_MODEL_CANDIDATES[0];

const VAD_MODEL_PATH = path.join(os.homedir(), '.cache', 'whisper-cpp', 'ggml-silero-v6.2.0.bin');

// The spelling-hint prompt is the Worker's (roe-pipeline/src/whisper-prompt.js):
// the local one had grown past the ~224 tokens Whisper reads and lost the hosts' names.

// ── Step 1: Prerequisite checks ────────────────────────────────────────

// Only checks tools the steps that will actually run depend on. Whisper (CLI +
// models) is transcribe-only; ffmpeg is used by both transcribe and upload-audio.
// This keeps embed/summary-only runs (e.g. process-all phase 2, merge-episode)
// from failing on a machine without whisper installed. The keys those steps
// need are checked here too, so a missing one stops the run before anything is
// written, not halfway through it.
function checkPrerequisites(skip = new Set(), engine = 'whisper.cpp') {
	const timer = stepTimer('PREREQUISITES');
	const missing = [];

	const needsWhisper = !skip.has('transcribe') && engine === 'whisper.cpp';
	const needsFfmpeg = !skip.has('transcribe') || !skip.has('upload-audio');

	if (needsWhisper) {
		try {
			execFileSync('which', ['whisper-cli'], { stdio: 'pipe' });
		} catch {
			missing.push('whisper-cli — install with: brew install whisper-cpp');
		}

		if (!fs.existsSync(WHISPER_MODEL_PATH)) {
			missing.push(
				`Whisper model not found at ${WHISPER_MODEL_PATH}\n` +
				'  Download with: curl -L --create-dirs -o ' + WHISPER_MODEL_PATH + ' https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin'
			);
		}

		if (!fs.existsSync(VAD_MODEL_PATH)) {
			missing.push(
				`Silero VAD model not found at ${VAD_MODEL_PATH}\n` +
				'  Download with: curl -L https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin -o ' + VAD_MODEL_PATH
			);
		}
	}

	if (needsFfmpeg) {
		try {
			execFileSync('which', ['ffmpeg'], { stdio: 'pipe' });
		} catch {
			missing.push('ffmpeg — install with: brew install ffmpeg');
		}
	}

	if ((!skip.has('summary') || (!skip.has('transcribe') && engine === 'openai')) && !process.env.OPENAI_API_KEY) {
		missing.push('OPENAI_API_KEY (for the summary, and the openai engine) — add it to .env');
	}
	if (!skip.has('embeddings') && !db.isLocal && !(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN)) {
		missing.push('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (for the embeddings) — add them to .env');
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

	// Roll Over Easy YYYY-MM-DD (space-separated, dashes in date — how the archive is
	// named today, with an optional part number: "Roll Over Easy 2015-05-14 2")
	const roeSpaceDashMatch = stem.match(/^Roll Over Easy\s+(\d{4})-(\d{2})-(\d{2})(?:\s|$)/i);
	if (roeSpaceDashMatch) {
		const [, y, m, d] = roeSpaceDashMatch;
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

	// Roll_Over_Easy_-_YYYY-MM-DD
	const roeUnderMatch = stem.match(/^Roll_Over_Easy_-_(\d{4})-(\d{2})-(\d{2})/i);
	if (roeUnderMatch) {
		const [, y, m, d] = roeUnderMatch;
		return `roll-over-easy_${y}-${m}-${d}_07-30-00`;
	}

	// rec_YYYYMMDD_HHMM
	const recYMDMatch = stem.match(/^rec_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})/);
	if (recYMDMatch) {
		const [, y, m, d] = recYMDMatch;
		return `roll-over-easy_${y}-${m}-${d}_07-30-00`;
	}

	// rec_(YYYY_MM_DD)_N
	const recParenYMDMatch = stem.match(/^rec_\((\d{4})_(\d{2})_(\d{2})\)_/);
	if (recParenYMDMatch) {
		const [, y, m, d] = recParenYMDMatch;
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

	// Unknown name: return null rather than the raw file name, which would become a
	// junk episode ID (with spaces) on the live site. Callers must handle null.
	return null;
}

// ── Step 3: Transcribe ─────────────────────────────────────────────────

async function transcribe(mp3Path, episodeId, force, engine) {
	const timer = stepTimer(`TRANSCRIBE (${engine})`);

	if (!force && fs.existsSync(transcriptPath(episodeId))) {
		timer.done('transcript already exists, skipping');
		return;
	}

	let transcript;
	let reasons;
	if (engine === 'openai') {
		({ transcript, reasons } = await transcribeAndSave(mp3Path, episodeId));
	} else {
		({ transcript, reasons } = transcribeWithWhisperCpp(mp3Path, episodeId));
	}

	const m = transcript.meta;
	if (!m.coverage.ok) logWarn(`[${episodeId}] ${m.coverage.problems.join('; ')}`);
	if (reasons.length > 0) console.log(`  On the re-transcribe list: ${reasons.join('; ')}`);
	timer.done(`${transcript.segments.length} segments (${m.lines_removed.cleaning} removed by cleanup, ${m.lines_removed.loops} by the loop check)`);
}

/** whisper.cpp on this machine, then the Worker's cleaning (roe-pipeline/src/clean-segments.js). */
function transcribeWithWhisperCpp(mp3Path, episodeId) {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roe-whisper-'));

	try {
		// Convert MP3 → WAV (16kHz mono)
		const wavPath = path.join(tmpDir, 'audio.wav');
		console.log('  Converting to WAV (16kHz mono)...');
		execFileSync('ffmpeg', ['-nostdin', '-y', '-i', mp3Path, '-vn', '-ar', '16000', '-ac', '1', wavPath], {
			encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
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
			// Don't feed Whisper its own recent text: that's what makes it go quiet after
			// a song or repeat a line (added 3/14, lost in the April refactor; of 78
			// transcripts that stop early, 76 were made without it). Carrying the prompt
			// into every window keeps the spelling hints working without that context.
			'--max-context', '0',
			'--carry-initial-prompt',
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
		const parsed = (whisperData.transcription || [])
			.map((seg) => ({ start_ms: seg.offsets.from, end_ms: seg.offsets.to, text: (seg.text || '').trim() }))
			.filter((seg) => seg.text.length >= 3); // whisper.cpp's stray fragments

		const segments = cleanSegments(parsed);
		const old = readTranscript(episodeId);
		const transcript = buildTranscript({
			episodeId,
			segments,
			audioMs: probeDurationMs(mp3Path),
			audioFile: mp3Path,
			engine: 'whisper.cpp',
			model: path.basename(WHISPER_MODEL_PATH, '.bin'),
			settings: { language: 'en', prompt_sha1: PROMPT_SHA1, max_context: 0, carry_initial_prompt: true, vad: true, suppress_nst: true },
			removedByCleaning: parsed.length - segments.length,
		});
		const reasons = writeTranscript(transcript, { oldVectorIds: old ? chunkEpisode(old).map((c) => c.id) : [] });
		return { transcript, reasons };
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

/**
 * A transcript file from before transcript-file.js has no meta block, and may
 * still hold a loop the old filters missed. Clean it the way new ones are and
 * save it, keeping the original in transcripts/.backups/, so D1 and the search
 * vectors are built from the same lines.
 */
function upgradeOldTranscript(episodeId, transcript, mp3Path) {
	const backupDir = path.join(transcriptsDir, '.backups', `${new Date().toLocaleDateString('sv')}-before-meta`); // today's local date
	fs.mkdirSync(backupDir, { recursive: true });
	fs.copyFileSync(transcriptPath(episodeId), path.join(backupDir, `${episodeId}.json`));
	const upgraded = buildTranscript({
		episodeId,
		title: transcript.title,
		segments: transcript.segments,
		audioMs: probeDurationMs(mp3Path),
		audioFile: mp3Path,
		engine: 'unknown (made before 2026-09-27)',
		model: 'unknown',
	});
	upgraded.meta.created_at = null;
	upgraded.meta.upgraded_at = new Date().toISOString();
	writeTranscript(upgraded, { oldVectorIds: chunkEpisode(transcript).map((c) => c.id) });
	console.log(`  Old transcript file cleaned and given a meta block (original kept in ${path.relative(transcriptsDir, backupDir)}/)`);
	return upgraded;
}

// ── Step 4: Seed D1 database ───────────────────────────────────────────

function seedDB(episodeId, force, mp3Path, acceptShort) {
	const timer = stepTimer('SEED-DB');
	const id = escapeSQL(episodeId);

	let transcript = readTranscript(episodeId);
	if (!transcript) throw new Error(`No transcript file for ${episodeId}; run the transcribe step first`);
	if (!transcript.meta) transcript = upgradeOldTranscript(episodeId, transcript, mp3Path);
	const { segments, meta } = transcript;

	// A transcript with no segments is a failed transcription — refuse to seed
	// an empty episode. Thrown before any D1 mutation.
	if (!Array.isArray(segments) || segments.length === 0) {
		throw new Error(`Transcript for ${episodeId} has no segments — refusing to seed an empty episode`);
	}
	// Measured again here, not taken from the file's meta, in case the lines were edited since
	const coverage = checkCoverage(segments, meta.audio_ms || probeDurationMs(mp3Path));
	const shortProblem = coverage.ok ? null : `Transcript for ${episodeId}: ${coverage.problems.join('; ')}`;

	// transcript_segments.episode_id has a foreign key to episodes, so the
	// episodes row must exist before segments are inserted (and must never be
	// deleted while segments or guests reference it). The duration_ms update
	// after all segments land is the completion marker: a crash mid-seed
	// leaves duration_ms NULL, so the next run re-seeds instead of skipping.
	const [inD1] = queryJSON(
		`SELECT e.duration_ms AS duration_ms,
			(SELECT COUNT(*) FROM transcript_segments WHERE episode_id = '${id}') AS lines,
			(SELECT MAX(end_ms) FROM transcript_segments WHERE episode_id = '${id}') AS end_ms
		 FROM episodes e WHERE e.id = '${id}'`,
		db
	);
	const endMs = segments.reduce((max, s) => Math.max(max, s.end_ms), 0);
	if (!force && inD1?.duration_ms != null && inD1.lines > 0) {
		// Already seeded: but from this transcript? An early partial one seeded first
		// used to stay in D1 while better transcripts on disk were skipped.
		const offMs = Math.abs((inD1.end_ms ?? 0) - endMs);
		const offShare = Math.abs(inD1.lines - segments.length) / Math.max(inD1.lines, segments.length);
		if (offMs <= RESEED_IF_OFF_MS && offShare <= RESEED_IF_OFF_SHARE) {
			timer.done('episode already in DB, skipping');
			return;
		}
		const difference = `D1 has a different transcript (${inD1.lines} lines to ${Math.round((inD1.end_ms ?? 0) / 60000)} min; the file has ${segments.length} to ${Math.round(endMs / 60000)} min)`;
		if (shortProblem && !acceptShort) {
			// Don't swap what's live for a file that is itself incomplete
			logWarn(`${difference}, but ${shortProblem.replace(`Transcript for ${episodeId}: `, 'the file ')}; D1 left as it is`);
			timer.done('left as it is');
			return;
		}
		console.log(`  ${difference}: re-seeding`);
	}

	// A new episode (or a forced seed) only gets a transcript that covers the recording
	if (shortProblem) {
		if (!acceptShort) throw new Error(`${shortProblem}. Not seeding it: transcribe it again (--force transcribe), or seed it anyway with --accept-short.`);
		logWarn(`${shortProblem} (seeding anyway: --accept-short)`);
	}

	// The vectors built from what D1 held go once the new ones are uploaded
	if (inD1?.lines > 0) {
		const oldLines = queryJSON(`SELECT start_ms, end_ms, text FROM transcript_segments WHERE episode_id = '${id}' ORDER BY start_ms`, db);
		rememberStaleVectors(episodeId, chunkSegments(episodeId, oldLines).map((c) => c.id));
	}

	// Clear partial segments from a previously crashed seed (no-op on a
	// clean run); under --force this also clears the old complete seed.
	// An existing episodes row is kept (audio_file, title, etc. survive a
	// re-seed); a new one is created with NULL duration until seeding finishes.
	runSQL(`DELETE FROM transcript_segments WHERE episode_id = '${id}'`, db);
	runSQL(`UPDATE episodes SET duration_ms = NULL WHERE id = '${id}'`, db);
	runSQL(`INSERT OR IGNORE INTO episodes (id, title) VALUES ('${id}', '${id}')`, db);

	// Insert segments in batches (spelling fixes are in the file already; applying
	// them again changes nothing)
	for (let i = 0; i < segments.length; i += DB_BATCH_SIZE) {
		const batch = segments.slice(i, i + DB_BATCH_SIZE);
		const values = batch
			.map((s) => `('${id}', ${s.start_ms}, ${s.end_ms}, '${escapeSQL(applyWordCorrections(s.text))}')`)
			.join(', ');
		runSQL(`INSERT INTO transcript_segments (episode_id, start_ms, end_ms, text) VALUES ${values}`, db);
	}

	// Set duration last — the completion marker. It's the recording's real
	// length, not the last line's end, which would hide a transcript that stops early.
	const durationMs = meta.audio_ms || endMs;
	runSQL(`UPDATE episodes SET duration_ms = ${durationMs} WHERE id = '${id}'`, db);

	timer.done(`${segments.length} segments inserted, duration ${Math.round(durationMs / 60000)} min`);
}

// ── Step 5: Generate embeddings → Vectorize ────────────────────────────

async function generateEmbeddings(episodeId) {
	const timer = stepTimer('EMBEDDINGS');

	if (db.isLocal) {
		timer.done('--local: Vectorize has no local copy, skipping');
		return;
	}
	// These calls go to Cloudflare's API directly, not through lib.js's test-run check
	if (process.env.ROE_PERSIST_TO) throw new Error('ROE_PERSIST_TO is set (a test run): refusing to write embeddings to production');

	const transcript = readTranscript(episodeId);
	if (!transcript) throw new Error(`No transcript file for ${episodeId}`);
	const segments = transcript.segments || [];
	const durationMs = transcript.meta?.audio_ms ?? segments.at(-1)?.end_ms ?? 0;

	// The Worker's own embeddings code, through REST stand-ins for its bindings
	const vectorize = remoteVectorize();
	const count = await embedEpisode(remoteAI(), vectorize, episodeId, segments, durationMs);

	// Vectors of the transcript this one replaced that it doesn't have any more
	const current = new Set(chunkSegments(episodeId, segments, durationMs).map((c) => c.id));
	const stale = staleVectors(episodeId).filter((vid) => !current.has(vid));
	for (let i = 0; i < stale.length; i += DELETE_BATCH_SIZE) {
		await vectorize.deleteByIds(stale.slice(i, i + DELETE_BATCH_SIZE));
	}
	forgetStaleVectors(episodeId);

	timer.done(`${count} vectors${stale.length ? `, ${stale.length} old ones deleted` : ''}`);
}

// ── Step 6: Generate summary ───────────────────────────────────────────

async function generateSummary(episodeId, force, includeReviewed) {
	const timer = stepTimer('SUMMARY');

	// A reviewed episode keeps its title, summary and guests (even with --force),
	// and any episode keeps an existing summary unless forced. If the check
	// itself fails, the error stops the run rather than risk overwriting them.
	const [row] = queryJSON(
		`SELECT summary, guests_reviewed FROM episodes WHERE id = '${escapeSQL(episodeId)}'`,
		db
	);
	if (row?.guests_reviewed && !includeReviewed) {
		timer.done('guests reviewed by hand, left alone (--include-reviewed to redo)');
		return;
	}
	if (!force && row?.summary) {
		timer.done('summary already exists, skipping');
		return;
	}

	// The Worker's summary (roe-pipeline/src/summary.js), written in one request
	const transcript = readTranscript(episodeId);
	const segments = transcript?.segments || [];
	console.log('  Generating title + summary...');
	const result = await summarizeEpisode(episodeId, segments, transcript?.meta?.audio_ms ?? segments.at(-1)?.end_ms);
	saveSummary(episodeId, result, db);

	timer.done(result.skipped ? 'transcript too thin to summarize; an existing summary is kept' : undefined);
}

// ── Step 7: Detect guest-interview start (guest_start_ms) ──────────────

// Depends on the summary step having populated episode_guests. Reads the
// local transcript for segments and the guest list from D1, then writes
// guest_start_ms — the field that gates the "Skip to interview" button.
function detectGuestStartStep(episodeId, force, includeReviewed) {
	const timer = stepTimer('GUEST-START');

	// Only an empty interview time is filled in, unless forced, and a reviewed
	// episode's is left alone (even with --force). A failed check stops the run.
	const [row] = queryJSON(
		`SELECT guest_start_ms, guests_reviewed FROM episodes WHERE id = '${escapeSQL(episodeId)}'`,
		db
	);
	if (row?.guests_reviewed && !includeReviewed) {
		timer.done('guests reviewed by hand, interview time left alone (--include-reviewed to redo)');
		return;
	}
	if (!force && row?.guest_start_ms != null) {
		timer.done('guest_start_ms already set, skipping');
		return;
	}

	// No guests → no interview marker
	const guestRows = queryJSON(`SELECT guest_name FROM episode_guests WHERE episode_id = '${escapeSQL(episodeId)}'`, db);
	const guests = guestRows.map((g) => g.guest_name);
	if (guests.length === 0) {
		timer.done('no guests, skipping');
		return;
	}

	// Read transcript segments (written by the transcribe step)
	const transcript = readTranscript(episodeId);
	if (!transcript) {
		logWarn(`[${episodeId}] transcript not found, skipping guest-start detection`);
		timer.done('no transcript, skipping');
		return;
	}
	const segments = transcript.segments || [];

	// Duration guard: skip episodes shorter than the 50-minute detection window
	const durationMs = transcript.meta?.audio_ms ?? (segments.length > 0 ? segments[segments.length - 1].end_ms : 0);
	if (durationMs && durationMs < MIN_START_MS) {
		timer.done(`episode shorter than 50min (${durationMs}ms), skipping`);
		return;
	}

	const startMs = detectGuestStart(segments, guests);
	if (startMs == null) {
		timer.done('no guest start detected, skipping');
		return;
	}

	// Sanity check against inflated timestamps
	if (durationMs && startMs > durationMs) {
		timer.done(`detected ${startMs}ms exceeds duration ${durationMs}ms, skipping`);
		return;
	}

	// Unless forced, the write also only lands on an empty value
	runSQL(
		`UPDATE episodes SET guest_start_ms = ${startMs} WHERE id = '${escapeSQL(episodeId)}'${force ? '' : ' AND guest_start_ms IS NULL'}`,
		db
	);

	const minutes = Math.floor(startMs / 60000);
	const seconds = Math.floor((startMs % 60000) / 1000);
	timer.done(`guest_start_ms=${startMs} (${minutes}:${String(seconds).padStart(2, '0')})`);
}

// ── Step 8: Upload audio → R2 ─────────────────────────────────────────

function uploadAudio(mp3Path, episodeId, force) {
	const timer = stepTimer('UPLOAD-AUDIO');

	// Check if already uploaded. audio_file must point at this episode's
	// .m4a — a raw-MP3 URL (e.g. from an ingest flow that stashed the
	// original upload) does NOT count, since the player only ever requests
	// /audio/{id}.m4a. A failed check stops the run.
	if (!force) {
		const existing = queryJSON(
			`SELECT audio_file FROM episodes WHERE id = '${escapeSQL(episodeId)}' AND audio_file IS NOT NULL AND audio_file != ''`,
			db
		);
		if (existing.length > 0 && existing[0].audio_file.endsWith(`/${episodeId}.m4a`)) {
			timer.done('audio already uploaded, skipping');
			return;
		}
	}

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roe-upload-'));

	try {
		// Convert MP3 → M4A (AAC 128k, faststart; lib.js drops cover art)
		console.log('  Converting to M4A...');
		const m4aPath = convertAudio(mp3Path, tmpDir);

		// Upload to R2
		const r2Key = `${episodeId}.m4a`;
		const publicUrl = `${R2_PUBLIC_URL}/${r2Key}`;
		console.log('  Uploading to R2...');
		wranglerExec(['r2', 'object', 'put', db.isLocal ? '--local' : '--remote', `${R2_BUCKET}/${r2Key}`, `--file=${m4aPath}`, '--content-type=audio/mp4']);

		// Update DB
		console.log('  Updating database...');
		runSQL(`UPDATE episodes SET audio_file = '${escapeSQL(publicUrl)}' WHERE id = '${escapeSQL(episodeId)}'`, db);

		timer.done();
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

// ── CLI ────────────────────────────────────────────────────────────────

export const STEPS = ['transcribe', 'seed-db', 'embeddings', 'summary', 'guest-start', 'upload-audio'];
const ENGINES = ['whisper.cpp', 'openai'];

function usage(problem) {
	if (problem) console.error(`${problem}\n`);
	console.error('Usage: node scripts/process-episode.js <mp3-file> [options]');
	console.error('');
	console.error('Options:');
	console.error('  --episode-id ID          Override auto-parsed episode ID');
	console.error('  --force step1,step2      Redo these steps even if already done');
	console.error('  --skip step1,step2       Skip these steps');
	console.error('  --include-reviewed       Also redo a reviewed episode\'s title, summary, guests and');
	console.error('                           interview time (left alone otherwise, even with --force)');
	console.error('  --local                  Use the local D1 copy and R2 (embeddings are skipped)');
	console.error('  --engine whisper.cpp|openai  How to transcribe (default whisper.cpp; openai is the');
	console.error('                           Cloudflare pipeline\'s code, about $0.72 for a two-hour show)');
	console.error('  --accept-short           Seed a transcript that stops early or has holes at the end');
	console.error('');
	console.error(`Steps, in order: ${STEPS.join(', ')}`);
	process.exit(1);
}

/** Parse "summary,guest-start" for --force/--skip. A name that isn't a step stops the run. */
function parseSteps(flag, value) {
	const steps = (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
	if (steps.length === 0) usage(`${flag} needs a list of steps, e.g. ${flag} summary,guest-start`);
	const unknown = steps.filter((s) => !STEPS.includes(s));
	if (unknown.length > 0) usage(`${flag}: no step called ${unknown.join(', ')}`);
	return steps;
}

function parseArgs(args) {
	const opts = { force: new Set(), skip: new Set(), episodeId: null, mp3Path: null, includeReviewed: false, local: false, engine: 'whisper.cpp', acceptShort: false };

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === '--force' || arg === '--skip') {
			for (const step of parseSteps(arg, args[++i])) opts[arg.slice(2)].add(step);
		} else if (arg === '--episode-id') {
			opts.episodeId = args[++i];
			if (!opts.episodeId || opts.episodeId.startsWith('-')) usage('--episode-id needs an episode ID');
		} else if (arg === '--include-reviewed') {
			opts.includeReviewed = true;
		} else if (arg === '--local') {
			opts.local = true;
		} else if (arg === '--engine') {
			opts.engine = args[++i];
			if (!ENGINES.includes(opts.engine)) usage(`--engine is one of: ${ENGINES.join(', ')}`);
		} else if (arg === '--accept-short') {
			opts.acceptShort = true;
		} else if (arg.startsWith('-')) {
			usage(`Unknown option: ${arg}`);
		} else if (opts.mp3Path) {
			usage(`One audio file at a time (got "${opts.mp3Path}" and "${arg}")`);
		} else {
			opts.mp3Path = arg;
		}
	}

	const both = [...opts.force].filter((s) => opts.skip.has(s));
	if (both.length > 0) usage(`Can't both force and skip: ${both.join(', ')}`);
	if (!opts.mp3Path) usage();
	return opts;
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	db.isLocal = opts.local;

	const mp3Path = path.resolve(opts.mp3Path);
	if (!fs.existsSync(mp3Path)) {
		console.error(`File not found: ${mp3Path}`);
		process.exit(1);
	}

	const episodeId = opts.episodeId || parseEpisodeId(mp3Path);
	if (!episodeId) {
		console.error(`Could not work out the episode ID from "${path.basename(mp3Path)}".`);
		console.error('Pass it explicitly: --episode-id roll-over-easy_YYYY-MM-DD_07-30-00');
		process.exit(1);
	}
	const { skip, force, includeReviewed } = opts;
	// A new transcript has to replace the one in D1 too, or the search vectors
	// (always rebuilt from the local file) stop matching the site's lines
	const reseed = force.has('transcribe') && !skip.has('seed-db') && !force.has('seed-db');
	if (reseed) force.add('seed-db');

	console.log('=== Roll Over Easy — Episode Processing Pipeline ===');
	console.log(`  File:       ${path.basename(mp3Path)}`);
	console.log(`  Episode ID: ${episodeId}`);
	console.log(`  Force:      ${force.size > 0 ? [...force].join(', ') : 'none'}${reseed ? ' (seed-db because transcribe is)' : ''}`);
	if (skip.size > 0) console.log(`  Skipping:   ${[...skip].join(', ')}`);
	if (includeReviewed) console.log('  Reviewed:   redo their title, summary, guests and interview time too');
	if (opts.local) console.log('  Database:   local D1 copy');
	if (!skip.has('transcribe')) console.log(`  Engine:     ${opts.engine}`);

	const totalStart = Date.now();

	// Step 1: Prerequisites (only for the tools the un-skipped steps need)
	checkPrerequisites(skip, opts.engine);

	// Step 2: Transcribe
	if (!skip.has('transcribe')) {
		await transcribe(mp3Path, episodeId, force.has('transcribe'), opts.engine);
	} else {
		console.log('\n[TRANSCRIBE] Skipped');
	}

	// Step 3: Seed D1
	if (!skip.has('seed-db')) {
		seedDB(episodeId, force.has('seed-db'), mp3Path, opts.acceptShort);
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
		await generateSummary(episodeId, force.has('summary'), includeReviewed);
	} else {
		console.log('\n[SUMMARY] Skipped');
	}

	// Step 6: Guest-interview start detection (needs guests from the summary step)
	if (!skip.has('guest-start')) {
		detectGuestStartStep(episodeId, force.has('guest-start'), includeReviewed);
	} else {
		console.log('\n[GUEST-START] Skipped');
	}

	// Step 7: Upload audio
	if (!skip.has('upload-audio')) {
		uploadAudio(mp3Path, episodeId, force.has('upload-audio'));
	} else {
		console.log('\n[UPLOAD-AUDIO] Skipped');
	}

	const totalElapsed = ((Date.now() - totalStart) / 1000).toFixed(1);
	console.log(`\n=== All done! (${totalElapsed}s total) ===`);
	console.log(`  Episode "${episodeId}" is now ${opts.local ? 'in the local database' : 'live'}.`);
}

// Only run main() when executed directly (not when imported)
if (import.meta.main) {
	main().catch((err) => {
		console.error(`\nFATAL: ${err.message}`);
		process.exit(1);
	});
}
