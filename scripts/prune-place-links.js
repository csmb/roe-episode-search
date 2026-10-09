#!/usr/bin/env node
/**
 * Remove map links (place_mentions) whose show never names the place, as the
 * pipeline's own check decides (placesInTranscript in roe-pipeline/src/places.js:
 * whole words, "Dolores" for Dolores Park but not "Golden Gate Bridge" for Golden
 * Gate Park). The old map build linked places from business lists, and GPT
 * sometimes names a place a show never mentions; the pin then lists that show.
 *
 *   node scripts/prune-place-links.js                                  plan (read-only)
 *   node scripts/prune-place-links.js --apply <plan.json>              what --yes would remove
 *   node scripts/prune-place-links.js --apply <plan.json> --yes        remove it, backed up
 *   --local        the local D1 copy (in a test run, the one under ROE_PERSIST_TO)
 *
 * The plan reads every link and every linked show's lines from D1 and writes
 * transcripts/.backups/<date>-place-links-plan/: plan.json (one entry per link to
 * remove: place, show, the line the old check matched if any) and review.md. Take
 * entries out of plan.json to keep those links, then --apply it. --apply removes a
 * link only while its place still has the name the plan read, then each place left
 * with no link and its narrative. It backs every row up first (<date>-place-links/:
 * rows.json, applied.sql, undo.sql, README.txt), runs one D1 import, and checks.
 * A place that keeps some links keeps its narrative as it was (regenerating it is
 * a paid GPT call, left to redo-places.js or the pipeline).
 */

import fs from 'node:fs';
import path from 'node:path';

import { escapeSQL, loadEnv, parseFlags, queryJSON, runSQLFile } from './lib.js';
import { placesInTranscript } from '../roe-pipeline/src/places.js';
import { mentionsPlace, placeMatchVariants } from '../roe-pipeline/src/sentiment.js';
import { insertStatement, newBackupDir } from './episode-backup.js';
import { inlineParams } from './remote-d1.js';
import { dateOf, episodeLines } from './repaired-episodes.js';

const USAGE = [
	'Usage: node scripts/prune-place-links.js [--local]',
	'       node scripts/prune-place-links.js --apply <plan.json> [--yes] [--local]',
].join('\n');
const ID_BATCH = 90; // place ids per IN list, under D1's 100 bound parameters
const EPISODE_ID = /^roll-over-easy_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/;

/**
 * The links whose show's lines never name their place, each with the first line
 * the old substring check would have matched (hint, hint_ms), or null. A show
 * with no lines is left alone: there is nothing to check it against.
 * @param {Array<{place_id: number, name: string, episode_id: string}>} links
 * @param {Map<string, Array<{start_ms: number, text: string}>>} lines
 */
export function linksToPrune(links, lines) {
	const texts = new Map();
	const out = [];
	for (const link of links) {
		const own = lines.get(link.episode_id) ?? [];
		if (own.length === 0) continue;
		if (!texts.has(link.episode_id)) texts.set(link.episode_id, own.map((l) => l.text).join(' '));
		if (placesInTranscript([link.name], texts.get(link.episode_id)).length > 0) continue;
		// Scored before the archive repair: its quote names the place, though the new lines spell it otherwise
		if (link.snippet && mentionsPlace(link.snippet, link.name)) continue;
		const variants = placeMatchVariants(link.name);
		const hit = own.find((l) => variants.some((v) => l.text.toLowerCase().includes(v)));
		out.push({ ...link, hint: hit ? hit.text : null, hint_ms: hit ? hit.start_ms : null });
	}
	return out;
}

function checkEntries(entries) {
	for (const e of entries) {
		if (!Number.isInteger(e.place_id) || e.place_id <= 0 || !EPISODE_ID.test(e.episode_id ?? '') || typeof e.name !== 'string') {
			throw new Error(`Refusing: bad entry in the plan: ${JSON.stringify(e)}`);
		}
	}
}

function idBatches(entries) {
	const ids = [...new Set(entries.map((e) => e.place_id))].sort((a, b) => a - b);
	const batches = [];
	for (let i = 0; i < ids.length; i += ID_BATCH) batches.push(ids.slice(i, i + ID_BATCH).join(', '));
	return batches;
}

/** The SELECTs that read every row --apply may remove: the touched places, all their links, their narratives. */
export function backupQueries(entries) {
	checkEntries(entries);
	const batches = idBatches(entries);
	return {
		place_mentions: batches.map((list) => `SELECT * FROM place_mentions WHERE place_id IN (${list}) ORDER BY place_id, episode_id`),
		places: batches.map((list) => `SELECT * FROM places WHERE id IN (${list}) ORDER BY id`),
		place_narratives: batches.map((list) => `SELECT * FROM place_narratives WHERE place_id IN (${list}) ORDER BY place_id`),
	};
}

