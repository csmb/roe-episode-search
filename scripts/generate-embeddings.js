#!/usr/bin/env node

/**
 * Make the search index match D1: each episode's vectors become exactly the
 * windows of its lines in D1 (what the site shows and plays), made with the
 * Worker's own code (roe-pipeline/src/embeddings.js) through REST stand-ins for
 * its bindings (remote-cloudflare.js). It re-embeds a few episodes, or rebuilds
 * the whole index (X1).
 *
 * Usage:
 *   node scripts/generate-embeddings.js --only <episode-id>[,<episode-id>…]   # a dry run
 *   node scripts/generate-embeddings.js --all                                 # a dry run of every D1 episode
 *   node scripts/generate-embeddings.js --only <ids> --yes                    # re-embed those
 *   node scripts/generate-embeddings.js --all --orphans --yes                 # rebuild the whole index
 *   node scripts/generate-embeddings.js --orphans [--yes]                     # only vectors whose episode is gone
 *   … --yes --resume <run folder>                                             # carry on a run that stopped
 *
 * Without --yes it changes nothing: it lists the index, reads D1 (SELECTs, after
 * the listing, so an episode with vectors is always in the read) and says per
 * episode what a run would add and delete. With --yes, one episode at a time:
 *   1. the vectors it will delete are backed up (get_by_ids) to deleted-vectors/<id>.ndjson
 *   2. every window of its D1 lines is embedded (Workers AI) and upserted
 *   3. its other vectors go: every listed ID starting "<id>:" that the windows
 *      don't have (and any a replaced transcript left in transcripts/.stale-vectors)
 * and it's written to progress.ndjson, so --resume skips it. Refused, and left as
 * they are: an episode whose lines end 30+ s past its length (wrong times, like
 * the old x10 ones) or whose lines make no windows while it has vectors.
 * --orphans also deletes the vectors of episode IDs that aren't in D1, backed up
 * first, checking D1 again for each one just before. The run ends by waiting
 * for Vectorize's write queue and listing the index again, to check that each
 * episode it did holds exactly its windows and nothing else changed.
 *
 * The plan, the listing, backups and progress go to
 * transcripts/.backups/<date>-embeddings/ (…-embeddings-plan for a dry run).
 * All 544 episodes (83,000 windows) cost about $1.20 of Workers AI.
 */

import fs from 'node:fs';
import path from 'node:path';

import { loadEnv, escapeSQL, parseFlags, queryJSON } from './lib.js';
import { chunkSegments, deleteEpisodeVectors, isEpisodeVectorId, replaceEmbeddings } from '../roe-pipeline/src/embeddings.js';
import { findLoops } from '../roe-pipeline/src/clean-segments.js';
import { OVERRUN_MS } from '../roe-pipeline/src/coverage.js';
import { remoteAI, remoteVectorize } from './remote-cloudflare.js';
import { appliedCheck, episodeOf, vectorIdSnapshot, vectorsNdjson, waitUntilApplied } from './vector-ids.js';
import { newBackupDir } from './episode-backup.js';
import { staleVectors, forgetStaleVectors } from './transcript-file.js';

// It lives in vector-ids.js now (importing this file loads no .env); transcribe.js and process-all.js import it from here
export { chunkEpisode } from './vector-ids.js';

const LINES_PER_QUERY = 20; // episodes whose lines one D1 SELECT reads (up to ~63,000 rows, under 2 s)
const FAILURES_IN_A_ROW = 3; // then something is wrong with more than one episode: stop
const USD_PER_M_TOKENS = 0.067; // bge-base-en-v1.5 on Workers AI

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const minutes = (ms) => `${(ms / 60_000).toFixed(1)} min`;
const startOf = (id) => Number(id.slice(id.lastIndexOf(':') + 1));
const n = (x) => x.toLocaleString('en-US');

// ── D1 (production, SELECTs only) ─────────────────────────────────────

