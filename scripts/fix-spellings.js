#!/usr/bin/env node

/**
 * Apply the word corrections (WORD_CORRECTIONS in roe-pipeline/src/clean-segments.js,
 * the list both pipelines use on new transcripts) to the transcript lines D1
 * already has. Made when the owner corrected "Suldrew" and "Bay to Breakers" on
 * 2026-09-30, for the hundreds of older lines that still had "Soul Drew" or
 * "Beta Breakers". A dry run unless --yes.
 *
 * Lines are found with a LIKE per correction, then corrected the way
 * applyWordCorrections does (whole words, in the list's order), so a line
 * changes exactly as a new transcript's would. The changes are listed per correction and per
 * episode, with examples, and saved in transcripts/.backups/<date>-spellings-plan/
 * (a dry run) or <date>-spellings/ (--yes).
 *
 * With --yes: lines.json (each line as it was and as it becomes), restore.sql,
 * applied.sql and a README with the undo command; then one D1 import of UPDATEs,
 * each only where the line's text is still the one read (D1's update trigger
 * keeps the keyword search in step); then the lines are read back. The search
 * entries of the episodes whose lines changed are made from the old text, so
 * the command that redoes them is printed (and their IDs saved in episodes.txt).
 *
 * --skip <corrections> leaves some out (their keys, comma-separated): on
 * 2026-09-30 "soldier" was, since 758 old lines had it and a few of them are
 * the real word ("Toy Soldier", "Soldier Boy").
 *
 * Usage:
 *   node scripts/fix-spellings.js [--skip <key>,…] [--yes] [--local]
 */

import fs from 'node:fs';
import path from 'node:path';

import { escapeSQL, loadEnv, parseFlags, queryJSON, runSQLFile } from './lib.js';
import { newBackupDir } from './episode-backup.js';
import { WORD_CORRECTIONS } from '../roe-pipeline/src/clean-segments.js';

const USAGE = 'Usage: node scripts/fix-spellings.js [--skip <key>,…] [--yes] [--local]';
const EXAMPLES = 3; // per correction, in the list

/** The SELECT that finds every line a correction might change (correctWith decides). */
export function candidateSQL(keys = Object.keys(WORD_CORRECTIONS)) {
	if (keys.length === 0) throw new Error('No word corrections to apply');
	const where = keys.map((k) => `lower(text) LIKE '%${escapeSQL(k.toLowerCase())}%'`).join(' OR ');
	return `SELECT id, episode_id, text FROM transcript_segments WHERE ${where} ORDER BY episode_id, start_ms, id`;
}

const wordRe = (key, flags) => new RegExp(`\\b${key}\\b`, flags);

/** The corrections in `keys` applied to a text, in the list's order, exactly as applyWordCorrections does. */
export function correctWith(text, keys = Object.keys(WORD_CORRECTIONS)) {
	for (const key of Object.keys(WORD_CORRECTIONS)) {
		if (keys.includes(key)) text = text.replace(wordRe(key, 'gi'), WORD_CORRECTIONS[key]);
	}
	return text;
}

/** The correction keys left after --skip; an unknown key stops the run. */
export function keysToApply(skip) {
	const out = (skip ?? '').split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
	const unknown = out.filter((k) => !(k in WORD_CORRECTIONS));
	if (unknown.length > 0) throw new Error(`--skip: no correction called ${unknown.join(', ')} (they are: ${Object.keys(WORD_CORRECTIONS).join(', ')})`);
	return Object.keys(WORD_CORRECTIONS).filter((k) => !out.includes(k));
}

/** Which lines change, and how, with the corrections that changed each. */
export function spellingChanges(rows, keys = Object.keys(WORD_CORRECTIONS)) {
	const changes = [];
	for (const r of rows) {
		const text = correctWith(r.text, keys);
		if (text === r.text) continue;
		changes.push({ id: r.id, episode_id: r.episode_id, old: r.text, new: text, keys: keys.filter((k) => wordRe(k, 'i').test(r.text)) });
	}
	return changes;
}

const checkId = (id) => {
	if (!Number.isInteger(id) || id < 1) throw new Error(`Not a line id: ${id}`);
	return id;
};

/** One line's correction, only where its text is still the one read. */
export function updateStatement(c) {
	return `UPDATE transcript_segments SET text = '${escapeSQL(c.new)}' WHERE id = ${checkId(c.id)} AND text = '${escapeSQL(c.old)}';`;
}

/** Puts one line back, only where it is still the corrected text. */
export function restoreStatement(c) {
	return `UPDATE transcript_segments SET text = '${escapeSQL(c.old)}' WHERE id = ${checkId(c.id)} AND text = '${escapeSQL(c.new)}';`;
}

