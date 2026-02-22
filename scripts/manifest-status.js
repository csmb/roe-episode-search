#!/usr/bin/env node

/**
 * Read-only script that prints a human-readable progress summary
 * from the episode manifest.
 *
 * Usage:
 *   node scripts/manifest-status.js
 */

import fs from 'node:fs';
import path from 'node:path';

const projectRoot = path.resolve(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)), '..');
const manifestPath = path.join(projectRoot, 'scripts', 'episode-manifest.json');

if (!fs.existsSync(manifestPath)) {
	console.error('Manifest not found. Run generate-manifest.js first.');
	process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
const episodes = manifest.episodes;
const total = episodes.length;

const counts = { completed: 0, pending: 0, failed: 0, skipped: 0 };
for (const ep of episodes) {
	counts[ep.status]++;
}

const pct = (n) => total > 0 ? `(${((n / total) * 100).toFixed(1)}%)` : '';

const nextPending = episodes.find((e) => e.status === 'pending');

console.log('=== Roll Over Easy — Episode Progress ===');
console.log(`  Total:       ${String(total).padStart(3)}`);
console.log(`  Completed:   ${String(counts.completed).padStart(3)}  ${pct(counts.completed)}`);
console.log(`  Pending:     ${String(counts.pending).padStart(3)}  ${pct(counts.pending)}`);
console.log(`  Failed:      ${String(counts.failed).padStart(3)}`);
console.log(`  Skipped:     ${String(counts.skipped).padStart(3)}`);
if (nextPending) {
	console.log(`  Next pending: ${nextPending.episodeId}`);
}
console.log(`  Generated:   ${manifest.generated}`);
