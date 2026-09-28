#!/usr/bin/env node

/**
 * Scan an audio directory, parse filenames, deduplicate, and return a sorted episode manifest.
 *
 * A date recorded as several different files ("Roll Over Easy 2015-05-14 1.mp3",
 * "… 2.mp3") is skipped and reported as MULTI-PART: no one file is the whole show,
 * so join the parts into one file first.
 *
 * Usage (standalone preview):
 *   node scripts/discover-episodes.js "/path/to/All episodes/"
 *
 * Usage (as module):
 *   import { discoverEpisodes } from './discover-episodes.js';
 *   const episodes = discoverEpisodes('/path/to/All episodes/');
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseEpisodeId } from './process-episode.js';

// Files that are not ROE episodes
const SKIP_FILES = new Set([
	'SFMTrA.mp3',
	'Tall Trees with Jay Beaman.mp3',
	'Feb 26 - Burrito Justice Radio.mp3',
]);

// Audio formats to scan — kept in sync with transcribe-all.js so the discovery
// and transcription paths agree on which files count as episodes.
const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.wav', '.ogg', '.flac', '.aac', '.wma']);

// Minimum file size (5 MB) — smaller files are likely fragments
const MIN_SIZE_BYTES = 5 * 1024 * 1024;

// A part number at the end of the name: "Roll Over Easy 2015-05-14 2.mp3", "rec_(2014_01_13)_1.mp3".
const PART_NUMBER = /[\s_]\d{1,2}\.[^.]+$/;
// "(1)" or "copy" marks a duplicate of another file, not a part.
const DUPLICATE = /\(\d+\)|\bcopy\b/i;

/**
 * True when a date has a numbered file and its files (duplicates aside) are not
 * all the same size, i.e. the same recording. Numbered files of one size are
 * copies (most of the archive's numbered dates are), and even a short part
 * counts: a missing 4-minute intro is still missing. A false alarm (say a name
 * ending in a day, "Roll Over Easy March 20.mp3", next to another recording)
 * only means the date is listed for a person to look at.
 */
function isMultiPart(files) {
	const originals = files.filter((f) => !DUPLICATE.test(f.filename));
	return originals.some((f) => PART_NUMBER.test(f.filename))
		&& new Set(originals.map((f) => f.fileSize)).size > 1;
}

/**
 * Extract the date portion (YYYY-MM-DD) from a canonical episode ID.
 */
function episodeDate(episodeId) {
	const match = episodeId.match(/(\d{4}-\d{2}-\d{2})/);
	return match ? match[1] : null;
}

/**
 * Score a filename for preference when deduplicating.
 * Higher score = more preferred.
 */
function filePreferenceScore(filename) {
	const lower = filename.toLowerCase();
	let score = 0;

	// Prefer "final" or "full" in the name
	if (lower.includes('final') || lower.includes('_full')) score += 100;

	// Penalize "copy" or "(1)" duplicates
	if (lower.includes('copy') || /\(\d+\)/.test(lower)) score -= 50;

	// Penalize "Podcast Roll Over Easy" if it might duplicate a regular file
	if (lower.startsWith('podcast ')) score -= 10;

	// Penalize numbered suffixes like " 2.mp3", " 3.mp3" (fragment indicators)
	if (/\s\d\.mp3$/i.test(filename)) score -= 20;

	return score;
}

/**
 * Scan the audio directory and return a deduplicated, sorted episode list.
 *
 * @param {string} audioDir - Path to directory containing MP3 files
 * @param {Object} [opts] - Options
 * @param {Set<string>} [opts.alreadyProcessed] - Set of episode IDs to exclude
 * @returns {{ episodes: { episodeId: string, date: string, filePath: string, fileSize: number }[],
 *   multiPart: { date: string, files: string[] }[], unparseable: string[], totalFiles: number, uniqueDates: number }}
 *   multiPart lists the dates skipped because they are split into parts (only dates not already processed).
 */
