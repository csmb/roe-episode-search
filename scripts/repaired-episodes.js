/**
 * What the follow-ups to the transcript repair share (fill-interview-times.js,
 * reanchor-place-quotes.js): which episodes to work on (--only, or
 * --from-repair: the ones the repair's progress marks published or done, less
 * --except), never one the repair is still working on; their lines from D1 a
 * page at a time; and m:ss times. The repair's state is
 * transcripts/.repair/progress.json unless --progress names another, and only
 * counts for the database it was made on.
 */

import fs from 'node:fs';
import path from 'node:path';

import { escapeSQL, queryJSON, transcriptsDir } from './lib.js';
import { pickEpisodes } from './scan-transcripts.js';

export const REPAIRED_STATES = ['published', 'done']; // a new transcript published, or a lines-only or duration fix done
export const AT_REST = ['published', 'done', 'skipped', 'set-aside']; // the repair isn't working on these
const PAGE = 20; // episodes per query for the lines: ~40,000 rows

export const repairProgressPath = () => path.join(transcriptsDir, '.repair', 'progress.json');

/** The episode IDs a repair run has finished: redone and published, or its lines or length fixed. */
export function repairedIds(progress) {
	return Object.entries(progress?.episodes ?? {})
		.filter(([, r]) => REPAIRED_STATES.includes(r?.state))
		.map(([id]) => id)
		.sort();
}

/** The episodes the repair is working on (id -> its state): left alone, as the repair checks them. */
export function repairBusy(progress) {
	return new Map(Object.entries(progress?.episodes ?? {})
		.filter(([, r]) => !AT_REST.includes(r?.state))
		.map(([id, r]) => [id, r?.state ?? 'starting afresh']));
}

/**
 * The repair's state for this database, or null when there is none (or, without --from-repair, it
 * is another database's). Throws when --from-repair can't use it.
 */
export function loadRepairState({ file = repairProgressPath(), isLocal = false, fromRepair = false } = {}) {
	const progress = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : null;
	const database = isLocal ? 'local' : 'production';
	if (progress && (progress.database ?? 'production') !== database) {
		if (fromRepair) throw new Error(`${file} is the repair's state on the ${progress.database ?? 'production'} database, not the ${database} one`);
		return null;
	}
	if (!progress && fromRepair) throw new Error(`No repair progress at ${file}: use --only <dates>`);
	return progress;
}

/**
 * The episodes to work on, in ID order: those `only` names (dates or IDs), or with `fromRepair`
 * the ones the repair's progress has finished; less those `except` names, and less any the repair
 * is working on. A name that matches no episode stops the run (pickEpisodes).
 * @param {Array<{id: string}>} episodes - every episode in D1
 * @returns {{chosen: Array, busy: Array<{id: string, state: string}>, notInD1: string[]}} busy: left
 *   out because the repair is working on them; notInD1: finished by the repair but gone from D1
 */
export function chooseEpisodes(episodes, { only, fromRepair = false, except, progress = null } = {}) {
	if (!only === !fromRepair) throw new Error('Name the episodes: --only <dates> or --from-repair');
	let chosen;
	let notInD1 = [];
	if (only) {
		chosen = pickEpisodes(episodes, only);
	} else {
		const done = repairedIds(progress);
		const inD1 = new Set(episodes.map((e) => e.id));
		chosen = episodes.filter((e) => done.includes(e.id));
		notInD1 = done.filter((id) => !inD1.has(id));
	}
	if (except) {
		const out = new Set(pickEpisodes(episodes, except).map((e) => e.id));
		chosen = chosen.filter((e) => !out.has(e.id));
	}
	const working = repairBusy(progress);
	const busy = chosen.filter((e) => working.has(e.id)).map((e) => ({ id: e.id, state: working.get(e.id) }));
	return { chosen: chosen.filter((e) => !working.has(e.id)), busy, notInD1 };
}

/** Each episode's lines in D1, in time order: Map id -> [{start_ms, end_ms, text}]. */
export function episodeLines(ids, target) {
	const lines = new Map(ids.map((id) => [id, []]));
	for (let i = 0; i < ids.length; i += PAGE) {
		const page = ids.slice(i, i + PAGE);
		const rows = queryJSON(
			`SELECT episode_id, start_ms, end_ms, text FROM transcript_segments WHERE episode_id IN (${page.map((id) => `'${escapeSQL(id)}'`).join(', ')}) ORDER BY episode_id, start_ms, id`,
			target
		);
		for (const r of rows) lines.get(r.episode_id).push({ start_ms: r.start_ms, end_ms: r.end_ms, text: r.text });
	}
	return lines;
}

/** 83:05 for 4,985,000 ms; "empty" for none. */
export function mmss(ms) {
	if (ms == null) return 'empty';
	const s = Math.floor(ms / 1000);
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The date in an episode ID (roll-over-easy_2014-09-04_07-30-00 -> 2014-09-04). */
export const dateOf = (id) => id.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? id;

/** The repair's state for a run of either tool: --progress or the transcripts folder's, for its database. */
export function repairStateForRun(flags, { isLocal = false } = {}) {
	return loadRepairState({ file: flags.progress ? path.resolve(flags.progress) : repairProgressPath(), isLocal, fromRepair: !!flags['from-repair'] });
}

/**
 * The common start of both tools: the episodes (`all` is every episode row in D1), and the repair's
 * state; what was left out, and why, is printed.
 */
export function pickForRun(all, flags, { isLocal = false } = {}) {
	const progress = repairStateForRun(flags, { isLocal });
	const { chosen, busy, notInD1 } = chooseEpisodes(all, { only: flags.only, fromRepair: !!flags['from-repair'], except: flags.except, progress });
	if (notInD1.length > 0) console.log(`Not in D1, left out: ${notInD1.map(dateOf).join(', ')}`);
	if (busy.length > 0) console.log(`The repair is working on these, left out: ${busy.map((b) => `${dateOf(b.id)} (${b.state})`).join(', ')}`);
	return { episodes: chosen, progress };
}

/** A saved list's rows (--apply) less those of an episode the repair is working on now (printed). */
export function leaveOutBusy(rows, progress, idOf = (r) => r.id) {
	const working = repairBusy(progress);
	const out = rows.filter((r) => working.has(idOf(r)));
	if (out.length > 0) console.log(`The repair is working on these, left out: ${[...new Set(out.map((r) => dateOf(idOf(r))))].join(', ')}`);
	return rows.filter((r) => !working.has(idOf(r)));
}
