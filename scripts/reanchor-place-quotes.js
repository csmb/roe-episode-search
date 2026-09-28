#!/usr/bin/env node

/**
 * Move the map's place quotes to where they are in an episode's transcript
 * now. Each place_mentions row has a quote (snippet) and its time
 * (snippet_start_ms), which the map's "hear this quote" link plays from; a
 * repaired transcript has new line times, so after a repair those times point
 * into the old transcript's timeline (a joined show's were already moved by
 * the parts added before it). A dry run unless --yes.
 *
 * Each quote is looked for in the episode's lines in D1, as words (case and
 * punctuation ignored, across line breaks): word for word, or else, for a
 * quote of 6+ words, 75%+ of its words in order within a stretch not much
 * longer than the quote (accents ignored too). A place it is found only counts
 * within 90 s of a line naming the place (the words the pipeline picked the
 * quote's passage by, as whole words, the spaces between them optional) or
 * within 3 minutes of its old time: a short quote like "It's really cool." is
 * said more than once. Of several, the one its old time leads into wins (from
 * 30 s before its line to the line's end: the pipeline sets a quote's time to
 * the start of its passage, a few lines early), else the nearest; when none is
 * within 3 minutes of the old time (or there is none), there is no telling
 * which, and it keeps its time. Its new time is the start of the line the
 * match begins in, unless its old time still leads into it. A quote not found
 * keeps its time too, and both are listed.
 * Rows are never added or deleted (places removed by hand in the map review
 * stay removed), and only snippet_start_ms changes. (A time can be off without
 * a repair too: when GPT's quote isn't word for word in any of its passages,
 * the pipeline takes the first passage's time, and early 2014 quotes kept the
 * times of their 10x transcripts.)
 *
 * The list (every quote, old -> new, how it was found, the line) is printed
 * per episode and saved as quotes.txt and quotes.json in transcripts/.backups/
 * <date>-place-quotes-plan/ (a dry run) or <date>-place-quotes/ (--yes).
 *
 * --apply <quotes.json> --yes writes the rows a dry run saved, as they are
 * (edit it first: set a row's "new" to its "old" to leave it, or to the time
 * you want), without working them out again.
 *
 * With --yes: before.json (the rows as they were read) and restore.sql (puts
 * back each time this run changed, unless it has changed again since); then
 * one D1 import (applied.sql) of UPDATEs, each only where the quote and its
 * time are still the ones read; then the times are read back.
 *
 * Usage:
 *   node scripts/reanchor-place-quotes.js (--only <date|id>,… | --from-repair) [--except <dates>] [--progress <file>] [--yes] [--local]
 *   node scripts/reanchor-place-quotes.js --apply <quotes.json> [--progress <file>] [--yes] [--local]
 *
 *   --only         these episodes (YYYY-MM-DD dates or episode IDs, comma-separated)
 *   --from-repair  the episodes transcripts/.repair/progress.json has published or done
 *   --except       leave these out
 *   --progress     the repair's state file, if not transcripts/.repair/progress.json
 *   --apply        write the rows a dry run saved (with --yes)
 *   --yes          write the new times (after the backup)
 *   --local        the local D1 copy (in a test run, the one under ROE_PERSIST_TO)
 *
 * An episode the repair is working on (not published, done, skipped or set
 * aside) is always left out, --only, --apply or not: its transcript is about to
 * change, and the repair checks that its place quotes don't. The repair's state only
 * counts for the database it was made on (its "database").
 */

import fs from 'node:fs';
import path from 'node:path';

import { escapeSQL, loadEnv, parseFlags, queryJSON, runSQLFile } from './lib.js';
import { placeMatchVariants } from '../roe-pipeline/src/sentiment.js';
import { newBackupDir } from './episode-backup.js';
import { dateOf, episodeLines, leaveOutBusy, mmss, pickForRun, repairStateForRun } from './repaired-episodes.js';

export const MIN_SHARE = 0.75; // of a quote's words, in order, for a close match
export const MIN_CLOSE_WORDS = 6; // shorter quotes only count word for word
export const NEAR_PLACE_MS = 90_000; // a quote was picked from the lines around a mention of its place
export const NEAR_OLD_MS = 180_000; // or it is where it was, give or take the new line times
export const LEAD_IN_MS = 30_000; // the pipeline's time is the start of the quote's passage, a few lines before it
export const SAME_PLACE_MS = 30_000; // finds closer together than this are one place
const SLACK_WORDS = 4; // a close match may start this many words early...
const STRETCH = 1.5; // ...and run to 1.5x the quote's length
const COMMON = 400; // a word found more often than this doesn't suggest where a quote is
const CANDIDATES = 12; // places tried for a close match
const PAGE = 20; // episodes per query

