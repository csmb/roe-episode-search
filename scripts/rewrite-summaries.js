#!/usr/bin/env node

/**
 * Rewrite episodes' summary text from their transcript in D1, and nothing else:
 * the title, the guests, the reviewed flag and the interview time stay exactly
 * as they are, reviewed episodes included (unlike generate-summaries.js, which
 * redoes title, summary and guests together). Made for the episodes whose
 * transcript the archive repair redid: their summaries were written from the
 * old, partial transcripts.
 *
 * The new summary comes from summary-engines.js (the Worker's summary
 * instructions, asking for the summary only):
 *   --engine openai   GPT-4o-mini, paid (about half a cent a 2-hour show), only
 *                     within --max-cost (default $0: it shows the plan and stops)
 *   --engine ollama   a local model through Ollama, free (--model, default
 *                     qwen3:30b); a transcript too long for its context leaves
 *                     out its shortest lines. It won't start while whisper.cpp
 *                     is transcribing on the GPU (the repair's runs).
 * A transcript too thin to summarize (the Worker's rule) keeps its summary.
 *
 * Without --yes nothing is written: each episode's old and new summary are
 * printed side by side, and saved for you to read in
 * transcripts/.summaries/<time>-<engine>-<model>.json and .md. Then
 *   --apply <that .json> --yes   writes the summaries in the file (edit them
 *                                there first if you like), without asking a
 *                                model again
 *   --yes (with --engine)        writes the new ones as soon as they're made
 * Writing: a backup of the summaries there now in transcripts/.backups/<date>-
 * summaries/ (summaries.json, restore.sql, README.txt); one D1 import that sets
 * only `summary`, and only where it is still the one the new one was made
 * against and the transcript still the one it was made from (an episode whose
 * summary or transcript changed meanwhile is left alone); then a check that the
 * new summaries are in and nothing else about the episodes changed.
 *
 * An episode the repair is still working on (transcripts/.repair/progress.json)
 * is left out: its transcript is about to change, and the repair checks that
 * its summary doesn't.
 *
 * Usage:
 *   node scripts/rewrite-summaries.js (--only <date|id>,… | --from-repair) --engine openai|ollama [options]
 *   node scripts/rewrite-summaries.js --apply <file.json> [--yes] [--local]
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { escapeSQL, loadEnv, parseEpisodeDate, parseFlags, projectRoot, queryJSON, runSQLFile, transcriptsDir } from './lib.js';
import { newBackupDir } from './episode-backup.js';
import { pickEpisodes } from './scan-transcripts.js';
import { isThinTranscript, THIN_MIN_COVERAGE, THIN_MIN_SEGMENTS } from '../roe-pipeline/src/summary.js';
import {
	CHARS_PER_TOKEN, OLLAMA_MODEL, OLLAMA_NUM_CTX, OLLAMA_NUM_CTX_THINKING, OLLAMA_URL, OPENAI_MODEL, OPENAI_REPLY_TOKENS,
	OPENAI_USD_PER_TOKEN, askOllama, askOpenAI, fitTranscript, httpRequest, ollamaModels, promptTokens, retry, summaryMessages,
	summaryNotes, sunTimes, transcriptBudget, withRetries,
} from './summary-engines.js';

const FINISHED = ['published', 'done']; // what --from-repair takes: new transcript published, or lines-only / duration fix done
const AT_REST = ['published', 'done', 'skipped', 'set-aside']; // the repair isn't working on these
const FAILED_IN_A_ROW = 3; // this many failures one after another: something is wrong, stop
const PLAN_SUN = { sunrise: '12:00 AM', sunset: '12:00 PM' }; // to size a prompt before the lookup

const USAGE = `Usage: node scripts/rewrite-summaries.js (--only <date|id>,… | --from-repair) --engine openai|ollama [options]
       node scripts/rewrite-summaries.js --apply <file.json> [--yes] [--local]
  --only <list>          these episodes (YYYY-MM-DD dates or episode IDs, comma-separated)
  --from-repair          the episodes the transcript repair has published or finished (transcripts/.repair/progress.json)
  --progress <file>      another repair state file (the one --from-repair reads, and that says what the repair is working on)
  --engine openai        GPT-4o-mini: paid (about half a cent a show), only within --max-cost
  --engine ollama        a local model through Ollama: free (the Ollama app or \`ollama serve\` has to be running)
  --model <name>         the Ollama model (default ${OLLAMA_MODEL})
  --num-ctx <tokens>     Ollama's context size (default ${OLLAMA_NUM_CTX}, ${OLLAMA_NUM_CTX_THINKING} with --think); a longer transcript leaves out its shortest lines
  --think                let a thinking model reason before it answers (Ollama keeps the reasoning out of the answer; slower)
  --ollama-url <url>     where Ollama answers (default ${OLLAMA_URL})
  --max-cost <dollars>   the most OpenAI may cost (default 0: show the plan and the cost, and stop)
  --plan                 show the episodes, their size and the cost, and stop: no model is asked
  --yes                  write the new summaries (after a backup); without it, nothing is written
  --apply <file.json>    write the summaries a dry run saved, as they are in the file
  --local                the local D1 copy (a test run: ROE_PERSIST_TO)`;

// ── Small things ──────────────────────────────────────────────────────

/** "Sep 27 22:41:03", like the owner's `date "+%b %-d %H:%M:%S"`. */
function stamp(d = new Date()) {
	return `${d.toLocaleString('en-US', { month: 'short' })} ${d.getDate()} ${d.toTimeString().slice(0, 8)}`;
}

