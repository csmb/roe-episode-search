#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
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
	const durationStr = execFileSync('ffprobe', [
		'-v', 'error',
		'-show_entries', 'format=duration',
		'-of', 'csv=p=0',
		audioPath,
	], { encoding: 'utf-8' }).trim();
	const totalSeconds = parseFloat(durationStr);
	const totalChunks = Math.ceil(totalSeconds / CHUNK_DURATION_SECONDS);

	console.log(`  Duration: ${Math.round(totalSeconds / 60)} minutes, splitting into ${totalChunks} chunks`);

	for (let i = 0; i < totalChunks; i++) {
		const startSeconds = i * CHUNK_DURATION_SECONDS;
		const chunkPath = path.join(tmpDir, `chunk_${String(i).padStart(3, '0')}${ext}`);

		execFileSync('ffmpeg', [
			'-y', '-i', audioPath,
			'-ss', String(startSeconds),
			'-t', String(CHUNK_DURATION_SECONDS),
			'-acodec', 'copy',
			chunkPath,
		], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });

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
		prompt: [
			// Show context & proper nouns
			'Roll Over Easy, BFF.fm, San Francisco, the Bay Area,',
			// Neighborhoods
			'the Mission, the Castro, the Haight, Haight-Ashbury, SoMa, the Tenderloin,',
			'Noe Valley, Potrero Hill, Dogpatch, Bernal Heights, the Sunset, the Richmond,',
			'the Outer Sunset, the Inner Richmond, North Beach, Chinatown, Japantown,',
			'the Marina, Pac Heights, Pacific Heights, Russian Hill, Nob Hill, Telegraph Hill,',
			'the Fillmore, Hayes Valley, Cole Valley, Glen Park, Excelsior, Bayview,',
			'Hunters Point, Visitacion Valley, the Outer Richmond, Sea Cliff, the Presidio,',
			// Landmarks & places
			'the Ferry Building, Coit Tower, Golden Gate Bridge, Golden Gate Park,',
			'Alcatraz, Fishermans Wharf, Pier 39, AT&T Park, Oracle Park,',
			'Dolores Park, Alamo Square, the Painted Ladies, Twin Peaks,',
			'Sutro Baths, Lands End, Ocean Beach, Baker Beach, Fort Mason,',
			'the de Young Museum, Cal Academy, California Academy of Sciences,',
			'SFMOMA, the Exploratorium, Palace of Fine Arts, City Lights Bookstore,',
			'Tartine, Bi-Rite, Humphry Slocombe, Mitchell\'s Ice Cream,',
			'Anchor Brewing, Toronado, Zeitgeist, the Knockout, El Rio,',
			'Hamburger Haven, the San Francisco Botanical Garden,',
			// Transit & infrastructure
			'Muni, BART, Caltrain, the N-Judah, the L-Taraval, the K-Ingleside,',
			'the F-Market, cable cars, the 38 Geary, the Transbay Terminal,',
			'Salesforce Transit Center, SFO, Oakland,',
			// Institutions & culture
			'the San Francisco Chronicle, the SF Examiner, KQED, KALW,',
			'SF State, UCSF, USF, City College, the Board of Supervisors,',
			'the Giants, the 49ers, the Warriors, Chase Center,',
			// Food & drink culture
			'sourdough, cioppino, Mission burrito, Irish coffee, Dungeness crab,',
			'dim sum, boba, the Ferry Plaza Farmers Market,',
			// Weather & geography
			'Karl the Fog, fog, microclimates, the Bay, the Pacific,',
			'Marin, the East Bay, the Peninsula, Silicon Valley,',
			// Common SF topics
			'tech, gentrification, rent control, the housing crisis, NIMBYism, YIMBYism,',
			'the Summer of Love, the Beat Generation, Burning Man, Suldrew,',
		].join(' '),
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