export function productionD1() {
	const list = (ids) => ids.map((id) => `'${escapeSQL(id)}'`).join(', ');
	return {
		episodes: () => queryJSON('SELECT id, duration_ms FROM episodes ORDER BY id'),
		/** Map of episode ID -> its lines in time order, as the Worker embedded them. */
		lines(ids) {
			const byId = new Map(ids.map((id) => [id, []]));
			const rows = queryJSON(`SELECT episode_id, start_ms, end_ms, text FROM transcript_segments WHERE episode_id IN (${list(ids)}) ORDER BY episode_id, start_ms, id`);
			for (const r of rows) byId.get(r.episode_id)?.push({ start_ms: r.start_ms, end_ms: r.end_ms, text: r.text });
			return byId;
		},
		existing: (ids) => new Set(queryJSON(`SELECT id FROM episodes WHERE id IN (${list(ids)})`).map((r) => r.id)),
	};
}

// ── The plan ──────────────────────────────────────────────────────────

/**
 * What a run would do for one episode: its windows from D1's lines, the listed
 * IDs to delete, and whether it's refused.
 */
export function planEpisode({ id, duration_ms: durationMs }, lines, listed) {
	const windows = chunkSegments(id, lines, durationMs ?? 0);
	const expected = windows.map((w) => w.id);
	const want = new Set(expected);
	const have = new Set(listed);
	const endMs = lines.reduce((max, l) => Math.max(max, l.end_ms), 0);
	let refused = null;
	if (durationMs == null) {
		refused = 'D1 has no length for it: its seed never finished';
	} else if (endMs > durationMs + OVERRUN_MS) {
		refused = `its lines run to ${minutes(endMs)}, past its ${minutes(durationMs)} recording: their times are wrong`;
	} else if (expected.length === 0 && listed.length > 0) {
		refused = `its ${n(lines.length)} lines make no windows, and a run would delete all ${n(listed.length)} of its vectors`;
	}
	return {
		id,
		durationMs,
		lines: lines.length,
		listed: listed.length,
		expected,
		add: expected.filter((x) => !have.has(x)),
		remove: listed.filter((x) => !want.has(x)),
		pastEnd: durationMs == null ? 0 : listed.filter((x) => startOf(x) > durationMs).length,
		chars: windows.reduce((sum, w) => sum + w.text.length, 0),
		loops: findLoops(lines).loops.map(({ startMs, endMs: loopEnd, removed }) => ({ startMs, endMs: loopEnd, removed })),
		refused,
	};
}

/**
 * One listing of the index, then D1, then a plan per episode.
 * @param {{episodes: 'all'|string[], keepLines?: boolean}} what - which D1 episodes; keepLines for a run that embeds them
 */
export async function makePlan({ vectorize, d1, episodes = 'all', keepLines = false, log = console.log }) {
	const info = await vectorize.info();
	log(`Listing the search index: ${n(info.vectorCount)} vectors, about ${Math.ceil(info.vectorCount / 1000)} requests...`);
	const snapshot = await vectorIdSnapshot(vectorize);
	const before = snapshot.all();
	if (before.length !== info.vectorCount) log(`  (it listed ${n(before.length)}: writes still in Vectorize's queue aren't in a listing)`);

	// D1 after the listing: an episode that has vectors was seeded before them, so it's in this read
	const inD1 = d1.episodes();
	const inD1Ids = new Set(inD1.map((e) => e.id));
	const targets = episodes === 'all' ? inD1 : inD1.filter((e) => episodes.includes(e.id));
	const notInD1 = episodes === 'all' ? [] : episodes.filter((id) => !inD1Ids.has(id));
	const plans = [];
	const lines = new Map();
	for (let i = 0; i < targets.length; i += LINES_PER_QUERY) {
		const batch = targets.slice(i, i + LINES_PER_QUERY);
		const byId = d1.lines(batch.map((e) => e.id));
		for (const e of batch) {
			const episodeLines = byId.get(e.id) ?? [];
			plans.push(planEpisode(e, episodeLines, snapshot.forEpisode(e.id)));
			if (keepLines) lines.set(e.id, episodeLines);
		}
		if (targets.length > LINES_PER_QUERY) log(`  Read the lines of ${i + batch.length}/${targets.length} episodes from D1`);
	}
	const orphans = snapshot.prefixesNotIn(inD1Ids).sort().map((id) => ({ id, ids: snapshot.forEpisode(id) }));
	return {
		takenAt: snapshot.takenAt, info, snapshot, before, episodeIds: snapshot.episodes().length, unrecognised: snapshot.unrecognised(),
		d1Episodes: inD1.length, plans, lines, orphans, notInD1,
	};
}

