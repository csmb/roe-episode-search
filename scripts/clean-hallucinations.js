#!/usr/bin/env node

/**
 * Delete Whisper's repetition loops from episodes already in D1, with the
 * pipelines' own loop check (findLoops in roe-pipeline/src/clean-segments.js):
 * the repeats in a loop go, and each looping line keeps its first copy. New
 * transcripts are cleaned before they're saved and seeded; this is for what
 * was seeded before that.
 *
 * Usage:
 *   node scripts/clean-hallucinations.js                           # all episodes
 *   node scripts/clean-hallucinations.js 2014-03-06 2014-05-08    # specific dates
 *   node scripts/clean-hallucinations.js --local …                 # the local D1 copy
 *
 * The episode's search vectors are left as they were: re-embed it afterwards
 * (generate-embeddings.js --only <id>), or transcribe it again, which its loop
 * stretch usually needs.
 */

import { escapeSQL, queryJSON, runSQL } from './lib.js';
import { findLoops } from '../roe-pipeline/src/clean-segments.js';

const DELETE_BATCH = 200;

/** @param {{isLocal?: boolean}} [target] - `isLocal: true` cleans the local D1 copy. */
export function purgeEpisode(episodeId, target = {}) {
	const lines = queryJSON(
		`SELECT id, start_ms, end_ms, text FROM transcript_segments WHERE episode_id = '${escapeSQL(episodeId)}' ORDER BY start_ms, id`,
		target
	);
	const { segments: kept, loops } = findLoops(lines);
	if (loops.length === 0) {
		console.log(`  ${episodeId}: clean`);
		return 0;
	}

	const keep = new Set(kept.map((l) => l.id));
	const drop = lines.filter((l) => !keep.has(l.id)).map((l) => l.id);
	for (let i = 0; i < drop.length; i += DELETE_BATCH) {
		runSQL(`DELETE FROM transcript_segments WHERE id IN (${drop.slice(i, i + DELETE_BATCH).join(', ')})`, target);
	}

	console.log(`  ${episodeId}: deleted ${drop.length} looping lines in ${loops.length} stretch${loops.length === 1 ? '' : 'es'}`);
	for (const l of loops) {
		console.log(`    ${Math.round(l.startMs / 60000)}-${Math.round(l.endMs / 60000)} min: ×${l.removed}  "${l.top.slice(0, 80)}"`);
	}
	return drop.length;
}

async function main() {
	const argv = process.argv.slice(2);
	// A mistyped option would otherwise be dropped and the purge run on production
	const unknown = argv.filter((a) => a.startsWith('-') && a !== '--local');
	if (unknown.length > 0) {
		console.error(`Unknown option: ${unknown.join(' ')}\n`);
		console.error('Usage: node scripts/clean-hallucinations.js [--local] [YYYY-MM-DD …]');
		process.exit(1);
	}
	const target = { isLocal: argv.includes('--local') };
	const args = argv.filter((a) => !a.startsWith('-'));

	let episodeIds;
	if (args.length > 0) {
		// Dates provided — expand to full episode IDs by querying DB
		const dateFilters = args.map((d) => `id LIKE 'roll-over-easy_${escapeSQL(d)}%'`).join(' OR ');
		const rows = queryJSON(`SELECT id FROM episodes WHERE ${dateFilters} ORDER BY id`, target);
		if (rows.length === 0) {
			console.error('No episodes found matching the provided dates.');
			process.exit(1);
		}
		episodeIds = rows.map((r) => r.id);
		console.log(`Targeting ${episodeIds.length} episode(s) matching dates: ${args.join(', ')}`);
	} else {
		// All episodes
		const rows = queryJSON(`SELECT id FROM episodes ORDER BY id`, target);
		episodeIds = rows.map((r) => r.id);
		console.log(`Scanning all ${episodeIds.length} episodes...`);
	}

	console.log();
	let totalDeleted = 0;
	for (const id of episodeIds) {
		totalDeleted += purgeEpisode(id, target);
	}

	console.log();
	console.log(`Done. Total segments deleted: ${totalDeleted}`);
}

// Only run main() when executed directly (not when imported)
if (import.meta.main) {
	main().catch((err) => {
		console.error('Error:', err.message);
		process.exit(1);
	});
}
