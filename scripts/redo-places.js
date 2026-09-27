#!/usr/bin/env node
/**
 * Redo an episode's places with the pipeline's own code (roe-pipeline/src):
 * GPT reads the whole transcript from D1 and names the SF places; only places
 * the show actually mentions are kept; new ones are geocoded; the episode's
 * place links are replaced; then each place is scored for how the hosts talked
 * about it, and the narratives of those places are refreshed.
 *
 * Usage:
 *   node scripts/redo-places.js <episode-id> [<episode-id> …]
 *   node scripts/redo-places.js --no-places        # every episode that has none
 *   node scripts/redo-places.js --local <episode-id>  # against the local D1 copy
 *
 * Needs OPENAI_API_KEY (read from .env). About a cent per episode.
 */

import { loadEnv, queryJSON, escapeSQL } from './lib.js';
import { remoteD1 } from './remote-d1.js';
import { extractAndSeedPlaces } from '../roe-pipeline/src/places.js';
import { scoreAndSeedSentiment } from '../roe-pipeline/src/sentiment.js';

const MIN_LINES = 50; // below this there's nothing to find (e.g. "Recording Lost")

async function redoPlaces(db, episodeId, apiKey, target) {
	const segments = queryJSON(
		`SELECT start_ms, end_ms, text FROM transcript_segments WHERE episode_id = '${escapeSQL(episodeId)}' ORDER BY start_ms`,
		target,
	);
	if (segments.length < MIN_LINES) {
		console.log(`${episodeId}: skipped, only ${segments.length} transcript lines`);
		return;
	}
	const warn = message => console.warn(`  ${message}`);
	console.log(`${episodeId}: ${segments.length} lines`);
	await extractAndSeedPlaces(db, episodeId, segments, apiKey, { warn });
	await scoreAndSeedSentiment(db, episodeId, segments, apiKey, { warn });
	const [{ n }] = queryJSON(`SELECT COUNT(*) AS n FROM place_mentions WHERE episode_id = '${escapeSQL(episodeId)}'`, target);
	console.log(`${episodeId}: ${n} places linked`);
}

async function main() {
	loadEnv();
	const args = process.argv.slice(2);
	const local = args.includes('--local');
	const target = { isLocal: local };
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) throw new Error('OPENAI_API_KEY is not set (add it to .env)');

	let ids = args.filter(a => !a.startsWith('--'));
	if (args.includes('--no-places')) {
		ids = queryJSON(
			'SELECT id FROM episodes e WHERE NOT EXISTS (SELECT 1 FROM place_mentions pm WHERE pm.episode_id = e.id) ORDER BY id',
			target,
		).map(r => r.id);
	}
	if (ids.length === 0) {
		console.error('Usage: node scripts/redo-places.js [--local] (<episode-id> … | --no-places)');
		process.exit(1);
	}

	const db = remoteD1({ local });
	for (const id of ids) {
		const known = queryJSON(`SELECT id FROM episodes WHERE id = '${escapeSQL(id)}'`, target);
		if (known.length === 0) {
			console.error(`${id}: not in the database, skipped`);
			continue;
		}
		await redoPlaces(db, id, apiKey, target);
	}
}

if (import.meta.main) {
	main().catch(err => {
		console.error('Error:', err.message);
		process.exit(1);
	});
}
