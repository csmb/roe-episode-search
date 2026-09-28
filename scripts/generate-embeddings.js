#!/usr/bin/env node

/**
 * Embed episodes' transcripts into Cloudflare Vectorize with the Worker's own
 * code (roe-pipeline/src/embeddings.js), through REST stand-ins for its
 * bindings (remote-cloudflare.js).
 *
 * Usage:
 *   node scripts/generate-embeddings.js --only <episode-id>[,<episode-id>…]
 *   node scripts/generate-embeddings.js --all        # every transcript on disk
 *
 * Only episodes that are in D1 are embedded, so test clips and removed
 * duplicates stay out of search (rejected transcripts live in
 * transcripts/.rejected/). Safe to re-run: vector IDs come from the episode and
 * each window's start.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadEnv, transcriptsDir, parseFlags, queryJSON } from './lib.js';
import { chunkSegments, generateEmbeddings } from '../roe-pipeline/src/embeddings.js';
import { remoteAI, remoteVectorize } from './remote-cloudflare.js';

loadEnv();

/**
 * The windows a transcript file ({episode_id, title, segments}) is embedded in,
 * exactly as the Worker makes them. episode-backup.js uses it to find an
 * episode's vector IDs.
 */
export function chunkEpisode(transcript) {
	const { episode_id, title, segments } = transcript;
	if (!segments || segments.length === 0) return [];
	return chunkSegments(episode_id, segments, transcript.meta?.audio_ms).map((c) => ({ ...c, episode_id, title }));
}

const USAGE = 'Usage: node scripts/generate-embeddings.js (--only <episode-id>[,<episode-id>…] | --all)';

async function main() {
	const { flags, rest } = parseFlags(process.argv.slice(2), { '--only': 'value', '--all': 'flag' }, USAGE);
	if (rest.length > 0 || !flags.only === !flags.all) {
		console.error(USAGE);
		process.exit(1);
	}
	if (process.env.ROE_PERSIST_TO) throw new Error('ROE_PERSIST_TO is set (a test run): refusing to write embeddings to production');

	const ids = flags.only
		? flags.only.split(',').map((s) => s.trim()).filter(Boolean)
		: fs.readdirSync(transcriptsDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length)).sort();
	const inD1 = new Set(queryJSON('SELECT id FROM episodes').map((r) => r.id));

	const ai = remoteAI();
	const vectorize = remoteVectorize();
	let episodes = 0;
	let vectors = 0;
	for (const id of ids) {
		const file = path.join(transcriptsDir, `${id}.json`);
		if (!inD1.has(id)) {
			console.log(`  ${id}: not in D1, skipped`);
			continue;
		}
		if (!fs.existsSync(file)) {
			console.log(`  ${id}: no transcript file, skipped`);
			continue;
		}
		const transcript = JSON.parse(fs.readFileSync(file, 'utf-8'));
		const segments = transcript.segments || [];
		const durationMs = transcript.meta?.audio_ms ?? segments.at(-1)?.end_ms ?? 0;
		console.log(`${id}:`);
		vectors += await generateEmbeddings(ai, vectorize, id, segments, durationMs);
		episodes++;
	}
	console.log(`\nDone: ${vectors} vectors for ${episodes} episode(s).`);
}

// Only run main() when executed directly (not when imported)
if (import.meta.main) {
	main().catch((err) => {
		console.error('Error:', err.message);
		process.exit(1);
	});
}