/** The plan's totals. `orphans`: whether the run deletes them; `done`: episodes a stopped run already did. */
export function summarizePlan(plan, { orphans = false, done = new Set() } = {}) {
	const sum = (list, f) => list.reduce((total, x) => total + f(x), 0);
	const todo = plan.plans.filter((p) => !p.refused && !done.has(p.id));
	const chars = sum(todo, (p) => p.chars);
	const tokens = Math.round(chars / 4 + 2 * sum(todo, (p) => p.expected.length));
	return {
		index: plan.before.length,
		episodeIds: plan.episodeIds,
		unrecognised: plan.unrecognised.length,
		d1Episodes: plan.d1Episodes,
		planned: plan.plans.length,
		notInD1: plan.notInD1,
		windows: sum(plan.plans, (p) => p.expected.length),
		inIndex: sum(plan.plans, (p) => p.expected.length - p.add.length),
		missing: sum(plan.plans, (p) => p.add.length),
		missingEpisodes: plan.plans.filter((p) => p.add.length > 0).length,
		stale: sum(plan.plans, (p) => p.remove.length),
		staleEpisodes: plan.plans.filter((p) => p.remove.length > 0).length,
		pastEnd: sum(plan.plans, (p) => p.pastEnd),
		pastEndEpisodes: plan.plans.filter((p) => p.pastEnd > 0).length,
		refused: plan.plans.filter((p) => p.refused).map((p) => ({ id: p.id, why: p.refused, listed: p.listed })),
		loops: plan.plans.filter((p) => p.loops.length > 0).map((p) => ({ id: p.id, loops: p.loops.length, lines: sum(p.loops, (l) => l.removed) })),
		orphans: plan.orphans.map((o) => ({ id: o.id, vectors: o.ids.length })),
		done: plan.plans.filter((p) => done.has(p.id)).length,
		run: {
			episodes: todo.length,
			windows: sum(todo, (p) => p.expected.length),
			deletes: sum(todo, (p) => p.remove.length),
			orphanDeletes: orphans ? sum(plan.orphans.filter((o) => !done.has(o.id)), (o) => o.ids.length) : 0,
			tokens,
			usd: +((tokens / 1e6) * USD_PER_M_TOKENS).toFixed(2),
		},
	};
}

function printPlan(plan, s, { yes, orphans, log }) {
	log(`\nPlan (index listed ${plan.takenAt.toLocaleTimeString('en-US', { hour12: false })})`);
	log(`  Search index                      ${n(s.index)} vectors under ${n(s.episodeIds)} episode IDs${s.unrecognised ? `, and ${n(s.unrecognised)} of another form (left alone)` : ''}`);
	log(`  Episodes planned                  ${n(s.planned)} of the ${n(s.d1Episodes)} in D1${s.notInD1.length ? `; not in D1, so skipped: ${s.notInD1.join(', ')}` : ''}`);
	log(`  Windows their D1 lines make       ${n(s.windows)} (${n(s.inIndex)} already in the index, ${n(s.missing)} missing in ${n(s.missingEpisodes)} episodes)`);
	log(`  Vectors those lines don't make    ${n(s.stale)} in ${n(s.staleEpisodes)} episodes`);
	log(`  Vectors starting past the end     ${n(s.pastEnd)} in ${n(s.pastEndEpisodes)} episodes (of the recording's length in D1)`);
	log(`  Vectors of episodes not in D1     ${s.orphans.length ? `${n(s.orphans.reduce((t, o) => t + o.vectors, 0))} under ${s.orphans.length} ID(s): ${s.orphans.map((o) => `${o.id} (${n(o.vectors)})`).join(', ')}` : 'none'}`);
	for (const r of s.refused) log(`  Refused, left as it is:           ${r.id}: ${r.why} (${n(r.listed)} vectors)`);
	if (s.loops.length) log(`  Loops still in D1 (embedded as they are; clean-hallucinations.js removes them): ${s.loops.map((l) => `${l.id} (${n(l.lines)} lines)`).join(', ')}`);
	if (s.done) log(`  Done already (--resume):           ${n(s.done)} episodes`);

	const changed = plan.plans.filter((p) => p.add.length || p.remove.length || p.refused);
	if (changed.length) {
		log('\n  Episodes whose vectors differ from their D1 lines (listed / windows: missing, not made by the lines):');
		for (const p of changed) {
			log(`    ${p.id}  ${n(p.listed)} / ${n(p.expected.length)}: +${n(p.add.length)} -${n(p.remove.length)}${p.pastEnd ? ` (${n(p.pastEnd)} past the end)` : ''}${p.refused ? '  REFUSED' : ''}`);
		}
	}
	const r = s.run;
	const cost = r.usd >= 0.01 ? `$${r.usd.toFixed(2)}` : 'under $0.01';
	const what = `${yes ? 'This run' : 'A run with --yes'} ${yes ? 'embeds' : 'would embed'} ${n(r.windows)} windows of ${n(r.episodes)} episodes (about ${(r.tokens / 1e6).toFixed(1)} M tokens, ${cost} of Workers AI)`;
	const deletes = `${yes ? 'deletes' : 'would delete'} ${n(r.deletes)} vectors they don't make${orphans ? ` and ${n(r.orphanDeletes)} of episodes not in D1` : (s.orphans.length ? ' (the vectors of episodes not in D1 only with --orphans)' : '')}, backed up first`;
	log(`\n${what}, and ${deletes}.`);
}

