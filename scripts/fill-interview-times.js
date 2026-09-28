#!/usr/bin/env node

/**
 * Fill empty and 60:00 interview times ("Skip to interview") with the
 * detector's time (guest-start.js), after the transcript repair. Only a time
 * that is empty or exactly 3,600,000 ms (60:00: what the old detector gave when
 * it found nothing) gets a proposal, or that 60:00 as a join moved it (the
 * repair's progress records the move), or a time in the last 10 minutes of a
 * show 100+ minutes long: the old detector's sign-off pick (it took the first
 * mention after the last song), which the owner asked on 2026-09-28 to have on
 * the list too. Every other time stays as it is, reviewed or not (2026-09-24's
 * 4,637,000 was set by hand). Reviewed episodes are included: their guests
 * were checked, not their interview time. A dry run unless --yes.
 *
 * Each episode's guests and lines are read from D1 as they are now. There is
 * no proposal when the episode has no guests, is shorter than 50 minutes or
 * has no lines after 50 minutes, when the detector finds nothing (it would say
 * 60:00 again), or when its time is past the episode's length; a sign-off time
 * gets 60:00 then (the detector's own "found nothing"), as the goodbye is never
 * the interview. The list (old -> proposed, and the line at the proposed time)
 * is printed and saved as proposals.txt and proposals.json in
 * transcripts/.backups/<date>-interview-times-plan/ (a dry run) or
 * <date>-interview-times/ (--yes).
 *
 * --apply <proposals.json> --yes writes the list a dry run saved, as it is
 * (edit it first: set "proposed" to null to leave an episode out, or to the
 * time you want), without working it out again.
 *
 * With --yes: before.json (the times as they were read) and restore.sql (puts
 * back each time this run set, unless it has changed again since); then one
 * D1 import (applied.sql) sets guest_start_ms and nothing else, each episode
 * only if its time is still the one read; then the times are read back.
 *
 * Usage:
 *   node scripts/fill-interview-times.js (--only <date|id>,… | --from-repair | --all) [--except <dates>] [--progress <file>] [--yes] [--local]
 *   node scripts/fill-interview-times.js --apply <proposals.json> [--progress <file>] [--yes] [--local]
 *
 *   --only         these episodes (YYYY-MM-DD dates or episode IDs, comma-separated)
 *   --from-repair  the episodes transcripts/.repair/progress.json has published or done
 *   --all          every episode in D1
 *   --except       leave these out
 *   --progress     the repair's state file, if not transcripts/.repair/progress.json
 *   --apply        write the proposals a dry run saved (with --yes)
 *   --yes          write the proposed times (after the backup)
 *   --local        the local D1 copy (in a test run, the one under ROE_PERSIST_TO)
 *
 * An episode the repair is working on (not published, done, skipped or set
 * aside) is always left out, --only, --apply or not: its transcript is about to
 * change, and the repair checks that its interview time doesn't. The repair's
 * state only counts for the database it was made on (its "database").
 */

import fs from 'node:fs';
import path from 'node:path';

import { escapeSQL, loadEnv, parseFlags, queryJSON, runSQLFile } from './lib.js';
import { newBackupDir } from './episode-backup.js';
import { detectGuestStart, FALLBACK_MS, FULL_SHOW_MS, MIN_START_MS, SIGN_OFF_MS } from './guest-start.js';
import { dateOf, episodeLines, leaveOutBusy, mmss, pickForRun, repairStateForRun } from './repaired-episodes.js';

export const PLACEHOLDER_MS = FALLBACK_MS; // 60:00

const USAGE = [
	'Usage: node scripts/fill-interview-times.js (--only <date|id>,… | --from-repair | --all) [--except <dates>] [--progress <file>] [--yes] [--local]',
	'       node scripts/fill-interview-times.js --apply <proposals.json> [--progress <file>] [--yes] [--local]',
].join('\n');

/** The 60:00 of a joined show, as the join moved it (the repair's progress records the move), or null. */
export function movedPlaceholder(progress, episodeId) {
	const moved = progress?.episodes?.[episodeId]?.shift?.guest_start_ms;
	return Array.isArray(moved) && moved[0] === PLACEHOLDER_MS && Number.isInteger(moved[1]) ? moved[1] : null;
}

