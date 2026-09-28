// node --test scripts/test/*.test.js
// generate-embeddings.js (the X1 rebuild): the plan, a run and its check, with an in-memory D1 and
// the REST stand-in for Vectorize and Workers AI (helpers/fake-cloudflare.js). Nothing reaches the network.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeCloudflare } from './helpers/fake-cloudflare.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roe-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.ROE_PERSIST_TO ??= tmp; // a test run: no keys from .env; transcripts/ is <tmp>/transcripts
process.env.CLOUDFLARE_ACCOUNT_ID = 'test-account';
process.env.CLOUDFLARE_API_TOKEN = 'test-token';
const { remoteAI, remoteVectorize, pacing } = await import('../remote-cloudflare.js');
const { planEpisode, makePlan, summarizePlan, applyPlan, verifyRun, compareWithPlan, doneIn } = await import('../generate-embeddings.js');
const { rememberStaleVectors, staleVectors } = await import('../transcript-file.js');
const { chunkSegments } = await import('../../roe-pipeline/src/embeddings.js');
pacing.gapMs = 0;
pacing.retryWaitsMs = [0, 0];

const A = 'roll-over-easy_2016-03-24_07-30-00';
const B = 'roll-over-easy_2016-03-24_07-56-07'; // not in D1: the 3/24/2016 merge's leftovers
const C = 'roll-over-easy_2016-03-31_07-30-00'; // in step with D1 already
const X = 'roll-over-easy_2014-04-24_07-30-00'; // lines past the end: the old x10 times
const E = 'roll-over-easy_2015-01-01_07-30-00'; // lines too short to make a window
const F = 'roll-over-easy_2014-03-20_07-30-00'; // a loop still in D1
const G = 'roll-over-easy_2026-10-01_07-30-00'; // published while the run goes (in D1 by the orphan check)

/** A line every `step` seconds from `from` to `to`. */
const talk = (tag, from, to, step = 10) => Array.from({ length: Math.floor((to - from) / step) }, (_, i) => {
	const s = from + i * step;
	return { start_ms: s * 1000, end_ms: (s + step) * 1000, text: `${tag} talks about the city at second ${s}` };
});
const idsOf = (episode, starts) => starts.map((s) => `${episode}:${s}`);

function world() {
	const d1 = {
		[A]: { duration_ms: 600_000, lines: talk('A', 0, 600) },
		[C]: { duration_ms: 300_000, lines: talk('C', 0, 300) },
		[X]: { duration_ms: 60_000, lines: talk('X', 0, 300) },
		[E]: { duration_ms: 120_000, lines: [{ start_ms: 0, end_ms: 5000, text: 'mm-hmm' }] },
		[F]: { duration_ms: 400_000, lines: [...talk('F', 0, 100), ...Array.from({ length: 60 }, (_, i) => ({ start_ms: 100_000 + i * 2000, end_ms: 101_000 + i * 2000, text: 'Something to wear.' })), ...talk('F', 220, 400)] },
	};
	const windows = (id) => chunkSegments(id, d1[id].lines, d1[id].duration_ms).map((w) => w.id);
	const expected = Object.fromEntries(Object.keys(d1).map((id) => [id, windows(id)]));
	const index = [
		...expected[A].slice(2), ...idsOf(A, [123, 999_999]), `${A}:12x`, // 2 missing, 2 stale, 1 of another form
		...expected[C],
		...idsOf(X, [0, 350_000, 3_500_000]),
		...idsOf(E, [0, 35_000, 70_000]),
		...expected[F], ...idsOf(F, [111_111]),
		...idsOf(B, [0, 35_000, 70_000, 105_000, 140_000]),
		...idsOf(G, [0, 35_000]),
	];
	return { d1, expected, index };
}

/** An in-memory D1 with the same three reads as productionD1(), recording each. */
function memoryD1(rows, cf, { lateArrivals = [] } = {}) {
	const calls = [];
	return {
		calls,
		episodes() {
			calls.push({ read: 'episodes', vectorizeRequestsBefore: cf.requests.length });
			return Object.keys(rows).sort().map((id) => ({ id, duration_ms: rows[id].duration_ms }));
		},
		lines(ids) {
			calls.push({ read: 'lines', ids });
			return new Map(ids.map((id) => [id, rows[id].lines.map((l) => ({ ...l }))]));
		},
		existing(ids) {
			calls.push({ read: 'existing', ids });
			return new Set(ids.filter((id) => id in rows || lateArrivals.includes(id)));
		},
	};
}