// INSERT OR IGNORE of one row, its place found by name; a link only while its episode exists
function undoByName(table, row, placeName) {
	const cols = Object.keys(row).filter((c) => c !== 'place_id');
	const hasEpisode = cols.includes('episode_id');
	return inlineParams(
		`INSERT OR IGNORE INTO ${table} (place_id, ${cols.join(', ')}) SELECT id, ${cols.map(() => '?').join(', ')} ` +
			`FROM places WHERE name = ?${hasEpisode ? ' AND EXISTS (SELECT 1 FROM episodes WHERE id = ?)' : ''};`,
		[...cols.map((c) => row[c]), placeName, ...(hasEpisode ? [row.episode_id] : [])]
	);
}

/**
 * The SQL that removes the listed links (each only while its place keeps the
 * name the plan read), then each touched place left with no link and its
 * narrative; and the SQL that puts every one of those rows back.
 * @param {Array<{place_id: number, name: string, episode_id: string}>} entries
 * @param {{place_mentions: object[], places: object[], place_narratives: object[]}} rows - from backupQueries
 * @returns {{applied: string, undo: string, removed: object[]}} removed: the link rows listed
 */
export function pruneSQL(entries, rows) {
	checkEntries(entries);
	const listed = new Set(entries.map((e) => `${e.place_id}|${e.episode_id}`));
	const removed = rows.place_mentions.filter((m) => listed.has(`${m.place_id}|${m.episode_id}`));
	const applied = entries.map((e) =>
		`DELETE FROM place_mentions WHERE place_id = ${e.place_id} AND episode_id = '${escapeSQL(e.episode_id)}' ` +
			`AND EXISTS (SELECT 1 FROM places WHERE id = ${e.place_id} AND name = '${escapeSQL(e.name)}');`);
	for (const id of [...new Set(entries.map((e) => e.place_id))]) {
		applied.push(`DELETE FROM place_narratives WHERE place_id = ${id} AND NOT EXISTS (SELECT 1 FROM place_mentions WHERE place_id = ${id});`);
		applied.push(`DELETE FROM places WHERE id = ${id} AND NOT EXISTS (SELECT 1 FROM place_mentions WHERE place_id = ${id});`);
	}
	const names = new Map(rows.places.map((p) => [p.id, p.name]));
	const undo = [
		'-- Puts back what prune-place-links.js --apply removed: the places, then the links, then the narratives.',
		'-- Each row as it was (INSERT OR IGNORE, so rows still there are left alone); links and narratives',
		'-- find their place by name, and a link whose episode has been deleted since is left out.',
		...rows.places.map((r) => insertStatement('places', r, 'INSERT OR IGNORE')),
		...removed.map((r) => undoByName('place_mentions', r, names.get(r.place_id))),
		...rows.place_narratives.map((r) => undoByName('place_narratives', r, names.get(r.place_id))),
	];
	return { applied: applied.join('\n') + '\n', undo: undo.join('\n') + '\n', removed };
}

function reviewMarkdown(remove, total) {
	const byPlace = new Map();
	for (const r of remove) {
		if (!byPlace.has(r.name)) byPlace.set(r.name, []);
		byPlace.get(r.name).push(r);
	}
	const out = [`# Map links whose show never names the place: ${remove.length} of ${total}`, '',
		'Each line: the show, then the line the old check matched (if any). Delete an entry from plan.json to keep its link.', ''];
	for (const [name, list] of [...byPlace].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
		out.push(`## ${name} (${list.length})`);
		for (const r of list) out.push(`- ${dateOf(r.episode_id)} ${r.title ?? ''}${r.hint ? ` — matched: “${r.hint.slice(0, 160)}”` : ''}`);
		out.push('');
	}
	return out.join('\n');
}

function plan(target, database) {
	console.log(`Checking every map link against its show's lines, in the ${database} database (read-only)…`);
	const links = queryJSON(
		'SELECT pm.place_id, p.name, pm.episode_id, e.title, pm.sentiment_label AS label, pm.snippet ' +
			'FROM place_mentions pm JOIN places p ON p.id = pm.place_id JOIN episodes e ON e.id = pm.episode_id ORDER BY p.name, pm.episode_id',
		target
	);
	const ids = [...new Set(links.map((l) => l.episode_id))].sort();
	const lines = episodeLines(ids, target);
	const remove = linksToPrune(links, lines);
	const dir = newBackupDir('place-links-plan');
	fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ at: new Date().toISOString(), database, links: links.length, remove }, null, 1));
	fs.writeFileSync(path.join(dir, 'review.md'), reviewMarkdown(remove, links.length));
	const places = new Set(remove.map((r) => r.place_id)).size;
	console.log(`${links.length} links in ${ids.length} shows; ${remove.length} (to ${places} places) are in shows that never name the place.`);
	console.log(`Review: ${path.join(dir, 'review.md')}\nNothing changed. To remove them: node scripts/prune-place-links.js --apply "${path.join(dir, 'plan.json')}" --yes${target.isLocal ? ' --local' : ''}`);
}

