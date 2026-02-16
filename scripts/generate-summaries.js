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
 *   node scripts/generate-summaries.js [--local] [--force]
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DB_NAME = 'roe-episodes';

function usage() {
	console.log('Usage: node scripts/generate-summaries.js [--local] [--force]');
	console.log('');
	console.log('Generates AI summaries for episodes missing them.');
	console.log('  --force   Regenerate summaries for all episodes, even if they already have one.');
	console.log('Requires OPENAI_API_KEY environment variable.');
	process.exit(0);
}

function workerCwd() {
	return path.resolve(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)), '..', 'my-first-worker');
}

function escapeSQL(str) {
	return str.replace(/'/g, "''");
}

function parseEpisodeDate(episodeId) {
	const match = episodeId.match(/(\d{4}-\d{2}-\d{2})/);
	return match ? match[1] : null;
}

function utcToPacific(isoString) {
	const date = new Date(isoString);
	return date.toLocaleTimeString('en-US', {
		timeZone: 'America/Los_Angeles',
		hour: 'numeric',
		minute: '2-digit',
	});
}

async function fetchSunriseSunset(dateStr) {
	const url = `https://api.sunrise-sunset.org/json?lat=37.7955&lng=-122.3937&date=${dateStr}&formatted=0`;
	try {
		const res = await fetch(url);
		const data = await res.json();
		if (data.status !== 'OK') return null;
		return {
			sunrise: utcToPacific(data.results.sunrise),
			sunset: utcToPacific(data.results.sunset),
		};
	} catch {
		return null;
	}
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

async function generateSummary(text, { dateStr, sunData }) {
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) {
		throw new Error('OPENAI_API_KEY environment variable is required');
	}

	const systemLines = [
		'You summarize transcripts from "Roll Over Easy," a live morning radio show on BFF.fm broadcast from the Ferry Building in San Francisco.',
		'Write a concise summary in this format:',
		'',
		'Line 1: The weather/vibe that morning (if mentioned — fog, sun, rain, cold, etc.). If not mentioned, skip this line.',
		'Line 2: Who joined the show — name guests and briefly note who they are.',
		'Line 3-4: What stories and topics came up — San Francisco news, local culture, neighborhood happenings, food, music, etc.',
		'',
		'Keep a warm, San Francisco tone. Use 2-4 sentences total. Do not use bullet points or labels like "Weather:" — just weave it naturally.',
	];

	if (dateStr || sunData) {
		systemLines.push('');
		systemLines.push('Additional context for this episode:');
		if (dateStr) {
			const formatted = new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', {
				year: 'numeric', month: 'long', day: 'numeric',
			});
			systemLines.push(`- Date: ${formatted}`);
		}
		if (sunData) {
			systemLines.push(`- Sunrise: ${sunData.sunrise} PT`);
			systemLines.push(`- Sunset: ${sunData.sunset} PT`);
		}
		systemLines.push('Include the weather and temperature explicitly in your summary (pull temperature from what the hosts mention in the transcript). Also mention what time sunrise and sunset were that day.');
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
					content: systemLines.join('\n'),
				},
				{
					role: 'user',
					content: `Summarize this Roll Over Easy episode transcript:\n\n${text}`,
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
	const force = process.argv.includes('--force');

	if (!process.env.OPENAI_API_KEY) {
		console.error('Error: OPENAI_API_KEY environment variable is required');
		process.exit(1);
	}

	const transcriptsDir = path.resolve(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)), '..', 'transcripts');
	if (!fs.existsSync(transcriptsDir)) {
		console.error('No transcripts/ directory found.');
		process.exit(1);
	}

	// Find episodes to process
	let needsSummary;
	if (force) {
		const allEpisodes = queryJSON('SELECT id FROM episodes', isLocal);
		needsSummary = new Set(allEpisodes.map((r) => r.id));
	} else {
		const episodesWithoutSummary = queryJSON(
			"SELECT id FROM episodes WHERE summary IS NULL OR summary = ''",
			isLocal
		);
		needsSummary = new Set(episodesWithoutSummary.map((r) => r.id));
	}

	if (needsSummary.size === 0) {
		console.log('All episodes already have summaries. Nothing to do.');
		return;
	}

	console.log(`Found ${needsSummary.size} episode(s) ${force ? 'to regenerate' : 'needing summaries'}`);
	console.log(`Target: ${isLocal ? 'local' : 'remote'} D1 database`);
	console.log();

	const files = fs.readdirSync(transcriptsDir).filter((f) => f.endsWith('.json')).sort();

	let generated = 0;

	for (const file of files) {
		const transcript = JSON.parse(fs.readFileSync(path.join(transcriptsDir, file), 'utf-8'));
		const { episode_id, segments } = transcript;

		if (!needsSummary.has(episode_id)) {
			continue;
		}

		const transcriptText = segments.map((s) => s.text).join('\n');

		// Fetch sunrise/sunset for this episode's date
		const dateStr = parseEpisodeDate(episode_id);
		let sunData = null;
		if (dateStr) {
			console.log(`  Fetching sunrise/sunset for ${dateStr}...`);
			sunData = await fetchSunriseSunset(dateStr);
			if (sunData) {
				console.log(`    Sunrise: ${sunData.sunrise} PT, Sunset: ${sunData.sunset} PT`);
			} else {
				console.log('    Could not fetch sunrise/sunset data, continuing without it.');
			}
		}

		console.log(`  Generating summary for ${episode_id}...`);
		const summary = await generateSummary(transcriptText, { dateStr, sunData });
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
