#!/usr/bin/env node

/**
 * Batch-process all discovered episodes through the full pipeline.
 *
 * Features:
 *   - Checkpoint/resume: tracks completed/failed/skipped episodes in batch-progress.json
 *   - Leaves episodes that are already complete on the site alone (asks D1)
 *   - Skips dates split into several files (MULTI-PART, see discover-episodes.js)
 *   - Spawns process-episode.js as a subprocess per episode (isolates memory/crashes)
 *   - Configurable cooldown between episodes for thermal management
 *   - Retry up to 2 times on failure
 *   - Quality gates: rejects bad transcriptions, warns on hallucination indicators
 *   - A rejected recording falls back to the date's next one (discover-episodes.js
 *     alternates). A date whose every recording was rejected is skipped until a new
 *     or changed file for it appears; rejected transcripts go to transcripts/.rejected/
 *   - Progress logging with ETA
 *
 * Usage:
 *   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... OPENAI_API_KEY=... \
 *     node scripts/process-all.js "/path/to/All episodes/" [options]
 *
 * Options:
 *   --cooldown <seconds>    Cooldown between episodes (default: 120)
 *   --start-from <date>     Start from a specific date (YYYY-MM-DD), skipping earlier
 *   --dry-run               Show what would be processed without doing anything
 *   --max <n>               Process at most n episodes then stop
 *   --time-limit <hours>    Stop after this many hours (finishes current episode first)
 *   --force step1,step2     Redo these process-episode.js steps even if already done
 *   --include-reviewed      Also redo reviewed episodes' titles, summaries, guests and interview times
 *   --no-gpu                Run whisper.cpp on the CPU (slower; for when its GPU start-up hangs)
 *
 * --force and --include-reviewed apply to the episodes this run processes: new
 * ones and ones a run left unfinished. An episode complete on the site is never
 * re-run; use process-episode.js for that. Before the first episode, whisper.cpp
 * gets a one-second test run, so a whisper.cpp that hangs stops the batch at once.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { discoverEpisodes } from './discover-episodes.js';
import { STEPS, whisperStartProblem } from './process-episode.js';
import { chunkEpisode } from './generate-embeddings.js';
import { rememberStaleVectors } from './transcript-file.js';
import { queryJSON, projectRoot, transcriptsDir, probeDurationMs } from './lib.js';
import { checkCoverage } from '../roe-pipeline/src/coverage.js';

// A test run (ROE_PERSIST_TO, see lib.js) asks the scratch D1 which episodes are
// done, runs phase 2 against it (--local) and keeps its checkpoint in the test
// folder, so it can't reach production or change the real batch-progress.json
const testRun = !!process.env.ROE_PERSIST_TO;
const progressPath = testRun
	? path.join(path.resolve(process.env.ROE_PERSIST_TO), 'batch-progress.json')
	: path.join(projectRoot, 'scripts', 'batch-progress.json');
const processEpisodeScript = path.join(projectRoot, 'scripts', 'process-episode.js');

const MAX_RETRIES = 2;

// Quality gate thresholds
const MIN_SEGMENTS = 100;
const MAX_SEGMENT_CHARS = 500;
const MAX_PHRASE_REPEATS = 20;

// ── Progress tracking ──────────────────────────────────────────────────

function loadProgress() {
	if (fs.existsSync(progressPath)) {
		return JSON.parse(fs.readFileSync(progressPath, 'utf-8'));
	}
	return {
		started: new Date().toISOString(),
		completed: {},    // episodeId → { date, duration_sec, file, rejected? }
		failed: {},       // episodeId → { date, error, attempts, file }
		skipped: {},      // episodeId → { date, reason, file, rejected: [{ file, size, reason, timestamp }] }
		timings: [],      // duration in seconds for completed episodes (for ETA)
	};
}

function saveProgress(progress) {
	fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2));
}

/** The recordings a skipped entry says the quality gate rejected (older entries name only one). */
function rejections(entry) {
	return entry.rejected ?? [{ file: entry.file, reason: entry.reason, timestamp: entry.timestamp }];
}

/** Every recording of a date the quality gate rejected, in any run and under any episode ID. */
function rejectedRecordings(progress, date) {
	return Object.values(progress.skipped).filter((s) => s.date === date).flatMap(rejections);
}

/**
 * A date's recordings still worth a try: its preferred file, then its
 * alternates (discover-episodes.js), less the ones the quality gate rejected in
 * any run. A file with the same name and size is the one rejected; an older
 * entry has no size, so there the name decides.
 */