/** The list for the owner: per correction (with examples), then per episode. */
export function reportLines(changes) {
	const out = [];
	const episodes = [...new Set(changes.map((c) => c.episode_id))];
	out.push(`${changes.length} line${changes.length === 1 ? '' : 's'} to correct in ${episodes.length} episode${episodes.length === 1 ? '' : 's'}:`);
	for (const [key, to] of Object.entries(WORD_CORRECTIONS)) {
		const theirs = changes.filter((c) => c.keys.includes(key));
		if (theirs.length === 0) continue;
		out.push(`  "${key}" -> "${to}": ${theirs.length} line${theirs.length === 1 ? '' : 's'}`);
		for (const c of theirs.slice(0, EXAMPLES)) out.push(`      ${c.episode_id.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? c.episode_id}  "${c.old.slice(0, 90)}" -> "${c.new.slice(0, 90)}"`);
	}
	return out;
}

function writeBackup(dir, changes, { isLocal }) {
	const applied = changes.map(updateStatement).join('\n') + '\n';
	fs.writeFileSync(path.join(dir, 'lines.json'), JSON.stringify(changes, null, 1));
	fs.writeFileSync(path.join(dir, 'restore.sql'), [
		'-- Puts back the transcript lines fix-spellings.js corrected,',
		'-- each only where it is still the corrected text.',
		...changes.map(restoreStatement),
	].join('\n') + '\n');
	fs.writeFileSync(path.join(dir, 'applied.sql'), applied);
	fs.writeFileSync(path.join(dir, 'README.txt'), [
		`Transcript lines corrected by fix-spellings.js --yes, ${new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}, in the ${isLocal ? 'local D1 copy (--local)' : 'production D1 database'}.`,
		'',
		`  lines.json    the ${changes.length} lines as they were and as they became`,
		'  applied.sql   exactly what was run (each only where the line was still the one read)',
		'  restore.sql   puts back each line this run changed, unless it has changed again since',
		'  episodes.txt  the episodes whose search entries need redoing (generate-embeddings.js --only)',
		'',
		'To undo:',
		'  cd roe-search',
		`  env -u CLOUDFLARE_API_TOKEN npx wrangler d1 execute roe-episodes ${isLocal ? '--local' : '--remote'} --file "${path.join(dir, 'restore.sql')}"`,
		'',
	].join('\n'));
	return applied;
}

async function main() {
	loadEnv();
	const { flags, rest } = parseFlags(process.argv.slice(2), { '--skip': 'value', '--yes': 'flag', '--local': 'flag' }, USAGE);
	if (rest.length > 0) {
		console.error(USAGE);
		process.exit(1);
	}
	const target = { isLocal: !!flags.local };
	if (process.env.ROE_PERSIST_TO && !target.isLocal) throw new Error('ROE_PERSIST_TO is set (a test run): add --local');
	const where = `in the ${target.isLocal ? 'local D1 copy' : 'production database'}`;

	const keys = keysToApply(flags.skip);
	const changes = spellingChanges(queryJSON(candidateSQL(keys), target), keys);
	console.log(`${flags.yes ? 'Correcting' : 'Dry run (--yes to write):'} transcript lines ${where}${flags.skip ? ` (leaving out: ${flags.skip})` : ''}\n`);
	const report = reportLines(changes);
	console.log(report.join('\n'));
	const episodes = [...new Set(changes.map((c) => c.episode_id))];
	const dir = newBackupDir(flags.yes ? 'spellings' : 'spellings-plan');
	fs.writeFileSync(path.join(dir, 'report.txt'), `${report.join('\n')}\n`);
	fs.writeFileSync(path.join(dir, 'episodes.txt'), `${episodes.join(',')}\n`);
	if (!flags.yes) {
		if (changes.length > 0) fs.writeFileSync(path.join(dir, 'lines.json'), JSON.stringify(changes, null, 1));
		console.log(`\nNothing changed. The list: ${dir}`);
		return;
	}
	if (changes.length === 0) return;

	const applied = writeBackup(dir, changes, target);
	console.log(`\nBacked up to ${dir}`);
	runSQLFile(applied, target);

	// Read back: every changed line now has its corrected text
	const now = new Map();
	const ids = changes.map((c) => c.id);
	for (let i = 0; i < ids.length; i += 500) {
		for (const r of queryJSON(`SELECT id, text FROM transcript_segments WHERE id IN (${ids.slice(i, i + 500).join(', ')})`, target)) now.set(r.id, r.text);
	}
	const missed = changes.filter((c) => now.get(c.id) !== c.new);
	console.log(`Corrected ${changes.length - missed.length} of ${changes.length} lines in ${episodes.length} episodes.`);
	for (const c of missed.slice(0, 20)) console.log(`  line ${c.id} (${c.episode_id}): not corrected (it changed after it was read, or is gone)`);
	console.log(`\nTheir search entries still have the old text. To redo them:\n  node scripts/generate-embeddings.js --only "$(cat "${path.join(dir, 'episodes.txt')}")"   # a dry run; add --yes`);
	if (missed.length > 0) process.exitCode = 1;
}

if (import.meta.main) {
	main().catch((err) => {
		console.error(`\nError: ${err.message}`);
		process.exit(1);
	});
}
