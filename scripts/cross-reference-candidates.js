#!/usr/bin/env node
/**
 * cross-reference-candidates.js
 *
 * Matches candidate place names (from scripts/candidates/all.json) against
 * all 571 local transcript JSON files, then optionally verifies matches via
 * GPT-4o-mini.
 *
 * Usage:
 *   OPENAI_API_KEY=... node scripts/cross-reference-candidates.js
 *
 * Options:
 *   --skip-verify   Output all text matches without LLM verification
 *   --resume        Resume from checkpoint (skip already-processed candidates)
 */

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CANDIDATES_PATH = path.join(__dirname, 'candidates', 'all.json');
const TRANSCRIPTS_DIR = path.join(__dirname, '..', 'transcripts');
const OUTPUT_PATH = path.join(__dirname, 'verified_places.json');
const CHECKPOINT_PATH = path.join(__dirname, '.crossref-checkpoint.json');

const SKIP_VERIFY = process.argv.includes('--skip-verify');
const RESUME = process.argv.includes('--resume');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!SKIP_VERIFY && !OPENAI_API_KEY) {
	console.error('OPENAI_API_KEY required (or use --skip-verify)');
	process.exit(1);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Regex helpers
// ---------------------------------------------------------------------------

function escapeRegex(str) {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildWordBoundaryRegex(name) {
	return new RegExp('\\b' + escapeRegex(name) + '\\b', 'i');
}

// ---------------------------------------------------------------------------
// Phase 1: Load all transcripts into memory
// ---------------------------------------------------------------------------

function loadTranscripts() {
	const files = fs.readdirSync(TRANSCRIPTS_DIR).filter(f => f.endsWith('.json'));
	console.log(`Loading ${files.length} transcripts...`);

	const transcripts = [];
	for (const file of files) {
		try {
			const raw = fs.readFileSync(path.join(TRANSCRIPTS_DIR, file), 'utf8');
			const data = JSON.parse(raw);
			const segments = data.segments || [];
			const fullTextLower = segments.map(s => s.text || '').join(' ').toLowerCase();
			const episodeId = path.basename(file, '.json');
			transcripts.push({ id: episodeId, segments, fullTextLower });
		} catch (err) {
			console.warn(`  Warning: could not load ${file}: ${err.message}`);
		}
	}

	console.log(`  Loaded ${transcripts.length} transcripts.\n`);
	return transcripts;
}

// ---------------------------------------------------------------------------
// Phase 2: Text search — find candidates that appear in any transcript
// ---------------------------------------------------------------------------

function searchTranscripts(candidates, transcripts) {
	console.log(`Searching ${candidates.length} candidates across ${transcripts.length} transcripts...`);

	const textMatches = []; // candidates with at least one transcript hit

	for (let i = 0; i < candidates.length; i++) {
		const candidate = candidates[i];
		const nameLower = candidate.name.toLowerCase();

		// Quick filter: substring check against concatenated lowercased text
		const matchingTranscripts = transcripts.filter(t => t.fullTextLower.includes(nameLower));
		if (matchingTranscripts.length === 0) continue;

		// Build word-boundary regex for precise segment-level matching
		const regex = buildWordBoundaryRegex(candidate.name);
		const episodeMatches = [];

		for (const transcript of matchingTranscripts) {
			const mentions = [];
			for (const seg of transcript.segments) {
				if (regex.test(seg.text)) {
					mentions.push({
						start_ms: seg.start_ms,
						end_ms: seg.end_ms,
						context: seg.text,
					});
				}
			}
			if (mentions.length > 0) {
				episodeMatches.push({ episode_id: transcript.id, mentions });
			}
		}

		if (episodeMatches.length > 0) {
			textMatches.push({ candidate, episodes: episodeMatches });
		}

		if ((i + 1) % 500 === 0) {
			console.log(`  Searched ${i + 1}/${candidates.length} candidates — ${textMatches.length} matches so far`);
		}
	}

	console.log(`  Text search complete: ${textMatches.length} candidates matched.\n`);
	return textMatches;
}

// ---------------------------------------------------------------------------
// Phase 3: LLM verification via GPT-4o-mini
// ---------------------------------------------------------------------------

function callOpenAI(messages) {
	return new Promise((resolve, reject) => {
		const body = JSON.stringify({
			model: 'gpt-4o-mini',
			messages,
			temperature: 0,
			max_tokens: 1500,
		});

		const req = https.request(
			{
				hostname: 'api.openai.com',
				path: '/v1/chat/completions',
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${OPENAI_API_KEY}`,
					'Content-Length': Buffer.byteLength(body),
				},
			},
			res => {
				let data = '';
				res.on('data', chunk => data += chunk);
				res.on('end', () => {
					try {
						const json = JSON.parse(data);
						if (json.error) {
							reject(new Error(`OpenAI error: ${json.error.message}`));
						} else {
							resolve(json.choices[0].message.content.trim());
						}
					} catch (e) {
						reject(new Error(`JSON parse error: ${e.message} — raw: ${data.slice(0, 200)}`));
					}
				});
			}
		);
		req.on('error', reject);
		req.write(body);
		req.end();
	});
}

/**
 * Verify a batch of up to 10 text-matched candidates via a single LLM call.
 * Returns an array of booleans (true = YES, false = NO) aligned to the batch.
 */
async function verifyBatch(batch) {
	const systemPrompt = `You are verifying transcript excerpts from "Roll Over Easy," a San Francisco local radio show. For each numbered item, decide whether the speaker is clearly referring to that specific place.

Reply with one line per item in this exact format:
1. YES - reason
2. NO - reason
...

Use YES if the speaker is clearly referring to that specific named place (restaurant, bar, venue, landmark, etc.).
Use NO if it is a coincidental word match, a person's name, a different place with a similar name, or the reference is ambiguous.`;

	const lines = batch.map((item, idx) => {
		const { candidate, sampleContext } = item;
		const desc = candidate.address
			? `${candidate.name} (${candidate.category || 'place'} at ${candidate.address})`
			: `${candidate.name} (${candidate.category || 'place'})`;
		return `${idx + 1}. Name: "${desc}"\n   Transcript: "${sampleContext}"\n   Is the speaker referring to this specific place?`;
	});

	const userPrompt = lines.join('\n\n');

	const response = await callOpenAI([
		{ role: 'system', content: systemPrompt },
		{ role: 'user', content: userPrompt },
	]);

	// Parse response: look for lines matching ^\d+\.\s*(YES|NO)
	const verdicts = new Array(batch.length).fill(false);
	for (const line of response.split('\n')) {
		const m = line.match(/^(\d+)\.\s*(YES|NO)/i);
		if (m) {
			const idx = parseInt(m[1], 10) - 1;
			if (idx >= 0 && idx < batch.length) {
				verdicts[idx] = m[2].toUpperCase() === 'YES';
			}
		}
	}

	return verdicts;
}

/**
 * Verify text matches via LLM. Calls onCheckpoint(verified) every 50 confirmed
 * matches so the caller can persist progress incrementally.
 */
async function verifyMatches(textMatches, onCheckpoint) {
	console.log(`LLM verifying ${textMatches.length} text matches in batches of 10...`);

	const verified = [];
	const BATCH_SIZE = 10;
	let sinceLastCheckpoint = 0;

	for (let i = 0; i < textMatches.length; i += BATCH_SIZE) {
		const batch = textMatches.slice(i, i + BATCH_SIZE).map(m => ({
			candidate: m.candidate,
			episodes: m.episodes,
			// Use the context from the very first mention of the first episode
			sampleContext: m.episodes[0].mentions[0].context,
		}));

		let verdicts;
		try {
			verdicts = await verifyBatch(batch);
		} catch (err) {
			console.warn(`\n  LLM batch ${i}-${i + BATCH_SIZE} failed: ${err.message} — skipping batch`);
			// On error, skip rather than silently include
			verdicts = new Array(batch.length).fill(false);
		}

		for (let j = 0; j < batch.length; j++) {
			if (verdicts[j]) {
				verified.push({ match: batch[j], episodes: batch[j].episodes });
				sinceLastCheckpoint++;
			}
		}

		// Checkpoint every 50 verified candidates
		if (sinceLastCheckpoint >= 50) {
			onCheckpoint(verified);
			sinceLastCheckpoint = 0;
		}

		process.stdout.write(`\r  LLM: ${Math.min(i + BATCH_SIZE, textMatches.length)}/${textMatches.length} verified — ${verified.length} confirmed`);

		// 200ms sleep between batches to be respectful of rate limits
		if (i + BATCH_SIZE < textMatches.length) {
			await sleep(200);
		}
	}

	console.log('');
	return verified;
}

// ---------------------------------------------------------------------------
// Checkpoint helpers
// ---------------------------------------------------------------------------

function saveCheckpoint(processed, matches) {
	fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify({ processed: [...processed], matches }, null, 2));
}

function loadCheckpoint() {
	if (!fs.existsSync(CHECKPOINT_PATH)) return null;
	try {
		return JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf8'));
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Build output record from a verified or text-matched candidate
// ---------------------------------------------------------------------------

function buildOutputRecord(candidate, episodes, confidence) {
	const totalMentions = episodes.reduce((sum, ep) => sum + ep.mentions.length, 0);
	return {
		name: candidate.name,
		lat: candidate.lat,
		lng: candidate.lng,
		address: candidate.address || null,
		source: candidate.source,
		sources: candidate.sources,
		category: candidate.category || null,
		confidence,
		episode_count: episodes.length,
		total_mentions: totalMentions,
		episodes,
	};
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	// Load candidates
	if (!fs.existsSync(CANDIDATES_PATH)) {
		console.error(`Candidates file not found: ${CANDIDATES_PATH}`);
		console.error('Run scripts/candidates/merge-candidates.js first.');
		process.exit(1);
	}

	const { candidates } = JSON.parse(fs.readFileSync(CANDIDATES_PATH, 'utf8'));
	console.log(`Loaded ${candidates.length} candidates from all.json\n`);

	// Load checkpoint if resuming
	let processedNames = new Set();
	let matches = [];

	if (RESUME) {
		const checkpoint = loadCheckpoint();
		if (checkpoint) {
			processedNames = new Set(checkpoint.processed || []);
			matches = checkpoint.matches || [];
			console.log(`Resuming from checkpoint: ${processedNames.size} already processed, ${matches.length} confirmed matches so far\n`);
		} else {
			console.log('No checkpoint found — starting fresh\n');
		}
	}

	// Phase 1: Load transcripts
	const transcripts = loadTranscripts();

	// Filter out already-processed candidates when resuming
	const remainingCandidates = RESUME
		? candidates.filter(c => !processedNames.has(c.normalizedName))
		: candidates;

	if (RESUME && remainingCandidates.length < candidates.length) {
		console.log(`Skipping ${candidates.length - remainingCandidates.length} already-processed candidates\n`);
	}

	// Phase 2: Text search
	const textMatches = searchTranscripts(remainingCandidates, transcripts);

	if (textMatches.length === 0) {
		console.log('No text matches found.');
	}

	// Phase 3: LLM verification (or pass-through with --skip-verify)
	let newMatches = [];

	if (SKIP_VERIFY) {
		console.log('--skip-verify: skipping LLM verification, including all text matches.\n');
		for (const m of textMatches) {
			newMatches.push(buildOutputRecord(m.candidate, m.episodes, 'text_match'));
		}
	} else if (textMatches.length > 0) {
		// Checkpoint callback: save incremental progress every 50 confirmed matches
		const onCheckpoint = (verified) => {
			const currentNewMatches = verified.map(({ match, episodes }) =>
				buildOutputRecord(match.candidate, episodes, 'llm_verified')
			);
			const currentProcessedNames = new Set([
				...processedNames,
				...textMatches.map(m => m.candidate.normalizedName),
			]);
			saveCheckpoint(currentProcessedNames, [...matches, ...currentNewMatches]);
		};

		const verified = await verifyMatches(textMatches, onCheckpoint);
		console.log(`\n  ${verified.length}/${textMatches.length} candidates confirmed by LLM.\n`);

		for (const { match, episodes } of verified) {
			newMatches.push(buildOutputRecord(match.candidate, episodes, 'llm_verified'));
		}
	}

	// Accumulate new matches into the running list (from checkpoint or fresh)
	matches = [...matches, ...newMatches];

	// For --skip-verify, save a checkpoint so resume is possible if interrupted
	if (SKIP_VERIFY) {
		const allProcessed = new Set([
			...processedNames,
			...remainingCandidates.map(c => c.normalizedName),
		]);
		saveCheckpoint(allProcessed, matches);
	}

	// Sort by total_mentions descending
	matches.sort((a, b) => b.total_mentions - a.total_mentions);

	// Write final output
	const output = { matches };
	fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));

	// Delete checkpoint on successful completion
	if (fs.existsSync(CHECKPOINT_PATH)) {
		fs.unlinkSync(CHECKPOINT_PATH);
	}

	// Summary
	const llmVerified = matches.filter(m => m.confidence === 'llm_verified').length;
	const textMatchOnly = matches.filter(m => m.confidence === 'text_match').length;
	console.log('Results:');
	console.log(`  Total confirmed: ${matches.length}`);
	if (!SKIP_VERIFY) {
		console.log(`  LLM verified:   ${llmVerified}`);
	} else {
		console.log(`  Text matches:   ${textMatchOnly}`);
	}
	console.log(`\nTop 20 by total mentions:`);
	for (const m of matches.slice(0, 20)) {
		console.log(`  ${m.total_mentions}x across ${m.episode_count} eps — ${m.name} [${m.confidence}]`);
	}
	console.log(`\nOutput saved to ${OUTPUT_PATH}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