export function recordingsToTry(episode, progress) {
	const rejected = rejectedRecordings(progress, episode.date);
	const wasRejected = (f) => rejected.some((r) => r.file === path.basename(f.filePath) && (r.size == null || r.size === f.fileSize));
	return [episode, ...(episode.alternates ?? [])]
		.filter((f) => !wasRejected(f))
		.map(({ episodeId, filePath, fileSize }) => ({ episodeId, filePath, fileSize }));
}

/**
 * Move a transcript the gate rejected to transcripts/.rejected/ (no script reads
 * it there), so the date's next recording is transcribed afresh instead of this
 * one being reused. Any search vectors it had go when the next one is embedded.
 */
function setAside(episodeId, filePath) {
	const from = path.join(transcriptsDir, `${episodeId}.json`);
	if (!fs.existsSync(from)) return;
	const vectorIds = chunkEpisode(JSON.parse(fs.readFileSync(from, 'utf-8'))).map((c) => c.id);
	if (vectorIds.length > 0) rememberStaleVectors(episodeId, vectorIds);
	const dir = path.join(transcriptsDir, '.rejected');
	fs.mkdirSync(dir, { recursive: true });
	fs.renameSync(from, path.join(dir, `${episodeId} (${path.parse(filePath).name}).json`));
}

// ── Quality gates ──────────────────────────────────────────────────────

function checkQuality(episodeId, filePath) {
	const warnings = [];

	// Check transcript
	const transcriptPath = path.join(transcriptsDir, `${episodeId}.json`);
	if (!fs.existsSync(transcriptPath)) {
		return { pass: false, errors: ['Transcript file not found after processing'] };
	}

	const transcript = JSON.parse(fs.readFileSync(transcriptPath, 'utf-8'));
	const segments = transcript.segments || [];

	if (segments.length < MIN_SEGMENTS) {
		return { pass: false, errors: [`Only ${segments.length} segments (minimum ${MIN_SEGMENTS}) — likely failed transcription`] };
	}

	// Does it cover the recording? New transcripts record it (transcript-file.js);
	// older files are measured against the recording now. A show that stops at 45
	// minutes has ~750 lines and passed the line count alone.
	const coverage = checkCoverage(segments, transcript.meta?.audio_ms || probeDurationMs(filePath));
	if (!coverage.ok) return { pass: false, errors: coverage.problems.map((p) => `Coverage: ${p}`) };
	if (transcript.meta?.holes?.length) warnings.push(`${transcript.meta.holes.length} hole(s) of 5+ minutes (on the re-transcribe list)`);

	const longSegments = segments.filter((s) => s.text.length > MAX_SEGMENT_CHARS);
	if (longSegments.length > 0) {
		warnings.push(`${longSegments.length} segments exceed ${MAX_SEGMENT_CHARS} chars (possible hallucination)`);
	}

	const phraseFreq = new Map();
	for (const seg of segments) {
		if (seg.text.length > 20) {
			const key = seg.text.trim().toLowerCase();
			phraseFreq.set(key, (phraseFreq.get(key) || 0) + 1);
		}
	}
	for (const [text, count] of phraseFreq) {
		if (count > MAX_PHRASE_REPEATS) {
			return { pass: false, errors: [`Hallucination: "${text.slice(0, 60)}..." repeated ${count}×`] };
		}
	}

	return { pass: true, warnings, segmentCount: segments.length };
}

// ── Formatting helpers ─────────────────────────────────────────────────

function formatDuration(seconds) {
	if (seconds < 60) return `${seconds.toFixed(0)}s`;
	if (seconds < 3600) return `${(seconds / 60).toFixed(1)} min`;
	const h = Math.floor(seconds / 3600);
	const m = Math.round((seconds % 3600) / 60);
	return `${h}h ${m}m`;
}

function timestamp() {
	return new Date().toLocaleTimeString('en-US', { hour12: false });
}

function megabytes(bytes) {
	return (bytes / (1024 * 1024)).toFixed(1);
}

/**
 * The two process-episode.js runs for one file (node arguments). `episodeId`
 * puts a file whose name gives another ID in as that episode (a date's
 * alternate recording).
 */
