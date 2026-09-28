#!/usr/bin/env node

/**
 * Transcribe a show with OpenAI Whisper, using the Cloudflare pipeline's own
 * code (roe-pipeline/src/transcribe.js): six-minute chunks cut on MP3 frames,
 * English, the pipeline's spelling-hint prompt, retries of holes inside a chunk
 * and across chunk boundaries, and the same cleaning. The local MP3 is read
 * through a stand-in for R2.
 *
 * A chunk that fails is retried after 1, 5 and 15 minutes, not the whole show,
 * and progress is saved after every chunk (transcripts/.partial/<id>.json), so a
 * crash or Ctrl-C resumes where it stopped instead of paying again. Whisper
 * costs about $0.006 a minute.
 *
 * Usage:
 *   node scripts/transcribe.js <file.mp3> <episode-id> [--force]
 */

import fs from 'node:fs';
import path from 'node:path';

import { newTranscription, transcriptionDone, transcribeNextChunk, finishTranscription, TARGET_CHUNK_SEC } from '../roe-pipeline/src/transcribe.js';
import { isPermanent } from '../roe-pipeline/src/limits.js';
import { id3v2Size } from '../roe-pipeline/src/mp3-frames.js';
import { loadEnv, parseFlags, probeDurationMs, transcriptsDir } from './lib.js';
import { buildTranscript, writeTranscript, readTranscript, PROMPT_SHA1 } from './transcript-file.js';
import { chunkEpisode } from './generate-embeddings.js';

const RETRY_WAITS_MS = [60_000, 5 * 60_000, 15 * 60_000]; // as the Worker retries a step

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const partialPath = (episodeId) => path.join(transcriptsDir, '.partial', `${episodeId}.json`);

/** A stand-in for an R2 bucket holding one local file: what the Worker's chunker reads through. */
function fileBucket(filePath) {
	const { size, mtimeMs } = fs.statSync(filePath);
	const fd = fs.openSync(filePath, 'r');
	return {
		etag: `${size}-${Math.round(mtimeMs)}`,
		close: () => fs.closeSync(fd),
		async head() {
			return { size, etag: this.etag };
		},
		async get(_key, { range }) {
			const buf = Buffer.alloc(range.length);
			const read = fs.readSync(fd, buf, 0, range.length, range.offset);
			return { arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + read) };
		},
	};
}

/**
 * Transcribe an MP3 to a transcript object (see transcript-file.js), resuming
 * a partial run of the same file if there is one.
 */
