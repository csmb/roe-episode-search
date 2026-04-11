#!/usr/bin/env node

/**
 * Generate AI summaries for episodes that don't have one yet.
 *
 * Usage:
 *   node scripts/generate-summaries.js [--local] [--force]
 */

import fs from 'node:fs';
import path from 'node:path';
import {
	loadEnv, escapeSQL, runSQL, queryJSON, transcriptsDir,
	parseEpisodeDate, fetchSunriseSunset,
} from './lib.js';
import { buildSummarySystemPrompt } from './prompts.js';

loadEnv();

function usage() {
	console.log('Usage: node scripts/generate-summaries.js [--local] [--force]');
	console.log('');
	console.log('Generates AI summaries for episodes missing them.');
	console.log('  --force   Regenerate summaries for all episodes, even if they already have one.');
	console.log('Requires OPENAI_API_KEY environment variable.');
	process.exit(0);
}

/**
 * Generate a summary from transcript text using GPT-4o-mini.
 * Exported for process-episode.js to reuse.
 */
export async function generateSummaryFromText(text, { dateStr, sunData } = {}) {
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) {
		throw new Error('OPENAI_API_KEY environment variable is required');
	}

	const systemPrompt = buildSummarySystemPrompt({ dateStr, sunData });

	const res = await fetch('https://api.openai.com/v1/chat/completions', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model: 'gpt-4o-mini',
			messages: [
				{ role: 'system', content: systemPrompt },
				{ role: 'user', content: `Summarize this Roll Over Easy episode transcript:\n\n${text}` },
			],
			temperature: 0.5,
			max_tokens: 400,
			response_format: { type: 'json_object' },
		}),
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`OpenAI API error ${res.status}: ${body}`);
	}

	const data = await res.json();
	const content = data.choices[0].message.content.trim();
	try {
		const parsed = JSON.parse(content);
		return {
			title: parsed.title?.trim() || null,
			summary: parsed.summary?.trim() || content,
			guests: Array.isArray(parsed.guests) ? parsed.guests : [],
		};
	} catch {
		return { title: null, summary: content, guests: [] };
	}
}

async function main() {
	if (process.argv.includes('--help') || process.argv.includes('-h')) usage();

	const isLocal = process.argv.includes('--local');
	const force = process.argv.includes('--force');

	if (!process.env.OPENAI_API_KEY) {
		console.error('Error: OPENAI_API_KEY environment variable is required');
		process.exit(1);
	}

	if (!fs.existsSync(transcriptsDir)) {
		console.error('No transcripts/ directory found.');
		process.exit(1);
	}

	// Find episodes to process
	let needsSummary;
	if (force) {
		const allEpisodes = queryJSON('SELECT id FROM episodes', { isLocal });
		needsSummary = new Set(allEpisodes.map((r) => r.id));
	} else {
		const episodesWithoutSummary = queryJSON(
			"SELECT id FROM episodes WHERE summary IS NULL OR summary = ''",
			{ isLocal }
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

		console.log(`  Generating title + summary for ${episode_id}...`);
		const { title, summary, guests } = await generateSummaryFromText(transcriptText, { dateStr, sunData });
		if (title) {
			console.log(`    Title: ${title}`);
		}
		console.log(`    Summary: ${(summary || '').slice(0, 80)}...`);
		if (guests.length > 0) {
			console.log(`    Guests: ${guests.join(', ')}`);
		}

		// Update D1
		if (title) {
			runSQL(
				`UPDATE episodes SET title = '${escapeSQL(title)}', summary = '${escapeSQL(summary)}' WHERE id = '${escapeSQL(episode_id)}'`,
				{ isLocal }
			);
		} else {
			runSQL(
				`UPDATE episodes SET summary = '${escapeSQL(summary)}' WHERE id = '${escapeSQL(episode_id)}'`,
				{ isLocal }
			);
		}

		// Insert guests
		if (guests.length > 0) {
			runSQL(`DELETE FROM episode_guests WHERE episode_id = '${escapeSQL(episode_id)}'`, { isLocal });
			for (const guest of guests) {
				const name = guest.trim();
				if (name) {
					runSQL(
						`INSERT OR IGNORE INTO episode_guests (episode_id, guest_name) VALUES ('${escapeSQL(episode_id)}', '${escapeSQL(name)}')`,
						{ isLocal }
					);
				}
			}
		}

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