const plural = (n, word, many = `${word}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? word : many}`;
const number = (n) => Math.round(n).toLocaleString('en-US');
const dollars = (usd) => `$${usd < 0.1 && usd > 0 ? usd.toFixed(4) : usd.toFixed(2)}`;
const rel = (file) => {
	const inside = path.relative(projectRoot, file);
	return inside && !inside.startsWith('..') && !path.isAbsolute(inside) ? inside : file;
};
const sqlText = (value) => (value == null ? 'NULL' : `'${escapeSQL(String(value))}'`);
const inList = (ids) => ids.map(sqlText).join(', ');

function writeFileAtomic(file, text) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(`${file}.tmp`, text);
	fs.renameSync(`${file}.tmp`, file);
}

// ── The repair's state ────────────────────────────────────────────────

/** transcripts/.repair/progress.json (or another), null when there is none. */
export function readRepairState(file) {
	if (!fs.existsSync(file)) return null;
	return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

/** The episodes the repair has finished: a new transcript published, or a lines-only or duration fix done. */
export function repairFinished(progress) {
	return Object.entries(progress?.episodes ?? {})
		.filter(([, r]) => FINISHED.includes(r?.state))
		.map(([id, r]) => ({ id, repair: `${r.act} ${r.state}` }))
		.sort((a, b) => a.id.localeCompare(b.id));
}

/** --from-repair: the finished episodes D1 has (with the repair's act and state), and the IDs it doesn't. */
export function fromRepair(progress, db) {
	const finished = repairFinished(progress);
	const inD1 = new Set(finished.length ? db.query(`SELECT id FROM episodes WHERE id IN (${inList(finished.map((f) => f.id))})`).map((r) => r.id) : []);
	return { picked: finished.filter((f) => inD1.has(f.id)), notInD1: finished.filter((f) => !inD1.has(f.id)).map((f) => f.id) };
}

/** The episodes the repair is working on (id -> its state): they are left alone. */
export function repairBusy(progress) {
	return new Map(Object.entries(progress?.episodes ?? {})
		.filter(([, r]) => !AT_REST.includes(r?.state))
		.map(([id, r]) => [id, r?.state ?? 'starting afresh']));
}

// ── D1 ────────────────────────────────────────────────────────────────

/** D1 through wrangler: production, or the local copy. Tests give their own { query, importSQL }. */
export function wranglerDb({ isLocal = false } = {}) {
	return { query: (sql) => queryJSON(sql, { isLocal }), importSQL: (sql) => runSQLFile(sql, { isLocal }) };
}

/**
 * The episodes' rows as this script uses them, by ID: the episode, its guests
 * (in name order), and its lines' count, characters and last end.
 */
export function loadEpisodes(db, ids) {
	if (ids.length === 0) return new Map();
	const list = inList(ids);
	const rows = db.query(`SELECT id, title, summary, guests_reviewed, guest_start_ms, duration_ms FROM episodes WHERE id IN (${list})`);
	const guests = db.query(`SELECT episode_id, guest_name FROM episode_guests WHERE episode_id IN (${list}) ORDER BY episode_id, guest_name`);
	const stats = db.query(`SELECT episode_id, COUNT(*) AS line_count, SUM(LENGTH(text)) AS chars, MAX(end_ms) AS last_end_ms FROM transcript_segments WHERE episode_id IN (${list}) GROUP BY episode_id`);
	const statsOf = new Map(stats.map((s) => [s.episode_id, s]));
	return new Map(rows.map((r) => {
		const s = statsOf.get(r.id);
		return [r.id, {
			...r,
			reviewed: r.guests_reviewed === 1,
			guests: guests.filter((g) => g.episode_id === r.id).map((g) => g.guest_name),
			line_count: s?.line_count ?? 0,
			chars: s?.chars ?? 0,
			last_end_ms: s?.last_end_ms ?? 0,
		}];
	}));
}

const linesSQL = (id) => `SELECT start_ms, end_ms, text FROM transcript_segments WHERE episode_id = ${sqlText(id)} ORDER BY start_ms, id`;

/**
 * What tells a transcript from another: its lines, characters (code points, as SQLite's
 * LENGTH counts them) and last end, the figures loadEpisodes has for what D1 holds now.
 */
export function transcriptPrint(lines) {
	return {
		lines: lines.length,
		chars: lines.reduce((n, l) => n + [...l.text].length, 0),
		last_end_ms: lines.reduce((max, l) => Math.max(max, l.end_ms), 0),
	};
}

const sameTranscript = (ep, print) => ep.line_count === print.lines && ep.chars === print.chars && ep.last_end_ms === print.last_end_ms;

// ── The plan ──────────────────────────────────────────────────────────

/**
 * One episode's size and cost, from its line counts (no lines read): whether it is
 * too thin to summarize (the Worker's rule), the prompt's tokens, how far over a
 * local model's context its transcript is, and what OpenAI would cost.
 */
export function planEpisode(ep, { numCtx = OLLAMA_NUM_CTX, think = false } = {}) {
	const thin = ep.line_count < THIN_MIN_SEGMENTS || (ep.duration_ms > 0 && ep.last_end_ms < THIN_MIN_COVERAGE * ep.duration_ms);
	const transcriptTokens = Math.ceil((ep.chars + Math.max(0, ep.line_count - 1)) / CHARS_PER_TOKEN);
	const tokens = promptTokens(summaryMessages(ep, '', PLAN_SUN)) + transcriptTokens;
	return {
		thin,
		tokens,
		overBy: Math.max(0, transcriptTokens - transcriptBudget(ep, PLAN_SUN, { numCtx, think })),
		usd: thin ? 0 : tokens * OPENAI_USD_PER_TOKEN.in + OPENAI_REPLY_TOKENS * OPENAI_USD_PER_TOKEN.out,
	};
}

function printPlan(episodes, { engine, model, numCtx, think, database, picked }) {
	const how = engine === 'openai' ? `${OPENAI_MODEL} (OpenAI)` : `${model} (Ollama, a ${number(numCtx)}-token context, thinking ${think ? 'on' : 'off'})`;
	console.log(`[${stamp()}] ${plural(episodes.length, 'episode')} (${picked}) in ${database === 'local' ? 'the local D1 copy' : 'production D1'}; new summaries from ${how}\n`);
	console.log(`  date        repair        reviewed  lines    tokens`);
	for (const ep of episodes) {
		const p = ep.plan;
		const note = p.thin ? 'too thin to summarize: its summary stays'
			: engine === 'ollama' && p.overBy > 0 ? `about ${number(p.overBy)} tokens of its shortest lines left out to fit` : '';
		console.log(`  ${parseEpisodeDate(ep.id) ?? ep.id}  ${(ep.repair ?? '').padEnd(12)}  ${(ep.reviewed ? 'yes' : 'no').padEnd(8)}  ${number(ep.line_count).padStart(5)}  ${`~${number(p.tokens)}`.padStart(8)}  ${note}`.trimEnd());
	}
	const todo = episodes.filter((e) => !e.plan.thin);
	const usd = todo.reduce((n, e) => n + e.plan.usd, 0);
	const trimmed = todo.filter((e) => e.plan.overBy > 0).length;
	console.log(`\n${plural(todo.length, 'summary', 'summaries')} to rewrite, ${todo.filter((e) => e.reviewed).length} of them on reviewed episodes (their guests and reviewed flag stay)${todo.length < episodes.length ? `; ${episodes.length - todo.length} too thin (kept as they are)` : ''}`);
	if (engine === 'openai') {
		console.log(`Cost: about ${dollars(usd)} of OpenAI (${number(todo.reduce((n, e) => n + e.plan.tokens, 0))} tokens in at most; a dry run spends it too, since it makes the summaries to show them)`);
	} else {
		console.log(`Cost: $0 (a local model; OpenAI would be about ${dollars(usd)})${trimmed ? `. ${plural(trimmed, 'transcript')} too long for the context lose some short lines (a larger --num-ctx avoids it)` : ''}`);
	}
}

// ── A new summary ─────────────────────────────────────────────────────

/** What the review file keeps about an episode, whatever happens to it. */
function reviewRecord(ep) {
	return {
		id: ep.id,
		date: parseEpisodeDate(ep.id),
		title: ep.title,
		reviewed: ep.reviewed,
		guests: ep.guests,
		repair: ep.repair ?? null,
		line_count: ep.line_count,
		old_summary: ep.summary ?? null,
	};
}

/**
 * Ask the engine for one episode's new summary. An episode's own failure comes back
 * as status 'failed' (with stopRun when the next episode would fail the same way:
 * Ollama not running or not answering in time, a bad key, no such model). `usd` is
 * what every OpenAI answer cost, those refused included.
 * @param {object} ep - from loadEpisodes (with .repair when known)
 * @param {Array<{start_ms: number, end_ms: number, text: string}>} lines - the transcript in D1
 * @param {{engine: 'openai'|'ollama', apiKey?, model?, numCtx?, think?, ollamaUrl?, fetchImpl?, request?, timeoutMs?, log?}} opts
 */
export async function rewriteEpisode(ep, lines, { engine, apiKey, model, numCtx, think = false, ollamaUrl, fetchImpl = fetch, request = httpRequest, timeoutMs, log = console.warn }) {
	// The transcript the summary is made from: a later write checks D1 still has it
	const record = { ...reviewRecord(ep), line_count: lines.length, transcript: transcriptPrint(lines) };
	if (isThinTranscript(lines, ep.duration_ms)) {
		return { ...record, status: 'kept', reason: `the transcript is too thin to summarize (${plural(lines.length, 'line')})` };
	}
	const meter = { usd: 0 };
	try {
		const sun = await sunTimes(parseEpisodeDate(ep.id), { fetchImpl });
		const full = lines.map((l) => l.text).join('\n');
		const fit = engine === 'ollama' ? fitTranscript(lines, transcriptBudget(ep, sun, { numCtx, think })) : { text: full, leftOut: 0 };
		const messages = summaryMessages(ep, fit.text, sun);
		const ask = engine === 'openai'
			? () => askOpenAI(messages, { apiKey, fetchImpl, meter, ...(timeoutMs ? { timeoutMs } : {}) })
			: () => askOllama(messages, { url: ollamaUrl, model, numCtx, think, request, ...(timeoutMs ? { timeoutMs } : {}) });
		const answer = await withRetries(ask, engine === 'openai' ? retry.openaiWaitsMs : retry.ollamaWaitsMs, log);
		const context = messages[0].content;
		return {
			...record,
			status: 'rewritten',
			new_summary: answer.summary,
			notes: summaryNotes(answer.summary, full, context),
			old_notes: ep.summary ? summaryNotes(ep.summary, full, context) : [],
			left_out_lines: fit.leftOut,
			prompt_tokens: answer.promptTokens,
			reply_tokens: answer.replyTokens,
			...(answer.thinkingChars ? { thinking_chars: answer.thinkingChars } : {}),
			...(answer.seconds != null ? { seconds: answer.seconds } : {}),
			usd: meter.usd,
		};
	} catch (err) {
		// A local model that gave no answer in the time limit (asked twice) won't for the next show either
		const stopRun = err.stopRun || (engine === 'ollama' && err.name === 'TimeoutError');
		return { ...record, status: 'failed', error: err.message.split('\n')[0], usd: meter.usd, ...(stopRun ? { stopRun: true } : {}) };
	}
}

// ── Showing them ──────────────────────────────────────────────────────

function wrap(text, width) {
	const out = [];
	for (const paragraph of String(text).split('\n')) {
		let line = '';
		for (let word of paragraph.split(/\s+/).filter(Boolean)) {
			if (line && line.length + 1 + word.length > width) {
				out.push(line);
				line = '';
			}
			while (word.length > width) {
				out.push(word.slice(0, width));
				word = word.slice(width);
			}
			line = line ? `${line} ${word}` : word;
		}
		out.push(line);
	}
	return out;
}

/** Two texts in two columns, `width` characters in all. */
export function sideBySide(left, right, width = 120) {
	const col = Math.max(24, Math.floor((width - 3) / 2));
	const a = wrap(left, col);
	const b = wrap(right, col);
	return Array.from({ length: Math.max(a.length, b.length) }, (_, i) => `${(a[i] ?? '').padEnd(col)} | ${b[i] ?? ''}`.trimEnd());
}

function describe(e) {
	return [
		e.reviewed ? 'reviewed' : 'not reviewed',
		e.guests?.length ? `guests: ${e.guests.join(', ')}` : 'no guests',
		...(e.repair ? [`repair: ${e.repair}`] : []),
		`${plural(e.line_count ?? 0, 'line')}${e.left_out_lines ? ` (${number(e.left_out_lines)} short ones left out to fit)` : ''}`,
		...(e.prompt_tokens ? [`${number(e.prompt_tokens)} tokens in`] : []),
		...(e.thinking_chars ? [`${number(e.thinking_chars)} characters of thinking`] : []),
		...(e.seconds != null ? [`${e.seconds < 90 ? `${e.seconds} s` : `${(e.seconds / 60).toFixed(1)} min`}`] : []),
		...(e.usd ? [dollars(e.usd)] : []),
	].join(' · ');
}

function printRecord(e, width) {
	const say = (line) => console.log(`  ${line}`);
	say(describe(e));
	if (e.status === 'rewritten') {
		for (const line of sideBySide('BEFORE', 'AFTER', width)) say(line);
		for (const line of sideBySide(e.old_summary ?? '(no summary)', e.new_summary, width)) say(line);
		for (const n of e.old_notes ?? []) say(`check (before): ${n}`);
		for (const n of e.notes ?? []) say(`check (after): ${n}`);
	} else if (e.status === 'kept') {
		say(`kept as it is: ${e.reason}`);
	} else {
		say(`FAILED: ${e.error}`);
	}
	console.log();
}

/** The review file as Markdown: each episode's summary before and after, with what to check. */
export function reviewMarkdown(review, jsonFile) {
	const n = (status) => review.episodes.filter((e) => e.status === status).length;
	const usd = review.episodes.reduce((sum, e) => sum + (e.usd ?? 0), 0);
	const when = (iso) => new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
	const out = [
		`# New summaries: ${review.engine} ${review.model}`,
		'',
		`Made ${when(review.made_at)} from the transcripts in ${review.database === 'local' ? 'the local D1 copy' : 'production D1'} (${review.picked}). ${plural(review.episodes.length, 'episode')}: ${n('rewritten')} rewritten, ${n('kept')} kept as they are, ${n('failed')} failed${review.engine === 'openai' ? `; OpenAI ${dollars(usd)}` : ''}.`,
		'',
	];
	for (const w of review.writes ?? []) {
		out.push(`Written ${when(w.at)}: ${plural(w.ids.length, 'summary', 'summaries')}. The old ones: ${rel(w.backup)} (its restore.sql puts them back).`);
	}
	if (!review.writes?.length) {
		out.push(`Nothing has been written. To write the new summaries as they are in ${path.basename(jsonFile)} (edit them there first if you like):`, '', '```',
			`node scripts/rewrite-summaries.js --apply "${rel(jsonFile)}"${review.database === 'local' ? ' --local' : ''} --yes`, '```');
	}
	const checks = (notes) => (notes?.length ? ['', ...notes.map((note) => `- Check: ${note}`)] : []);
	for (const e of review.episodes) {
		out.push('', `## ${e.date ?? e.id}: ${e.title}`, '', `\`${e.id}\` · ${describe(e)}`, '');
		if (e.status === 'rewritten') {
			out.push('**Before**', '', e.old_summary ?? '_(no summary)_', ...checks(e.old_notes), '', '**After**', '', e.new_summary, ...checks(e.notes));
		} else {
			out.push(e.status === 'kept' ? `**Kept as it is:** ${e.reason}.` : `**Failed:** ${e.error}`, '', e.old_summary ?? '_(no summary)_');
		}
	}
	return out.join('\n') + '\n';
}

function saveReview(review, jsonFile) {
	writeFileAtomic(jsonFile, JSON.stringify(review, null, 1) + '\n');
	writeFileAtomic(jsonFile.replace(/\.json$/, '.md'), reviewMarkdown(review, jsonFile));
}

// ── Writing ───────────────────────────────────────────────────────────

/**
 * Which new summaries to write, against the rows D1 has now: only where the summary is
 * still the one the new one was made against (`old_summary`), and the transcript still
 * the one it was made from (`transcript`, when known: the repair may have redone it).
 * @param {Array<{id: string, old_summary: string|null, new_summary: string, transcript?: object}>} wanted
 * @param {Map<string, object>} now - loadEpisodes
 * @returns {{changes: object[], leftAlone: {id: string, why: string}[], already: string[]}} already: D1 has the new summary
 */
export function summaryChanges(wanted, now) {
	const changes = [];
	const leftAlone = [];
	const already = [];
	for (const w of wanted) {
		const ep = now.get(w.id);
		if (!ep) leftAlone.push({ id: w.id, why: 'not in the database' });
		else if (ep.summary === w.new_summary) already.push(w.id);
		else if ((ep.summary ?? null) !== (w.old_summary ?? null)) leftAlone.push({ id: w.id, why: 'its summary changed after the new one was made' });
		else if (w.transcript && !sameTranscript(ep, w.transcript)) leftAlone.push({ id: w.id, why: 'its transcript changed after the new summary was made from it' });
		else changes.push({ id: w.id, old_summary: ep.summary ?? null, new_summary: w.new_summary });
	}
	return { changes, leftAlone, already };
}

/**
 * The one D1 import that writes new summaries: the summary column only, and each one
 * only where the summary is still the old one (so a summary changed meanwhile, by hand
 * or by another run, is left alone).
 */
export function summaryUpdateSQL(changes) {
	return changes.map((c) => `UPDATE episodes SET summary = ${sqlText(c.new_summary)} WHERE id = ${sqlText(c.id)} AND summary IS ${sqlText(c.old_summary)};`).join('\n') + '\n';
}

/**
 * SQL that puts the old summaries back (the summary column only), each where the summary
 * is still the one written: one changed since, or never written, is left as it is.
 */
export function restoreSQL(changes) {
	return [
		'-- Puts back the summaries rewrite-summaries.js replaced (it changed nothing but the summary column),',
		'-- each only where the summary is still the one it wrote.',
		...changes.map((c) => `UPDATE episodes SET summary = ${sqlText(c.old_summary)} WHERE id = ${sqlText(c.id)} AND summary IS ${sqlText(c.new_summary)};`),
	].join('\n') + '\n';
}

/** transcripts/.backups/<date>-summaries/: the old summaries (and the new), restore.sql and a README. */
export function backupSummaries(changes, { database = 'production', source = '' } = {}) {
	const dir = newBackupDir('summaries');
	const persistTo = process.env.ROE_PERSIST_TO ? ` --persist-to "${path.resolve(process.env.ROE_PERSIST_TO)}"` : ''; // a test run's own local D1
	const target = database === 'local' ? `--local${persistTo}` : '--remote';
	fs.writeFileSync(path.join(dir, 'summaries.json'), JSON.stringify({
		taken_at: new Date().toISOString(),
		database,
		source,
		episodes: changes.map((c) => ({ id: c.id, summary: c.old_summary, new_summary: c.new_summary })),
	}, null, 1) + '\n');
	fs.writeFileSync(path.join(dir, 'restore.sql'), restoreSQL(changes));
	fs.writeFileSync(path.join(dir, 'README.txt'), [
		`Summaries rewrite-summaries.js replaced, ${new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}, in the ${database === 'local' ? 'local D1 copy (--local)' : 'production D1 database'}.`,
		...(source ? [`The new ones came from ${source}.`] : []),
		'',
		`  summaries.json  each episode's summary before (summary) and the one written (new_summary): ${changes.length}`,
		'  restore.sql     puts the old summaries back (the summary column only; nothing else was changed),',
		'                  each where the summary is still the one written (one changed since stays)',
		'',
		'To put them back:',
		'  cd roe-search',
		`  env -u CLOUDFLARE_API_TOKEN npx wrangler d1 execute roe-episodes ${target} --file "${path.join(dir, 'restore.sql')}"`,
		'',
	].join('\n'));
	return dir;
}

/**
 * After the import: which new summaries are in, and anything else about the episodes
 * that changed (nothing should: the import sets the summary only).
 */
export function checkWritten(changes, before, after) {
	const written = [];
	const problems = [];
	for (const c of changes) {
		const b = before.get(c.id);
		const a = after.get(c.id);
		if (!a) {
			problems.push(`${c.id}: no longer in the database`);
			continue;
		}
		if (a.summary === c.new_summary) written.push(c.id);
		else problems.push(`${c.id}: its summary isn't the new one (something else changed it as it was written?)`);
		for (const col of ['title', 'guests_reviewed', 'guest_start_ms']) {
			if (a[col] !== b[col]) problems.push(`${c.id}: ${col} changed (${JSON.stringify(b[col])} -> ${JSON.stringify(a[col])})`);
		}
		if (a.guests.join('\n') !== b.guests.join('\n')) problems.push(`${c.id}: its guests changed`);
	}
	return { written, problems };
}

/**
 * Write new summaries: read the episodes again, back up the summaries they have, one
 * import, then check what D1 has, even when the import reported an error (it may have
 * applied all the same). Returns { dir, written, leftAlone, already, problems } (dir: the backup).
 */
export function writeSummaries(db, wanted, { database = 'production', source = '' } = {}) {
	const before = loadEpisodes(db, wanted.map((w) => w.id));
	const { changes, leftAlone, already } = summaryChanges(wanted, before);
	if (changes.length === 0) return { dir: null, written: [], leftAlone, already, problems: [] };
	const dir = backupSummaries(changes, { database, source });
	let importError = null;
	try {
		db.importSQL(summaryUpdateSQL(changes));
	} catch (err) {
		importError = err;
	}
	const after = loadEpisodes(db, changes.map((c) => c.id));
	const { written, problems } = checkWritten(changes, before, after);
	if (importError) problems.unshift(`the import reported an error (${importError.message.split('\n')[0]}); what D1 holds now is checked below`);
	return { dir, written, leftAlone, already, problems };
}

function reportWrite(result) {
	if (result.dir) {
		console.log(`[${stamp()}] Backed up the old summaries to ${rel(result.dir)} (restore.sql puts them back)`);
		console.log(`[${stamp()}] Wrote ${plural(result.written.length, 'new summary', 'new summaries')}${result.problems.length ? '' : '; checked: the new summaries are in, and titles, guests, reviewed flags and interview times are unchanged'}`);
	} else {
		console.log(`[${stamp()}] Nothing to write`);
	}
	if (result.already.length > 0) console.log(`  ${plural(result.already.length, 'episode')} already had the new summary`);
	for (const l of result.leftAlone) console.log(`  left alone: ${l.id}: ${l.why}`);
	for (const p of result.problems) console.log(`  PROBLEM: ${p}`);
}

/** Note a write in the review file (and its .md), so it says what was written and where the old ones went. */
function noteWrite(review, jsonFile, result) {
	if (!result.dir) return;
	review.writes = [...(review.writes ?? []), { at: new Date().toISOString(), backup: result.dir, ids: result.written }];
	saveReview(review, jsonFile);
}

// ── --apply ───────────────────────────────────────────────────────────

/** The new summaries in a review file, less those the repair is working on. */
export function reviewedSummaries(review, busy = new Map()) {
	const wanted = [];
	const skipped = [];
	for (const e of review.episodes ?? []) {
		if (e.status !== 'rewritten') continue;
		const text = typeof e.new_summary === 'string' ? e.new_summary.trim() : '';
		if (!text) skipped.push({ id: e.id, why: 'no new summary in the file' });
		else if (busy.has(e.id)) skipped.push({ id: e.id, why: `the repair is working on it (${busy.get(e.id)})` });
		else wanted.push({ id: e.id, old_summary: e.old_summary ?? null, new_summary: text, ...(e.transcript ? { transcript: e.transcript } : {}) });
	}
	return { wanted, skipped };
}

function applyReview(file, db, { yes, database, busy }) {
	const review = JSON.parse(fs.readFileSync(file, 'utf-8'));
	if ((review.database ?? 'production') !== database) {
		quit(`${rel(file)} was made from the ${review.database === 'local' ? 'local D1 copy' : 'production database'}: ${database === 'local' ? 'leave out' : 'add'} --local`);
	}
	const { wanted, skipped } = reviewedSummaries(review, busy);
	for (const s of skipped) console.log(`  left out: ${s.id}: ${s.why}`);
	const where = database === 'local' ? 'the local D1 copy' : 'production D1';
	if (!yes) {
		const { changes, leftAlone, already } = summaryChanges(wanted, loadEpisodes(db, wanted.map((w) => w.id)));
		if (already.length > 0) console.log(`  ${plural(already.length, 'episode')} already had the new summary`);
		for (const l of leftAlone) console.log(`  left alone: ${l.id}: ${l.why}`);
		console.log(`[${stamp()}] ${rel(file)} (${review.engine} ${review.model}): ${plural(changes.length, 'new summary', 'new summaries')} to write to ${where}. Nothing was written: add --yes to write ${changes.length === 1 ? 'it' : 'them'} (the old ones are backed up first).`);
		return 0;
	}
	console.log(`[${stamp()}] Writing the new summaries in ${rel(file)} (${review.engine} ${review.model}) to ${where}`);
	const result = writeSummaries(db, wanted, { database, source: `${rel(file)} (${review.engine} ${review.model})` });
	reportWrite(result);
	noteWrite(review, file, result);
	return result.problems.length > 0 ? 1 : 0;
}

// ── The GPU ───────────────────────────────────────────────────────────

/**
 * The whisper-cli processes on the GPU (not given -ng) in `ps -axo pid=,args=`
 * output, by pid: the repair's transcriptions. A local model beside one would slow
 * both, and could take the transcription past its time limit.
 */
export function whisperOnGpu(psOutput) {
	return psOutput.split('\n').map((l) => l.trim().split(/\s+/)).filter(([, command = '', ...args]) => path.basename(command) === 'whisper-cli' && !args.includes('-ng')).map(([pid]) => Number(pid));
}

function runningWhisperOnGpu() {
	try {
		return whisperOnGpu(execFileSync('ps', ['-axo', 'pid=,args='], { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 }));
	} catch {
		return [];
	}
}

// ── CLI ───────────────────────────────────────────────────────────────

function quit(problem) {
	console.error(problem);
	process.exit(1);
}

async function main() {
	const { flags, rest } = parseFlags(process.argv.slice(2), {
		'--only': 'value', '--from-repair': 'flag', '--progress': 'value', '--engine': 'value', '--model': 'value', '--num-ctx': 'value',
		'--think': 'flag', '--ollama-url': 'value', '--max-cost': 'value', '--plan': 'flag', '--yes': 'flag', '--apply': 'value', '--local': 'flag',
	}, USAGE);
	const stop = (problem) => quit(`${problem}\n\n${USAGE}`);
	if (rest.length > 0) stop(`Not an option: ${rest.join(' ')}`);
	const isLocal = !!flags.local;
	const database = isLocal ? 'local' : 'production';
	if (process.env.ROE_PERSIST_TO && !isLocal) stop('ROE_PERSIST_TO is set (a test run): add --local');
	loadEnv();

	// The repair's state, when it is for this database (a --local run on the developer's copy
	// may find production's): what it has finished (--from-repair) and what it is working on
	const progressFile = flags.progress ? path.resolve(flags.progress) : path.join(transcriptsDir, '.repair', 'progress.json');
	let repair = readRepairState(progressFile);
	if (repair && (repair.database ?? 'production') !== database) {
		if (flags['from-repair']) quit(`${rel(progressFile)} is the repair's state on the ${repair.database ?? 'production'} database, not the ${database} one`);
		repair = null;
	}
	const busy = repairBusy(repair);
	const db = wranglerDb({ isLocal });

	if (flags.apply) {
		const extra = ['only', 'from-repair', 'engine', 'model', 'num-ctx', 'think', 'ollama-url', 'max-cost', 'plan'].filter((f) => flags[f] !== undefined);
		if (extra.length > 0) stop(`--apply goes with --yes, --local and --progress only (not --${extra.join(', --')})`);
		process.exitCode = applyReview(path.resolve(flags.apply), db, { yes: !!flags.yes, database, busy });
		return;
	}

	// What to do, and how
	if (!flags.only === !flags['from-repair']) stop('Say which episodes: --only <date|id>,… or --from-repair');
	const engine = flags.engine;
	if (!['openai', 'ollama'].includes(engine)) stop('Say which engine: --engine openai or --engine ollama');
	const ollamaOnly = ['model', 'num-ctx', 'think', 'ollama-url'].filter((f) => flags[f] !== undefined);
	if (engine !== 'ollama' && ollamaOnly.length > 0) stop(`--${ollamaOnly.join(', --')} ${ollamaOnly.length > 1 ? 'are' : 'is'} for --engine ollama`);
	if (engine !== 'openai' && flags['max-cost'] !== undefined) stop('--max-cost is for --engine openai');
	const think = !!flags.think;
	const numCtx = flags['num-ctx'] === undefined ? (think ? OLLAMA_NUM_CTX_THINKING : OLLAMA_NUM_CTX) : Number(flags['num-ctx']);
	if (!Number.isInteger(numCtx) || numCtx < 4096) stop('--num-ctx needs a whole number of tokens, 4096 or more');
	const maxCost = flags['max-cost'] === undefined ? 0 : Number(flags['max-cost']);
	if (!(maxCost >= 0)) stop('--max-cost needs an amount in dollars');
	const model = engine === 'openai' ? OPENAI_MODEL : (flags.model ?? OLLAMA_MODEL);
	const ollamaUrl = (flags['ollama-url'] ?? OLLAMA_URL).replace(/\/+$/, '');

	// Which episodes
	let picked;
	let label;
	if (flags['from-repair']) {
		if (!repair) quit(`No repair state at ${rel(progressFile)}`);
		const { picked: finished, notInD1 } = fromRepair(repair, db);
		if (notInD1.length > 0) console.log(`Not in D1, left out: ${notInD1.join(', ')}`);
		picked = finished;
		label = `the repair's published and finished episodes, from ${rel(progressFile)}`;
	} else {
		try {
			picked = pickEpisodes(db.query('SELECT id FROM episodes ORDER BY id'), flags.only)
				.map(({ id }) => ({ id, repair: repair?.episodes?.[id] ? `${repair.episodes[id].act} ${repair.episodes[id].state ?? ''}`.trim() : null }));
		} catch (err) {
			quit(err.message);
		}
		label = `--only ${flags.only}`;
	}
	const working = picked.filter((p) => busy.has(p.id));
	if (working.length > 0) console.log(`The repair is working on these, left out: ${working.map((p) => `${p.id} (${busy.get(p.id)})`).join(', ')}`);
	picked = picked.filter((p) => !busy.has(p.id));
	if (picked.length === 0) quit('No episodes to rewrite.');
	const rows = loadEpisodes(db, picked.map((p) => p.id));
	const episodes = picked.map((p) => ({ ...rows.get(p.id), repair: p.repair }));
	for (const ep of episodes) ep.plan = planEpisode(ep, { numCtx, think });

	printPlan(episodes, { engine, model, numCtx, think, database, picked: label });
	if (flags.plan) {
		console.log('\nNothing was asked or written (--plan).');
		return;
	}
	const todo = episodes.filter((e) => !e.plan.thin);
	const estimate = todo.reduce((n, e) => n + e.plan.usd, 0);
	let apiKey;
	if (engine === 'openai') {
		if (estimate > maxCost) quit(`\nOpenAI would cost about ${dollars(estimate)}, more than --max-cost ${dollars(maxCost)}: run again with --max-cost ${Math.max(0.01, Math.ceil(estimate * 1.25 * 100) / 100).toFixed(2)} to go ahead. Nothing was asked or written.`);
		apiKey = process.env.OPENAI_API_KEY;
		if (!apiKey) quit('\nOPENAI_API_KEY is not set (add it to .env)');
	} else {
		const onThisMac = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(ollamaUrl).hostname);
		const whisper = onThisMac ? runningWhisperOnGpu() : [];
		if (whisper.length > 0) quit(`\nwhisper.cpp is transcribing on the GPU (whisper-cli, pid ${whisper.join(', ')}; the repair?): a local model would share the GPU with it, slow both, and could take the transcription past its time limit. Run this when it has finished (pgrep -fl whisper-cli). Nothing was asked or written.`);
		const models = await ollamaModels(ollamaUrl).catch((err) => quit(`\n${err.message}`));
		if (!models.includes(model) && !models.includes(`${model}:latest`)) quit(`\nOllama doesn't have ${model} (it has: ${models.join(', ') || 'none'}): \`ollama pull ${model}\`, or --model <one of those>`);
	}

	// Ask, one episode at a time, keeping the review file up to date
	const made = new Date();
	const fileStamp = [made.getFullYear(), made.getMonth() + 1, made.getDate()].map((n) => String(n).padStart(2, '0')).join('-')
		+ `-${made.toTimeString().slice(0, 8).replace(/:/g, '')}`; // local time, like the backups' folders
	const reviewFile = path.join(transcriptsDir, '.summaries', `${fileStamp}-${engine}-${model.replace(/[^\w.-]+/g, '-')}.json`);
	const review = {
		made_at: made.toISOString(),
		engine,
		model,
		...(engine === 'ollama' ? { num_ctx: numCtx, think } : {}),
		database,
		picked: label,
		episodes: [],
	};
	const width = Math.min(process.stdout.columns || 120, 160) - 2;
	console.log(`\n[${stamp()}] Asking ${model} for ${plural(episodes.length, 'episode')}; the review file: ${rel(reviewFile)} (and .md)\n`);
	let spent = 0;
	let failedInARow = 0;
	let stopped = null;
	for (const [i, ep] of episodes.entries()) {
		if (engine === 'openai' && !ep.plan.thin && spent + ep.plan.usd > maxCost) {
			stopped = `the next one would take OpenAI past --max-cost ${dollars(maxCost)} (${dollars(spent)} spent)`;
			break;
		}
		console.log(`[${stamp()}] ${i + 1}/${episodes.length} ${parseEpisodeDate(ep.id) ?? ep.id}: ${ep.title}`);
		const lines = db.query(linesSQL(ep.id));
		const { stopRun, ...record } = await rewriteEpisode(ep, lines, { engine, apiKey, model, numCtx, think, ollamaUrl });
		spent += record.usd ?? 0;
		review.episodes.push(record);
		saveReview(review, reviewFile);
		printRecord(record, width);
		if (stopRun) {
			stopped = record.error;
			break;
		}
		failedInARow = record.status === 'failed' ? failedInARow + 1 : 0;
		if (failedInARow >= FAILED_IN_A_ROW) {
			stopped = `${FAILED_IN_A_ROW} episodes in a row failed (the last: ${record.error})`;
			break;
		}
	}

	const n = (status) => review.episodes.filter((e) => e.status === status).length;
	console.log(`[${stamp()}] ${stopped ? `Stopped: ${stopped}` : 'Done'}. ${n('rewritten')} rewritten, ${n('kept')} kept as they are, ${n('failed')} failed${stopped ? `, ${episodes.length - review.episodes.length} not asked` : ''}${engine === 'openai' ? `; OpenAI ${dollars(spent)}` : ''}`);
	for (const e of review.episodes.filter((x) => x.status === 'failed')) console.log(`  failed: ${e.id}: ${e.error}`);
	const flagged = review.episodes.filter((e) => e.notes?.length).length;
	if (flagged > 0) console.log(`  ${plural(flagged, 'new summary', 'new summaries')} with something to check (the .md lists them)`);
	console.log(`  Review: ${rel(reviewFile.replace(/\.json$/, '.md'))}`);

	if (!flags.yes) {
		console.log(`\nNothing was written. To write these as they are in the review file: node scripts/rewrite-summaries.js --apply "${rel(reviewFile)}"${isLocal ? ' --local' : ''} --yes`);
		process.exitCode = stopped ? 1 : 0;
		return;
	}
	// The repair may have moved on during a long run: what it is working on now is left out
	const { wanted, skipped } = reviewedSummaries(review, repair ? repairBusy(readRepairState(progressFile)) : busy);
	for (const s of skipped) console.log(`  left out: ${s.id}: ${s.why}`);
	if (wanted.length === 0) {
		console.log('\nNo new summaries to write.');
		process.exitCode = stopped ? 1 : 0;
		return;
	}
	console.log(`\n[${stamp()}] Writing ${plural(wanted.length, 'new summary', 'new summaries')} to ${isLocal ? 'the local D1 copy' : 'production D1'}`);
	const result = writeSummaries(db, wanted, { database, source: `${rel(reviewFile)} (${engine} ${model})` });
	reportWrite(result);
	noteWrite(review, reviewFile, result);
	process.exitCode = stopped || result.problems.length > 0 ? 1 : 0;
}

if (import.meta.main) {
	main().catch((err) => {
		console.error(`\n[${stamp()}] Error: ${err.message}`);
		process.exit(1);
	});
}
