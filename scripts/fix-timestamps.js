#!/usr/bin/env node

/**
 * One-off fix for the 10x timestamp bug.
 *
 * Whisper's offsets.from/offsets.to (with VAD + --output-json-full) are already
 * in milliseconds, but process-episode.js was multiplying them by 10, storing
 * 10x-too-large values everywhere.
 *
 * This script fixes the stored data in the correct order:
 *   1. Read current (wrong) transcript JSONs → compute old wrong vector IDs
 *   2. Delete old wrong-ID vectors from Vectorize
 *   3. Divide all timestamps in transcript JSONs by 10 and write back
 *   4. Re-embed all chunks with correct timestamps → upsert to Vectorize
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

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const INDEX_NAME = 'roe-transcripts';
const MODEL = '@cf/baai/bge-base-en-v1.5';

const WINDOW_SEC = 45;
const STEP_SEC = 35;
const EMBED_BATCH_SIZE = 100;
const UPSERT_BATCH_SIZE = 1000;
const DELETE_BATCH_SIZE = 1000;

if (!ACCOUNT_ID || !API_TOKEN) {
	console.error('Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN environment variables.');
	process.exit(1);
}

const BASE_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}`;

// Replicate the chunk-windowing logic from process-episode.js / generate-embeddings.js
function chunkTranscript(transcript) {
	const { episode_id, title, segments } = transcript;
	if (!segments || segments.length === 0) return [];

	const lastSegment = segments[segments.length - 1];
	const episodeDurationMs = lastSegment.end_ms;
	const windowMs = WINDOW_SEC * 1000;
	const stepMs = STEP_SEC * 1000;

	const chunks = [];

	for (let windowStart = 0; windowStart < episodeDurationMs; windowStart += stepMs) {
		const windowEnd = windowStart + windowMs;

		const windowSegments = segments.filter(
			(s) => s.end_ms > windowStart && s.start_ms < windowEnd
		);

		if (windowSegments.length === 0) continue;

		const text = windowSegments.map((s) => s.text).join(' ');

		// eslint-disable-next-line no-control-regex
		if (!/^[\x00-\x7F]*$/.test(text)) continue;
		if (text.trim().length < 20) continue;

		const chunkStartMs = windowSegments[0].start_ms;
		const chunkEndMs = windowSegments[windowSegments.length - 1].end_ms;

		chunks.push({
			id: `${episode_id}:${chunkStartMs}`,
			episode_id,
			title,
			start_ms: chunkStartMs,
			end_ms: chunkEndMs,
			text: text.trim(),
		});
	}

	return chunks;
}

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

	// ── Step 1: Read wrong transcripts, compute old vector IDs ────────────
	console.log('=== Step 1/4: Computing old (wrong-ID) vector IDs ===');
	const oldIds = [];
	const episodeData = []; // store { filePath, transcript } for later steps

	for (const file of files) {
		const filePath = path.join(transcriptsDir, file);
		const transcript = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
		const chunks = chunkTranscript(transcript);
		const ids = chunks.map((c) => c.id);
		console.log(`  ${transcript.episode_id}: ${ids.length} wrong vectors`);
		oldIds.push(...ids);
		episodeData.push({ filePath, transcript });
	}

	console.log(`\nTotal old vectors to delete: ${oldIds.length}`);

	// ── Step 2: Delete old wrong-ID vectors from Vectorize ────────────────
	console.log('\n=== Step 2/4: Deleting old wrong-ID vectors from Vectorize ===');

	for (let i = 0; i < oldIds.length; i += DELETE_BATCH_SIZE) {
		const batch = oldIds.slice(i, i + DELETE_BATCH_SIZE);
		const result = await deleteVectors(batch);
		const deleted = result?.result?.count ?? batch.length;
		console.log(
			`  Deleted batch ${Math.floor(i / DELETE_BATCH_SIZE) + 1}: ${deleted} vectors ` +
			`(${Math.min(i + DELETE_BATCH_SIZE, oldIds.length)}/${oldIds.length} total)`
		);
	}

	// ── Step 3: Fix transcript JSONs (divide all timestamps by 10) ────────
	console.log('\n=== Step 3/4: Fixing transcript JSON files (dividing timestamps by 10) ===');

	const fixedTranscripts = [];

	for (const { filePath, transcript } of episodeData) {
		const fixed = {
			...transcript,
			segments: transcript.segments.map((seg) => ({
				...seg,
				start_ms: Math.round(seg.start_ms / 10),
				end_ms: Math.round(seg.end_ms / 10),
			})),
		};

		fs.writeFileSync(filePath, JSON.stringify(fixed, null, 2));

		const last = fixed.segments[fixed.segments.length - 1];
		const durationSec = last ? (last.end_ms / 1000).toFixed(0) : '?';
		console.log(`  ${transcript.episode_id}: ${fixed.segments.length} segs, duration ~${durationSec}s`);

		fixedTranscripts.push(fixed);
	}

	// ── Step 4: Re-embed with correct timestamps ──────────────────────────
	console.log('\n=== Step 4/4: Re-embedding with correct timestamps ===');

	let allChunks = [];
	for (const transcript of fixedTranscripts) {
		const chunks = chunkTranscript(transcript);
		console.log(`  ${transcript.episode_id}: ${chunks.length} chunks`);
		allChunks = allChunks.concat(chunks);
	}

	console.log(`\nTotal chunks to embed: ${allChunks.length}`);

	const vectors = [];

	for (let i = 0; i < allChunks.length; i += EMBED_BATCH_SIZE) {
		const batch = allChunks.slice(i, i + EMBED_BATCH_SIZE);
		const texts = batch.map((c) => c.text);

		const embeddings = await embedBatch(texts);

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

		if ((i + EMBED_BATCH_SIZE) % 500 === 0 || i + EMBED_BATCH_SIZE >= allChunks.length) {
			console.log(`  Embedded ${Math.min(i + EMBED_BATCH_SIZE, allChunks.length)}/${allChunks.length}`);
		}
	}

	console.log(`\nUpserting ${vectors.length} vectors to Vectorize...`);

	for (let i = 0; i < vectors.length; i += UPSERT_BATCH_SIZE) {
		const batch = vectors.slice(i, i + UPSERT_BATCH_SIZE);
		await upsertVectors(batch);
		console.log(`  Upserted ${Math.min(i + UPSERT_BATCH_SIZE, vectors.length)}/${vectors.length}`);
	}

	console.log('\n✓ Vectorize and transcript JSON files fixed.');
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
