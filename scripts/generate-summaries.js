#!/usr/bin/env node

/**
 * Generate AI summaries for episodes that don't have one yet.
 *
 * Prerequisites:
 *   - OPENAI_API_KEY environment variable set
 *   - Transcripts in transcripts/ directory
 *   - Episodes already seeded in D1
 *
 * Usage:
 *   node scripts/generate-summaries.js [--local]
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DB_NAME = 'roe-episodes';

function usage() {
	console.log('Usage: node scripts/generate-summaries.js [--local]');
	console.log('');
	console.log('Generates AI summaries for episodes missing them.');
	console.log('Requires OPENAI_API_KEY environment variable.');
	process.exit(0);
}

function workerCwd() {
	return path.resolve(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)), '..', 'my-first-worker');
}

function escapeSQL(str) {
	return str.replace(/'/g, "''");
}

function runSQL(sql, isLocal) {
	const flag = isLocal ? '--local' : '--remote';
	const cmd = `npx wrangler d1 execute ${DB_NAME} ${flag} --command="${sql.replace(/"/g, '\\"')}"`;
	return execSync(cmd, {
		cwd: workerCwd(),
		encoding: 'utf-8',
		stdio: 'pipe',
	});
}

function queryJSON(sql, isLocal) {
	const flag = isLocal ? '--local' : '--remote';
	const cmd = `npx wrangler d1 execute ${DB_NAME} ${flag} --json --command="${sql.replace(/"/g, '\\"')}"`;
	const result = execSync(cmd, {
		cwd: workerCwd(),
		encoding: 'utf-8',
		stdio: 'pipe',
	});
	const parsed = JSON.parse(result);
	return parsed[0]?.results ?? [];
}

async function generateSummary(text) {
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) {
		throw new Error('OPENAI_API_KEY environment variable is required');
	}

	const res = await fetch('https://api.openai.com/v1/chat/completions', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model: 'gpt-4o-mini',
			messages: [
				{
					role: 'system',
					content:
						'You summarize podcast episode transcripts. Write a single paragraph summary describing what topics were discussed and who the guests were (if identifiable). Be concise but informative.',
				},
				{
					role: 'user',
					content: `Summarize this podcast episode transcript:\n\n${text}`,
				},
			],
			temperature: 0.5,
			max_tokens: 300,
		}),
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`OpenAI API error ${res.status}: ${body}`);
	}

	const data = await res.json();
	return data.choices[0].message.content.trim();
}

async function main() {
	if (process.argv.includes('--help') || process.argv.includes('-h')) usage();

	const isLocal = process.argv.includes('--local');

	if (!process.env.OPENAI_API_KEY) {
		console.error('Error: OPENAI_API_KEY environment variable is required');
		process.exit(1);
	}

	const transcriptsDir = path.resolve(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)), '..', 'transcripts');
	if (!fs.existsSync(transcriptsDir)) {
		console.error('No transcripts/ directory found.');
		process.exit(1);
	}

	// Find episodes without summaries
	const episodesWithoutSummary = queryJSON(
		"SELECT id FROM episodes WHERE summary IS NULL OR summary = ''",
		isLocal
	);

	if (episodesWithoutSummary.length === 0) {
		console.log('All episodes already have summaries. Nothing to do.');
		return;
	}

	console.log(`Found ${episodesWithoutSummary.length} episode(s) needing summaries`);
	console.log(`Target: ${isLocal ? 'local' : 'remote'} D1 database`);
	console.log();

	const needsSummary = new Set(episodesWithoutSummary.map((r) => r.id));

	const files = fs.readdirSync(transcriptsDir).filter((f) => f.endsWith('.json')).sort();

	let generated = 0;

	for (const file of files) {
		const transcript = JSON.parse(fs.readFileSync(path.join(transcriptsDir, file), 'utf-8'));
		const { episode_id, segments } = transcript;

		if (!needsSummary.has(episode_id)) {
			continue;
		}

		const transcriptText = segments.map((s) => s.text).join('\n');

		console.log(`  Generating summary for ${episode_id}...`);
		const summary = await generateSummary(transcriptText);
		console.log(`    Summary: ${summary.slice(0, 80)}...`);

		// Update D1
		runSQL(
			`UPDATE episodes SET summary = '${escapeSQL(summary)}' WHERE id = '${escapeSQL(episode_id)}'`,
			isLocal
		);

		generated++;
	}

	console.log();
	console.log('=== Summary ===');
	console.log(`Generated: ${generated} summaries`);
	console.log(`Skipped: ${files.length - generated} (already had summaries or no transcript)`);
}

main().catch((err) => {
	console.error('Error:', err.message);
	process.exit(1);
});
