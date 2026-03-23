#!/usr/bin/env node
/**
 * cross-reference.js
 *
 * Matches harvested SF business names against the local transcript FTS5 index.
 * Uses tiered confidence: high-confidence matches pass through, ambiguous ones
 * get verified by GPT-4o-mini.
 *
 * Usage:
 *   OPENAI_API_KEY=... node --experimental-sqlite scripts/cross-reference.js
 *
 * Options:
 *   --skip-llm    Skip LLM verification (output all FTS matches as-is)
 *   --resume      Resume from last checkpoint
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIZ_DB_PATH = path.join(__dirname, 'sf_businesses.db');
const INDEX_DB_PATH = path.join(__dirname, 'transcript_index.db');
const BLOCKLIST_PATH = path.join(__dirname, 'common-words-blocklist.json');
const OUTPUT_PATH = path.join(__dirname, 'business_matches.json');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SKIP_LLM = process.argv.includes('--skip-llm');
const RESUME = process.argv.includes('--resume');

if (!SKIP_LLM && !OPENAI_API_KEY) {
	console.error('OPENAI_API_KEY required (or use --skip-llm)');
	process.exit(1);
}

// Food/drink/culture keywords that boost confidence
const FOOD_KEYWORDS = [
	'cafe', 'café', 'coffee', 'bakery', 'restaurant', 'bar', 'grill', 'pizza',
	'taqueria', 'brewery', 'brewing', 'deli', 'bistro', 'kitchen', 'eatery',
	'tavern', 'pub', 'saloon', 'lounge', 'cocktail', 'wine', 'beer', 'ice cream',
	'gelato', 'donut', 'bagel', 'burrito', 'taco', 'sushi', 'ramen', 'noodle',
	'dim sum', 'dumpling', 'pho', 'thai', 'diner', 'brunch', 'roast', 'roaster',
	'bookstore', 'books', 'records', 'vinyl', 'gallery', 'theater', 'theatre',
	'music', 'club', 'venue', 'market', 'grocer', 'butcher', 'fish', 'seafood',
];

// Corporate suffixes to skip
const CORP_SUFFIXES = [
	' llc', ' inc', ' inc.', ' corp', ' corp.', ' ltd', ' ltd.', ' llp',
	' lp', ' co.', ' pllc', ' pc', ' p.c.', ' dba', ' gp',
];

function loadBlocklist() {
	return new Set(JSON.parse(fs.readFileSync(BLOCKLIST_PATH, 'utf8')).map(w => w.toLowerCase()));
}

function stripArticles(name) {
	return name.replace(/^(the|a|an)\s+/i, '').trim();
}

function hasFoodKeyword(name) {
	const lower = name.toLowerCase();
	return FOOD_KEYWORDS.some(kw => lower.includes(kw));
}

function hasCorporateSuffix(name) {
	const lower = name.toLowerCase();
	return CORP_SUFFIXES.some(sfx => lower.endsWith(sfx));
}

function sanitizeFtsQuery(name) {
	// Escape special FTS5 characters and wrap as phrase
	const cleaned = name.replace(/['"*(){}[\]:^~!@#$%&]/g, '').trim();
	if (!cleaned) return null;
	return `"${cleaned}"`;
}

function callGpt(messages) {
	return new Promise((resolve, reject) => {
		const body = JSON.stringify({
			model: 'gpt-4o-mini',
			messages,
			max_tokens: 100,
			temperature: 0,
		});
		const req = https.request({
			hostname: 'api.openai.com',
			path: '/v1/chat/completions',
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${OPENAI_API_KEY}`,
			},
		}, res => {
			let data = '';
			res.on('data', chunk => data += chunk);
			res.on('end', () => {
				try {
					const json = JSON.parse(data);
					if (json.error) reject(new Error(json.error.message));
					else resolve(json.choices[0].message.content.trim());
				} catch (e) { reject(e); }
			});
		});
		req.on('error', reject);
		req.write(body);
		req.end();
	});
}

async function verifyWithLlm(bizName, address, transcriptContext) {
	const prompt = `In this radio show transcript excerpt, is "${bizName}" referring to the San Francisco business${address ? ` at ${address}` : ''}? Or is it a common word/phrase used in a different sense?

Transcript: "${transcriptContext}"

Answer YES if it refers to the SF business, NO if it's just a common word. One sentence explanation.`;

	const response = await callGpt([{ role: 'user', content: prompt }]);
	return response.toUpperCase().startsWith('YES');
}

function getCandidates(bizDb, blocklist) {
	// Get unique business names, deduped by normalized_name
	// Pick one representative row per name (with address for LLM context)
	const rows = bizDb.prepare(`
		SELECT normalized_name, dba_name, address,
			MIN(start_date) as earliest_start, MAX(end_date) as latest_end
		FROM businesses
		GROUP BY normalized_name
	`).all();

	const candidates = [];
	let skipped = { short: 0, corp: 0, blocked: 0 };

	for (const row of rows) {
		const stripped = stripArticles(row.normalized_name);

		// Skip very short names
		if (stripped.length < 4) { skipped.short++; continue; }

		// Skip corporate entities
		if (hasCorporateSuffix(row.normalized_name)) { skipped.corp++; continue; }

		// Skip blocklisted common words (check both full name and stripped)
		if (blocklist.has(row.normalized_name) || blocklist.has(stripped)) { skipped.blocked++; continue; }

		candidates.push({
			normalized_name: row.normalized_name,
			dba_name: row.dba_name,
			address: row.address,
		});
	}

	console.log(`Candidates: ${candidates.length} (skipped: ${skipped.short} short, ${skipped.corp} corp, ${skipped.blocked} blocked)`);
	return candidates;
}

function searchTranscripts(indexDb, ftsQuery) {
	try {
		return indexDb.prepare(`
			SELECT w.episode_id, w.start_ms, w.end_ms, w.text
			FROM windows w
			WHERE w.id IN (
				SELECT rowid FROM windows_fts WHERE windows_fts MATCH ?
			)
			ORDER BY w.episode_id, w.start_ms
		`).all(ftsQuery);
	} catch {
		// FTS5 can throw on certain inputs
		return [];
	}
}

function classifyConfidence(name, episodeCount) {
	const hasFood = hasFoodKeyword(name);

	// Extremely common = almost certainly a common phrase, not a business
	if (episodeCount > 100) return 'skip';
	if (episodeCount > 50 && !hasFood) return 'skip';

	// Food/drink/culture keywords in the name = high confidence
	if (hasFood) return 'high';

	// Everything else needs LLM verification
	return 'medium';
}

async function main() {
	const bizDb = new DatabaseSync(BIZ_DB_PATH);
	const indexDb = new DatabaseSync(INDEX_DB_PATH, { open: true, readOnly: true });
	const blocklist = loadBlocklist();

	// Load checkpoint state if resuming
	let processed = new Set();
	let matches = [];
	if (RESUME && fs.existsSync(OUTPUT_PATH)) {
		const existing = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
		matches = existing.matches || [];
		processed = new Set(matches.map(m => m.normalized_name));
		console.log(`Resuming: ${processed.size} already processed`);
	}

	const candidates = getCandidates(bizDb, blocklist);

	let stats = { total: candidates.length, matched: 0, no_match: 0, llm_verified: 0, llm_rejected: 0, skipped_common: 0 };

	// Phase A: FTS5 matching (fast, no API calls)
	console.log('\nPhase A: FTS5 phrase matching...');
	const ftsMatches = []; // items needing LLM verification
	for (let i = 0; i < candidates.length; i++) {
		const c = candidates[i];
		if (processed.has(c.normalized_name)) continue;

		const ftsQuery = sanitizeFtsQuery(c.normalized_name);
		if (!ftsQuery) { stats.no_match++; continue; }

		const results = searchTranscripts(indexDb, ftsQuery);
		if (!results.length) { stats.no_match++; continue; }

		// Group by episode
		const episodeMap = new Map();
		for (const r of results) {
			if (!episodeMap.has(r.episode_id)) episodeMap.set(r.episode_id, []);
			episodeMap.get(r.episode_id).push({
				start_ms: r.start_ms,
				end_ms: r.end_ms,
				context: r.text.substring(0, 200),
			});
		}

		const episodes = [...episodeMap.entries()].map(([id, mentions]) => ({
			episode_id: id,
			mentions,
		}));

		const confidence = classifyConfidence(c.normalized_name, episodes.length);

		if (confidence === 'skip') {
			stats.skipped_common++;
		} else if (confidence === 'high') {
			stats.matched++;
			matches.push({
				dba_name: c.dba_name,
				normalized_name: c.normalized_name,
				address: c.address,
				confidence: 'high',
				episode_count: episodes.length,
				total_mentions: results.length,
				episodes,
			});
		} else {
			// medium confidence — queue for LLM verification
			ftsMatches.push({
				...c,
				sampleContext: results[0].text,
				episodes,
				total_mentions: results.length,
			});
		}

		if ((i + 1) % 500 === 0 || i === candidates.length - 1) {
			process.stdout.write(`\r  FTS: ${i + 1}/${candidates.length} | High: ${stats.matched} | Need LLM: ${ftsMatches.length} | Skipped: ${stats.skipped_common}`);
		}
	}
	console.log('');

	// Phase B: LLM verification (concurrent batches)
	if (ftsMatches.length && !SKIP_LLM) {
		console.log(`\nPhase B: LLM verifying ${ftsMatches.length} ambiguous matches...`);
		const CONCURRENCY = 8;
		for (let i = 0; i < ftsMatches.length; i += CONCURRENCY) {
			const batch = ftsMatches.slice(i, i + CONCURRENCY);
			const results = await Promise.allSettled(
				batch.map(m => verifyWithLlm(m.dba_name, m.address, m.sampleContext))
			);

			for (let j = 0; j < batch.length; j++) {
				const m = batch[j];
				const r = results[j];
				if (r.status === 'fulfilled' && r.value) {
					stats.llm_verified++;
					matches.push({
						dba_name: m.dba_name,
						normalized_name: m.normalized_name,
						address: m.address,
						confidence: 'llm_verified',
						episode_count: m.episodes.length,
						total_mentions: m.total_mentions,
						episodes: m.episodes,
					});
				} else if (r.status === 'fulfilled') {
					stats.llm_rejected++;
				} else {
					// LLM error — keep as unverified
					matches.push({
						dba_name: m.dba_name,
						normalized_name: m.normalized_name,
						address: m.address,
						confidence: 'unverified',
						episode_count: m.episodes.length,
						total_mentions: m.total_mentions,
						episodes: m.episodes,
					});
				}
			}

			// Checkpoint every 100 LLM calls
			if ((i + CONCURRENCY) % 100 < CONCURRENCY) {
				fs.writeFileSync(OUTPUT_PATH, JSON.stringify({ matches, stats }, null, 2));
			}
			process.stdout.write(`\r  LLM: ${Math.min(i + CONCURRENCY, ftsMatches.length)}/${ftsMatches.length} | Verified: ${stats.llm_verified} | Rejected: ${stats.llm_rejected}`);
		}
		console.log('');
	} else if (ftsMatches.length && SKIP_LLM) {
		// --skip-llm: add all as unverified
		for (const m of ftsMatches) {
			matches.push({
				dba_name: m.dba_name,
				normalized_name: m.normalized_name,
				address: m.address,
				confidence: 'unverified',
				episode_count: m.episodes.length,
				total_mentions: m.total_mentions,
				episodes: m.episodes,
			});
		}
	}

	// Final save
	// Sort matches by total mentions descending
	matches.sort((a, b) => b.total_mentions - a.total_mentions);

	fs.writeFileSync(OUTPUT_PATH, JSON.stringify({ matches, stats }, null, 2));

	console.log(`\n\nResults:`);
	console.log(`  Candidates searched: ${stats.total}`);
	console.log(`  Matches found: ${matches.length}`);
	console.log(`  High confidence: ${stats.matched}`);
	console.log(`  LLM verified: ${stats.llm_verified}`);
	console.log(`  LLM rejected: ${stats.llm_rejected}`);
	console.log(`  Skipped (too common): ${stats.skipped_common}`);
	console.log(`  No match: ${stats.no_match}`);
	console.log(`\nTop 20 by mention count:`);
	for (const m of matches.slice(0, 20)) {
		console.log(`  ${m.total_mentions}x across ${m.episode_count} eps — ${m.dba_name} (${m.confidence})`);
	}

	console.log(`\nOutput saved to ${OUTPUT_PATH}`);
	bizDb.close();
	indexDb.close();
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
