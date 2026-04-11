#!/usr/bin/env node
/**
 * cleanup-places.js
 *
 * Re-verifies existing D1 places and removes false positives.
 *
 * Phase 1: Stoplist check — flag places whose name is in the stoplist or ≤ 2 chars.
 * Phase 2: LLM verification — GPT-4o-mini decides KEEP or REMOVE for remaining places.
 *
 * Usage:
 *   OPENAI_API_KEY=... node scripts/cleanup-places.js [--apply]
 *
 *   Without --apply: generates scripts/cleanup_report.json (dry run).
 *   With --apply:    deletes flagged places from D1.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRANSCRIPTS_DIR = path.join(__dirname, '..', 'transcripts');
const REPORT_PATH = path.join(__dirname, 'cleanup_report.json');
const APPLY = process.argv.includes('--apply');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
	console.error('OPENAI_API_KEY is required');
	process.exit(1);
}

// Strip CLOUDFLARE_API_TOKEN so wrangler uses its OAuth login
const wranglerEnv = { ...process.env };
delete wranglerEnv.CLOUDFLARE_API_TOKEN;

function d1(sql) {
	const result = execSync(
		`npx wrangler d1 execute roe-episodes --remote --json --command=${JSON.stringify(sql)}`,
		{ cwd: path.join(__dirname, '..', 'roe-search'), env: wranglerEnv }
	);
	return JSON.parse(result.toString());
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Stoplist — same as scripts/candidates/merge-candidates.js
// ---------------------------------------------------------------------------

const STOPLIST = new Set([
	'the page', 'amber', 'grace', 'maven', 'slate', 'the social', 'the vault',
	'the mint', 'urban', 'nova', 'the ramp', 'sage', 'the corner', 'local',
	'the plant', 'the mill', 'the grove', 'the square', 'bon', 'reed',
	'the den', 'the net', 'rogue', 'the marsh', 'the line', 'the center',
	'the shop', 'the bar', 'haven', 'the hall', 'the bay', 'native', 'pearl',
	'the start', 'standard', 'the independent', 'the market', 'noble',
	'anthony', 'irving', 'lyft', 'uber', 'meta', 'stripe',
]);

// ---------------------------------------------------------------------------
// Known-good SF places — skip LLM verification to save API calls
// ---------------------------------------------------------------------------

const KNOWN_GOOD = new Set([
	'mission district', 'dolores park', 'ocean beach', 'golden gate park',
	'twin peaks', 'bernal hill', 'market street', 'valencia street',
	'ferry building', 'castro', 'haight-ashbury', 'the sunset',
	'inner richmond', 'outer richmond', 'dogpatch', 'soma', 'tenderloin',
	'civic center', 'north beach', 'chinatown', 'presidio', 'lands end',
	'baker beach', 'coit tower', 'transamerica pyramid', 'sutro tower',
	'alamo square',
]);

// ---------------------------------------------------------------------------
// Transcript context search — sequential file-by-file, not loading all at once
// ---------------------------------------------------------------------------

function findContextInTranscripts(placeName) {
	const nameLower = placeName.toLowerCase();
	const regex = new RegExp('\\b' + placeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');

	let files;
	try {
		files = fs.readdirSync(TRANSCRIPTS_DIR).filter(f => f.endsWith('.json'));
	} catch {
		return null;
	}

	for (const file of files) {
		let data;
		try {
			data = JSON.parse(fs.readFileSync(path.join(TRANSCRIPTS_DIR, file), 'utf8'));
		} catch {
			continue;
		}

		const segments = data.segments || [];
		// Quick substring check before regex
		const fullText = segments.map(s => s.text || '').join(' ');
		if (!fullText.toLowerCase().includes(nameLower)) continue;

		for (const seg of segments) {
			if (regex.test(seg.text)) {
				return {
					episode_id: data.episode_id || path.basename(file, '.json'),
					context: seg.text,
				};
			}
		}
	}

	return null;
}

// ---------------------------------------------------------------------------
// OpenAI call via node:https
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
 * Verify a batch of up to 10 places via a single GPT-4o-mini call.
 * Returns an array of 'KEEP' | 'REMOVE' strings aligned to the batch.
 */