/** Whether a time is in the last 10 minutes of a show 100+ minutes long: the old detector's sign-off pick. */
export const inSignOff = (ms, durationMs) => ms != null && durationMs != null && durationMs >= FULL_SHOW_MS && ms >= durationMs - SIGN_OFF_MS;

/** Whether an interview time may be filled: empty, the old detector's 60:00, that 60:00 moved by a join, or a sign-off pick. */
export const fillable = (ms, moved = null, durationMs = null) => ms == null || ms === PLACEHOLDER_MS || (moved != null && ms === moved) || inSignOff(ms, durationMs);

/**
 * What to do with one episode's interview time.
 * @param {{id: string, duration_ms: number|null, guest_start_ms: number|null, guests_reviewed: number}} ep
 * @param {string[]} guests
 * @param {Array<{start_ms: number, end_ms: number, text: string}>} lines - D1's lines now
 * @param {{moved?: number|null}} [opts] - its 60:00 as a join moved it (movedPlaceholder)
 * @returns {{id, date, reviewed, guests, old, moved60, duration_ms, signOff: boolean, proposed: number|null, line: string|null, reason: string}}
 */
export function proposeTime(ep, guests, lines, { moved = null } = {}) {
	const signOff = ep.guest_start_ms !== PLACEHOLDER_MS && ep.guest_start_ms !== moved && inSignOff(ep.guest_start_ms, ep.duration_ms);
	const base = { id: ep.id, date: dateOf(ep.id), reviewed: ep.guests_reviewed === 1, guests, old: ep.guest_start_ms ?? null, moved60: moved, duration_ms: ep.duration_ms ?? null, signOff, proposed: null, line: null };
	if (!fillable(ep.guest_start_ms, moved, ep.duration_ms)) return { ...base, reason: 'has a time: kept' };
	if (guests.length === 0) return { ...base, reason: 'no guests' };
	if (ep.duration_ms && ep.duration_ms < MIN_START_MS) return { ...base, reason: 'shorter than 50 minutes' };
	const ms = detectGuestStart(lines, guests);
	let nothing = null;
	if (ms == null) nothing = 'no lines after 50 minutes';
	else if (ms === PLACEHOLDER_MS) nothing = 'the detector finds nothing (it would say 60:00 again)';
	else if (ep.duration_ms && ms > ep.duration_ms) nothing = `the detected ${mmss(ms)} is past the end (${mmss(ep.duration_ms)})`;
	else if (signOff && inSignOff(ms, ep.duration_ms)) nothing = `the detected ${mmss(ms)} is in the sign-off too`;
	// The goodbye is never the interview: a sign-off time gets the detector's own "found nothing"
	if (nothing && signOff) return { ...base, proposed: PLACEHOLDER_MS, reason: `proposed 60:00: ${nothing}` };
	if (nothing) return { ...base, reason: nothing };
	return { ...base, proposed: ms, line: lines.find((s) => s.start_ms === ms)?.text ?? null, reason: 'proposed' };
}

/** A saved proposals.json (--apply), checked: every proposal, as the dry run (or you) left it. */
export function savedProposals(saved, { database }) {
	if (!Array.isArray(saved?.proposals)) throw new Error('Not a proposals.json from fill-interview-times.js');
	if ((saved.database ?? 'production') !== database) throw new Error(`The list was made on the ${saved.database ?? 'production'} database, not the ${database} one`);
	return saved.proposals;
}

const whereTime = (ms) => (ms == null ? 'guest_start_ms IS NULL' : `guest_start_ms = ${ms}`);
const checkMs = (ms) => {
	if (!Number.isInteger(ms) || ms < 0) throw new Error(`Not a time in ms: ${ms}`);
	return ms;
};