export async function transcribeFile(audioPath, episodeId, title = episodeId) {
	if (!/\.mp3$/i.test(audioPath)) throw new Error(`${path.basename(audioPath)} isn't an MP3; convert it first (ffmpeg -i in.m4a -c:a libmp3lame -q:a 2 out.mp3)`);
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) throw new Error('OPENAI_API_KEY is not set (add it to .env)');

	const audioMs = probeDurationMs(audioPath);
	const bucket = fileBucket(audioPath);
	const partial = partialPath(episodeId);
	try {
		const head = await bucket.head();
		let state = fs.existsSync(partial) ? JSON.parse(fs.readFileSync(partial, 'utf-8')) : null;
		if (state && state.tx.etag !== head.etag) {
			console.log('  The saved progress is for a different copy of the file; starting over');
			state = null;
		}
		if (!state) {
			const tx = newTranscription(head);
			// Start after any ID3 tag: cover art is full of bytes that look like frame starts
			const tag = id3v2Size(new Uint8Array((await (await bucket.get(null, { range: { offset: 0, length: Math.min(10, head.size) } })).arrayBuffer())));
			if (tag > 0 && tag < head.size) tx.fileOffset = tag;
			state = { tx, own: [], boundary: [] };
		} else {
			console.log(`  Resuming after chunk ${state.tx.chunks}`);
		}
		console.log(`  ${(audioMs / 60000).toFixed(1)} minutes, about $${((audioMs / 60000) * 0.006).toFixed(2)} of Whisper`);

		while (!transcriptionDone(state.tx)) {
			const prevSegments = state.own.at(-1) ?? [];
			let out;
			for (let attempt = 1; ; attempt++) {
				try {
					out = await transcribeNextChunk(bucket, audioPath, apiKey, state.tx, { prevSegments });
					break;
				} catch (err) {
					if (isPermanent(err) || attempt > RETRY_WAITS_MS.length) throw err;
					const wait = RETRY_WAITS_MS[attempt - 1];
					console.warn(`  Chunk ${state.tx.chunks + 1} failed (${err.message.split('\n')[0]}); trying again in ${wait / 60000} min`);
					await sleep(wait);
				}
			}
			state = { tx: out.tx, own: [...state.own, out.segments], boundary: [...state.boundary, out.boundary] };
			fs.mkdirSync(path.dirname(partial), { recursive: true });
			fs.writeFileSync(`${partial}.tmp`, JSON.stringify(state));
			fs.renameSync(`${partial}.tmp`, partial);
		}

		const raw = [...state.own.flat(), ...state.boundary.flat()];
		const { segments, loops } = finishTranscription(raw, Math.round(state.tx.timeOffset * 1000));
		return buildTranscript({
			knownLoops: loops,
			episodeId,
			title,
			segments,
			audioMs,
			audioFile: audioPath,
			engine: 'openai',
			model: 'whisper-1',
			settings: { chunk_sec: TARGET_CHUNK_SEC, language: 'en', prompt_sha1: PROMPT_SHA1, gap_retry: true },
			removedByCleaning: raw.length - segments.length,
		});
	} finally {
		bucket.close();
	}
}

/** Once the transcript is saved, the saved progress isn't needed. */
export function clearPartial(episodeId) {
	fs.rmSync(partialPath(episodeId), { force: true });
}

/**
 * Transcribe and save, remembering the old transcript's vector IDs so the
 * embeddings step can delete any the new one doesn't have. Returns the
 * transcript and the reasons it's on the re-transcribe list (if any).
 */
export async function transcribeAndSave(audioPath, episodeId, title = episodeId) {
	const old = readTranscript(episodeId);
	const transcript = await transcribeFile(audioPath, episodeId, title);
	const reasons = writeTranscript(transcript, { oldVectorIds: old ? chunkEpisode(old).map((c) => c.id) : [] });
	clearPartial(episodeId);
	return { transcript, reasons };
}

async function main() {
	loadEnv();
	const usage = 'Usage: node scripts/transcribe.js <file.mp3> <episode-id> [--force]';
	const { flags, rest } = parseFlags(process.argv.slice(2), { '--force': 'flag' }, usage);
	if (rest.length !== 2) {
		console.error(usage);
		process.exit(1);
	}
	const [audioArg, episodeId] = rest;
	const audioPath = path.resolve(audioArg);
	if (!fs.existsSync(audioPath)) {
		console.error(`File not found: ${audioPath}`);
		process.exit(1);
	}
	if (readTranscript(episodeId) && !flags.force) {
		console.log(`Transcript already exists for ${episodeId} (--force to redo it)`);
		return;
	}

	console.log(`Transcribing ${path.basename(audioPath)} as ${episodeId}`);
	const { transcript, reasons } = await transcribeAndSave(audioPath, episodeId);
	const m = transcript.meta;
	console.log(`\nDone: ${transcript.segments.length} lines (${m.lines_removed.cleaning} removed by cleaning, ${m.lines_removed.loops} by the loop check)`);
	if (!m.coverage.ok) console.warn(`  Coverage: ${m.coverage.problems.join('; ')}`);
	if (reasons.length > 0) console.warn(`  On the re-transcribe list: ${reasons.join('; ')}`);
}

// Run CLI if executed directly
if (import.meta.main) {
	main().catch((err) => {
		console.error('Error:', err.message);
		process.exit(1);
	});
}