export function episodeRuns(filePath, { force = [], includeReviewed = false, noGpu = false, local = false, episodeId = null } = {}) {
	const id = episodeId ? ['--episode-id', episodeId] : [];

	// Phase 1: transcribe only, so the quality gate can reject a bad
	// transcript BEFORE anything goes live in D1/Vectorize/R2 (the
	// interview time included).
	const phase1 = [processEpisodeScript, filePath, ...id, '--skip', 'seed-db,embeddings,summary,guest-start,upload-audio'];
	if (force.includes('transcribe')) phase1.push('--force', 'transcribe');
	if (noGpu) phase1.push('--no-gpu');

	// Phase 2: the remaining steps. Transcription is skipped explicitly so
	// --force can't redo it; a new transcript is seeded again.
	const phase2 = [processEpisodeScript, filePath, ...id, '--skip', 'transcribe'];
	const forced = force.filter((s) => s !== 'transcribe');
	if (force.includes('transcribe') && !forced.includes('seed-db')) forced.push('seed-db');
	if (forced.length > 0) phase2.push('--force', forced.join(','));
	if (includeReviewed) phase2.push('--include-reviewed');
	if (local) phase2.push('--local');
	return [phase1, phase2];
}

// Run one process-episode.js invocation with retries.
// Returns null on success, or the last error message.
function runEpisodeStep(args) {
	let lastError = null;
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		if (attempt > 0) {
			console.log(`\n  ${timestamp()} Retry ${attempt}/${MAX_RETRIES}...`);
		}
		try {
			execFileSync('node', args, {
				encoding: 'utf-8',
				stdio: 'inherit',
				timeout: 0, // no timeout — transcription can take 60+ min
				env: process.env,
			});
			return null;
		} catch (err) {
			lastError = err.message || String(err);
			console.error(`  ${timestamp()} Error: ${lastError.slice(0, 200)}`);
		}
	}
	return lastError;
}

// ── Main ───────────────────────────────────────────────────────────────

function usage(problem) {
	if (problem) console.error(`${problem}\n`);
	console.error('Usage: node scripts/process-all.js <audio-directory> [options]');
	console.error('');
	console.error('Options:');
	console.error('  --cooldown <seconds>    Cooldown between episodes (default: 120)');
	console.error('  --start-from <date>     Start from YYYY-MM-DD, skipping earlier');
	console.error('  --dry-run               Show what would be processed');
	console.error('  --max <n>               Process at most n episodes');
	console.error('  --time-limit <hours>    Stop after this many hours');
	console.error('  --force step1,step2     Redo these steps even if already done');
	console.error('  --include-reviewed      Also redo reviewed episodes\' titles, summaries, guests and interview times');
	console.error('  --no-gpu                Run whisper.cpp on the CPU (slower), for when its GPU start-up hangs');
	console.error('');
	console.error(`Steps: ${STEPS.join(', ')}`);
	process.exit(1);
}

// Mistyped options stop the run instead of being ignored
function parseArgs() {
	const args = process.argv.slice(2);
	const opts = { audioDir: null, cooldown: 120, startFrom: null, dryRun: false, max: Infinity, timeLimitMs: null, force: [], includeReviewed: false, noGpu: false };
	const value = (i, check) => {
		if (args[i + 1] === undefined || !check(args[i + 1])) usage(`${args[i]} needs a valid value`);
		return args[i + 1];
	};
	const isNumber = (v) => Number.isFinite(Number(v)) && Number(v) >= 0;

	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--cooldown') {
			opts.cooldown = parseInt(value(i++, isNumber), 10);
		} else if (args[i] === '--start-from') {
			opts.startFrom = value(i++, (v) => /^\d{4}-\d{2}-\d{2}$/.test(v));
		} else if (args[i] === '--dry-run') {
			opts.dryRun = true;
		} else if (args[i] === '--max') {
			opts.max = parseInt(value(i++, isNumber), 10);
		} else if (args[i] === '--time-limit') {
			opts.timeLimitMs = parseFloat(value(i++, isNumber)) * 60 * 60 * 1000;
		} else if (args[i] === '--force') {
			opts.force = value(i++, (v) => !v.startsWith('-')).split(',').map((s) => s.trim()).filter(Boolean);
			const unknown = opts.force.filter((s) => !STEPS.includes(s));
			if (opts.force.length === 0) usage('--force needs a list of steps, e.g. --force summary,guest-start');
			if (unknown.length > 0) usage(`--force: no step called ${unknown.join(', ')}`);
		} else if (args[i] === '--include-reviewed') {
			opts.includeReviewed = true;
		} else if (args[i] === '--no-gpu') {
			opts.noGpu = true;
		} else if (args[i].startsWith('-')) {
			usage(`Unknown option: ${args[i]}`);
		} else if (opts.audioDir) {
			usage(`One audio directory at a time (got "${opts.audioDir}" and "${args[i]}")`);
		} else {
			opts.audioDir = args[i];
		}
	}

	return opts;
}