const USAGE = [
	'Usage: node scripts/reanchor-place-quotes.js (--only <date|id>,… | --from-repair) [--except <dates>] [--progress <file>] [--yes] [--local]',
	'       node scripts/reanchor-place-quotes.js --apply <quotes.json> [--progress <file>] [--yes] [--local]',
].join('\n');

/** Lowercase words, punctuation and accents dropped: "It's 8:30, Beyoncé!" -> ['it', 's', '8', '30', 'beyonce']. */
export const wordsOf = (text) => String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
	.replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);

/** An episode's words in order, each with the line it is in, and where each word is. */
export function wordStream(lines) {
	const words = [];
	const lineOf = [];
	lines.forEach((line, i) => {
		for (const w of wordsOf(line.text)) {
			words.push(w);
			lineOf.push(i);
		}
	});
	const index = new Map();
	words.forEach((w, pos) => {
		if (!index.has(w)) index.set(w, []);
		index.get(w).push(pos);
	});
	return { lines, words, lineOf, index };
}

/** Where the quote's words appear word for word: the positions of its first word. */
function exactStarts(q, stream) {
	let rare = 0;
	for (let j = 1; j < q.length; j++) {
		if ((stream.index.get(q[j])?.length ?? 0) < (stream.index.get(q[rare])?.length ?? 0)) rare = j;
	}
	const starts = [];
	for (const pos of stream.index.get(q[rare]) ?? []) {
		const start = pos - rare;
		if (start < 0 || start + q.length > stream.words.length) continue;
		if (q.every((w, j) => stream.words[start + j] === w)) starts.push(start);
	}
	return starts;
}

/**
 * Likely starts for a close match: where the quote's less common words point to, most votes
 * first, one per stretch, only those `keep` allows.
 */
function likelyStarts(q, stream, keep) {
	const votes = new Map();
	q.forEach((w, j) => {
		const found = stream.index.get(w) ?? [];
		if (found.length > COMMON) return;
		for (const pos of found) {
			const start = Math.max(0, pos - j);
			if (keep(start)) votes.set(start, (votes.get(start) ?? 0) + 1);
		}
	});
	const starts = [];
	for (const [start] of [...votes].sort((a, b) => b[1] - a[1] || a[0] - b[0])) {
		if (starts.some((s) => Math.abs(s - start) < q.length)) continue;
		starts.push(start);
		if (starts.length === CANDIDATES) break;
	}
	return starts;
}

/**
 * The most of the quote's words found in order from about `start`: their share, and where the
 * match starts: the latest word from which all of them can still be found, so a stray copy of the
 * quote's first word just before it ("did I? I was downtown") doesn't pull it a line early.
 */
function alignAt(q, stream, start) {
	const from = Math.max(0, start - SLACK_WORDS);
	const to = Math.min(stream.words.length, start + Math.ceil(q.length * STRETCH) + SLACK_WORDS);
	const w = stream.words.slice(from, to);
	// Longest common subsequence of q[i..] and w[k..], for every i and k
	const cols = w.length + 1;
	const t = new Uint16Array((q.length + 1) * cols);
	for (let i = q.length - 1; i >= 0; i--) {
		for (let k = w.length - 1; k >= 0; k--) {
			t[i * cols + k] = q[i] === w[k] ? t[(i + 1) * cols + k + 1] + 1 : Math.max(t[(i + 1) * cols + k], t[i * cols + k + 1]);
		}
	}
	const matched = t[0];
	if (matched === 0) return { share: 0, first: -1 };
	let k = 0;
	while (k + 1 < w.length && t[k + 1] === matched) k++;
	return { share: matched / q.length, first: from + k };
}

/** A place name's words run together, "theater" spelled "theatre": "Castro Theater" is "castrotheatre". */
const squash = (words) => words.join('').replace(/theater/g, 'theatre');

