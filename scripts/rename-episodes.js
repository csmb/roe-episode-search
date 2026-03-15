#!/usr/bin/env node

/**
 * Rename MP3 files in a directory to a uniform scheme.
 *
 * Usage:
 *   node scripts/rename-episodes.js [--dir <path>] [--apply]
 *
 * Default dir: ./All episodes
 * Default mode: dry-run (print plan only)
 * Pass --apply to actually rename files.
 *
 * Naming scheme:
 *   - Single file for a date    → "Roll Over Easy YYYY-MM-DD.mp3"
 *   - Multiple files for a date → "Roll Over Easy YYYY-MM-DD 1.mp3", …
 *   - Unparseable filename      → "{original stem} Roll Over Easy YYYY-MM-DD.mp3"
 *                                  (using filesystem birthtime as the date)
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseEpisodeId } from './process-episode.js';

const SKIP_FILES = new Set([
	'SFMTrA.mp3',
	'Tall Trees with Jay Beaman.mp3',
	'Feb 26 - Burrito Justice Radio.mp3',
]);

// ── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let dir = './All episodes';
let apply = false;

for (let i = 0; i < args.length; i++) {
	if (args[i] === '--dir' && args[i + 1]) {
		dir = args[++i];
	} else if (args[i] === '--apply') {
		apply = true;
	}
}

dir = path.resolve(dir);

// ── Helpers ─────────────────────────────────────────────────────────────────

function humanSize(bytes) {
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function episodeDateFromId(episodeId) {
	const m = episodeId.match(/(\d{4}-\d{2}-\d{2})/);
	return m ? m[1] : null;
}

function formatDate(d) {
	const y = d.getFullYear();
	const mo = String(d.getMonth() + 1).padStart(2, '0');
	const day = String(d.getDate()).padStart(2, '0');
	return `${y}-${mo}-${day}`;
}

/**
 * Return a numeric sort key (minutes since midnight) when possible,
 * or a string sort key (filename) for alphabetical ordering.
 */
function sortKey(filename) {
	const stem = path.basename(filename, path.extname(filename));

	// App Recording YYYYMMDD HHMM  /  App_Recording_YYYYMMDD_HHMM
	const appMatch = stem.match(/App[_ ]Recording[_ ]+\d{8}[_ ]+(\d{2})(\d{2})/i);
	if (appMatch) return parseInt(appMatch[1], 10) * 60 + parseInt(appMatch[2], 10);

	// Input Device Recording YYYYMMDD HHMM
	const inputMatch = stem.match(/Input Device Recording\s+\d{8}\s+(\d{2})(\d{2})/i);
	if (inputMatch) return parseInt(inputMatch[1], 10) * 60 + parseInt(inputMatch[2], 10);

	// roll-over-easy_YYYY-MM-DD_HH-MM-SS
	const canonMatch = stem.match(/^roll-over-easy_\d{4}-\d{2}-\d{2}_(\d{2})-(\d{2})-\d{2}$/i);
	if (canonMatch) return parseInt(canonMatch[1], 10) * 60 + parseInt(canonMatch[2], 10);

	// Alphabetical fallback
	return stem;
}

function compareKeys(a, b) {
	if (typeof a === 'number' && typeof b === 'number') return a - b;
	return String(a).localeCompare(String(b));
}

// ── Scan directory ───────────────────────────────────────────────────────────

const allFiles = fs.readdirSync(dir)
	.filter((f) => f.toLowerCase().endsWith('.mp3'))
	.sort();

let skippedCount = 0;
const parseable = [];   // { filename, date, key, size }
const unparseable = []; // { filename, size, birthtime }