function main() {
	const opts = parseArgs();

	if (!opts.audioDir) usage();

	// Load checkpoint. Only episodes recorded as completed count as done — a
	// transcript on disk alone does NOT, because the pipeline may have failed
	// after transcription (seed/embed/summary/upload). Such episodes are re-run;
	// process-episode.js skips the transcription step (and any other step
	// already done) itself. A quality-skipped date is left out further down,
	// unless it has a recording the gate hasn't rejected yet.
	const progress = loadProgress();

	// Episodes already complete on the site (a duration, a summary and audio)
	// also count as done: most arrived by drag and drop after this checkpoint
	// was last written. Re-running one would transcribe it again and replace its
	// search vectors with ones built from a different transcript. A run of ours
	// that stopped partway leaves one of the three empty, so it is still resumed.
	const onSite = queryJSON(
		"SELECT id FROM episodes WHERE duration_ms IS NOT NULL AND summary IS NOT NULL AND summary != '' AND audio_file IS NOT NULL",
		{ isLocal: testRun }
	).map((r) => r.id);
	const alreadyDone = new Set([
		...Object.keys(progress.completed),
		...onSite,
	]);

	let transcriptsOnDisk = 0;
	if (fs.existsSync(transcriptsDir)) {
		transcriptsOnDisk = fs.readdirSync(transcriptsDir).filter((f) => f.endsWith('.json')).length;
	}

	// Discover episodes (dates split into parts are left out and listed in multiPart)
	const { episodes, multiPart, totalFiles, uniqueDates } = discoverEpisodes(opts.audioDir, { alreadyProcessed: alreadyDone });

	// Apply --start-from filter
	let toProcess = episodes;
	let splitDates = multiPart;
	if (opts.startFrom) {
		toProcess = toProcess.filter((e) => e.date >= opts.startFrom);
		splitDates = splitDates.filter((m) => m.date >= opts.startFrom);
	}

	// A date the quality gate rejected before is only tried again with a recording
	// it hasn't rejected: a new file for the date, or one that changed
	let retired = 0;
	toProcess = toProcess.flatMap((e) => {
		const files = recordingsToTry(e, progress);
		if (files.length === 0) retired++;
		return files.length > 0 ? [{ ...e, files }] : [];
	});

	// Apply --max limit
	if (toProcess.length > opts.max) {
		toProcess = toProcess.slice(0, opts.max);
	}

	// Summary
	const completedCount = Object.keys(progress.completed).length;
	const failedCount = Object.keys(progress.failed).length;

	console.log('=== Roll Over Easy — Batch Processing ===');
	if (testRun) console.log(`  ${timestamp()} Test run: the scratch D1 and checkpoint in ${path.resolve(process.env.ROE_PERSIST_TO)}`);
	console.log(`  ${timestamp()} Total MP3 files: ${totalFiles}`);
	console.log(`  ${timestamp()} Unique dates: ${uniqueDates}`);
	console.log(`  ${timestamp()} Previously completed: ${completedCount}`);
	console.log(`  ${timestamp()} Previously failed: ${failedCount}`);
	console.log(`  ${timestamp()} Quality-skipped, no new recording to try: ${retired}`);
	console.log(`  ${timestamp()} Complete on the site: ${onSite.length}`);
	console.log(`  ${timestamp()} Transcripts on disk: ${transcriptsOnDisk}`);
	console.log(`  ${timestamp()} To process this run: ${toProcess.length}`);
	console.log(`  ${timestamp()} Cooldown: ${opts.cooldown}s between episodes`);
	if (opts.startFrom) console.log(`  ${timestamp()} Starting from: ${opts.startFrom}`);
	if (opts.timeLimitMs) console.log(`  ${timestamp()} Time limit: ${opts.timeLimitMs / 3600000}h`);
	for (const m of splitDates) {
		console.log(`  ${timestamp()} MULTI-PART ${m.date}: ${m.files.length} files — skipped (join the parts into one file first)`);
	}
	console.log('');

	if (opts.dryRun) {
		console.log('=== DRY RUN — would process: ===');
		for (let i = 0; i < toProcess.length; i++) {
			const e = toProcess[i];
			const [first, ...next] = e.files;
			const before = rejectedRecordings(progress, e.date);
			console.log(`  ${String(i + 1).padStart(3)}. ${e.date}  ${e.episodeId}  (${megabytes(first.fileSize)} MB)  ${path.basename(first.filePath)}`);
			for (const f of next) console.log(`         if rejected: ${path.basename(f.filePath)} (${megabytes(f.fileSize)} MB)`);
			if (before.length > 0) console.log(`         rejected before: ${before.map((r) => r.file).join(', ')}`);
		}
		return;
	}

	if (toProcess.length === 0) {
		console.log('Nothing to process!');
		return;
	}

	// A whisper.cpp that hangs at start-up would fail every episode in turn: test it
	// once first (unless every episode already has its transcript)
	const needsWhisper = opts.force.includes('transcribe') || toProcess.some((e) => !fs.existsSync(path.join(transcriptsDir, `${e.episodeId}.json`)));
	if (needsWhisper) {
		console.log(`  ${timestamp()} Testing whisper.cpp${opts.noGpu ? ' on the CPU' : ''} (one second of silence)...`);
		const problem = whisperStartProblem(opts.noGpu);
		if (problem) {
			console.error(`\n${problem}.`);
			if (opts.noGpu) {
				console.error('Transcribe with OpenAI instead (about $0.72 a show): node scripts/transcribe-all.js <audio-directory>;');
				console.error('this batch then uses those transcripts.');
			} else {
				console.error('whisper.cpp can hang while it starts the GPU on this Mac. Check that no whisper-cli is left running');
				console.error('(pgrep -fl whisper-cli), then run the batch again with --no-gpu (on the CPU, slower).');
			}
			process.exit(1);
		}
		console.log(`  ${timestamp()} whisper.cpp starts`);
	}

	// Process each episode
	let processed = 0;
	let succeeded = 0;
	let failed = 0;
	const batchStart = Date.now();

	for (let i = 0; i < toProcess.length; i++) {
		const episode = toProcess[i];
		const episodeStart = Date.now();

		// Calculate ETA from running average
		const avgSec = progress.timings.length > 0
			? progress.timings.reduce((a, b) => a + b, 0) / progress.timings.length
			: 65 * 60; // default estimate: 65 min
		const remaining = toProcess.length - i;
		const etaStr = formatDuration(remaining * avgSec);

		const [first, ...next] = episode.files;
		const before = rejectedRecordings(progress, episode.date);
		console.log(`\n${'='.repeat(70)}`);
		console.log(`[${i + 1}/${toProcess.length}] ${episode.episodeId}`);
		console.log(`  ${timestamp()} File: ${path.basename(first.filePath)}`);
		console.log(`  ${timestamp()} Size: ${megabytes(first.fileSize)} MB`);
		if (next.length > 0) console.log(`  ${timestamp()} If the quality gate rejects it: ${next.map((f) => path.basename(f.filePath)).join(', ')}`);
		if (before.length > 0) console.log(`  ${timestamp()} Rejected before: ${before.map((r) => r.file).join(', ')}`);
		console.log(`  ${timestamp()} ETA for remaining: ${etaStr}`);
		console.log(`${'='.repeat(70)}`);

		// The date's recordings in turn, until one passes the quality gate
		let lastError = null;
		let quality = null;
		let file = null;
		for (const f of episode.files) {
			if (file) {
				console.log(`\n  ${timestamp()} Trying the date's next recording: ${path.basename(f.filePath)} (${megabytes(f.fileSize)} MB)`);
			}
			file = f;
			// Every recording of a date goes in as the date's one episode
			const episodeId = f.episodeId === episode.episodeId ? null : episode.episodeId;
			const [phase1, phase2] = episodeRuns(f.filePath, { ...opts, local: testRun, episodeId });
			lastError = runEpisodeStep(phase1);
			if (lastError) break;

			// Phase 2 only if the transcript passes the gate
			quality = checkQuality(episode.episodeId, f.filePath);
			if (quality.pass) {
				lastError = runEpisodeStep(phase2);
				break;
			}
			console.error(`  ${timestamp()} QUALITY GATE FAILED for ${path.basename(f.filePath)} (nothing seeded/uploaded):`);
			quality.errors.forEach((e) => console.error(`    - ${e}`));
			setAside(episode.episodeId, f.filePath);

			// Every rejected recording is kept (at once), so a later run only tries the others
			const rejection = { file: path.basename(f.filePath), size: f.fileSize, reason: quality.errors.join('; '), timestamp: new Date().toISOString() };
			const earlier = progress.skipped[episode.episodeId];
			progress.skipped[episode.episodeId] = {
				date: episode.date,
				reason: rejection.reason,
				file: rejection.file,
				timestamp: rejection.timestamp,
				rejected: [...(earlier ? rejections(earlier) : []), rejection],
			};
			saveProgress(progress);
		}

		const durationSec = (Date.now() - episodeStart) / 1000;

		if (lastError) {
			console.error(`  ${timestamp()} FAILED after ${MAX_RETRIES + 1} attempts`);
			progress.failed[episode.episodeId] = {
				date: episode.date,
				error: lastError.slice(0, 500),
				attempts: MAX_RETRIES + 1,
				file: path.basename(file.filePath),
				timestamp: new Date().toISOString(),
			};
			failed++;
		} else if (!quality.pass) {
			console.error(`  ${timestamp()} Every recording of ${episode.date} was rejected: skipped until a new or changed file for it appears`);
		} else {
			if (quality.warnings && quality.warnings.length > 0) {
				quality.warnings.forEach((w) => console.warn(`  ${timestamp()} WARNING: ${w}`));
			}
			console.log(`  ${timestamp()} OK (${quality.segmentCount} segments, ${formatDuration(durationSec)})`);
			progress.completed[episode.episodeId] = {
				date: episode.date,
				duration_sec: Math.round(durationSec),
				file: path.basename(file.filePath),
				timestamp: new Date().toISOString(),
			};
			// The recordings rejected on the way stay on record with it
			const skipped = progress.skipped[episode.episodeId];
			if (skipped) {
				progress.completed[episode.episodeId].rejected = rejections(skipped);
				delete progress.skipped[episode.episodeId];
			}
			progress.timings.push(durationSec);
			succeeded++;
		}

		processed++;
		saveProgress(progress);

		// Stop if time limit reached (finishes current episode first)
		if (opts.timeLimitMs && (Date.now() - batchStart) >= opts.timeLimitMs) {
			console.log(`\n  ${timestamp()} Time limit reached — stopping after ${processed} episodes.`);
			break;
		}

		// Running summary every 10 episodes
		if (processed % 10 === 0) {
			const elapsed = (Date.now() - batchStart) / 1000;
			console.log(`\n--- Progress: ${processed}/${toProcess.length} processed | ${succeeded} ok | ${failed} failed | ${formatDuration(elapsed)} elapsed ---\n`);
		}

		// Cooldown between episodes (skip after last episode)
		if (i < toProcess.length - 1 && opts.cooldown > 0) {
			console.log(`  ${timestamp()} Cooling down for ${opts.cooldown}s...`);
			const cooldownMs = opts.cooldown * 1000;
			const cooldownEnd = Date.now() + cooldownMs;
			while (Date.now() < cooldownEnd) {
				// Use a sync sleep via Atomics to avoid busy-wait
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(1000, cooldownEnd - Date.now()));
			}
		}
	}

	// Final summary
	const totalElapsed = (Date.now() - batchStart) / 1000;
	const totalCompleted = Object.keys(progress.completed).length;
	const totalFailed = Object.keys(progress.failed).length;
	const totalSkipped = Object.keys(progress.skipped).length;

	console.log(`\n${'='.repeat(70)}`);
	console.log('=== Batch Complete ===');
	console.log(`  ${timestamp()} This run: ${processed} processed (${succeeded} ok, ${failed} failed)`);
	console.log(`  ${timestamp()} All-time: ${totalCompleted} completed, ${totalFailed} failed, ${totalSkipped} quality-skipped`);
	console.log(`  ${timestamp()} Elapsed: ${formatDuration(totalElapsed)}`);

	if (totalFailed > 0) {
		console.log(`\n  Failed episodes:`);
		for (const [id, info] of Object.entries(progress.failed)) {
			if (typeof info === 'string') {
				console.log(`    - ${id}: ${info}`);
			} else {
				console.log(`    - ${id} (${info.file}): ${(info.error || 'unknown error').slice(0, 100)}`);
			}
		}
	}

	if (totalSkipped > 0) {
		console.log(`\n  Quality-skipped episodes:`);
		for (const [id, info] of Object.entries(progress.skipped)) {
			console.log(`    - ${id}: ${rejections(info).map((r) => `${r.file}: ${r.reason}`).join('; ')}`);
		}
	}

	console.log(`\n  Progress file: ${progressPath}`);
}

if (import.meta.main) {
	try {
		main();
	} catch (err) {
		console.error(`\nFATAL: ${err.message}`);
		process.exit(1);
	}
}
