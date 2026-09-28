#!/usr/bin/env node

/**
 * Transcribe every show in an archive folder that has no transcript yet, with
 * OpenAI Whisper (transcribe.js). The folder is read by discover-episodes.js:
 * one file per date, shows split into several files skipped and listed, and
 * names it can't read listed too. A show that fails is reported and the rest
 * go on; running this again resumes each show from its last saved chunk, so
 * nothing is paid for twice.
 *
 * Usage:
 *   node scripts/transcribe-all.js <audio-directory> [--max <n>]
 *
 * Needs OPENAI_API_KEY (in .env). About $0.72 for a two-hour show.
 */

import fs from 'node:fs';
import path from 'node:path';
import { discoverEpisodes } from './discover-episodes.js';
import { transcribeAndSave } from './transcribe.js';
import { loadEnv, parseFlags } from './lib.js';
import { readTranscript } from './transcript-file.js';

const USAGE = 'Usage: node scripts/transcribe-all.js <audio-directory> [--max <n>]';

async function main() {
	loadEnv();
	const { flags, rest } = parseFlags(process.argv.slice(2), { '--max': 'value' }, USAGE);
	if (rest.length !== 1) {
		console.error(USAGE);
		process.exit(1);
	}
	const max = flags.max === undefined ? Infinity : Number(flags.max);
	if (!(max > 0)) {
		console.error(`--max needs a positive number\n\n${USAGE}`);
		process.exit(1);
	}
	if (!process.env.OPENAI_API_KEY) {
		console.error('OPENAI_API_KEY is not set (add it to .env)');
		process.exit(1);
	}

	const audioDir = path.resolve(rest[0]);
	if (!fs.existsSync(audioDir)) {
		console.error(`Directory not found: ${audioDir}`);
		process.exit(1);
	}

	const { episodes, multiPart, unparseable } = discoverEpisodes(audioDir);
	const pending = episodes.filter((e) => !readTranscript(e.episodeId)).slice(0, max);
	console.log(`\n${episodes.length} shows, ${episodes.length - episodes.filter((e) => !readTranscript(e.episodeId)).length} already transcribed; transcribing ${pending.length}`);
	if (multiPart.length > 0) console.log(`Skipped, split into parts: ${multiPart.map((m) => m.date).join(', ')}`);
	if (unparseable.length > 0) console.log(`Skipped, names it can't read: ${unparseable.length}`);

	const failures = [];
	for (const [i, ep] of pending.entries()) {
		console.log(`\n[${i + 1}/${pending.length}] ${path.basename(ep.filePath)} → ${ep.episodeId}`);
		try {
			const { transcript, reasons } = await transcribeAndSave(ep.filePath, ep.episodeId);
			console.log(`  Done: ${transcript.segments.length} lines${reasons.length ? `; on the re-transcribe list: ${reasons.join('; ')}` : ''}`);
		} catch (err) {
			console.error(`  FAILED: ${err.message.split('\n')[0]} (run again to resume it)`);
			failures.push(ep.episodeId);
		}
	}

	console.log(`\n=== Done: ${pending.length - failures.length} transcribed, ${failures.length} failed ===`);
	for (const id of failures) console.log(`  - ${id}`);
	if (failures.length > 0) process.exit(1);
}

main().catch((err) => {
	console.error('Fatal error:', err.message);
	process.exit(1);
});
