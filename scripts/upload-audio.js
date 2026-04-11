#!/usr/bin/env node

/**
 * Re-mux and upload audio files to R2, then update the DB with the audio URL.
 *
 * Usage:
 *   node scripts/upload-audio.js <audio-directory> [--local]
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { escapeSQL, wranglerExec, runSQL, queryJSON, transcriptsDir } from './lib.js';

const R2_BUCKET = 'roe-audio';
const R2_PUBLIC_URL = 'https://pub-e95bd2be3f9d4147b2955503d75e50c1.r2.dev';

const AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.wav', '.ogg', '.flac', '.aac', '.wma'];

/**
 * Convert audio to M4A (AAC) with faststart for reliable browser streaming.
 */
export function convertAudio(inputPath, tmpDir) {
	const outPath = path.join(tmpDir, 'converted.m4a');
	execFileSync('ffmpeg', [
		'-y', '-i', inputPath,
		'-c:a', 'aac', '-b:a', '128k',
		'-movflags', '+faststart',
		outPath,
	], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
	return outPath;
}

function findAudioFile(audioDir, episodeId) {
	for (const ext of AUDIO_EXTENSIONS) {
		const candidate = path.join(audioDir, episodeId + ext);
		if (fs.existsSync(candidate)) return candidate;
	}
	return null;
}

async function main() {
	const audioDir = process.argv[2];
	if (!audioDir || audioDir.startsWith('--')) {
		console.error('Usage: node scripts/upload-audio.js <audio-directory> [--local]');
		process.exit(1);
	}

	const resolvedAudioDir = path.resolve(audioDir);
	if (!fs.existsSync(resolvedAudioDir)) {
		console.error(`Directory not found: ${resolvedAudioDir}`);
		process.exit(1);
	}

	const isLocal = process.argv.includes('--local');

	// Get list of transcribed episodes
	if (!fs.existsSync(transcriptsDir)) {
		console.error('No transcripts/ directory. Run transcription first.');
		process.exit(1);
	}

	const transcriptFiles = fs.readdirSync(transcriptsDir).filter((f) => f.endsWith('.json'));
	if (transcriptFiles.length === 0) {
		console.log('No transcripts found.');
		process.exit(0);
	}

	// Check which episodes already have audio in the DB
	let existingAudio = new Set();
	try {
		const results = queryJSON(
			"SELECT id FROM episodes WHERE audio_file IS NOT NULL AND audio_file != ''",
			{ isLocal }
		);
		existingAudio = new Set(results.map((r) => r.id));
	} catch {
		// Table might not exist yet
	}

	// Determine what needs uploading
	const pending = [];
	for (const file of transcriptFiles) {
		const episodeId = path.basename(file, '.json');
		if (existingAudio.has(episodeId)) continue;

		const audioFile = findAudioFile(resolvedAudioDir, episodeId);
		if (!audioFile) {
			console.log(`  Skipping ${episodeId} (audio file not found)`);
			continue;
		}
		pending.push({ episodeId, audioFile });
	}

	console.log(`Transcribed episodes: ${transcriptFiles.length}`);
	console.log(`Already have audio URL: ${existingAudio.size}`);
	console.log(`To upload: ${pending.length}`);
	console.log();

	if (pending.length === 0) {
		console.log('Nothing to upload!');
		process.exit(0);
	}

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roe-upload-'));
	let uploaded = 0;
	let failed = 0;

	try {
		for (let i = 0; i < pending.length; i++) {
			const { episodeId, audioFile } = pending[i];
			const r2Key = `${episodeId}.m4a`;
			const publicUrl = `${R2_PUBLIC_URL}/${r2Key}`;

			console.log(`[${i + 1}/${pending.length}] ${episodeId}`);

			try {
				// Convert to M4A for browser compatibility
				console.log('  Converting to M4A...');
				const convertedPath = convertAudio(audioFile, tmpDir);

				// Upload to R2
				console.log('  Uploading to R2...');
				wranglerExec([
					'r2', 'object', 'put', `${R2_BUCKET}/${r2Key}`,
					`--file=${convertedPath}`, '--content-type=audio/mp4',
				]);

				// Update DB
				console.log('  Updating database...');
				runSQL(
					`UPDATE episodes SET audio_file = '${escapeSQL(publicUrl)}' WHERE id = '${escapeSQL(episodeId)}'`,
					{ isLocal }
				);

				// Clean up temp file for next iteration
				fs.rmSync(convertedPath, { force: true });

				console.log('  Done.');
				uploaded++;
			} catch (err) {
				console.error(`  FAILED: ${err.message}`);
				failed++;
			}
			console.log();
		}
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}

	console.log('=== Summary ===');
	console.log(`Uploaded: ${uploaded}`);
	console.log(`Failed: ${failed}`);
	console.log(`Previously done: ${existingAudio.size}`);
}

main().catch((err) => {
	console.error('Fatal error:', err.message);
	process.exit(1);
});
