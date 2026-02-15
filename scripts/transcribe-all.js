#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { transcribeFile } from './transcribe.js';

const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.wav', '.ogg', '.flac', '.aac', '.wma']);
const MAX_RETRIES = 2;

function usage() {
	console.error('Usage: node scripts/transcribe-all.js <audio-directory>');
	console.error('');
	console.error('Transcribes all audio files in the directory.');
	console.error('Skips files that already have a transcript in transcripts/.');
	console.error('');
	console.error('Environment: OPENAI_API_KEY must be set.');
	process.exit(1);
}

async function main() {
	const audioDir = process.argv[2];
	if (!audioDir) usage();

	const resolvedDir = path.resolve(audioDir);
	if (!fs.existsSync(resolvedDir)) {
		console.error(`Directory not found: ${resolvedDir}`);
		process.exit(1);
	}

	const transcriptsDir = path.resolve(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)), '..', 'transcripts');
	fs.mkdirSync(transcriptsDir, { recursive: true });

	// Find all audio files
	const files = fs.readdirSync(resolvedDir)
		.filter((f) => AUDIO_EXTENSIONS.has(path.extname(f).toLowerCase()))
		.sort();

	if (files.length === 0) {
		console.log(`No audio files found in ${resolvedDir}`);
		process.exit(0);
	}

	// Determine which need transcribing
	const pending = [];
	const skipped = [];
	for (const file of files) {
		const episodeId = path.basename(file, path.extname(file));
		const transcriptPath = path.join(transcriptsDir, `${episodeId}.json`);
		if (fs.existsSync(transcriptPath)) {
			skipped.push(file);
		} else {
			pending.push(file);
		}
	}

	console.log(`Found ${files.length} audio files`);
	console.log(`  Already transcribed: ${skipped.length}`);
	console.log(`  To transcribe: ${pending.length}`);
	console.log();

	if (pending.length === 0) {
		console.log('Nothing to do!');
		process.exit(0);
	}

	let succeeded = 0;
	let failed = 0;
	const failures = [];

	for (let i = 0; i < pending.length; i++) {
		const file = pending[i];
		const episodeId = path.basename(file, path.extname(file));
		const audioPath = path.join(resolvedDir, file);
		const outputPath = path.join(transcriptsDir, `${episodeId}.json`);

		console.log(`[${i + 1}/${pending.length}] ${file}`);

		let lastError;
		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			try {
				if (attempt > 0) console.log(`  Retry ${attempt}/${MAX_RETRIES}...`);

				const transcript = await transcribeFile(audioPath, episodeId, episodeId);
				fs.writeFileSync(outputPath, JSON.stringify(transcript, null, 2));
				console.log(`  Done: ${transcript.segments.length} segments`);
				succeeded++;
				lastError = null;
				break;
			} catch (err) {
				lastError = err;
				console.error(`  Error: ${err.message}`);
			}
		}

		if (lastError) {
			console.error(`  FAILED after ${MAX_RETRIES + 1} attempts, skipping.`);
			failed++;
			failures.push(file);
		}

		console.log();
	}

	console.log('=== Summary ===');
	console.log(`Succeeded: ${succeeded}`);
	console.log(`Failed: ${failed}`);
	console.log(`Previously done: ${skipped.length}`);
	if (failures.length > 0) {
		console.log(`\nFailed files:`);
		failures.forEach((f) => console.log(`  - ${f}`));
	}
}

main().catch((err) => {
	console.error('Fatal error:', err.message);
	process.exit(1);
});
