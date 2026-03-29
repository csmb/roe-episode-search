#!/usr/bin/env node

/**
 * Backfill guest names for existing episodes that already have summaries.
 * Uses GPT-4o-mini to extract guest names from transcripts.
 *
 * Usage:
 *   node scripts/backfill-guests.js [--local] [--force]
 *
 * Options:
 *   --local   Target local D1 database instead of remote
 *   --force   Re-extract guests for all episodes, even if already populated
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// ── Load .env ─────────────────────────────────────────────────────────

const envPath = path.resolve(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)), '..', '.env');
if (fs.existsSync(envPath)) {
	for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const eq = trimmed.indexOf('=');
		if (eq === -1) continue;
		const key = trimmed.slice(0, eq);
		const val = trimmed.slice(eq + 1);
		if (!process.env[key]) process.env[key] = val;
	}
}

const DB_NAME = 'roe-episodes';

function workerCwd() {
	return path.resolve(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)), '..', 'roe-search');
}

function escapeSQL(str) {
	return str.replace(/'/g, "''");
}

function wranglerEnv() {
	// Strip CLOUDFLARE_API_TOKEN so wrangler uses its OAuth login instead
	const env = { ...process.env };
	delete env.CLOUDFLARE_API_TOKEN;
	return env;
}

function runSQL(sql, isLocal) {
	const flag = isLocal ? '--local' : '--remote';
	const cmd = `npx wrangler d1 execute ${DB_NAME} ${flag} --command="${sql.replace(/"/g, '\\"')}"`;
	return execSync(cmd, {
		cwd: workerCwd(),
		encoding: 'utf-8',
		stdio: 'pipe',
		env: wranglerEnv(),
	});
}

function queryJSON(sql, isLocal) {
	const flag = isLocal ? '--local' : '--remote';
	const cmd = `npx wrangler d1 execute ${DB_NAME} ${flag} --json --command="${sql.replace(/"/g, '\\"')}"`;
	const result = execSync(cmd, {
		cwd: workerCwd(),
		encoding: 'utf-8',
		stdio: 'pipe',
		env: wranglerEnv(),
	});
	const parsed = JSON.parse(result);
	return parsed[0]?.results ?? [];
}

async function extractGuests(transcriptText) {
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
					content: [
						'You extract guest names from transcripts of "Roll Over Easy," a live morning radio show on BFF.fm in San Francisco.',
						'',
						'Respond with a JSON object containing one field:',
						'"guests": An array of guest full names who appeared on the episode. Exclude the hosts Sequoia and The Early Bird. Return an empty array if there are no guests.',
						'',
						'Only include people who are actually on the show as guests (interviewed, in-studio, called in). Do not include people who are merely mentioned or discussed.',
					].join('\n'),
				},
				{
					role: 'user',
					content: `Extract guest names from this Roll Over Easy episode transcript:\n\n${transcriptText}`,
				},
			],
			temperature: 0.3,
			max_tokens: 200,
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
		return Array.isArray(parsed.guests) ? parsed.guests : [];
	} catch {
		return [];
	}
}

async function main() {
	if (process.argv.includes('--help') || process.argv.includes('-h')) {
		console.log('Usage: node scripts/backfill-guests.js [--local] [--force]');
		console.log('');
		console.log('Extracts guest names from existing transcripts and populates episode_guests table.');
		console.log('  --local   Target local D1 database');
		console.log('  --force   Re-extract for all episodes, even if they already have guests');
		process.exit(0);
	}

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
	const allEpisodes = queryJSON('SELECT id FROM episodes', isLocal);
	const allIds = new Set(allEpisodes.map(r => r.id));

	let alreadyHasGuests = new Set();
	if (!force) {
		try {
			const existing = queryJSON('SELECT DISTINCT episode_id FROM episode_guests', isLocal);
			alreadyHasGuests = new Set(existing.map(r => r.episode_id));
		} catch {
			// Table might not exist yet
		}
	}

	const files = fs.readdirSync(transcriptsDir).filter(f => f.endsWith('.json')).sort();

	console.log(`Found ${allIds.size} episodes in DB, ${alreadyHasGuests.size} already have guests`);
	console.log(`Target: ${isLocal ? 'local' : 'remote'} D1 database`);
	console.log();

	let processed = 0;
	let totalGuests = 0;

	for (const file of files) {
		const transcript = JSON.parse(fs.readFileSync(path.join(transcriptsDir, file), 'utf-8'));
		const { episode_id, segments } = transcript;

		if (!allIds.has(episode_id)) continue;
		if (!force && alreadyHasGuests.has(episode_id)) continue;

		const transcriptText = segments.map(s => s.text).join('\n');

		console.log(`  Extracting guests for ${episode_id}...`);
		const guests = await extractGuests(transcriptText);

		if (guests.length > 0) {
			console.log(`    Found: ${guests.join(', ')}`);

			// Clear existing and insert
			runSQL(`DELETE FROM episode_guests WHERE episode_id = '${escapeSQL(episode_id)}'`, isLocal);
			for (const guest of guests) {
				const name = guest.trim();
				if (name) {
					runSQL(
						`INSERT OR IGNORE INTO episode_guests (episode_id, guest_name) VALUES ('${escapeSQL(episode_id)}', '${escapeSQL(name)}')`,
						isLocal
					);
					totalGuests++;
				}
			}
		} else {
			console.log('    No guests found');
		}

		processed++;
	}

	console.log();
	console.log('=== Backfill Complete ===');
	console.log(`Processed: ${processed} episodes`);
	console.log(`Total guest entries: ${totalGuests}`);
}

main().catch(err => {
	console.error('Error:', err.message);
	process.exit(1);
});
