#!/usr/bin/env node

/**
 * Generate AI summaries for episodes that don't have one yet.
 *
 * Usage:
 *   node scripts/generate-summaries.js [--local] [--force] [--include-reviewed] [--dry-run]
 *
 * Episodes whose guests were reviewed by hand keep their title, summary and
 * guests, even with --force, unless --include-reviewed is given (new guests
 * then go back to the admin page's review queue).
 */

import fs from 'node:fs';
import path from 'node:path';
import {
	loadEnv, escapeSQL, runSQL, queryJSON, transcriptsDir,
	parseEpisodeDate, fetchSunriseSunset,
} from './lib.js';
import { buildSummarySystemPrompt } from './prompts.js';

loadEnv();

const OPTIONS = new Set(['--local', '--force', '--include-reviewed', '--dry-run', '--help', '-h']);

function usage(exitCode = 0) {
	const log = exitCode ? console.error : console.log;
	log('Usage: node scripts/generate-summaries.js [--local] [--force] [--include-reviewed] [--dry-run]');
	log('');
	log('Generates AI titles, summaries and guests for episodes missing a summary.');
	log('  --force             Also redo episodes that already have a summary.');
	log('  --include-reviewed  Also redo episodes whose guests were reviewed by hand');
	log('                      (left alone otherwise, even with --force).');
	log('  --dry-run           List the episodes it would do, without calling OpenAI or writing.');
	log('Requires OPENAI_API_KEY (read from .env), except with --dry-run.');
	process.exit(exitCode);
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
	const content = data.choices?.[0]?.message?.content?.trim();
	if (!content) {
		throw new Error(`OpenAI returned no message content (choices: ${JSON.stringify(data.choices)?.slice(0, 200)})`);
	}
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
	const args = process.argv.slice(2);
	const unknown = args.filter((a) => !OPTIONS.has(a));
	if (unknown.length > 0) {
		console.error(`Unknown option: ${unknown.join(' ')}\n`);
		usage(1);
	}
	if (args.includes('--help') || args.includes('-h')) usage();

	const isLocal = args.includes('--local');
	const force = args.includes('--force');
	const includeReviewed = args.includes('--include-reviewed');
	const dryRun = args.includes('--dry-run');

	if (!dryRun && !process.env.OPENAI_API_KEY) {
		console.error('Error: OPENAI_API_KEY environment variable is required');
		process.exit(1);
	}

	if (!fs.existsSync(transcriptsDir)) {
		console.error('No transcripts/ directory found.');
		process.exit(1);
	}

	// Find episodes to process: those without a summary (all of them with
	// --force), leaving out reviewed episodes unless --include-reviewed
	const missing = "(summary IS NULL OR summary = '')";
	const where = [force ? null : missing, includeReviewed ? null : 'COALESCE(guests_reviewed, 0) = 0'].filter(Boolean);
	const rows = queryJSON(`SELECT id FROM episodes${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`, { isLocal });
	const needsSummary = new Set(rows.map((r) => r.id));
	if (!includeReviewed) {
		const [{ n }] = queryJSON(`SELECT COUNT(id) AS n FROM episodes WHERE guests_reviewed = 1${force ? '' : ` AND ${missing}`}`, { isLocal });
		if (n > 0) console.log(`Leaving alone ${n} reviewed episode(s) (--include-reviewed to include them)`);
	}

	if (needsSummary.size === 0) {
		console.log('No episodes to summarize. Nothing to do.');
		return;
	}

	console.log(`Found ${needsSummary.size} episode(s) ${force ? 'to regenerate' : 'needing summaries'}`);
	console.log(`Target: ${isLocal ? 'local' : 'remote'} D1 database${dryRun ? ' (DRY RUN)' : ''}`);
	console.log();

	const files = fs.readdirSync(transcriptsDir).filter((f) => f.endsWith('.json')).sort();

	let generated = 0;

	for (const file of files) {
		const transcript = JSON.parse(fs.readFileSync(path.join(transcriptsDir, file), 'utf-8'));
		const { episode_id, segments } = transcript;

		if (!needsSummary.has(episode_id)) {
			continue;
		}
		if (dryRun) {
			console.log(`  Would summarize ${episode_id}`);
			generated++;
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

		// A long run can outlast a review done in the admin page meanwhile: check again
		const [now] = queryJSON(`SELECT guests_reviewed FROM episodes WHERE id = '${escapeSQL(episode_id)}'`, { isLocal });
		if (now?.guests_reviewed && !includeReviewed) {
			console.log('    Reviewed while this ran: left alone');
			continue;
		}

		// Update D1. New AI guests go back in the admin page's review queue.
		const unreview = guests.length > 0 ? ', guests_reviewed = 0' : '';
		if (title) {
			runSQL(
				`UPDATE episodes SET title = '${escapeSQL(title)}', summary = '${escapeSQL(summary)}'${unreview} WHERE id = '${escapeSQL(episode_id)}'`,
				{ isLocal }
			);
		} else {
			runSQL(
				`UPDATE episodes SET summary = '${escapeSQL(summary)}'${unreview} WHERE id = '${escapeSQL(episode_id)}'`,
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
	console.log(`${dryRun ? 'Would generate' : 'Generated'}: ${generated} summaries`);
	console.log(`Skipped: ${files.length - generated} (already had summaries or no transcript)`);
}

// Only run main() when executed directly (not when imported)
if (import.meta.main) {
	main().catch((err) => {
		console.error('Error:', err.message);
		process.exit(1);
	});
}