async function verifyBatch(batch) {
	const systemPrompt = `You are auditing a database of San Francisco places extracted from radio show transcripts. For each numbered item, decide whether it is a real San Francisco place name that belongs in a places database.

Reply with one line per item in this exact format:
1. KEEP - reason
2. REMOVE - reason
...

Use KEEP if the name is a real SF place (neighborhood, park, street, landmark, restaurant, bar, venue, etc.).
Use REMOVE if the name is a person's name, a generic common word, a company/brand that is not a place, or otherwise not a meaningful place name.`;

	const lines = batch.map((item, idx) => {
		const ctx = item.context
			? `\n   Transcript context: "${item.context}"`
			: '';
		return `${idx + 1}. "${item.name}" (appears in ${item.ep_count} episode${item.ep_count !== 1 ? 's' : ''})${ctx}`;
	});

	const userPrompt = lines.join('\n\n');

	const response = await callOpenAI([
		{ role: 'system', content: systemPrompt },
		{ role: 'user', content: userPrompt },
	]);

	// Parse response: look for lines matching ^\d+\.\s*(KEEP|REMOVE)
	const verdicts = new Array(batch.length).fill('KEEP');
	for (const line of response.split('\n')) {
		const m = line.match(/^(\d+)\.\s*(KEEP|REMOVE)/i);
		if (m) {
			const idx = parseInt(m[1], 10) - 1;
			if (idx >= 0 && idx < batch.length) {
				verdicts[idx] = m[2].toUpperCase();
			}
		}
	}

	return verdicts;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	// Step 1: Fetch all places with episode counts
	console.log('Fetching places from D1...');
	const rows = d1(`
		SELECT p.id, p.name, COUNT(pm.episode_id) as ep_count
		FROM places p
		LEFT JOIN place_mentions pm ON pm.place_id = p.id
		GROUP BY p.id
		ORDER BY ep_count DESC
	`);
	const places = rows[0]?.results || [];
	console.log(`${places.length} places in D1`);

	// Step 2: Phase 1 — Stoplist check
	const toRemove = [];   // { id, name, episodes: ep_count, reason }
	const toVerify = [];   // { id, name, ep_count } — candidates for LLM check
	let knownGoodCount = 0;

	for (const place of places) {
		const lower = place.name.toLowerCase();

		if (place.name.length <= 2) {
			toRemove.push({ id: place.id, name: place.name, episodes: place.ep_count, reason: 'name too short (≤2 chars)' });
			continue;
		}

		if (STOPLIST.has(lower)) {
			toRemove.push({ id: place.id, name: place.name, episodes: place.ep_count, reason: 'stoplist word' });
			continue;
		}

		if (KNOWN_GOOD.has(lower)) {
			knownGoodCount++;
			continue;
		}

		toVerify.push({ id: place.id, name: place.name, ep_count: place.ep_count });
	}

	console.log(`Phase 1: ${toRemove.length} flagged by stoplist, ${knownGoodCount} known-good skipped, ${toVerify.length} to LLM-verify`);

	// Step 3: Phase 2 — LLM verification for remaining places
	console.log(`\nPhase 2: LLM-verifying ${toVerify.length} places in batches of 10...`);
	const BATCH_SIZE = 10;

	for (let i = 0; i < toVerify.length; i += BATCH_SIZE) {
		const batch = toVerify.slice(i, i + BATCH_SIZE);

		// For each place in batch, find a transcript context sample
		for (const item of batch) {
			const hit = findContextInTranscripts(item.name);
			item.context = hit ? hit.context : null;
		}

		let verdicts;
		try {
			verdicts = await verifyBatch(batch);
		} catch (err) {
			console.warn(`\n  LLM batch ${i}-${i + BATCH_SIZE} failed: ${err.message} — keeping all in batch`);
			verdicts = new Array(batch.length).fill('KEEP');
		}

		for (let j = 0; j < batch.length; j++) {
			if (verdicts[j] === 'REMOVE') {
				toRemove.push({
					id: batch[j].id,
					name: batch[j].name,
					episodes: batch[j].ep_count,
					reason: 'llm: not a real SF place',
				});
			}
		}

		process.stdout.write(`\r  LLM: ${Math.min(i + BATCH_SIZE, toVerify.length)}/${toVerify.length} checked — ${toRemove.length} total to remove`);

		if (i + BATCH_SIZE < toVerify.length) {
			await sleep(200);
		}
	}
	console.log('');

	// Step 4: Write report
	const report = {
		toRemove,
		total: toRemove.length,
	};
	fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
	console.log(`\nReport written to ${REPORT_PATH}`);

	if (!APPLY) {
		// Dry run: print top 20 and instructions
		console.log(`\nTop 20 places to remove:`);
		for (const r of toRemove.slice(0, 20)) {
			console.log(`  [${r.episodes} ep] ${r.name} — ${r.reason}`);
		}
		if (toRemove.length > 20) {
			console.log(`  ... and ${toRemove.length - 20} more (see cleanup_report.json)`);
		}
		console.log(`\nTo apply deletions, re-run with --apply:`);
		console.log(`  OPENAI_API_KEY=... node scripts/cleanup-places.js --apply`);
		return;
	}

	// Step 5: Apply deletions
	if (toRemove.length === 0) {
		console.log('Nothing to remove.');
		return;
	}

	const ids = toRemove.map(r => r.id);
	const BATCH = 20;

	console.log(`\nDeleting place_mentions for ${ids.length} places...`);
	for (let i = 0; i < ids.length; i += BATCH) {
		const chunk = ids.slice(i, i + BATCH);
		const idList = chunk.join(', ');
		try {
			d1(`DELETE FROM place_mentions WHERE place_id IN (${idList})`);
		} catch (err) {
			console.error(`  Delete mentions error: ${err.message}`);
		}
		process.stdout.write(`\r  Mentions deleted: ${Math.min(i + BATCH, ids.length)}/${ids.length}`);
	}
	console.log('');

	console.log(`Deleting ${ids.length} places...`);
	for (let i = 0; i < ids.length; i += BATCH) {
		const chunk = ids.slice(i, i + BATCH);
		const idList = chunk.join(', ');
		try {
			d1(`DELETE FROM places WHERE id IN (${idList})`);
		} catch (err) {
			console.error(`  Delete places error: ${err.message}`);
		}
		process.stdout.write(`\r  Places deleted: ${Math.min(i + BATCH, ids.length)}/${ids.length}`);
	}
	console.log('\nDone!');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