// ── The run (--yes) ───────────────────────────────────────────────────

function readProgress(dir) {
	const file = path.join(dir, 'progress.ndjson');
	if (!fs.existsSync(file)) return [];
	return fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).flatMap((line) => {
		try {
			return [JSON.parse(line)];
		} catch {
			return []; // a line cut short by a crash
		}
	});
}

/** Episodes and orphan IDs a stopped run in `dir` finished (failed ones are tried again). */
export function doneIn(dir) {
	return new Set(readProgress(dir).filter((e) => !e.failed).map((e) => e.id ?? e.orphan));
}

/**
 * Embed each planned episode and delete its other vectors, then (with
 * `orphans`) the vectors of episode IDs not in D1. Backups and progress go to
 * `dir`. Returns what was done.
 */
export async function applyPlan(plan, { ai, vectorize, d1, dir, orphans = false, done = new Set(), log = console.log }) {
	const backups = path.join(dir, 'deleted-vectors');
	fs.mkdirSync(backups, { recursive: true });
	const record = (entry) => fs.appendFileSync(path.join(dir, 'progress.ndjson'), `${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`);
	// Appended, never overwritten: an episode redone after a failure midway keeps the backup of what already went
	const backUp = async (episodeId, ids) => {
		const saved = ids.length > 0 ? await vectorize.getByIds(ids) : [];
		if (saved.length > 0) fs.appendFileSync(path.join(backups, `${episodeId}.ndjson`), vectorsNdjson(saved));
		return saved.length;
	};
	const results = { embedded: [], failed: [], refused: [], skipped: [], orphansDeleted: [], orphansKept: [] };

	// A failure is logged and the run goes on; FAILURES_IN_A_ROW of them stop it
	let failuresInARow = 0;
	const attempt = async (id, work) => {
		try {
			await work();
			failuresInARow = 0;
		} catch (err) {
			log(`  FAILED: ${err.message}`);
			record({ id, failed: err.message });
			results.failed.push({ id, error: err.message });
			if (++failuresInARow >= FAILURES_IN_A_ROW) {
				throw new Error(`${failuresInARow} failed in a row, so the run stopped (the last: ${err.message}). Fix the cause, then carry on with --resume "${dir}"`);
			}
		}
	};

	const todo = plan.plans.filter((p) => !done.has(p.id) && !p.refused);
	for (const p of plan.plans) {
		if (done.has(p.id)) {
			results.skipped.push(p.id);
			continue;
		}
		if (p.refused) {
			results.refused.push(p.id);
			continue;
		}
		log(`\n[${todo.indexOf(p) + 1}/${todo.length}] ${p.id}: ${n(p.listed)} listed, ${n(p.expected.length)} windows (+${n(p.add.length)} -${n(p.remove.length)})`);
		await attempt(p.id, async () => {
			const listed = plan.snapshot.forEpisode(p.id);
			const old = [...listed, ...staleVectors(p.id)];
			const keep = new Set(p.expected);
			const backedUp = await backUp(p.id, [...new Set(old)].filter((id) => isEpisodeVectorId(p.id, id) && !keep.has(id)));
			const { upserted, deleted, ids } = await replaceEmbeddings(ai, vectorize, p.id, plan.lines.get(p.id), p.durationMs, old);
			forgetStaleVectors(p.id);
			plan.snapshot.replace(p.id, ids);
			record({ id: p.id, listed: listed.length, expected: ids.length, upserted, deleted, backedUp, mutationId: vectorize.lastMutation?.mutationId ?? null });
			results.embedded.push(p.id);
		});
	}

	for (const orphan of orphans ? plan.orphans : []) {
		if (done.has(orphan.id)) continue;
		await attempt(orphan.id, async () => {
			// Checked again just before: an episode published since the D1 read is no orphan
			if (d1.existing([orphan.id]).has(orphan.id)) {
				log(`\n${orphan.id}: in D1 now, so its ${n(orphan.ids.length)} vectors are left alone`);
				results.orphansKept.push(orphan.id);
				return;
			}
			log(`\n${orphan.id}: not in D1, deleting its ${n(orphan.ids.length)} vectors`);
			const backedUp = await backUp(orphan.id, orphan.ids);
			const deleted = await deleteEpisodeVectors(vectorize, orphan.id, orphan.ids);
			plan.snapshot.drop(orphan.id);
			record({ orphan: orphan.id, deleted, backedUp, mutationId: vectorize.lastMutation?.mutationId ?? null });
			results.orphansDeleted.push(orphan.id);
		});
	}
	return results;
}

