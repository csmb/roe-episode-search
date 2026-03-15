#!/usr/bin/env node

/**
 * Audit episode MP3 files for date anomalies.
 *
 * Usage:
 *   node scripts/audit-episodes.js [episodes-dir]
 *
 * Default episodes-dir: ./All episodes
 *
 * Reports:
 *   - Episodes whose date does not fall on a Thursday
 *   - Thursdays in the date range with no matching episode
 *   - Dates with more than one file (duplicates across main + fresh-downloads)
 *   - Files that could not be date-parsed
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseEpisodeId } from './process-episode.js';

const SKIP_FILES = new Set([
	'SFMTrA.mp3',
	'Tall Trees with Jay Beaman.mp3',
	'Feb 26 - Burrito Justice Radio.mp3',
]);

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function episodeDateFromId(episodeId) {
	const match = episodeId.match(/(\d{4}-\d{2}-\d{2})/);
	return match ? match[1] : null;
}

function isCanonicalId(episodeId) {
	// Returns true only if parseEpisodeId produced a structured result (not a raw stem fallback)
	return /^\d{4}-\d{2}-\d{2}$/.test(episodeId) || episodeDateFromId(episodeId) !== null;
}

function scanDir(dir, label) {
	const entries = [];
	if (!fs.existsSync(dir)) return entries;

	const files = fs.readdirSync(dir)
		.filter((f) => f.toLowerCase().endsWith('.mp3') && !SKIP_FILES.has(f));

	for (const filename of files) {
		const filePath = path.join(dir, filename);
		const stat = fs.statSync(filePath);

		// Suppress the console.warn from parseEpisodeId fallback
		const warnOrig = console.warn;
		let warnCalled = false;
		console.warn = () => { warnCalled = true; };
		const episodeId = parseEpisodeId(filePath);
		console.warn = warnOrig;

		const date = episodeDateFromId(episodeId);
		const parseable = date !== null && !warnCalled;

		entries.push({ filename, filePath, label, date, episodeId, fileSize: stat.size, parseable });
	}

	return entries;
}

function formatMB(bytes) {
	return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function thursdaysBetween(startDate, endDate) {
	const thursdays = [];
	const d = new Date(startDate + 'T12:00:00Z');
	// Advance to first Thursday
	while (d.getUTCDay() !== 4) d.setUTCDate(d.getUTCDate() + 1);
	const end = new Date(endDate + 'T12:00:00Z');
	while (d <= end) {
		thursdays.push(d.toISOString().slice(0, 10));
		d.setUTCDate(d.getUTCDate() + 7);
	}
	return thursdays;
}

// ── Main ───────────────────────────────────────────────────────────────

const episodesDir = path.resolve(process.argv[2] || './All episodes');
const freshDir = path.join(episodesDir, 'fresh-downloads');

const mainEntries = scanDir(episodesDir, 'main');
const freshEntries = scanDir(freshDir, 'fresh-downloads');
const allEntries = [...mainEntries, ...freshEntries];

const parseable = allEntries.filter((e) => e.parseable);
const unparseable = allEntries.filter((e) => !e.parseable);

// Group by date (across both directories)
const byDate = new Map();
for (const entry of parseable) {
	if (!byDate.has(entry.date)) byDate.set(entry.date, []);
	byDate.get(entry.date).push(entry);
}

const sortedDates = [...byDate.keys()].sort();
const earliestDate = sortedDates[0];
const today = new Date().toISOString().slice(0, 10);

// Non-Thursday episodes
const nonThursday = [];
for (const [date, entries] of byDate) {
	const day = new Date(date + 'T12:00:00Z').getUTCDay();
	if (day !== 4) {
		nonThursday.push({ date, day, entries });
	}
}
nonThursday.sort((a, b) => a.date.localeCompare(b.date));

// Missing Thursdays
const allThursdays = earliestDate ? thursdaysBetween(earliestDate, today) : [];
const knownDates = new Set(sortedDates);
const missingThursdays = allThursdays.filter((t) => !knownDates.has(t));

// Duplicates (dates with > 1 file)
const duplicates = [...byDate.entries()]
	.filter(([, entries]) => entries.length > 1)
	.sort(([a], [b]) => a.localeCompare(b));

// ── Output ─────────────────────────────────────────────────────────────

console.log(`\n=== AUDIT: ${episodesDir} + fresh-downloads ===`);
console.log(`Total files scanned: ${allEntries.length} (main: ${mainEntries.length}, fresh-downloads: ${freshEntries.length})`);
console.log(`Parsed dates: ${parseable.length}  |  Unparseable: ${unparseable.length}`);

console.log(`\n=== NON-THURSDAY EPISODES (${nonThursday.length}) ===`);
if (nonThursday.length === 0) {
	console.log('  (none)');
} else {
	for (const { date, day, entries } of nonThursday) {
		for (const e of entries) {
			console.log(`  ${date} (${DAY_NAMES[day]})  ${e.filename}  [${e.label}]`);
		}
	}
}

console.log(`\n=== MISSING THURSDAYS (${missingThursdays.length}) ===`);
if (missingThursdays.length === 0) {
	console.log('  (none)');
} else {
	for (const d of missingThursdays) {
		console.log(`  ${d}`);
	}
}

console.log(`\n=== DUPLICATES (${duplicates.length} dates) ===`);
if (duplicates.length === 0) {
	console.log('  (none)');
} else {
	for (const [date, entries] of duplicates) {
		console.log(`  ${date} (${entries.length} files)`);
		for (const e of entries) {
			const label = `[${e.label}]`.padEnd(18);
			console.log(`    ${label} ${e.filename}  (${formatMB(e.fileSize)})`);
		}
	}
}

console.log(`\n=== UNPARSEABLE FILES (${unparseable.length}) ===`);
if (unparseable.length === 0) {
	console.log('  (none)');
} else {
	for (const e of unparseable) {
		console.log(`  [${e.label}]  ${e.filename}`);
	}
}

console.log('');
