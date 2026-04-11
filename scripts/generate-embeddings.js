#!/usr/bin/env node

/**
 * Generate vector embeddings for transcript chunks and upsert to Cloudflare Vectorize.
 *
 * Usage:
 *   node scripts/generate-embeddings.js
 *
 * Safe to re-run — vector IDs are deterministic ({episode_id}:{start_ms}).
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadEnv, isAscii, transcriptsDir } from './lib.js';

loadEnv();

const INDEX_NAME = 'roe-transcripts';
const MODEL = '@cf/baai/bge-base-en-v1.5';

const WINDOW_SEC = 45;
const STEP_SEC = 35; // 45 - 10 overlap
const EMBED_BATCH_SIZE = 100;
const UPSERT_BATCH_SIZE = 1000;

/**
 * Chunk a transcript into overlapping windows for embedding.
 * Exported for process-episode.js to reuse.
 */
export function chunkEpisode(transcript) {
	const { episode_id, title, segments } = transcript;
	if (!segments || segments.length === 0) return [];

	const lastSegment = segments[segments.length - 1];
	const episodeDurationMs = lastSegment.end_ms;
	const windowMs = WINDOW_SEC * 1000;
	const stepMs = STEP_SEC * 1000;

	const chunks = [];

	for (let windowStart = 0; windowStart < episodeDurationMs; windowStart += stepMs) {
		const windowEnd = windowStart + windowMs;

		// Collect segments that overlap with this window
		const windowSegments = segments.filter(
			(s) => s.end_ms > windowStart && s.start_ms < windowEnd
		);

		if (windowSegments.length === 0) continue;

		const text = windowSegments.map((s) => s.text).join(' ');

		// Filter out non-ASCII chunks (Whisper hallucinations on music/noise)
		if (!isAscii(text)) continue;

		// Skip very short chunks (likely noise)
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

async function embedBatch(texts, baseUrl, apiToken) {
	const res = await fetch(`${baseUrl}/ai/run/${MODEL}`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiToken}`,
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

async function upsertVectors(vectors, baseUrl, apiToken) {
	// Vectorize REST API expects NDJSON
	const ndjson = vectors.map((v) => JSON.stringify(v)).join('\n');

	const res = await fetch(`${baseUrl}/vectorize/v2/indexes/${INDEX_NAME}/upsert`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiToken}`,
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
	const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
	const apiToken = process.env.CLOUDFLARE_API_TOKEN;

	if (!accountId || !apiToken) {
		console.error('Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN environment variables.');
		process.exit(1);
	}

	const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;

	if (!fs.existsSync(transcriptsDir)) {
		console.error('No transcripts/ directory found.');
		process.exit(1);
	}

	const files = fs.readdirSync(transcriptsDir).filter((f) => f.endsWith('.json')).sort();
	console.log(`Found ${files.length} transcript files`);

	// 1. Chunk all episodes
	let allChunks = [];
	for (const file of files) {
		const transcript = JSON.parse(fs.readFileSync(path.join(transcriptsDir, file), 'utf-8'));
		const chunks = chunkEpisode(transcript);
		console.log(`  ${transcript.episode_id}: ${chunks.length} chunks`);
		allChunks = allChunks.concat(chunks);
	}

	console.log(`\nTotal chunks: ${allChunks.length}`);

	// 2. Embed in batches
	console.log(`\nEmbedding in batches of ${EMBED_BATCH_SIZE}...`);
	const vectors = [];

	for (let i = 0; i < allChunks.length; i += EMBED_BATCH_SIZE) {
		const batch = allChunks.slice(i, i + EMBED_BATCH_SIZE);
		const texts = batch.map((c) => c.text);

		const embeddings = await embedBatch(texts, baseUrl, apiToken);

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

		console.log(`  Embedded ${Math.min(i + EMBED_BATCH_SIZE, allChunks.length)}/${allChunks.length}`);
	}

	// 3. Upsert to Vectorize in batches
	console.log(`\nUpserting ${vectors.length} vectors in batches of ${UPSERT_BATCH_SIZE}...`);

	for (let i = 0; i < vectors.length; i += UPSERT_BATCH_SIZE) {
		const batch = vectors.slice(i, i + UPSERT_BATCH_SIZE);
		await upsertVectors(batch, baseUrl, apiToken);
		console.log(`  Upserted ${Math.min(i + UPSERT_BATCH_SIZE, vectors.length)}/${vectors.length}`);
	}

	console.log('\nDone!');
}

main().catch((err) => {
	console.error('Error:', err.message);
	process.exit(1);
});
