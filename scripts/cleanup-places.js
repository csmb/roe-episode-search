#!/usr/bin/env node
/**
 * cleanup-places.js
 *
 * Re-verifies existing D1 places and removes false positives, in two runs.
 *
 * 1. The dry run (no --apply) writes scripts/cleanup_report.json:
 *    Phase 1: Stoplist check — flag places whose name is in the stoplist or ≤ 2 chars.
 *    Phase 2: LLM verification — GPT-4o-mini decides KEEP or REMOVE for remaining places.
 *    It changes nothing, and needs OPENAI_API_KEY (read from .env).
 * 2. --apply deletes exactly the places listed in that report, with their
 *    links and narratives: edit the report first to keep any of them. It asks
 *    GPT nothing (so needs no key), refuses if any listed place was renamed or
 *    removed since the report, and first backs up every row it deletes, with
 *    undo SQL, in transcripts/.backups/<date>-cleanup-places/.
 *
 * Usage:
 *   node scripts/cleanup-places.js [--local]            # dry run: writes the report
 *   node scripts/cleanup-places.js --apply [--local]    # deletes what the report lists
 */

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { loadEnv, queryJSON, runSQL } from './lib.js';
import { newBackupDir, insertStatement } from './episode-backup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRANSCRIPTS_DIR = path.join(__dirname, '..', 'transcripts');
const REPORT_PATH = path.join(__dirname, 'cleanup_report.json');

const args = process.argv.slice(2);
const unknown = args.filter((a) => a !== '--apply' && a !== '--local');
if (unknown.length > 0) {
	console.error(`Unknown option: ${unknown.join(' ')}\n`);
	console.error('Usage: node scripts/cleanup-places.js [--apply] [--local]');
	process.exit(1);
}
const APPLY = args.includes('--apply');
const TARGET = { isLocal: args.includes('--local') };
const DATABASE = TARGET.isLocal ? 'local' : 'production';

loadEnv();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Stoplist — copied from scripts/archive/candidates/merge-candidates.js (retired)
// ---------------------------------------------------------------------------