function apply(file, { yes, target, database }) {
	const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
	if ((saved.database ?? 'production') !== database) throw new Error(`${file} was made from the ${saved.database} database, not the ${database} one`);
	const entries = (saved.remove ?? []).map(({ place_id, name, episode_id }) => ({ place_id, name, episode_id }));
	if (entries.length === 0) return console.log('The plan lists no links.');
	const q = backupQueries(entries);
	const read = (list) => list.flatMap((sql) => queryJSON(sql, target));
	const rows = { place_mentions: read(q.place_mentions), places: read(q.places), place_narratives: read(q.place_narratives) };
	const { applied, undo, removed } = pruneSQL(entries, rows);
	const names = new Map(rows.places.map((p) => [p.id, p.name]));
	const renamed = entries.filter((e) => names.get(e.place_id) !== e.name);
	const left = new Map();
	for (const m of rows.place_mentions) left.set(m.place_id, (left.get(m.place_id) ?? 0) + 1);
	for (const m of removed) left.set(m.place_id, left.get(m.place_id) - 1);
	const emptied = rows.places.filter((p) => left.get(p.id) === 0 && !renamed.some((e) => e.place_id === p.id));
	console.log(`${removed.length} of the plan's ${entries.length} links are still there to remove; ${emptied.length} place(s) would have none left and go with their narratives.`);
	if (renamed.length) console.log(`${renamed.length} link(s) kept: their place was renamed or removed since the plan.`);
	if (!yes) return console.log('\nDry run: nothing changed. Add --yes to remove them.');

	const dir = newBackupDir('place-links');
	fs.writeFileSync(path.join(dir, 'rows.json'), JSON.stringify(rows, null, 1));
	fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(saved, null, 1));
	fs.writeFileSync(path.join(dir, 'applied.sql'), applied);
	fs.writeFileSync(path.join(dir, 'undo.sql'), undo);
	fs.writeFileSync(path.join(dir, 'README.txt'), [
		`Map links removed by prune-place-links.js --apply --yes, ${new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}, in the ${database} D1 database.`,
		`The list: plan.json (a copy of ${path.resolve(file)}).`,
		'',
		`  rows.json    every row that could go: ${rows.places.length} places, ${rows.place_mentions.length} of their links, ${rows.place_narratives.length} narratives`,
		'  applied.sql  exactly what was run (one import)',
		'  undo.sql     puts back everything removed',
		'',
		'To undo:',
		'  cd roe-search',
		`  env -u CLOUDFLARE_API_TOKEN npx wrangler d1 execute roe-episodes ${target.isLocal ? '--local' : '--remote'} --file "${path.join(dir, 'undo.sql')}"`,
		'',
	].join('\n'));
	console.log(`Backed up to ${dir}`);
	runSQLFile(applied, target);

	const still = new Set(read(q.place_mentions).map((m) => `${m.place_id}|${m.episode_id}`));
	const missed = removed.filter((m) => still.has(`${m.place_id}|${m.episode_id}`) && names.get(m.place_id) === entries.find((e) => e.place_id === m.place_id)?.name);
	console.log(`Removed ${removed.length - missed.length} of ${removed.length} links.`);
	if (missed.length > 0) {
		for (const m of missed) console.log(`  still there: place ${m.place_id} in ${m.episode_id}`);
		process.exitCode = 1;
	}
}

function main() {
	loadEnv();
	const { flags, rest } = parseFlags(process.argv.slice(2), { '--apply': 'value', '--yes': 'flag', '--local': 'flag' }, USAGE);
	if (rest.length > 0) {
		console.error(USAGE);
		process.exit(1);
	}
	const target = { isLocal: !!flags.local };
	if (process.env.ROE_PERSIST_TO && !target.isLocal) throw new Error('ROE_PERSIST_TO is set (a test run): add --local');
	const database = target.isLocal ? 'local' : 'production';
	if (flags.yes && !flags.apply) throw new Error('--yes goes with --apply <plan.json>');
	if (flags.apply) apply(flags.apply, { yes: !!flags.yes, target, database });
	else plan(target, database);
}

if (import.meta.main) {
	try {
		main();
	} catch (err) {
		console.error(`\nError: ${err.message}`);
		process.exit(1);
	}
}