/** The statement that sets one proposed time, only where the time is still the one read (empty, 60:00 or a sign-off pick). */
export function fillStatement(p) {
	if (!fillable(p.old, p.moved60, p.duration_ms)) throw new Error(`${p.id}: its interview time ${p.old} is not empty, 60:00 or in the sign-off; refusing to change it`);
	return `UPDATE episodes SET guest_start_ms = ${checkMs(p.proposed)} WHERE id = '${escapeSQL(p.id)}' AND ${whereTime(p.old == null ? null : checkMs(p.old))};`;
}

/** The statement that puts one time back, only where it is still the one this run set. */
export function restoreStatement(p) {
	return `UPDATE episodes SET guest_start_ms = ${p.old == null ? 'NULL' : checkMs(p.old)} WHERE id = '${escapeSQL(p.id)}' AND guest_start_ms = ${checkMs(p.proposed)};`;
}

const oldTime = (p) => `${mmss(p.old).padStart(6)}${p.old != null && p.old === p.moved60 ? ' (60:00 moved by the join)' : p.signOff ? ` (sign-off, of ${mmss(p.duration_ms)})` : ''}`;

/** The list for the owner, as printed and saved. */
export function reportLines(proposals) {
	const out = [];
	for (const p of proposals.filter((p) => p.proposed != null)) {
		out.push(`  ${p.date}  ${oldTime(p)} -> ${mmss(p.proposed).padStart(6)}  ${p.reviewed ? 'reviewed' : 'not reviewed'}  ${p.guests.join(', ')}`);
		out.push(p.reason === 'proposed' ? `              "${(p.line ?? '(no line starts there)').slice(0, 160)}"` : `              (${p.reason})`);
	}
	const kept = proposals.filter((p) => p.proposed == null);
	if (kept.length > 0) {
		out.push('', `  Left as they are (${kept.length}):`);
		for (const p of kept) out.push(`  ${p.date}  ${oldTime(p)}  ${p.reason}`);
	}
	return out;
}

/**
 * Before any change: the times as they were read, restore.sql and applied.sql (what the change
 * runs), and a README with the undo command. Returns the SQL to run.
 */
export function writeBackup(dir, todo, { isLocal = false } = {}) {
	const applied = todo.map(fillStatement).join('\n') + '\n';
	fs.writeFileSync(path.join(dir, 'before.json'), JSON.stringify(todo.map((p) => ({ id: p.id, guest_start_ms: p.old, guests_reviewed: p.reviewed ? 1 : 0 })), null, 1));
	fs.writeFileSync(path.join(dir, 'restore.sql'), [
		'-- Puts back the interview times fill-interview-times.js set,',
		'-- each only where it is still the time that run set.',
		...todo.map(restoreStatement),
	].join('\n') + '\n');
	fs.writeFileSync(path.join(dir, 'applied.sql'), applied);
	fs.writeFileSync(path.join(dir, 'README.txt'), readme(dir, { count: todo.length, isLocal }));
	return applied;
}

