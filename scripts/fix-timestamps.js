#!/usr/bin/env node

/**
 * One-off fix for the 10x timestamp bug.
 *
 * Whisper's offsets.from/offsets.to (with VAD + --output-json-full) are already
 * in milliseconds, but process-episode.js was multiplying them by 10, storing
 * 10x-too-large values everywhere.
 *
 * The fix is applied PER EPISODE, in a crash-safe / idempotent order:
 *   1. Read the (wrong) transcript JSON. If it already carries the
 *      `timestamps_fixed: true` marker, skip it entirely.
 *   2. Compute the old wrong vector IDs from the ORIGINAL (pre-fix) content.
 *   3. Build the fixed transcript in memory (timestamps / 10 + marker).
 *   4. Delete old wrong-ID vectors from Vectorize (idempotent).
 *   5. Re-embed the fixed chunks → upsert to Vectorize (idempotent).
 *   6. Only then write the fixed transcript JSON back to disk (commit point).
 *
 * A crash at any point before step 6 leaves the file untouched, so a rerun
 * simply redoes that episode from scratch (deletes/upserts are idempotent).
 * Once the marker is on disk, the episode's remote state is already correct
 * and the episode is skipped on rerun — timestamps can never be divided twice.
 *
 * After running this script, also run the D1 fix:
 *   npx wrangler d1 execute roe-episodes --remote \
 *     --command="UPDATE transcript_segments SET start_ms = start_ms / 10, end_ms = end_ms / 10"
 *   npx wrangler d1 execute roe-episodes --remote \
 *     --command="UPDATE episodes SET duration_ms = duration_ms / 10"
 *
 * Prerequisites:
 *   CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chunkEpisode } from './generate-embeddings.js';

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const INDEX_NAME = 'roe-transcripts';
const MODEL = '@cf/baai/bge-base-en-v1.5';

const EMBED_BATCH_SIZE = 100;
const UPSERT_BATCH_SIZE = 1000;
const DELETE_BATCH_SIZE = 1000;

if (!ACCOUNT_ID || !API_TOKEN) {
	console.error('Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN environment variables.');
	process.exit(1);
}

const BASE_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}`;

// Chunk-windowing logic is shared with generate-embeddings.js / delete-episode.js
// via the imported chunkEpisode() — these must stay in lockstep so recomputed
// vector IDs match what was upserted.

async function deleteVectors(ids) {
	const res = await fetch(`${BASE_URL}/vectorize/v2/indexes/${INDEX_NAME}/delete-by-ids`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${API_TOKEN}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ ids }),
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Vectorize delete error ${res.status}: ${body}`);
	}

	return res.json();
}

async function embedBatch(texts) {
	const res = await fetch(`${BASE_URL}/ai/run/${MODEL}`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${API_TOKEN}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ text: texts }),
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Embedding API error ${res.status}: ${body}`);
	}

	const json = await res.json();
	return json.result.data;
}

async function upsertVectors(vectors) {
	const ndjson = vectors.map((v) => JSON.stringify(v)).join('\n');

	const res = await fetch(`${BASE_URL}/vectorize/v2/indexes/${INDEX_NAME}/upsert`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${API_TOKEN}`,
			'Content-Type': 'application/x-ndjson',
		},
		body: ndjson,
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Vectorize upsert error ${res.status}: ${body}`);
	}

	return res.json();
}

async function main() {
	const transcriptsDir = path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		'..',
		'transcripts'
	);

	if (!fs.existsSync(transcriptsDir)) {
		console.error('No transcripts/ directory found.');
		process.exit(1);
	}

	const files = fs.readdirSync(transcriptsDir).filter((f) => f.endsWith('.json')).sort();
	console.log(`Found ${files.length} transcript files\n`);

	let fixedCount = 0;
	let skippedCount = 0;

	for (const file of files) {
		const filePath = path.join(transcriptsDir, file);
		const transcript = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

		// ── Already fixed? Skip — never divide twice, never delete good vectors.
		if (transcript.timestamps_fixed === true) {
			console.log(`  ${transcript.episode_id}: already fixed (timestamps_fixed marker), skipping`);
			skippedCount++;
			continue;
		}

		// ── Sanity guard for transcripts fixed before the marker existed (or
		//    never broken): a real episode is a few hours at most, while the
		//    10x bug inflates a 2h episode to ~20h. If the duration is already
		//    plausible, the timestamps aren't inflated — don't touch them.
		const lastSeg = transcript.segments?.[transcript.segments.length - 1];
		if (!lastSeg || lastSeg.end_ms < 5 * 3600 * 1000) {
			console.log(`  ${transcript.episode_id}: duration already plausible (<5h), skipping`);
			skippedCount++;
			continue;
		}

		console.log(`\n=== Fixing ${transcript.episode_id} ===`);

		// ── 1. Compute old (wrong) vector IDs from the ORIGINAL content,
		//       before any mutation or write.
		const oldIds = chunkEpisode(transcript).map((c) => c.id);
		console.log(`  Old wrong-ID vectors to delete: ${oldIds.length}`);

		// ── 2. Build the fixed transcript in memory only (no write yet).
		const fixed = {
			...transcript,
			timestamps_fixed: true,
			segments: transcript.segments.map((seg) => ({
				...seg,
				start_ms: Math.round(seg.start_ms / 10),
				end_ms: Math.round(seg.end_ms / 10),
			})),
		};

		const newChunks = chunkEpisode(fixed);
		console.log(`  New chunks to embed: ${newChunks.length}`);

		// ── 3. Delete old wrong-ID vectors (idempotent: deleting missing IDs is a no-op).
		for (let i = 0; i < oldIds.length; i += DELETE_BATCH_SIZE) {
			const batch = oldIds.slice(i, i + DELETE_BATCH_SIZE);
			const result = await deleteVectors(batch);
			const deleted = result?.result?.count ?? batch.length;
			console.log(
				`  Deleted ${deleted} vectors ` +
				`(${Math.min(i + DELETE_BATCH_SIZE, oldIds.length)}/${oldIds.length} total)`
			);
		}

		// ── 4. Re-embed and upsert (idempotent: upsert overwrites by ID).
		const vectors = [];

		for (let i = 0; i < newChunks.length; i += EMBED_BATCH_SIZE) {
			const batch = newChunks.slice(i, i + EMBED_BATCH_SIZE);
			const embeddings = await embedBatch(batch.map((c) => c.text));

			for (let j = 0; j < batch.length; j++) {
				vectors.push({
					id: batch[j].id,
					values: embeddings[j],
					metadata: {
						episode_id: batch[j].episode_id,
						title: batch[j].title,
						start_ms: batch[j].start_ms,
						end_ms: batch[j].end_ms,
						text: batch[j].text,
					},
				});
			}

			console.log(`  Embedded ${Math.min(i + EMBED_BATCH_SIZE, newChunks.length)}/${newChunks.length}`);
		}

		for (let i = 0; i < vectors.length; i += UPSERT_BATCH_SIZE) {
			await upsertVectors(vectors.slice(i, i + UPSERT_BATCH_SIZE));
			console.log(`  Upserted ${Math.min(i + UPSERT_BATCH_SIZE, vectors.length)}/${vectors.length}`);
		}

		// ── 5. Commit point: write the fixed transcript (with marker) only after
		//       all remote state is correct. A crash before this line leaves the
		//       file untouched, so a rerun redoes this episode from scratch.
		fs.writeFileSync(filePath, JSON.stringify(fixed, null, 2));

		const last = fixed.segments[fixed.segments.length - 1];
		const durationSec = last ? (last.end_ms / 1000).toFixed(0) : '?';
		console.log(
			`  Wrote fixed transcript: ${fixed.segments.length} segs, duration ~${durationSec}s ` +
			`(timestamps_fixed marker set)`
		);
		fixedCount++;
	}

	console.log(`\n✓ Done: ${fixedCount} episode(s) fixed, ${skippedCount} skipped (already fixed).`);
	console.log('\nNow fix D1 with:');
	console.log(
		'  npx wrangler d1 execute roe-episodes --remote ' +
		'--command="UPDATE transcript_segments SET start_ms = start_ms / 10, end_ms = end_ms / 10"'
	);
	console.log(
		'  npx wrangler d1 execute roe-episodes --remote ' +
		'--command="UPDATE episodes SET duration_ms = duration_ms / 10"'
	);
	console.log('\nVerification:');
	console.log(
		'  node -e "const fs=require(\'fs\'); ' +
		'const t=JSON.parse(fs.readFileSync(\'transcripts/roll-over-easy_2014-08-14_07-30-00.json\')); ' +
		'const last=t.segments[t.segments.length-1]; ' +
		'console.log(\'last end_ms/1000 =\', last.end_ms/1000, \'s (expect ~7200)\')"'
	);
}

main().catch((err) => {
	console.error('\nFatal error:', err.message);
	process.exit(1);
});