// ── The check at the end ──────────────────────────────────────────────

const OTHER_FORMS = '(IDs of other forms)';

function groupByEpisode(ids) {
	const by = new Map();
	for (const id of ids) {
		const episode = episodeOf(id) || OTHER_FORMS;
		if (!by.has(episode)) by.set(episode, new Set());
		by.get(episode).add(id);
	}
	return by;
}

/**
 * Compare a listing taken after the run with the plan: each episode the run
 * (or the stopped runs before it) did holds exactly its windows, each deleted
 * orphan has nothing left, and every other episode ID is as it was listed
 * before. `pending`: differences that are the run's own writes not applied yet.
 */
export function compareWithPlan(plan, results, afterIds, { done = new Set() } = {}) {
	const before = groupByEpisode(plan.before);
	const after = groupByEpisode(afterIds);
	const did = new Map(plan.plans.filter((p) => results.embedded.includes(p.id) || done.has(p.id)).map((p) => [p.id, new Set(p.expected)]));
	const gone = new Set([...results.orphansDeleted, ...plan.orphans.filter((o) => done.has(o.id)).map((o) => o.id)]);
	const report = { episodes: did.size, wrong: [], orphansLeft: [], changedElsewhere: [], pending: 0 };
	for (const [id, want] of did) {
		const now = after.get(id) ?? new Set();
		const extra = [...now].filter((x) => !want.has(x));
		const missing = [...want].filter((x) => !now.has(x));
		if (extra.length || missing.length) {
			report.wrong.push({ id, extra: extra.length, missing: missing.length });
			report.pending += extra.filter((x) => before.get(id)?.has(x)).length + missing.length;
		}
	}
	for (const id of gone) {
		const left = after.get(id)?.size ?? 0;
		if (left) {
			report.orphansLeft.push({ id, left });
			report.pending += left;
		}
	}
	const failed = new Set(results.failed.map((f) => f.id)); // reported on their own: a failure can come after the upserts
	for (const id of new Set([...before.keys(), ...after.keys()])) {
		if (did.has(id) || gone.has(id) || failed.has(id)) continue;
		const was = before.get(id) ?? new Set();
		const now = after.get(id) ?? new Set();
		if (was.size !== now.size || [...was].some((x) => !now.has(x))) report.changedElsewhere.push({ id, before: was.size, after: now.size });
	}
	report.ok = !report.wrong.length && !report.orphansLeft.length && !report.changedElsewhere.length;
	return report;
}

/**
 * Wait for the run's last write to be applied, then list the index again and
 * compare (again later while writes are still showing up). When the last write
 * leaves nothing to look for (an upsert of IDs the index had), only its
 * mutation ID can say it was applied, which another writer's can hide: the
 * wait is then short, and the listings decide.
 */