/**
 * When the lines name the place, with the words the pipeline found the quote's passages by
 * (roe-pipeline/src/sentiment.js), as whole words, the spaces between them optional ("Sight Glass"
 * for Sightglass, but not "so many" for SoMa): the start of each line that does.
 */
export function placeTimes(lines, name) {
	const variants = placeMatchVariants(name ?? '').map((v) => squash(wordsOf(v))).filter((v) => v.length >= 3);
	if (variants.length === 0) return [];
	const names = (lineWords) => lineWords.some((_, i) => {
		let run = '';
		for (let j = i; j < lineWords.length && run.length < 40; j++) {
			run = squash([run, lineWords[j]]);
			if (variants.includes(run)) return true;
		}
		return false;
	});
	return lines.filter((l) => names(wordsOf(l.text))).map((l) => l.start_ms);
}

/**
 * Find a quote in an episode's lines.
 * @param {string} quote
 * @param {ReturnType<typeof wordStream>} stream
 * @param {number|null} oldMs - its old time: of several places it is found, the one it leads into
 *   (LEAD_IN_MS before its line to the line's end) or else the nearest wins; when none is within
 *   NEAR_OLD_MS of it (or it has none), several places are no answer: `ambiguous`
 * @param {number[]|null} placeMs - when the lines name its place (placeTimes). A place the quote is
 *   found only counts within NEAR_PLACE_MS of one of these or NEAR_OLD_MS of its old time; null:
 *   anywhere
 * @returns {{ms: number, line: number, how: 'word for word'|'close', share: number, places: number}
 *   |{ambiguous: true, how: string, places: number}|null}
 */
export function findQuote(quote, stream, oldMs = null, placeMs = null) {
	const q = wordsOf(quote);
	if (q.length === 0 || stream.words.length === 0) return null;
	const lineAt = (pos) => stream.lines[stream.lineOf[pos]];
	const msAt = (pos) => lineAt(pos).start_ms;
	const near = (pos) => placeMs == null
		|| placeMs.some((t) => Math.abs(t - msAt(pos)) <= NEAR_PLACE_MS)
		|| (oldMs != null && Math.abs(msAt(pos) - oldMs) <= NEAR_OLD_MS);
	const leadsIn = (pos) => oldMs != null && oldMs >= msAt(pos) - LEAD_IN_MS && oldMs <= lineAt(pos).end_ms;
	const away = (pos) => (leadsIn(pos) ? 0 : Math.abs(msAt(pos) - oldMs));

	let hits = exactStarts(q, stream).filter(near).map((pos) => ({ pos, share: 1 }));
	let how = 'word for word';
	if (hits.length === 0) {
		if (q.length < MIN_CLOSE_WORDS) return null;
		how = 'close';
		const seen = new Set();
		for (const start of likelyStarts(q, stream, near)) {
			const m = alignAt(q, stream, start);
			if (m.share < MIN_SHARE || seen.has(m.first) || !near(m.first)) continue;
			seen.add(m.first);
			hits.push({ pos: m.first, share: m.share });
		}
		if (hits.length === 0) return null;
		const best = Math.max(...hits.map((h) => h.share));
		hits = hits.filter((h) => h.share >= best - 0.05);
	}
	// Places more than SAME_PLACE_MS apart are different places ("oh yeah oh yeah" is one)
	const places = [...new Set(hits.map((h) => msAt(h.pos)))].sort((a, b) => a - b)
		.filter((ms, i, all) => i === 0 || ms - all[i - 1] > SAME_PLACE_MS).length;
	if (places > 1 && (oldMs == null || !hits.some((h) => away(h.pos) <= NEAR_OLD_MS))) return { ambiguous: true, how, places };
	const pick = oldMs == null ? hits.reduce((a, b) => (b.pos < a.pos ? b : a)) : hits.reduce((a, b) => (away(b.pos) < away(a.pos) ? b : a));
	return { ms: msAt(pick.pos), line: stream.lineOf[pick.pos], how, share: pick.share, places };
}

/**
 * Where each of an episode's quotes goes.
 * @param {Array<{place_id: number, name: string, episode_id: string, snippet: string|null, snippet_start_ms: number|null}>} mentions
 * @param {Array<{start_ms: number, end_ms: number, text: string}>} lines - the episode's lines in D1 now
 */
