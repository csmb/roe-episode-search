#!/usr/bin/env node

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import OpenAI from 'openai';

const CHUNK_DURATION_SECONDS = 600; // 10 minutes per chunk

let _openai;
function getClient() {
	if (!_openai) _openai = new OpenAI();
	return _openai;
}

/**
 * Split an audio file into chunks using ffmpeg.
 * Returns array of { path, offsetMs } for each chunk.
 */
function splitAudio(audioPath, tmpDir) {
	const ext = path.extname(audioPath);
	const chunks = [];

	// Get total duration in seconds
	const durationStr = execSync(
		`ffprobe -v error -show_entries format=duration -of csv=p=0 "${audioPath}"`,
		{ encoding: 'utf-8' }
	).trim();
	const totalSeconds = parseFloat(durationStr);
	const totalChunks = Math.ceil(totalSeconds / CHUNK_DURATION_SECONDS);

	console.log(`  Duration: ${Math.round(totalSeconds / 60)} minutes, splitting into ${totalChunks} chunks`);

	for (let i = 0; i < totalChunks; i++) {
		const startSeconds = i * CHUNK_DURATION_SECONDS;
		const chunkPath = path.join(tmpDir, `chunk_${String(i).padStart(3, '0')}${ext}`);

		execSync(
			`ffmpeg -y -i "${audioPath}" -ss ${startSeconds} -t ${CHUNK_DURATION_SECONDS} -acodec copy "${chunkPath}" 2>/dev/null`,
			{ encoding: 'utf-8' }
		);

		chunks.push({ path: chunkPath, offsetMs: startSeconds * 1000 });
	}

	return chunks;
}

/**
 * Transcribe a single audio chunk via Whisper API.
 * Returns array of segments with timestamps.
 */
async function transcribeChunk(chunkPath, offsetMs) {
	const file = fs.createReadStream(chunkPath);

	const response = await getClient().audio.transcriptions.create({
		model: 'whisper-1',
		file,
		response_format: 'verbose_json',
		timestamp_granularities: ['segment'],
	});

	return (response.segments || []).map((seg) => ({
		start_ms: Math.round(seg.start * 1000) + offsetMs,
		end_ms: Math.round(seg.end * 1000) + offsetMs,
		text: seg.text.trim(),
	}));
}

/**
 * Transcribe a full audio file. Returns the transcript object.
 */
export async function transcribeFile(audioPath, episodeId, title) {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roe-transcribe-'));

	try {
		console.log(`Splitting audio: ${path.basename(audioPath)}`);
		const chunks = splitAudio(audioPath, tmpDir);

		const allSegments = [];
		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i];
			console.log(`  Transcribing chunk ${i + 1}/${chunks.length}...`);
			const segments = await transcribeChunk(chunk.path, chunk.offsetMs);
			allSegments.push(...segments);
		}

		return {
			episode_id: episodeId,
			title,
			segments: allSegments,
		};
	} finally {
		// Clean up temp files
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

/**
 * CLI: node scripts/transcribe.js <audio-file> [episode-id] [title]
 */
async function main() {
	const audioPath = process.argv[2];
	if (!audioPath) {
		console.error('Usage: node scripts/transcribe.js <audio-file> [episode-id] [title]');
		process.exit(1);
	}

	const resolvedPath = path.resolve(audioPath);
	if (!fs.existsSync(resolvedPath)) {
		console.error(`File not found: ${resolvedPath}`);
		process.exit(1);
	}

	const basename = path.basename(resolvedPath, path.extname(resolvedPath));
	const episodeId = process.argv[3] || basename;
	const title = process.argv[4] || basename;

	const outputDir = path.resolve(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)), '..', 'transcripts');
	fs.mkdirSync(outputDir, { recursive: true });

	const outputPath = path.join(outputDir, `${episodeId}.json`);
	if (fs.existsSync(outputPath)) {
		console.log(`Transcript already exists: ${outputPath}`);
		console.log('Delete it to re-transcribe.');
		process.exit(0);
	}

	console.log(`Transcribing: ${path.basename(resolvedPath)}`);
	console.log(`Episode ID: ${episodeId}`);
	console.log(`Output: ${outputPath}`);
	console.log();

	const transcript = await transcribeFile(resolvedPath, episodeId, title);

	fs.writeFileSync(outputPath, JSON.stringify(transcript, null, 2));
	console.log();
	console.log(`Done! ${transcript.segments.length} segments written to ${outputPath}`);
}

// Run CLI if executed directly
const scriptPath = decodeURIComponent(new URL(import.meta.url).pathname);
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath);
if (isDirectRun) {
	main().catch((err) => {
		console.error('Error:', err.message);
		process.exit(1);
	});
}