function stand(options) {
	const cf = fakeCloudflare(options);
	globalThis.fetch = cf.fetch;
	return cf;
}

async function outsideTestRun(fn) {
	const saved = process.env.ROE_PERSIST_TO;
	delete process.env.ROE_PERSIST_TO;
	try {
		return await fn();
	} finally {
		process.env.ROE_PERSIST_TO = saved;
	}
}

const quiet = () => {};
const ofEpisode = (cf, id) => [...cf.index.keys()].filter((x) => x.startsWith(`${id}:`)).sort();
const sorted = (list) => [...list].sort();
const runDir = () => fs.mkdtempSync(path.join(tmp, 'run-'));
const progress = (dir) => fs.readFileSync(path.join(dir, 'progress.ndjson'), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('planEpisode: windows from D1\'s lines, what to add and delete, and what it refuses', () => {
	const { d1, expected } = world();
	const listed = [...expected[A].slice(2), ...idsOf(A, [123, 999_999])];
	const p = planEpisode({ id: A, duration_ms: 600_000 }, d1[A].lines, listed);
	assert.deepEqual(p.expected, expected[A]);
	assert.deepEqual(p.add, expected[A].slice(0, 2));
	assert.deepEqual(p.remove, idsOf(A, [123, 999_999]));
	assert.equal(p.pastEnd, 1); // 999,999 ms is past the 600,000 ms recording
	assert.equal(p.refused, null);

	assert.match(planEpisode({ id: X, duration_ms: 60_000 }, d1[X].lines, []).refused, /its lines run to 5\.0 min, past its 1\.0 min recording: their times are wrong/);
	assert.equal(planEpisode({ id: X, duration_ms: 60_000 }, d1[X].lines.filter((l) => l.end_ms <= 90_000), []).refused, null, 'up to 30 s past the end is fine');
	assert.match(planEpisode({ id: A, duration_ms: null }, d1[A].lines, []).refused, /no length for it: its seed never finished/);
	assert.match(planEpisode({ id: E, duration_ms: 120_000 }, d1[E].lines, idsOf(E, [0])).refused, /its 1 lines make no windows, and a run would delete all 1 of its vectors/);
	assert.equal(planEpisode({ id: E, duration_ms: 120_000 }, d1[E].lines, []).refused, null, 'nothing to embed and nothing to lose');
	assert.deepEqual(planEpisode({ id: F, duration_ms: 400_000 }, d1[F].lines, []).loops.map((l) => l.removed), [59]);
});

test('a dry run only reads: one listing, then D1, and a plan that matches the index', async () => {
	const { d1, expected, index } = world();
	const cf = stand({ ids: index });
	const db = memoryD1(d1, cf);
	const plan = await makePlan({ vectorize: remoteVectorize(), d1: db, episodes: 'all', log: quiet });
	assert.deepEqual(sorted(new Set(cf.ops())), ['info', 'list'], 'Vectorize: reads only');
	assert.equal(db.calls[0].read, 'episodes');
	assert.equal(db.calls[0].vectorizeRequestsBefore, cf.requests.length, 'D1 was read after the whole listing');

	const s = summarizePlan(plan);
	assert.equal(s.index, index.length);
	assert.equal(s.planned, 5);
	assert.equal(s.windows, Object.values(expected).reduce((t, ids) => t + ids.length, 0));
	assert.equal(s.missing, 2 + expected[X].length - 1, 'A misses 2 windows; X has only its first');
	assert.equal(s.stale, 2 + 2 + 3 + 1, 'A 2, X 2, E 3, F 1');
	assert.equal(s.pastEnd, 1 + 2, 'A 1, X 2');
	assert.deepEqual(s.refused.map((r) => r.id), [X, E]);
	assert.deepEqual(s.loops.map((l) => l.id), [F]);
	assert.deepEqual(s.orphans, [{ id: B, vectors: 5 }, { id: G, vectors: 2 }]);
	assert.equal(s.unrecognised, 1);
	assert.equal(s.run.episodes, 3);
	assert.equal(s.run.deletes, 3, 'A 2, F 1: the refused episodes keep theirs');
	assert.ok(s.run.usd >= 0 && s.run.tokens > 0);

	const only = await makePlan({ vectorize: remoteVectorize(), d1: memoryD1(d1, cf), episodes: [A, 'roll-over-easy_2030-01-01_07-30-00'], log: quiet });
	assert.deepEqual(only.plans.map((p) => p.id), [A]);
	assert.deepEqual(only.notInD1, ['roll-over-easy_2030-01-01_07-30-00']);
	assert.deepEqual(sorted(new Set(cf.ops())), ['info', 'list']);
});

test('a run backs up, embeds and deletes one episode at a time, touching nothing else, and its check passes', async () => {
	const { d1, expected, index } = world();
	const cf = stand({ ids: index });
	const db = memoryD1(d1, cf);
	const vectorize = remoteVectorize();
	rememberStaleVectors(A, [`${A}:424242`]); // a replaced transcript's leftover the listing can't see
	const plan = await makePlan({ vectorize, d1: db, episodes: 'all', keepLines: true, log: quiet });
	const dir = runDir();
	const results = await outsideTestRun(() => applyPlan(plan, { ai: remoteAI(), vectorize, d1: db, dir, log: quiet }));
	assert.deepEqual(results.embedded, [F, A, C]);
	assert.deepEqual(results.refused, [X, E]);

	assert.deepEqual(ofEpisode(cf, A), sorted([...expected[A], `${A}:12x`]), 'A: its windows (and the ID of another form, left alone)');
	assert.deepEqual(ofEpisode(cf, C), sorted(expected[C]), 'C: re-upserted, nothing deleted');
	assert.deepEqual(ofEpisode(cf, F), sorted(expected[F]));
	assert.deepEqual(ofEpisode(cf, X), sorted(idsOf(X, [0, 350_000, 3_500_000])), 'X refused: as it was');
	assert.deepEqual(ofEpisode(cf, E), sorted(idsOf(E, [0, 35_000, 70_000])), 'E refused: as it was');
	assert.equal(ofEpisode(cf, B).length, 5, 'no --orphans: B is left');
	assert.deepEqual(staleVectors(A), [], 'the remembered IDs are forgotten');

	// Each episode: its backup (get) before its upsert, its upsert before its deletes
	const deletes = cf.requests.filter((r) => r.op === 'delete_by_ids').map((r) => JSON.parse(r.body).ids);
	assert.deepEqual(deletes.map(sorted), [idsOf(F, [111_111]), sorted([...idsOf(A, [123, 999_999]), `${A}:424242`])]);
	const ops = cf.ops().filter((op) => op !== 'list' && op !== 'info');
	assert.deepEqual(ops, ['get_by_ids', 'ai', 'upsert', 'delete_by_ids', 'get_by_ids', 'ai', 'upsert', 'delete_by_ids', 'ai', 'upsert']);

	const backup = fs.readFileSync(path.join(dir, 'deleted-vectors', `${A}.ndjson`), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
	assert.deepEqual(backup.map((v) => v.id).sort(), sorted(idsOf(A, [123, 999_999])), 'the backup holds the deleted vectors that existed');
	assert.deepEqual(backup[0], { id: backup[0].id, values: [0.5, 0.25], metadata: { episode_id: A, text: `text of ${backup[0].id}` } });
	assert.ok(!fs.existsSync(path.join(dir, 'deleted-vectors', `${C}.ndjson`)), 'nothing deleted, nothing backed up');
	assert.deepEqual(progress(dir).map((e) => [e.id, e.upserted, e.deleted, e.backedUp]), [[F, expected[F].length, 1, 1], [A, expected[A].length, 3, 2], [C, expected[C].length, 0, 0]]);

	const report = await verifyRun(plan, results, { vectorize, log: quiet, wait: { pollMs: 5, timeoutMs: 1000 } });
	assert.equal(report.ok, true, JSON.stringify(report));
	assert.equal(report.episodes, 3);
	assert.equal(report.vectors, cf.index.size);
});

test('--orphans deletes the vectors of an episode ID not in D1 after a backup, unless D1 has it by then', async () => {
	const { d1, index } = world();
	const cf = stand({ ids: index });
	const db = memoryD1(d1, cf, { lateArrivals: [G] });
	const vectorize = remoteVectorize();
	const plan = await makePlan({ vectorize, d1: db, episodes: [], keepLines: true, log: quiet });
	assert.deepEqual(plan.orphans.map((o) => o.id), [B, G]);
	const dir = runDir();
	const results = await outsideTestRun(() => applyPlan(plan, { ai: remoteAI(), vectorize, d1: db, dir, orphans: true, log: quiet }));
	assert.deepEqual(results.orphansDeleted, [B]);
	assert.deepEqual(results.orphansKept, [G], 'published during the run: not an orphan');
	assert.deepEqual(db.calls.filter((c) => c.read === 'existing').map((c) => c.ids), [[B], [G]], 'checked one at a time, just before');
	assert.deepEqual(ofEpisode(cf, B), []);
	assert.equal(ofEpisode(cf, G).length, 2);
	assert.equal(fs.readFileSync(path.join(dir, 'deleted-vectors', `${B}.ndjson`), 'utf-8').trim().split('\n').length, 5);
	assert.deepEqual(progress(dir).map((e) => [e.orphan, e.deleted, e.backedUp]), [[B, 5, 5]]);
	const report = await verifyRun(plan, results, { vectorize, log: quiet, wait: { pollMs: 5, timeoutMs: 1000 } });
	assert.equal(report.ok, true, JSON.stringify(report));
});

test('a failed embed changes nothing for that episode; the run goes on, and --resume does only what\'s left', async () => {
	const { d1, expected, index } = world();
	const cf = stand({ ids: index });
	let aiDown = true;
	globalThis.fetch = async (url, init) => (aiDown && String(url).includes('/ai/run/') && init.body.includes('C talks')
		? new Response(JSON.stringify({ success: false, errors: [{ code: 5006, message: 'made-up bad input' }] }), { status: 400 })
		: cf.fetch(url, init));
	const vectorize = remoteVectorize();
	const plan = await makePlan({ vectorize, d1: memoryD1(d1, cf), episodes: 'all', keepLines: true, log: quiet });
	const dir = runDir();
	const results = await outsideTestRun(() => applyPlan(plan, { ai: remoteAI(), vectorize, d1: memoryD1(d1, cf), dir, log: quiet }));
	assert.deepEqual(results.embedded, [F, A]);
	assert.deepEqual(results.failed.map((f) => f.id), [C]);
	assert.match(results.failed[0].error, /Workers AI error 400/);
	assert.deepEqual(ofEpisode(cf, C), sorted(expected[C]), 'C as it was');
	const report = await verifyRun(plan, results, { vectorize, log: quiet, wait: { pollMs: 5, timeoutMs: 1000 } });
	assert.equal(report.ok, true, 'the failed episode is reported on its own, not as changed by someone else');

	// Carry on: a new listing and plan, and only C is done
	aiDown = false;
	const done = doneIn(dir);
	assert.deepEqual(sorted(done), sorted([F, A]));
	fs.appendFileSync(path.join(dir, 'progress.ndjson'), '{"id": "cut sho'); // a line a crash cut short
	assert.deepEqual(sorted(doneIn(dir)), sorted([F, A]));
	const again = await makePlan({ vectorize, d1: memoryD1(d1, cf), episodes: 'all', keepLines: true, log: quiet });
	assert.equal(summarizePlan(again, { done }).run.episodes, 1);
	const before = cf.requests.length;
	const second = await outsideTestRun(() => applyPlan(again, { ai: remoteAI(), vectorize, d1: memoryD1(d1, cf), dir, done, log: quiet }));
	assert.deepEqual(second.embedded, [C]);
	assert.deepEqual(sorted(second.skipped), sorted([F, A]));
	assert.deepEqual(cf.requests.slice(before).map((r) => r.op), ['ai', 'upsert'], 'only C was embedded');
	const final = await verifyRun(again, second, { vectorize, done, log: quiet, wait: { pollMs: 5, timeoutMs: 1000 } });
	assert.equal(final.ok, true, JSON.stringify(final));
	assert.equal(final.episodes, 3);
});

test('three failures in a row stop the run', async () => {
	const { d1, index } = world();
	const cf = stand({ ids: index });
	globalThis.fetch = async (url, init) => (String(url).includes('/ai/run/') ? new Response('{}', { status: 401 }) : cf.fetch(url, init));
	const vectorize = remoteVectorize();
	const plan = await makePlan({ vectorize, d1: memoryD1(d1, cf), episodes: 'all', keepLines: true, log: quiet });
	const dir = runDir();
	await assert.rejects(
		outsideTestRun(() => applyPlan(plan, { ai: remoteAI(), vectorize, d1: memoryD1(d1, cf), dir, log: quiet })),
		new RegExp(`3 failed in a row, so the run stopped \\(the last: Workers AI error 401.*carry on with --resume "${dir}"`),
	);
	assert.deepEqual(cf.ops().filter((op) => op === 'upsert' || op === 'delete_by_ids'), []);
});

test('an episode that fails halfway through its deletes keeps a backup of everything, after --resume too', async () => {
	const { d1, expected, index } = world();
	const stale = Array.from({ length: 150 }, (_, i) => `${A}:${7_000_001 + i}`);
	const cf = stand({ ids: [...index, ...stale] });
	let deletes = 0;
	globalThis.fetch = async (url, init) => (String(url).endsWith('/delete_by_ids') && ++deletes === 2
		? new Response('{"success":false}', { status: 400 })
		: cf.fetch(url, init));
	const vectorize = remoteVectorize();
	const dir = runDir();
	const plan = await makePlan({ vectorize, d1: memoryD1(d1, cf), episodes: [A], keepLines: true, log: quiet });
	const first = await outsideTestRun(() => applyPlan(plan, { ai: remoteAI(), vectorize, d1: memoryD1(d1, cf), dir, log: quiet }));
	assert.deepEqual(first.failed.map((f) => f.id), [A]);
	assert.equal(ofEpisode(cf, A).length, expected[A].length + 52 + 1, 'every window upserted, 100 of the 152 stale ones deleted before the failure (and the ID of another form)');
	const backup = path.join(dir, 'deleted-vectors', `${A}.ndjson`);
	const savedIds = () => new Set(fs.readFileSync(backup, 'utf-8').trim().split('\n').map((l) => JSON.parse(l).id));
	assert.equal(savedIds().size, 152, 'the 150 and the 2 stale ones, before anything went');

	const again = await makePlan({ vectorize, d1: memoryD1(d1, cf), episodes: [A], keepLines: true, log: quiet });
	const second = await outsideTestRun(() => applyPlan(again, { ai: remoteAI(), vectorize, d1: memoryD1(d1, cf), dir, done: doneIn(dir), log: quiet }));
	assert.deepEqual(second.embedded, [A]);
	assert.deepEqual(ofEpisode(cf, A), sorted([...expected[A], `${A}:12x`]));
	assert.equal(savedIds().size, 152, 'the first 100 deleted are still in the backup');
});

test('an orphan that fails is logged, and the run goes on', async () => {
	const { d1, index } = world();
	const cf = stand({ ids: index });
	const db = memoryD1(d1, cf);
	db.existing = () => {
		throw new Error('made-up D1 outage');
	};
	const vectorize = remoteVectorize();
	const plan = await makePlan({ vectorize, d1: db, episodes: [], keepLines: true, log: quiet });
	const results = await outsideTestRun(() => applyPlan(plan, { ai: remoteAI(), vectorize, d1: db, dir: runDir(), orphans: true, log: quiet }));
	assert.deepEqual(results.failed.map((f) => [f.id, f.error]), [[B, 'made-up D1 outage'], [G, 'made-up D1 outage']]);
	assert.equal(ofEpisode(cf, B).length, 5, 'nothing deleted without the check');
});

test('the check finds another writer\'s change, and tells the run\'s own writes still in the queue', async () => {
	const { d1, expected, index } = world();
	const cf = stand({ ids: index, queued: true });
	const vectorize = remoteVectorize();
	const plan = await makePlan({ vectorize, d1: memoryD1(d1, cf), episodes: [A], keepLines: true, log: quiet });
	const results = await outsideTestRun(() => applyPlan(plan, { ai: remoteAI(), vectorize, d1: memoryD1(d1, cf), dir: runDir(), log: quiet }));

	// Nothing applied yet: A's deletes and new windows don't show
	const early = compareWithPlan(plan, results, [...cf.index.keys()]);
	assert.equal(early.ok, false);
	assert.deepEqual(early.wrong, [{ id: A, extra: 2, missing: 2 }]);
	assert.equal(early.pending, 4);

	// Applied, but meanwhile someone added a vector to C
	cf.apply();
	const late = compareWithPlan(plan, results, [...cf.index.keys(), `${C}:777000`]);
	assert.deepEqual(late.wrong, []);
	assert.deepEqual(late.changedElsewhere, [{ id: C, before: expected[C].length, after: expected[C].length + 1 }]);
	assert.equal(late.ok, false);

	// verifyRun waits for the queue first, then lists
	const cf2 = stand({ ids: index, queued: true });
	const v2 = remoteVectorize();
	const plan2 = await makePlan({ vectorize: v2, d1: memoryD1(d1, cf2), episodes: [A], keepLines: true, log: quiet });
	const results2 = await outsideTestRun(() => applyPlan(plan2, { ai: remoteAI(), vectorize: v2, d1: memoryD1(d1, cf2), dir: runDir(), log: quiet }));
	setTimeout(() => cf2.apply(), 30);
	const report = await verifyRun(plan2, results2, { vectorize: v2, log: quiet, wait: { pollMs: 5, timeoutMs: 2000 } });
	assert.equal(report.ok, true, JSON.stringify(report));
});