export function placeQuotes(mentions, lines) {
	const stream = wordStream(lines);
	const placeMs = new Map();
	return mentions.map((m) => {
		const row = { place_id: m.place_id, name: m.name, episode_id: m.episode_id, snippet: m.snippet, old: m.snippet_start_ms ?? null, new: null, how: null, share: null, line: null };
		if (!m.snippet?.trim()) return { ...row, how: 'no quote' };
		if (!placeMs.has(m.name)) placeMs.set(m.name, placeTimes(lines, m.name));
		const hit = findQuote(m.snippet, stream, row.old, placeMs.get(m.name));
		if (!hit) return { ...row, how: 'not found' };
		if (hit.ambiguous) return { ...row, how: 'more than one place' };
		const at = lines[hit.line];
		// An old time that still leads into the quote stays, as the pipeline set it
		const fits = row.old != null && row.old >= at.start_ms - LEAD_IN_MS && row.old <= at.end_ms;
		return { ...row, new: fits ? row.old : hit.ms, how: hit.how, share: Math.round(hit.share * 100) / 100, line: at.text };
	});
}

/** A saved quotes.json (--apply), checked: every row, as the dry run (or you) left it. */
export function savedRows(saved, { database }) {
	if (!Array.isArray(saved?.rows)) throw new Error('Not a quotes.json from reanchor-place-quotes.js');
	if ((saved.database ?? 'production') !== database) throw new Error(`The list was made on the ${saved.database ?? 'production'} database, not the ${database} one`);
	return saved.rows;
}

/** Whether a row's time changes. */
export const moves = (r) => r.new != null && r.new !== r.old;

const checkMs = (ms) => {
	if (!Number.isInteger(ms) || ms < 0) throw new Error(`Not a time in ms: ${ms}`);
	return ms;
};
// The row, and its quote as read: a row scored again since, with a new quote, is left alone
const whereRow = (r) => {
	if (typeof r.snippet !== 'string' || !r.snippet.trim()) throw new Error(`${r.episode_id} #${r.place_id}: no quote to move`);
	return `place_id = ${Number(r.place_id)} AND episode_id = '${escapeSQL(r.episode_id)}' AND snippet = '${escapeSQL(r.snippet)}'`;
};
const whereTime = (ms) => (ms == null ? 'snippet_start_ms IS NULL' : `snippet_start_ms = ${checkMs(ms)}`);

/** The statement that moves one quote's time, only where the quote and its time are still the ones read. */
export function moveStatement(r) {
	return `UPDATE place_mentions SET snippet_start_ms = ${checkMs(r.new)} WHERE ${whereRow(r)} AND ${whereTime(r.old)};`;
}

/** The statement that puts one back, only where the quote is the same and the time still the one this run set. */
export function restoreStatement(r) {
	return `UPDATE place_mentions SET snippet_start_ms = ${r.old == null ? 'NULL' : checkMs(r.old)} WHERE ${whereRow(r)} AND snippet_start_ms = ${checkMs(r.new)};`;
}

const signed = (ms) => `${ms < 0 ? '-' : '+'}${mmss(Math.abs(ms))}`;

/** One episode's summary, and with `detail` every quote. */
export function episodeReport(id, rows, { detail = false } = {}) {
	const count = (how) => rows.filter((r) => r.how === how).length;
	const moved = rows.filter(moves);
	const shifts = moved.filter((r) => r.old != null).map((r) => Math.abs(r.new - r.old)).sort((a, b) => a - b);
	const out = [`${dateOf(id)}  ${rows.length} quote${rows.length === 1 ? '' : 's'}: ${count('word for word')} word for word, ${count('close')} close, ${count('not found')} not found${count('more than one place') ? `, ${count('more than one place')} in more than one place` : ''}${count('no quote') ? `, ${count('no quote')} without a quote` : ''}; ${moved.length} to move${shifts.length ? ` (median ${mmss(shifts[shifts.length >> 1])}, largest ${mmss(shifts[shifts.length - 1])})` : ''}`];
	if (detail) {
		for (const r of rows) {
			// kept: not found (or no quote); stays: found, and its old time still leads into it
			let where = `${mmss(r.old).padStart(6)} kept`;
			if (r.new != null) where = moves(r) ? `${mmss(r.old).padStart(6)} -> ${mmss(r.new).padStart(6)}${r.old != null ? ` (${signed(r.new - r.old)})` : ''}` : `${mmss(r.old).padStart(6)} stays`;
			out.push(`    ${where}  ${r.how}${r.how === 'close' ? ` ${Math.round(r.share * 100)}%` : ''}  ${r.name}: "${String(r.snippet ?? '').slice(0, 90)}"`);
			if (r.line && r.how === 'close') out.push(`             line: "${r.line.slice(0, 110)}"`);
		}
	}
	return out;
}

