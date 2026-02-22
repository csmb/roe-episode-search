#!/usr/bin/env node

/**
 * Delete hallucinated repeated-phrase segments from D1.
 *
 * Whisper hallucinates by repeating a phrase hundreds of times.
 * This script finds any phrase with length > 20 chars appearing > 20 times
 * within one episode and deletes all matching rows.
 *
 * Usage:
 *   node scripts/clean-hallucinations.js                           # all episodes
 *   node scripts/clean-hallucinations.js 2014-03-06 2014-05-08    # specific dates
 */

import { execSync } from 'node:child_process';
import path from 'node:path';

const DB_NAME = 'roe-episodes';
const workerDir = path.resolve(
	path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)),
	'..',
	'roe-search'
);

function escapeSQL(str) {
	return str.replace(/'/g, "''");
}

function wranglerExec(args) {
	const env = { ...process.env };
	delete env.CLOUDFLARE_API_TOKEN;
	return execSync(`npx wrangler ${args}`, {
		cwd: workerDir,
		encoding: 'utf-8',
		stdio: 'pipe',
		env,
	});
}

function queryJSON(sql) {
	const cmd = `d1 execute ${DB_NAME} --remote --json --command="${sql.replace(/"/g, '\\"')}"`;
	const result = wranglerExec(cmd);
	const parsed = JSON.parse(result);
	return parsed[0]?.results ?? [];
}

function runSQL(sql) {
	const cmd = `d1 execute ${DB_NAME} --remote --command="${sql.replace(/"/g, '\\"')}"`;
	wranglerExec(cmd);
}

function purgeEpisode(episodeId) {
	// Find hallucinated phrases: length > 20 chars, repeated > 20 times
	const hallucinations = queryJSON(
		`SELECT text, COUNT(*) as cnt FROM transcript_segments
		 WHERE episode_id = '${escapeSQL(episodeId)}'
		 GROUP BY text
		 HAVING cnt > 20 AND length(text) > 20`
	);

	if (hallucinations.length === 0) {
		console.log(`  ${episodeId}: clean`);
		return 0;
	}

	const phrases = hallucinations.map((r) => `'${escapeSQL(r.text)}'`).join(', ');
	runSQL(
		`DELETE FROM transcript_segments
		 WHERE episode_id = '${escapeSQL(episodeId)}'
		   AND text IN (${phrases})`
	);

	const totalDeleted = hallucinations.reduce((sum, r) => sum + r.cnt, 0);
	const uniqueCount = hallucinations.length;
	console.log(
		`  ${episodeId}: deleted ${totalDeleted} segments (${uniqueCount} unique phrase${uniqueCount === 1 ? '' : 's'})`
	);
	for (const { text, cnt } of hallucinations) {
		console.log(`    × ${cnt}  "${text.slice(0, 80)}${text.length > 80 ? '...' : ''}"`);
	}
	return totalDeleted;
}

async function main() {
	const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));

	let episodeIds;
	if (args.length > 0) {
		// Dates provided — expand to full episode IDs by querying DB
		const dateFilters = args.map((d) => `id LIKE 'roll-over-easy_${escapeSQL(d)}%'`).join(' OR ');
		const rows = queryJSON(`SELECT id FROM episodes WHERE ${dateFilters} ORDER BY id`);
		if (rows.length === 0) {
			console.error('No episodes found matching the provided dates.');
			process.exit(1);
		}
		episodeIds = rows.map((r) => r.id);
		console.log(`Targeting ${episodeIds.length} episode(s) matching dates: ${args.join(', ')}`);
	} else {
		// All episodes
		const rows = queryJSON(`SELECT id FROM episodes ORDER BY id`);
		episodeIds = rows.map((r) => r.id);
		console.log(`Scanning all ${episodeIds.length} episodes...`);
	}

	console.log();
	let totalDeleted = 0;
	for (const id of episodeIds) {
		totalDeleted += purgeEpisode(id);
	}

	console.log();
	console.log(`Done. Total segments deleted: ${totalDeleted}`);
}

main().catch((err) => {
	console.error('Error:', err.message);
	process.exit(1);
});