const STOPLIST = new Set([
	'the page', 'amber', 'grace', 'maven', 'slate', 'the social', 'the vault',
	'the mint', 'urban', 'nova', 'the ramp', 'sage', 'the corner', 'local',
	'the plant', 'the mill', 'the grove', 'the square', 'bon', 'reed',
	'the den', 'the net', 'rogue', 'the marsh', 'the line', 'the center',
	'the shop', 'the bar', 'haven', 'the hall', 'the bay', 'native', 'pearl',
	// 'the independent' deliberately NOT listed — it's a real SF music venue
	'the start', 'standard', 'the market', 'noble',
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
// Dry run: write the report
// ---------------------------------------------------------------------------

async function writeReport() {
	if (!OPENAI_API_KEY) {
		console.error('OPENAI_API_KEY is required for the dry run (--apply needs none)');
		process.exit(1);
	}

	// Step 1: Fetch all places with episode counts
	console.log(`Fetching places from the ${DATABASE} D1 database...`);
	const places = queryJSON(`
		SELECT p.id, p.name, COUNT(pm.episode_id) as ep_count
		FROM places p
		LEFT JOIN place_mentions pm ON pm.place_id = p.id
		GROUP BY p.id
		ORDER BY ep_count DESC
	`, TARGET);
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

	// Step 4: Write report (what --apply will delete)
	const report = {
		generated: new Date().toISOString(),
		database: DATABASE,
		toRemove,
		total: toRemove.length,
	};
	fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
	console.log(`\nReport written to ${REPORT_PATH}`);

	// Print top 20 and instructions
	console.log(`\nTop 20 places to remove:`);
	for (const r of toRemove.slice(0, 20)) {
		console.log(`  [${r.episodes} ep] ${r.name} — ${r.reason}`);
	}
	if (toRemove.length > 20) {
		console.log(`  ... and ${toRemove.length - 20} more (see cleanup_report.json)`);
	}
	console.log('\nCheck the report (delete any entry you want to keep), then delete exactly what it lists with:');
	console.log(`  node scripts/cleanup-places.js --apply${TARGET.isLocal ? ' --local' : ''}`);
}

// ---------------------------------------------------------------------------
// --apply: delete exactly what the report lists
// ---------------------------------------------------------------------------

const ID_BATCH = 20;

function idBatches(ids) {
	const batches = [];
	for (let i = 0; i < ids.length; i += ID_BATCH) batches.push(ids.slice(i, i + ID_BATCH).join(', '));
	return batches;
}

function applyReport() {
	if (!fs.existsSync(REPORT_PATH)) throw new Error(`No report at ${REPORT_PATH}: run the dry run first`);
	const report = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf-8'));
	if (!Array.isArray(report.toRemove)) throw new Error(`${REPORT_PATH} has no toRemove list`);
	if (report.database && report.database !== DATABASE) {
		throw new Error(`The report was made from the ${report.database} database, not the ${DATABASE} one`);
	}

	// ids come from D1 (integer PKs), but check them before splicing into SQL
	const names = new Map();
	for (const entry of report.toRemove) {
		const id = Number(entry.id);
		if (!Number.isInteger(id) || id <= 0 || typeof entry.name !== 'string') {
			throw new Error(`Refusing: bad entry in the report: ${JSON.stringify(entry)}`);
		}
		names.set(id, entry.name);
	}
	const ids = [...names.keys()];
	console.log(`The report (${report.generated ?? 'undated'}) lists ${ids.length} place(s) to remove.`);
	if (ids.length === 0) return;

	// Every listed place must still be there, under the same name
	const now = new Map();
	for (const list of idBatches(ids)) {
		for (const row of queryJSON(`SELECT id, name FROM places WHERE id IN (${list})`, TARGET)) now.set(row.id, row.name);
	}
	const changed = ids.filter((id) => now.get(id) !== names.get(id));
	if (changed.length > 0) {
		console.error(`\nRefusing: ${changed.length} place(s) changed since the report:`);
		for (const id of changed) {
			console.error(`  ${id}: "${names.get(id)}" in the report, ${now.has(id) ? `"${now.get(id)}" now` : 'no longer there'}`);
		}
		console.error('Nothing was deleted. Run the dry run again for a fresh report.');
		process.exit(1);
	}

	// Back up every row that will go, with undo SQL
	const rows = { places: [], place_mentions: [], place_narratives: [] };
	for (const list of idBatches(ids)) {
		rows.places.push(...queryJSON(`SELECT * FROM places WHERE id IN (${list}) ORDER BY id`, TARGET));
		rows.place_mentions.push(...queryJSON(`SELECT * FROM place_mentions WHERE place_id IN (${list}) ORDER BY place_id, episode_id`, TARGET));
		rows.place_narratives.push(...queryJSON(`SELECT * FROM place_narratives WHERE place_id IN (${list}) ORDER BY place_id`, TARGET));
	}
	const deletes = [];
	for (const table of ['place_mentions', 'place_narratives', 'places']) {
		const column = table === 'places' ? 'id' : 'place_id';
		for (const list of idBatches(ids)) deletes.push(`DELETE FROM ${table} WHERE ${column} IN (${list});`);
	}
	const undo = [
		'-- Puts back what cleanup-places.js --apply deleted: the places, then their links, then narratives.',
		...rows.places.map((r) => insertStatement('places', r, 'INSERT OR IGNORE')),
		...rows.place_mentions.map((r) => insertStatement('place_mentions', r, 'INSERT OR IGNORE')),
		...rows.place_narratives.map((r) => insertStatement('place_narratives', r, 'INSERT OR IGNORE')),
	];
	const dir = newBackupDir('cleanup-places');
	fs.writeFileSync(path.join(dir, 'rows.json'), JSON.stringify(rows, null, 1));
	fs.writeFileSync(path.join(dir, 'cleanup_report.json'), JSON.stringify(report, null, 2));
	fs.writeFileSync(path.join(dir, 'applied.sql'), deletes.join('\n') + '\n');
	fs.writeFileSync(path.join(dir, 'undo.sql'), undo.join('\n') + '\n');
	fs.writeFileSync(path.join(dir, 'README.txt'), [
		`Places deleted by cleanup-places.js --apply, ${new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}, ` +
			`from the ${DATABASE} D1 database.`,
		`The list is scripts/cleanup_report.json as it was then (made ${report.generated ?? 'at an unknown time'}); a copy is here.`,
		'',
		`  rows.json    every deleted row: ${rows.places.length} places, ${rows.place_mentions.length} place_mentions, ` +
			`${rows.place_narratives.length} place_narratives`,
		'  applied.sql  exactly what was run',
		'  undo.sql     puts them all back (INSERT OR IGNORE with every column as it was)',
		'',
		'To undo:',
		'  cd roe-search',
		`  env -u CLOUDFLARE_API_TOKEN npx wrangler d1 execute roe-episodes ${TARGET.isLocal ? '--local' : '--remote'} --file "${path.join(dir, 'undo.sql')}"`,
		'',
	].join('\n'));
	console.log(`Backed up ${rows.places.length} places, ${rows.place_mentions.length} links and ` +
		`${rows.place_narratives.length} narratives to ${dir}`);

	// Delete, stopping at the first error (the backup has every row)
	for (const sql of deletes) runSQL(sql, TARGET);
	console.log(`Deleted ${ids.length} places with their links and narratives (applied.sql).`);
}

if (APPLY) {
	try {
		applyReport();
	} catch (err) {
		console.error('Fatal:', err.message);
		process.exit(1);
	}
} else {
	writeReport().catch(err => { console.error('Fatal:', err); process.exit(1); });
}