function readme(dir, { count, isLocal }) {
	return [
		`Interview times set by fill-interview-times.js --yes, ${new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}, in the ${isLocal ? 'local D1 copy (--local)' : 'production D1 database'}.`,
		'',
		'  proposals.txt   the list: every episode looked at, old -> new, the line at the new time',
		'  proposals.json  the same as data',
		`  before.json     the ${count} interview time${count === 1 ? '' : 's'} as they were read, before the change`,
		'  applied.sql     exactly what was run (each only where the time was still the one read)',
		'  restore.sql     puts back each time this run set, unless it has changed again since',
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
		'--only': 'value', '--from-repair': 'flag', '--all': 'flag', '--except': 'value', '--progress': 'value', '--apply': 'value', '--yes': 'flag', '--local': 'flag',
	}, USAGE);
	const named = [flags.only, flags['from-repair'], flags.all].filter(Boolean).length;
	if (rest.length > 0 || (flags.apply ? named > 0 || flags.except : named !== 1)) {
		console.error(USAGE);
		process.exit(1);
	}
	const target = { isLocal: !!flags.local };
	if (process.env.ROE_PERSIST_TO && !target.isLocal) throw new Error('ROE_PERSIST_TO is set (a test run): add --local');
	const database = target.isLocal ? 'local' : 'production';
	const where = `in the ${target.isLocal ? 'local D1 copy' : 'production database'}`;

	let proposals;
	if (flags.apply) {
		const file = path.resolve(flags.apply);
		proposals = leaveOutBusy(savedProposals(JSON.parse(fs.readFileSync(file, 'utf-8')), { database }), repairStateForRun(flags, target));
		console.log(`${flags.yes ? 'Writing' : 'Dry run (--yes to write):'} the list in ${file}, ${where}\n`);
	} else {
		const all = queryJSON('SELECT id, duration_ms, guest_start_ms, guests_reviewed FROM episodes ORDER BY id', target);
		const { episodes, progress } = pickForRun(all, flags, target);
		console.log(`${flags.yes ? 'Filling' : 'Dry run (--yes to write):'} ${episodes.length} episode${episodes.length === 1 ? '' : 's'}${flags['from-repair'] ? ' the repair has finished' : ''}, ${where}\n`);
		if (episodes.length === 0) return;
		const guests = new Map(episodes.map((e) => [e.id, []]));
		for (const g of queryJSON(`SELECT episode_id, guest_name FROM episode_guests WHERE episode_id IN (${episodes.map((e) => `'${escapeSQL(e.id)}'`).join(', ')}) ORDER BY episode_id, guest_name`, target)) {
			guests.get(g.episode_id).push(g.guest_name);
		}
		// Lines only where a time could be proposed
		const moved = new Map(episodes.map((e) => [e.id, movedPlaceholder(progress, e.id)]));
		const lines = episodeLines(episodes.filter((e) => fillable(e.guest_start_ms, moved.get(e.id), e.duration_ms) && guests.get(e.id).length > 0).map((e) => e.id), target);
		proposals = episodes.map((e) => proposeTime(e, guests.get(e.id), lines.get(e.id) ?? [], { moved: moved.get(e.id) }));
	}
	const todo = proposals.filter((p) => p.proposed != null);

	const report = reportLines(proposals);
	console.log(report.join('\n'));
	const dir = newBackupDir(flags.yes ? 'interview-times' : 'interview-times-plan');
	fs.writeFileSync(path.join(dir, 'proposals.json'), JSON.stringify({ at: new Date().toISOString(), database, ...(flags.apply ? { from: path.resolve(flags.apply) } : {}), proposals }, null, 1));
	fs.writeFileSync(path.join(dir, 'proposals.txt'), `${todo.length} interview time${todo.length === 1 ? '' : 's'} proposed, ${new Date().toISOString()}\n\n${report.join('\n')}\n`);
	console.log(`\n${todo.length} proposed; the list: ${path.join(dir, 'proposals.txt')}`);
	if (!flags.yes) {
		console.log(todo.length > 0
			? `Nothing changed. To write exactly this list: node scripts/fill-interview-times.js --apply "${path.join(dir, 'proposals.json')}" --yes${target.isLocal ? ' --local' : ''}`
			: 'Nothing to change.');
		return;
	}
	if (todo.length === 0) return;

	// Back up, then one import that only changes a time still as it was read
	const applied = writeBackup(dir, todo, { isLocal: target.isLocal });
	console.log(`Backed up to ${dir}`);
	runSQLFile(applied, target);

	const now = new Map(queryJSON(`SELECT id, guest_start_ms FROM episodes WHERE id IN (${todo.map((p) => `'${escapeSQL(p.id)}'`).join(', ')})`, target).map((r) => [r.id, r.guest_start_ms]));
	const missed = todo.filter((p) => now.get(p.id) !== p.proposed);
	console.log(`Set ${todo.length - missed.length} of ${todo.length} interview times.`);
	for (const p of missed) console.log(`  ${p.date}: not set, it is ${mmss(now.get(p.id))} (it changed after it was read, or the episode is gone)`);
	if (missed.length > 0) process.exitCode = 1;
}

if (import.meta.main) {
	main().catch((err) => {
		console.error(`\nError: ${err.message}`);
		process.exit(1);
	});
}
