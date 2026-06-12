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
 * Naming scheme (canonical episode ID, the same one parseEpisodeId produces
 * and the rest of the pipeline uses for D1 IDs / R2 keys):
 *   - Parseable filename   → "roll-over-easy_YYYY-MM-DD_HH-MM-SS.mp3"
 *                            (time comes from parseEpisodeId: taken from the
 *                            source filename when present, else the show's
 *                            standard 07-30-00 slot)
 *   - Already canonical    → left untouched (no-op)
 *   - Unparseable filename → "roll-over-easy_YYYY-MM-DD_07-30-00.mp3"
 *                            (using filesystem birthtime as the date)
 *   - Two files mapping to the same episode ID are flagged as collisions
 *     and skipped (they need manual disambiguation, not auto-numbering).
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

// Canonical episode ID, e.g. roll-over-easy_2014-01-09_07-30-00.
// Must round-trip through parseEpisodeId (its canonical branch parses this
// exact shape back to itself), so renamed files feed the pipeline correctly.
const CANONICAL_ID_RE = /^roll-over-easy_(\d{4}-\d{2}-\d{2})_\d{2}-\d{2}-\d{2}$/;

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

// ── Scan directory ───────────────────────────────────────────────────────────

const allFiles = fs.readdirSync(dir)
	.filter((f) => f.toLowerCase().endsWith('.mp3'))
	.sort();

let skippedCount = 0;
const parseable = [];   // { filename, episodeId, size }
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

	if (!warnCalled && CANONICAL_ID_RE.test(episodeId)) {
		parseable.push({ filename, episodeId, size: stat.size });
	} else {
		unparseable.push({ filename, size: stat.size, birthtime: stat.birthtime });
	}
}

// ── Build rename plan ────────────────────────────────────────────────────────
// Target stem is the canonical episode ID itself, so parseEpisodeId(dest)
// round-trips to the same ID the pipeline will use. Files already named
// canonically map to themselves (src === dest) and are never renamed away.
// Multiple files resolving to one episode ID share a dest and get caught
// by the collision check below.

const plan = []; // { src, dest, size, note? }

for (const entry of parseable) {
	plan.push({ src: entry.filename, dest: `${entry.episodeId}.mp3`, size: entry.size });
}

for (const entry of unparseable) {
	const date = formatDate(entry.birthtime);
	plan.push({
		src: entry.filename,
		dest: `roll-over-easy_${date}_07-30-00.mp3`,
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
		const destPath = path.join(dir, item.dest);
		if (fs.existsSync(destPath)) {
			console.warn(`  SKIP (dest already exists): ${item.dest}  ←  ${item.src}`);
			continue;
		}
		fs.renameSync(path.join(dir, item.src), destPath);
		console.log(`  ${item.dest}  ←  ${item.src}`);
		renamedCount++;
	}
	console.log(`\nRenamed ${renamedCount} files.`);
}

const dateCount = new Set(parseable.map((e) => episodeDateFromId(e.episodeId))).size;

console.log('\n=== SUMMARY ===');
console.log(`  Parseable:       ${parseable.length} files across ${dateCount} dates`);
console.log(`  Unparseable:     ${unparseable.length} files (renamed using birthtime)`);
console.log(`  Skipped:         ${skippedCount} files (SKIP_FILES)`);
console.log(`  Collisions:      ${collisionItems.length} (skipped, see above)`);
console.log(`  Already correct: ${noopCount} files (no rename needed)`);
console.log(`  To rename:       ${renamePlan.length} files`);