export function discoverEpisodes(audioDir, opts = {}) {
	const resolvedDir = path.resolve(audioDir);
	const alreadyProcessed = opts.alreadyProcessed || new Set();

	// Read all MP3 files
	const allFiles = fs.readdirSync(resolvedDir)
		.filter((f) => AUDIO_EXTENSIONS.has(path.extname(f).toLowerCase()) && !SKIP_FILES.has(f));

	// Parse each file and collect candidates
	const candidates = [];
	const unparseable = [];

	for (const filename of allFiles) {
		const filePath = path.join(resolvedDir, filename);
		const episodeId = parseEpisodeId(filePath);

		// parseEpisodeId returns null for names it can't read
		const date = episodeId ? episodeDate(episodeId) : null;
		if (!date) {
			unparseable.push(filename);
			continue;
		}

		const stat = fs.statSync(filePath);

		candidates.push({
			filename,
			episodeId,
			date,
			filePath,
			fileSize: stat.size,
		});
	}

	// Group by date for deduplication
	const byDate = new Map();
	for (const c of candidates) {
		if (!byDate.has(c.date)) byDate.set(c.date, []);
		byDate.get(c.date).push(c);
	}

	// Pick the best file for each date
	const episodes = [];
	const multiPart = [];

	for (const [date, files] of byDate) {
		// A split show: skip it rather than quietly pick one part
		if (isMultiPart(files)) {
			if (!files.some((f) => alreadyProcessed.has(f.episodeId))) {
				multiPart.push({ date, files: files.map((f) => f.filePath).sort() });
			}
			continue;
		}

		// Filter out small files if there are larger alternatives
		let viable = files.filter((f) => f.fileSize >= MIN_SIZE_BYTES);
		if (viable.length === 0) {
			// All files are small — keep the largest one
			viable = [files.reduce((a, b) => (a.fileSize > b.fileSize ? a : b))];
		}

		// Sort by preference score (descending), then file size (descending)
		viable.sort((a, b) => {
			const scoreDiff = filePreferenceScore(b.filename) - filePreferenceScore(a.filename);
			if (scoreDiff !== 0) return scoreDiff;
			return b.fileSize - a.fileSize;
		});

		const best = viable[0];

		// Skip if already processed
		if (alreadyProcessed.has(best.episodeId)) continue;

		episodes.push({
			episodeId: best.episodeId,
			date: best.date,
			filePath: best.filePath,
			fileSize: best.fileSize,
		});
	}

	// Sort chronologically
	episodes.sort((a, b) => a.date.localeCompare(b.date));
	multiPart.sort((a, b) => a.date.localeCompare(b.date));

	return { episodes, multiPart, unparseable, totalFiles: allFiles.length, uniqueDates: byDate.size };
}

// ── CLI ────────────────────────────────────────────────────────────────

if (import.meta.main) {
	const audioDir = process.argv[2];
	if (!audioDir) {
		console.error('Usage: node scripts/discover-episodes.js <audio-directory>');
		process.exit(1);
	}

	// Check for existing transcripts to show what's already done
	const projectRoot = path.resolve(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)), '..');
	const transcriptsDir = path.join(projectRoot, 'transcripts');
	const alreadyProcessed = new Set();
	if (fs.existsSync(transcriptsDir)) {
		for (const f of fs.readdirSync(transcriptsDir)) {
			if (f.endsWith('.json')) {
				alreadyProcessed.add(path.basename(f, '.json'));
			}
		}
	}

	const { episodes, multiPart, unparseable, totalFiles, uniqueDates } = discoverEpisodes(audioDir, { alreadyProcessed });

	console.log('=== Episode Discovery ===');
	console.log(`  Total MP3 files:      ${totalFiles}`);
	console.log(`  Unique episode dates:  ${uniqueDates}`);
	console.log(`  Already processed:     ${alreadyProcessed.size}`);
	console.log(`  To process:            ${episodes.length}`);
	if (unparseable.length > 0) {
		console.log(`  Unparseable (skipped): ${unparseable.length}`);
		unparseable.forEach((f) => console.log(`    - ${f}`));
	}
	if (multiPart.length > 0) {
		console.log('');
		multiPart.forEach((m) => console.log(`MULTI-PART ${m.date}: ${m.files.length} files — skipped`));
		console.log('  (join each show\'s parts into one file to process it)');
	}

	console.log(`\n=== Episodes to process (${episodes.length}) ===`);
	for (let i = 0; i < episodes.length; i++) {
		const e = episodes[i];
		const sizeMB = (e.fileSize / (1024 * 1024)).toFixed(1);
		console.log(`  ${String(i + 1).padStart(3)}. ${e.date}  ${e.episodeId}  (${sizeMB} MB)  ${path.basename(e.filePath)}`);
	}
}
