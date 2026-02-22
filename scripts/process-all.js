#!/usr/bin/env node

/**
 * Batch-process all discovered episodes through the full pipeline.
 *
 * Features:
 *   - Checkpoint/resume: tracks completed/failed/skipped episodes in batch-progress.json
 *   - Spawns process-episode.js as a subprocess per episode (isolates memory/crashes)
 *   - Configurable cooldown between episodes for thermal management
 *   - Retry up to 2 times on failure
 *   - Quality gates: rejects bad transcriptions, warns on hallucination indicators
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
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { discoverEpisodes } from './discover-episodes.js';
import { updateManifestStatus } from './generate-manifest.js';

const projectRoot = path.resolve(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)), '..');
const transcriptsDir = path.join(projectRoot, 'transcripts');
const progressPath = path.join(projectRoot, 'scripts', 'batch-progress.json');
const processEpisodeScript = path.join(projectRoot, 'scripts', 'process-episode.js');

const MAX_RETRIES = 2;

// Quality gate thresholds
const MIN_SEGMENTS = 100;
const MAX_SEGMENT_CHARS = 500;
const MIN_SUMMARY_CHARS = 50;
const MAX_SUMMARY_CHARS = 500;
const MAX_PHRASE_REPEATS = 20;

// ── Progress tracking ──────────────────────────────────────────────────

function loadProgress() {
	if (fs.existsSync(progressPath)) {
		return JSON.parse(fs.readFileSync(progressPath, 'utf-8'));
	}
	return {
		started: new Date().toISOString(),
		completed: {},    // episodeId → { date, duration_sec, file }
		failed: {},       // episodeId → { date, error, attempts, file }
		skipped: {},      // episodeId → { date, reason, file }
		timings: [],      // duration in seconds for completed episodes (for ETA)
	};
}

function saveProgress(progress) {
	fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2));
}

// ── Quality gates ──────────────────────────────────────────────────────

function checkQuality(episodeId) {
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

// ── Main ───────────────────────────────────────────────────────────────

function parseArgs() {
	const args = process.argv.slice(2);
	const opts = { audioDir: null, cooldown: 120, startFrom: null, dryRun: false, max: Infinity };

	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--cooldown' && args[i + 1]) {
			opts.cooldown = parseInt(args[i + 1], 10);
			i++;
		} else if (args[i] === '--start-from' && args[i + 1]) {
			opts.startFrom = args[i + 1];
			i++;
		} else if (args[i] === '--dry-run') {
			opts.dryRun = true;
		} else if (args[i] === '--max' && args[i + 1]) {
			opts.max = parseInt(args[i + 1], 10);
			i++;
		} else if (!args[i].startsWith('--')) {
			opts.audioDir = args[i];
		}
	}

	return opts;
}

function main() {
	const opts = parseArgs();

	if (!opts.audioDir) {
		console.error('Usage: node scripts/process-all.js <audio-directory> [options]');
		console.error('');
		console.error('Options:');
		console.error('  --cooldown <seconds>    Cooldown between episodes (default: 120)');
		console.error('  --start-from <date>     Start from YYYY-MM-DD, skipping earlier');
		console.error('  --dry-run               Show what would be processed');
		console.error('  --max <n>               Process at most n episodes');
		process.exit(1);
	}

	// Load checkpoint
	const progress = loadProgress();
	const alreadyDone = new Set([
		...Object.keys(progress.completed),
		...Object.keys(progress.skipped),
	]);

	// Also count existing transcripts as already processed
	if (fs.existsSync(transcriptsDir)) {
		for (const f of fs.readdirSync(transcriptsDir)) {
			if (f.endsWith('.json')) {
				alreadyDone.add(path.basename(f, '.json'));
			}
		}
	}

	// Discover episodes
	const { episodes, totalFiles, uniqueDates } = discoverEpisodes(opts.audioDir, { alreadyProcessed: alreadyDone });

	// Apply --start-from filter
	let toProcess = episodes;
	if (opts.startFrom) {
		toProcess = toProcess.filter((e) => e.date >= opts.startFrom);
	}

	// Apply --max limit
	if (toProcess.length > opts.max) {
		toProcess = toProcess.slice(0, opts.max);
	}

	// Summary
	const completedCount = Object.keys(progress.completed).length;
	const failedCount = Object.keys(progress.failed).length;

	console.log('=== Roll Over Easy — Batch Processing ===');
	console.log(`  ${timestamp()} Total MP3 files: ${totalFiles}`);
	console.log(`  ${timestamp()} Unique dates: ${uniqueDates}`);
	console.log(`  ${timestamp()} Previously completed: ${completedCount}`);
	console.log(`  ${timestamp()} Previously failed: ${failedCount}`);
	console.log(`  ${timestamp()} Already have transcripts: ${alreadyDone.size}`);
	console.log(`  ${timestamp()} To process this run: ${toProcess.length}`);
	console.log(`  ${timestamp()} Cooldown: ${opts.cooldown}s between episodes`);
	if (opts.startFrom) console.log(`  ${timestamp()} Starting from: ${opts.startFrom}`);
	console.log('');

	if (opts.dryRun) {
		console.log('=== DRY RUN — would process: ===');
		for (let i = 0; i < toProcess.length; i++) {
			const e = toProcess[i];
			const sizeMB = (e.fileSize / (1024 * 1024)).toFixed(1);
			console.log(`  ${String(i + 1).padStart(3)}. ${e.date}  ${e.episodeId}  (${sizeMB} MB)`);
		}
		return;
	}

	if (toProcess.length === 0) {
		console.log('Nothing to process!');
		return;
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

		console.log(`\n${'='.repeat(70)}`);
		console.log(`[${i + 1}/${toProcess.length}] ${episode.episodeId}`);
		console.log(`  ${timestamp()} File: ${path.basename(episode.filePath)}`);
		console.log(`  ${timestamp()} Size: ${(episode.fileSize / (1024 * 1024)).toFixed(1)} MB`);
		console.log(`  ${timestamp()} ETA for remaining: ${etaStr}`);
		console.log(`${'='.repeat(70)}`);

		let lastError = null;

		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			if (attempt > 0) {
				console.log(`\n  ${timestamp()} Retry ${attempt}/${MAX_RETRIES}...`);
			}

			try {
				execFileSync('node', [processEpisodeScript, episode.filePath], {
					encoding: 'utf-8',
					stdio: 'inherit',
					timeout: 0, // no timeout — transcription can take 60+ min
					env: process.env,
				});

				lastError = null;
				break;
			} catch (err) {
				lastError = err.message || String(err);
				console.error(`  ${timestamp()} Error: ${lastError.slice(0, 200)}`);
			}
		}

		const durationSec = (Date.now() - episodeStart) / 1000;

		if (lastError) {
			console.error(`  ${timestamp()} FAILED after ${MAX_RETRIES + 1} attempts`);
			progress.failed[episode.episodeId] = {
				date: episode.date,
				error: lastError.slice(0, 500),
				attempts: MAX_RETRIES + 1,
				file: path.basename(episode.filePath),
				timestamp: new Date().toISOString(),
			};
			updateManifestStatus(episode.episodeId, 'failed');
			failed++;
		} else {
			// Quality gates
			const quality = checkQuality(episode.episodeId);

			if (!quality.pass) {
				console.error(`  ${timestamp()} QUALITY GATE FAILED:`);
				quality.errors.forEach((e) => console.error(`    - ${e}`));
				progress.skipped[episode.episodeId] = {
					date: episode.date,
					reason: quality.errors.join('; '),
					file: path.basename(episode.filePath),
					timestamp: new Date().toISOString(),
				};
				updateManifestStatus(episode.episodeId, 'skipped');
			} else {
				if (quality.warnings && quality.warnings.length > 0) {
					quality.warnings.forEach((w) => console.warn(`  ${timestamp()} WARNING: ${w}`));
				}
				console.log(`  ${timestamp()} OK (${quality.segmentCount} segments, ${formatDuration(durationSec)})`);
				progress.completed[episode.episodeId] = {
					date: episode.date,
					duration_sec: Math.round(durationSec),
					file: path.basename(episode.filePath),
					timestamp: new Date().toISOString(),
				};
				updateManifestStatus(episode.episodeId, 'completed');
				progress.timings.push(durationSec);
				succeeded++;
			}
		}

		processed++;
		saveProgress(progress);

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
			console.log(`    - ${id}: ${info.reason}`);
		}
	}

	console.log(`\n  Progress file: ${progressPath}`);
}

main();
