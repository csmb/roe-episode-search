#!/usr/bin/env node

/**
 * Generate (or regenerate) the episode manifest — a JSON file listing every
 * known episode and its processing status.
 *
 * Usage:
 *   node scripts/generate-manifest.js "/path/to/All episodes/"
 *
 * The manifest is written to scripts/episode-manifest.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import { discoverEpisodes } from './discover-episodes.js';

const projectRoot = path.resolve(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)), '..');
const manifestPath = path.join(projectRoot, 'scripts', 'episode-manifest.json');
const transcriptsDir = path.join(projectRoot, 'transcripts');
const progressPath = path.join(projectRoot, 'scripts', 'batch-progress.json');
const audioDir = path.join(projectRoot, 'audio');

// ── Manifest generation ─────────────────────────────────────────────────

export function generateManifest(sourceDir) {
	// 1. Discover all episodes from the iCloud source folder (no filtering)
	const source = discoverEpisodes(sourceDir);

	// 2. Discover episodes from audio/ (recent downloads) and merge
	const byDate = new Map();
	for (const ep of source.episodes) {
		byDate.set(ep.date, ep);
	}

	if (fs.existsSync(audioDir)) {
		const local = discoverEpisodes(audioDir);
		for (const ep of local.episodes) {
			// audio/ version wins if both exist (it's typically the actively-used copy)
			byDate.set(ep.date, ep);
		}
	}

	// Sort chronologically
	const allEpisodes = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));

	// 3. Cross-reference statuses

	// Existing transcripts
	const hasTranscript = new Set();
	if (fs.existsSync(transcriptsDir)) {
		for (const f of fs.readdirSync(transcriptsDir)) {
			if (f.endsWith('.json')) {
				hasTranscript.add(path.basename(f, '.json'));
			}
		}
	}

	// Batch progress
	let progress = { completed: {}, failed: {}, skipped: {} };
	if (fs.existsSync(progressPath)) {
		progress = JSON.parse(fs.readFileSync(progressPath, 'utf-8'));
	}

	// Build manifest entries
	const episodes = allEpisodes.map((ep) => {
		let status = 'pending';
		let completedAt = undefined;

		if (progress.completed[ep.episodeId]) {
			status = 'completed';
			completedAt = progress.completed[ep.episodeId].timestamp;
		} else if (progress.failed[ep.episodeId]) {
			status = 'failed';
		} else if (progress.skipped[ep.episodeId]) {
			status = 'skipped';
		} else if (hasTranscript.has(ep.episodeId)) {
			// Has a transcript but no batch-progress entry — still completed
			status = 'completed';
		}

		const entry = {
			episodeId: ep.episodeId,
			date: ep.date,
			status,
			file: path.basename(ep.filePath),
		};
		if (completedAt) entry.completedAt = completedAt;

		return entry;
	});

	const manifest = {
		generated: new Date().toISOString(),
		sourceDir,
		episodes,
	};

	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

	// Print summary
	const counts = { completed: 0, pending: 0, failed: 0, skipped: 0 };
	for (const ep of episodes) {
		counts[ep.status]++;
	}

	console.log('=== Episode Manifest ===');
	console.log(`  Total:     ${episodes.length}`);
	console.log(`  Completed: ${String(counts.completed).padStart(3)}`);
	console.log(`  Pending:   ${String(counts.pending).padStart(3)}`);
	console.log(`  Failed:    ${String(counts.failed).padStart(3)}`);
	console.log(`  Skipped:   ${String(counts.skipped).padStart(3)}`);
	console.log(`  Written to: ${manifestPath}`);
}

// ── updateManifestStatus (used by process-all.js) ───────────────────────

/**
 * Update a single episode's status in the manifest file.
 * No-ops silently if the manifest doesn't exist yet.
 */
export function updateManifestStatus(episodeId, status) {
	if (!fs.existsSync(manifestPath)) return;

	const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
	const entry = manifest.episodes.find((e) => e.episodeId === episodeId);
	if (!entry) return;

	entry.status = status;
	if (status === 'completed') {
		entry.completedAt = new Date().toISOString();
	}

	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

// ── CLI ─────────────────────────────────────────────────────────────────

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(decodeURIComponent(new URL(import.meta.url).pathname));
if (isMainModule) {
	const sourceDir = process.argv[2];
	if (!sourceDir) {
		console.error('Usage: node scripts/generate-manifest.js <source-audio-directory>');
		process.exit(1);
	}
	generateManifest(sourceDir);
}