export async function verifyRun(plan, results, { vectorize, done = new Set(), log = console.log, wait = {}, noProbeWaitMs = 2 * 60_000, relists = 3, relistWaitMs = 30_000 } = {}) {
	if (vectorize.lastMutation) {
		log('\nWaiting for Vectorize to apply the last write...');
		const check = appliedCheck(vectorize.lastMutation, new Set(plan.before));
		const probe = check.deletedIds?.length || check.newIds?.length;
		try {
			await waitUntilApplied(vectorize, check, probe ? wait : { ...wait, timeoutMs: Math.min(wait.timeoutMs ?? Infinity, noProbeWaitMs) });
		} catch (err) {
			log(`  ${err.message}; checking anyway`);
		}
	}
	for (let attempt = 1; ; attempt++) {
		log('Listing the index again to check the result...');
		const after = (await vectorIdSnapshot(vectorize)).all();
		const report = { ...compareWithPlan(plan, results, after, { done }), vectors: after.length, checkedAt: new Date().toISOString() };
		if (report.ok || !report.pending || attempt >= relists) return report;
		log(`  ${n(report.pending)} of the run's writes don't show yet (Vectorize's queue); listing again in ${relistWaitMs / 1000} s`);
		await sleep(relistWaitMs);
	}
}

function printReport(report, log) {
	log(`\nCheck (${report.checkedAt}): ${n(report.vectors)} vectors in the index`);
	log(`  ${n(report.episodes)} episodes done: ${report.wrong.length ? `${report.wrong.length} don't hold exactly their windows: ${report.wrong.map((w) => `${w.id} (+${w.extra} -${w.missing})`).join(', ')}` : 'each holds exactly its windows'}`);
	if (report.orphansLeft.length) log(`  Vectors left under deleted episode IDs: ${report.orphansLeft.map((o) => `${o.id} (${o.left})`).join(', ')}`);
	log(`  Other episode IDs: ${report.changedElsewhere.length ? `${report.changedElsewhere.length} changed during the run (another writer?): ${report.changedElsewhere.map((c) => `${c.id} ${c.before} -> ${c.after}`).join(', ')}` : 'unchanged'}`);
	if (!report.ok && report.pending) log('  Some writes may still be in Vectorize\'s queue: list again later (a dry run of the same episodes shows what differs).');
}

// ── CLI ────────────────────────────────────────────────────────────────

const USAGE = [
	'Usage: node scripts/generate-embeddings.js (--only <episode-id>[,<episode-id>…] | --all) [--orphans] [--yes [--resume <run folder>]]',
	'       node scripts/generate-embeddings.js --orphans [--yes]',
	'',
	'  (no --yes)   a dry run: lists the index, reads D1 and says what a run would do',
	'  --yes        embed the episodes\' D1 lines and delete their other vectors (backed up first)',
	'  --orphans    also delete the vectors of episode IDs that aren\'t in D1',
	'  --resume     carry on a stopped run, in its folder (transcripts/.backups/<date>-embeddings)',
].join('\n');

function writeFileOnce(dir, name, text) {
	const { name: base, ext } = path.parse(name);
	for (let i = 1; ; i++) {
		const file = path.join(dir, i === 1 ? name : `${base}-${i}${ext}`);
		if (!fs.existsSync(file)) {
			fs.writeFileSync(file, text);
			return file;
		}
	}
}

function runReadme(dir, args) {
	return [
		`Search index run started ${new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}:`,
		`  node scripts/generate-embeddings.js ${args.join(' ')}`,
		'',
		'  plan.json               what the run was to do: per episode, the IDs to add and delete',
		'  vector-ids-before.json  every ID the index listed before it wrote anything',
		'  deleted-vectors/        the vectors it deleted, one NDJSON file per episode ID',
		'  progress.ndjson         one line per episode done (a rerun with --resume skips them)',
		'  verify.json             the check at the end: a new listing against the plan',
		'(-2, -3 … files are from a run carried on with --resume.)',
		'',
		'To carry on after a stop:',
		`  node scripts/generate-embeddings.js ${args.filter((a, i) => a !== '--resume' && args[i - 1] !== '--resume').join(' ')} --resume "${dir}"`,
		'To put an episode\'s deleted vectors back:',
		'  cd roe-search',
		`  env -u CLOUDFLARE_API_TOKEN npx wrangler vectorize upsert roe-transcripts --file "${path.join(dir, 'deleted-vectors', '<episode-id>.ndjson')}"`,
		'(The windows it added are made from D1\'s lines, so they can simply be made again.)',
		'',
	].join('\n');
}

async function main() {
	loadEnv();
	const args = process.argv.slice(2);
	const { flags, rest } = parseFlags(args, { '--only': 'value', '--all': 'flag', '--orphans': 'flag', '--yes': 'flag', '--dry-run': 'flag', '--resume': 'value' }, USAGE);
	const stop = (problem) => {
		console.error(`${problem}\n\n${USAGE}`);
		process.exit(1);
	};
	if (rest.length > 0) stop(`Unexpected argument: ${rest.join(' ')}`);
	if (flags.only && flags.all) stop('--only or --all, not both');
	if (!flags.only && !flags.all && !flags.orphans) stop('Say which: --only <episode-ids>, --all or --orphans');
	if (flags.yes && flags['dry-run']) stop('--yes or --dry-run, not both (a dry run is the default)');
	if (flags.resume && !flags.yes) stop('--resume carries on a run, so it needs --yes');
	if (process.env.ROE_PERSIST_TO) throw new Error('ROE_PERSIST_TO is set (a test run): generate-embeddings.js reads and writes production D1 and Vectorize, so it doesn\'t run in a test run');

	const log = console.log;
	const episodes = flags.only ? flags.only.split(',').map((s) => s.trim()).filter(Boolean) : flags.all ? 'all' : [];
	const resumeDir = flags.resume ? path.resolve(flags.resume) : null;
	if (resumeDir && !fs.existsSync(path.join(resumeDir, 'plan.json'))) stop(`${resumeDir} isn't a run folder (no plan.json)`);
	const done = resumeDir ? doneIn(resumeDir) : new Set();

	const vectorize = remoteVectorize();
	const d1 = productionD1();
	const plan = await makePlan({ vectorize, d1, episodes, keepLines: !!flags.yes, log });
	const summary = summarizePlan(plan, { orphans: !!flags.orphans, done });
	printPlan(plan, summary, { yes: !!flags.yes, orphans: !!flags.orphans, log });

	const dir = resumeDir ?? newBackupDir(flags.yes ? 'embeddings' : 'embeddings-plan');
	const planFile = writeFileOnce(dir, 'plan.json', JSON.stringify({
		args, listedAt: plan.takenAt, info: plan.info, summary,
		episodes: plan.plans.map(({ expected, ...p }) => ({ ...p, expected: expected.length })),
		orphans: plan.orphans,
	}, null, 1));
	writeFileOnce(dir, 'vector-ids-before.json', JSON.stringify(plan.before));
	if (!flags.yes) {
		log(`\nA dry run: nothing was written to D1 or Vectorize. The plan is in ${planFile}.`);
		return;
	}

	if (!resumeDir) fs.writeFileSync(path.join(dir, 'README.txt'), runReadme(dir, args));
	log(`\nBackups and progress: ${dir}`);
	const results = await applyPlan(plan, { ai: remoteAI(), vectorize, d1, dir, orphans: !!flags.orphans, done, log });
	log(`\nEmbedded ${results.embedded.length} episodes; ${results.failed.length} failed; ${results.refused.length} refused; ${results.orphansDeleted.length} orphan IDs deleted.`);
	for (const f of results.failed) log(`  FAILED ${f.id}: ${f.error}`);

	// A resumed run checks the episodes done before it too, even when it has nothing left to write
	if (!vectorize.lastMutation && done.size === 0) {
		log('Nothing was written, so there is nothing to check.');
	} else {
		const report = await verifyRun(plan, results, { vectorize, done, log });
		writeFileOnce(dir, 'verify.json', JSON.stringify(report, null, 1));
		printReport(report, log);
		if (!report.ok) process.exitCode = 1;
	}
	if (results.failed.length) {
		log(`\nCarry on with: node scripts/generate-embeddings.js ${args.filter((a, i) => a !== '--resume' && args[i - 1] !== '--resume').join(' ')} --resume "${dir}"`);
		process.exitCode = 1;
	}
}

// Only run main() when executed directly (not when imported)
if (import.meta.main) {
	main().catch((err) => {
		console.error('Error:', err.message);
		process.exit(1);
	});
}