/**
 * Before any change: the rows as they were read, restore.sql and applied.sql (what the change
 * runs), and a README with the undo command. Returns the SQL to run.
 */
export function writeBackup(dir, todo, { isLocal = false } = {}) {
	const applied = todo.map(moveStatement).join('\n') + '\n';
	fs.writeFileSync(path.join(dir, 'before.json'), JSON.stringify(todo.map((r) => ({ place_id: r.place_id, name: r.name, episode_id: r.episode_id, snippet: r.snippet, snippet_start_ms: r.old })), null, 1));
	fs.writeFileSync(path.join(dir, 'restore.sql'), [
		'-- Puts back the quote times reanchor-place-quotes.js set,',
		'-- each only where it is still the time that run set.',
		...todo.map(restoreStatement),
	].join('\n') + '\n');
	fs.writeFileSync(path.join(dir, 'applied.sql'), applied);
	fs.writeFileSync(path.join(dir, 'README.txt'), readme(dir, { rows: todo.length, isLocal }));
	return applied;
}

function readme(dir, { rows, isLocal }) {
	return [
		`Place-quote times moved by reanchor-place-quotes.js --yes, ${new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}, in the ${isLocal ? 'local D1 copy (--local)' : 'production D1 database'}.`,
		'',
		'  quotes.txt    every quote looked at, old -> new time, how it was found',
		'  quotes.json   the same as data',
		`  before.json   the ${rows} place_mentions row${rows === 1 ? '' : 's'} whose time changed, as they were read`,
		'  applied.sql   exactly what was run (UPDATEs of snippet_start_ms only, each only where the',
		'                time was still the one read)',
		'  restore.sql   puts back each time this run set, unless it has changed again since',
		'',
		'To undo:',
		'  cd roe-search',
		`  env -u CLOUDFLARE_API_TOKEN npx wrangler d1 execute roe-episodes ${isLocal ? '--local' : '--remote'} --file "${path.join(dir, 'restore.sql')}"`,
		'',
	].join('\n');
}