for (const filename of allFiles) {
	if (SKIP_FILES.has(filename)) {
		skippedCount++;
		continue;
	}

	const filePath = path.join(dir, filename);
	const stat = fs.statSync(filePath);

	// Suppress console.warn; detect fallback
	const origWarn = console.warn;
	let warnCalled = false;
	console.warn = () => { warnCalled = true; };
	const episodeId = parseEpisodeId(filePath);
	console.warn = origWarn;

	const date = episodeDateFromId(episodeId);

	if (!warnCalled && date !== null) {
		parseable.push({ filename, date, key: sortKey(filename), size: stat.size });
	} else {
		unparseable.push({ filename, size: stat.size, birthtime: stat.birthtime });
	}
}

// ── Group parseable files by date; sort within each group ───────────────────

const byDate = new Map();
for (const entry of parseable) {
	if (!byDate.has(entry.date)) byDate.set(entry.date, []);
	byDate.get(entry.date).push(entry);
}

for (const entries of byDate.values()) {
	entries.sort((a, b) => compareKeys(a.key, b.key));
}

// ── Build rename plan ────────────────────────────────────────────────────────

const plan = []; // { src, dest, size, note? }

for (const [date, entries] of byDate) {
	if (entries.length === 1) {
		plan.push({ src: entries[0].filename, dest: `Roll Over Easy ${date}.mp3`, size: entries[0].size });
	} else {
		entries.forEach((entry, i) => {
			plan.push({ src: entry.filename, dest: `Roll Over Easy ${date} ${i + 1}.mp3`, size: entry.size });
		});
	}
}

for (const entry of unparseable) {
	const stem = path.basename(entry.filename, '.mp3');
	const date = formatDate(entry.birthtime);
	plan.push({
		src: entry.filename,
		dest: `${stem} Roll Over Easy ${date}.mp3`,
		size: entry.size,
		note: '[birthtime]',
	});
}

// ── Collision check ──────────────────────────────────────────────────────────

const destCounts = new Map();
for (const item of plan) {
	destCounts.set(item.dest, (destCounts.get(item.dest) || 0) + 1);
}

const collisionDests = new Set([...destCounts.entries()].filter(([, n]) => n > 1).map(([d]) => d));
const collisionItems = plan.filter((item) => collisionDests.has(item.dest));

if (collisionItems.length > 0) {
	console.warn('\n=== COLLISIONS (these files will be skipped) ===');
	for (const item of collisionItems) {
		console.warn(`  ${item.dest}  ←  ${item.src}`);
	}
}

const activePlan = plan.filter((item) => !collisionDests.has(item.dest));
const renamePlan = activePlan.filter((item) => item.src !== item.dest);
const noopCount  = activePlan.filter((item) => item.src === item.dest).length;

// ── Output ───────────────────────────────────────────────────────────────────

if (!apply) {
	console.log('\n=== RENAME PLAN (dry-run — pass --apply to execute) ===\n');

	const maxDest = renamePlan.reduce((m, i) => Math.max(m, i.dest.length), 0);
	const maxSrc  = renamePlan.reduce((m, i) => Math.max(m, i.src.length), 0);

	for (const item of renamePlan) {
		const note = item.note ? `  ${item.note}` : '';
		console.log(`  ${item.dest.padEnd(maxDest)}  ←  ${item.src.padEnd(maxSrc)}  (${humanSize(item.size)})${note}`);
	}
} else {
	console.log('\n=== APPLYING RENAMES ===\n');
	let renamedCount = 0;
	for (const item of renamePlan) {
		fs.renameSync(path.join(dir, item.src), path.join(dir, item.dest));
		console.log(`  ${item.dest}  ←  ${item.src}`);
		renamedCount++;
	}
	console.log(`\nRenamed ${renamedCount} files.`);
}

console.log('\n=== SUMMARY ===');
console.log(`  Parseable:       ${parseable.length} files across ${byDate.size} dates`);
console.log(`  Unparseable:     ${unparseable.length} files (renamed using birthtime)`);
console.log(`  Skipped:         ${skippedCount} files (SKIP_FILES)`);
console.log(`  Collisions:      ${collisionItems.length} (skipped, see above)`);
console.log(`  Already correct: ${noopCount} files (no rename needed)`);
console.log(`  To rename:       ${renamePlan.length} files`);