async function main() {
	loadEnv();
	const { flags, rest } = parseFlags(process.argv.slice(2), {
		'--only': 'value', '--from-repair': 'flag', '--except': 'value', '--progress': 'value', '--apply': 'value', '--yes': 'flag', '--local': 'flag',
	}, USAGE);
	const picking = flags.only || flags['from-repair'] || flags.except;
	if (rest.length > 0 || (flags.apply ? picking : !flags.only === !flags['from-repair'])) {
		console.error(USAGE);
		process.exit(1);
	}
	const target = { isLocal: !!flags.local };
	if (process.env.ROE_PERSIST_TO && !target.isLocal) throw new Error('ROE_PERSIST_TO is set (a test run): add --local');
	const database = target.isLocal ? 'local' : 'production';
	const where = `in the ${target.isLocal ? 'local D1 copy' : 'production database'}`;

	let rows = [];
	let ids;
	if (flags.apply) {
		const file = path.resolve(flags.apply);
		rows = leaveOutBusy(savedRows(JSON.parse(fs.readFileSync(file, 'utf-8')), { database }), repairStateForRun(flags, target), (r) => r.episode_id);
		ids = [...new Set(rows.map((r) => r.episode_id))];
		console.log(`${flags.yes ? 'Moving' : 'Dry run (--yes to write):'} the quote times in ${file}, ${where}\n`);
	} else {
		const { episodes } = pickForRun(queryJSON('SELECT id FROM episodes ORDER BY id', target), flags, target);
		ids = episodes.map((e) => e.id);
		console.log(`${flags.yes ? 'Moving' : 'Dry run (--yes to write):'} the place quotes of ${ids.length} episode${ids.length === 1 ? '' : 's'}${flags['from-repair'] ? ' the repair has finished' : ''}, ${where}\n`);
		const mentions = new Map();
		for (let i = 0; i < ids.length; i += PAGE) {
			const page = ids.slice(i, i + PAGE).map((id) => `'${escapeSQL(id)}'`).join(', ');
			for (const m of queryJSON(`SELECT pm.place_id, p.name, pm.episode_id, pm.snippet, pm.snippet_start_ms FROM place_mentions pm LEFT JOIN places p ON p.id = pm.place_id WHERE pm.episode_id IN (${page}) ORDER BY pm.episode_id, pm.snippet_start_ms, pm.place_id`, target)) {
				if (!mentions.has(m.episode_id)) mentions.set(m.episode_id, []);
				mentions.get(m.episode_id).push(m);
			}
		}
		const lines = episodeLines([...mentions.keys()], target);
		for (const id of ids) if (mentions.has(id)) rows.push(...placeQuotes(mentions.get(id), lines.get(id)));
	}
	const report = ids.flatMap((id) => {
		const theirs = rows.filter((r) => r.episode_id === id);
		return theirs.length ? episodeReport(id, theirs, { detail: true }) : [`${dateOf(id)}  no place quotes`];
	});
	console.log(ids.map((id) => episodeReport(id, rows.filter((r) => r.episode_id === id))[0]).join('\n'));

	const todo = rows.filter(moves);
	const unplaced = rows.filter((r) => r.how === 'not found' || r.how === 'more than one place');
	const count = (how) => rows.filter((r) => r.how === how).length;
	const totals = `${rows.length} quotes: ${count('word for word')} word for word, ${count('close')} close, ${count('not found')} not found, ${count('more than one place')} in more than one place (their times kept); ${todo.length} to move`;
	const dir = newBackupDir(flags.yes ? 'place-quotes' : 'place-quotes-plan');
	fs.writeFileSync(path.join(dir, 'quotes.json'), JSON.stringify({ at: new Date().toISOString(), database, ...(flags.apply ? { from: path.resolve(flags.apply) } : {}), rows }, null, 1));
	fs.writeFileSync(path.join(dir, 'quotes.txt'), `${totals}, ${new Date().toISOString()}\n("stays": found, and its old time still leads into it, up to 30 s before its line; "kept": not found, in more than one place, or no quote)\n\n${report.join('\n')}\n`);
	console.log(`\n${totals}\nEvery quote: ${path.join(dir, 'quotes.txt')}`);
	if (unplaced.length > 0) {
		console.log('\nNot found, or in more than one place (kept):');
		for (const r of unplaced) console.log(`  ${dateOf(r.episode_id)} ${mmss(r.old).padStart(6)}  ${r.name}: "${String(r.snippet).slice(0, 100)}"${r.how === 'not found' ? '' : ' (more than one place)'}`);
	}
	if (!flags.yes) {
		console.log(todo.length > 0
			? `\nNothing changed. To write exactly this list: node scripts/reanchor-place-quotes.js --apply "${path.join(dir, 'quotes.json')}" --yes${target.isLocal ? ' --local' : ''}`
			: '\nNothing to change.');
		return;
	}
	if (todo.length === 0) return;

	// Back up, then one import that only changes a time still as it was read
	const applied = writeBackup(dir, todo, { isLocal: target.isLocal });
	console.log(`\nBacked up to ${dir}`);
	runSQLFile(applied, target);

	const now = new Map();
	const touched = [...new Set(todo.map((r) => r.episode_id))];
	for (let i = 0; i < touched.length; i += PAGE) {
		const page = touched.slice(i, i + PAGE).map((id) => `'${escapeSQL(id)}'`).join(', ');
		for (const m of queryJSON(`SELECT place_id, episode_id, snippet_start_ms FROM place_mentions WHERE episode_id IN (${page})`, target)) now.set(`${m.episode_id}|${m.place_id}`, m.snippet_start_ms);
	}
	const missed = todo.filter((r) => now.get(`${r.episode_id}|${r.place_id}`) !== r.new);
	console.log(`Moved ${todo.length - missed.length} of ${todo.length} quote times.`);
	for (const r of missed) console.log(`  ${dateOf(r.episode_id)} ${r.name}: not moved, it is ${mmss(now.get(`${r.episode_id}|${r.place_id}`))} (it changed after it was read, or the row is gone)`);
	if (missed.length > 0) process.exitCode = 1;
}

if (import.meta.main) {
	main().catch((err) => {
		console.error(`\nError: ${err.message}`);
		process.exit(1);
	});
}
