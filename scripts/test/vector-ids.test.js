// node --test scripts/test/*.test.js
// vector-ids.js: listing the index, the per-run snapshot and waiting for Vectorize's queue,
// through remote-cloudflare.js and a stand-in for Cloudflare's REST API (nothing reaches the network).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeCloudflare } from './helpers/fake-cloudflare.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roe-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.ROE_PERSIST_TO ??= tmp; // a test run: no keys from .env
process.env.CLOUDFLARE_ACCOUNT_ID = 'test-account';
process.env.CLOUDFLARE_API_TOKEN = 'test-token';
const { remoteVectorize, pacing } = await import('../remote-cloudflare.js');
const { listAllVectorIds, vectorIdSnapshot, waitUntilApplied, appliedCheck, chunkEpisode, vectorsNdjson, listing } = await import('../vector-ids.js');
const { chunkSegments } = await import('../../roe-pipeline/src/embeddings.js');
pacing.gapMs = 0;
pacing.retryWaitsMs = [0, 0];
listing.retryWaitsMs = [0, 0];

const A = 'roll-over-easy_2016-03-24_07-30-00';
const B = 'roll-over-easy_2016-03-24_07-56-07'; // the same date: the real pair from the 3/24/2016 merge
const C = 'roll-over-easy_2016-03-31_07-30-00';
const idsOf = (episode, n, from = 0) => Array.from({ length: n }, (_, i) => `${episode}:${(from + i) * 1000}`);
const sorted = (list) => [...list].sort();

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

test('the listing follows the cursor to the end, whatever order the index lists in', async () => {
	const ids = [...idsOf(A, 1200), ...idsOf(B, 900), ...idsOf(C, 450)];
	const cf = stand({ ids, runs: 4 });
	const listed = await listAllVectorIds(remoteVectorize());
	assert.equal(listed.length, 2550);
	assert.deepEqual(sorted(listed), sorted(ids));
	assert.notDeepEqual(listed, sorted(listed)); // like the real index: sorted runs one after another
	assert.deepEqual(cf.ops(), ['list', 'list', 'list']);
});

test('a listing that comes back short stops, rather than leave vectors nobody deletes', async () => {
	const cf = stand({ ids: [...idsOf(A, 1500), ...idsOf(B, 1000)] });
	// A page that says there's more but gives no cursor
	globalThis.fetch = async (url, init) => {
		const res = await cf.fetch(url, init);
		if (!String(url).includes('/list')) return res;
		const body = await res.json();
		body.result.nextCursor = null;
		return new Response(JSON.stringify(body));
	};
	await assert.rejects(listAllVectorIds(remoteVectorize()), /says there is more but gives no cursor/);
	// Fewer IDs than the count the first page gave
	globalThis.fetch = async (url, init) => {
		const res = await cf.fetch(url, init);
		if (!String(url).includes('/list')) return res;
		const body = await res.json();
		body.result.totalCount += 5;
		return new Response(JSON.stringify(body));
	};
	await assert.rejects(listAllVectorIds(remoteVectorize()), /gave 2500 of the 2505 IDs it said the index holds/);
	// A page sent twice counts once
	let pages = 0;
	globalThis.fetch = async (url, init) => {
		const res = await cf.fetch(url, init);
		if (!String(url).includes('/list') || ++pages !== 2) return res;
		const body = await res.json();
		body.result.vectors = [...body.result.vectors, ...body.result.vectors.slice(0, 3)];
		return new Response(JSON.stringify(body));
	};
	assert.equal((await listAllVectorIds(remoteVectorize())).length, 2500);
});

test('a cursor Vectorize rejects partway through (40052) starts the listing again, at most 3 times', async () => {
	const ids = [...idsOf(A, 1500), ...idsOf(B, 1000)]; // 3 pages a listing
	const cf = stand({ ids });
	const corrupted = () => new Response(JSON.stringify({ result: null, success: false,
		errors: [{ code: 40052, message: 'List vectors cursor appears to be corrupted' }] }), { status: 400 });
	// The first listing's second page is refused, as on 2026-09-28; a new listing goes through
	let lists = 0;
	globalThis.fetch = async (url, init) => (String(url).includes('/list') && ++lists === 2 ? corrupted() : cf.fetch(url, init));
	assert.deepEqual(sorted(await listAllVectorIds(remoteVectorize())), sorted(ids));
	assert.equal(lists, 5);
	// Refused every time: the third listing's error reaches the caller
	lists = 0;
	globalThis.fetch = async (url, init) => (String(url).includes('/list') && String(url).includes('cursor=') && ++lists ? corrupted() : cf.fetch(url, init));
	await assert.rejects(listAllVectorIds(remoteVectorize()), /40052/);
	assert.equal(lists, 3);
	// Any other listing error isn't retried
	lists = 0;
	globalThis.fetch = async (url, init) => (String(url).includes('/list') && ++lists ? new Response(JSON.stringify({ success: false, errors: [{ code: 40004, message: 'count must be 1-1000' }] }), { status: 400 }) : cf.fetch(url, init));
	await assert.rejects(listAllVectorIds(remoteVectorize()), /40004/);
	assert.equal(lists, 1);
	// It waits before each new listing, longer each time
	listing.retryWaitsMs = [40, 80];
	lists = 0;
	globalThis.fetch = async (url, init) => (String(url).includes('/list') && String(url).includes('cursor=') && ++lists ? corrupted() : cf.fetch(url, init));
	const started = Date.now();
	await assert.rejects(listAllVectorIds(remoteVectorize()), /40052/);
	assert.ok(Date.now() - started >= 120, `waited ${Date.now() - started} ms`);
	listing.retryWaitsMs = [0, 0];
});

test('a snapshot groups by episode: a same-date neighbour, a longer ID or a malformed one never joins', async () => {
	const odd = [`${A}:12x`, `${A}:1:2`, 'no-colon', ':5'];
	stand({ ids: [...idsOf(A, 3), ...idsOf(B, 2), `${A}0:5`, ...odd] });
	const snap = await vectorIdSnapshot(remoteVectorize());
	assert.equal(snap.count, 10);
	assert.deepEqual(sorted(snap.forEpisode(A)), sorted(idsOf(A, 3)));
	assert.deepEqual(sorted(snap.forEpisode(B)), sorted(idsOf(B, 2)));
	assert.deepEqual(snap.forEpisode(`${A}0`), [`${A}0:5`]); // well formed, so an episode of its own
	assert.deepEqual(sorted(snap.unrecognised()), sorted(odd));
	assert.deepEqual(sorted(snap.episodes()), sorted([A, B, `${A}0`]));
	assert.deepEqual(snap.prefixesNotIn(new Set([A, B])), [`${A}0`]);
	assert.equal(snap.all().length, 10);
});

test('replace and drop keep a snapshot up to date, and never move another episode\'s IDs', async () => {
	stand({ ids: [...idsOf(A, 3), ...idsOf(B, 2)] });
	const snap = await vectorIdSnapshot(remoteVectorize());
	snap.replace(A, [`${A}:7000`, `${A}:8000`, `${B}:0`, `${A}:7000`]);
	assert.deepEqual(snap.forEpisode(A), [`${A}:7000`, `${A}:8000`]);
	assert.deepEqual(sorted(snap.forEpisode(B)), sorted(idsOf(B, 2)));
	snap.drop(B);
	assert.deepEqual(snap.forEpisode(B), []);
	assert.deepEqual(snap.prefixesNotIn(new Set()), [A]);
	snap.replace(A, []);
	assert.deepEqual(snap.episodes(), []);
	assert.deepEqual(snap.all(), []);
});

test('waitUntilApplied returns once the index has processed the write', async () => {
	const cf = stand({ ids: idsOf(A, 3), queued: true });
	const vectorize = remoteVectorize();
	await outsideTestRun(() => vectorize.deleteByIds([`${A}:0`]));
	assert.ok(cf.index.has(`${A}:0`), 'still queued');
	setTimeout(() => cf.apply(), 40);
	const info = await waitUntilApplied(vectorize, { mutationId: vectorize.lastMutation.mutationId }, { pollMs: 10, timeoutMs: 5000 });
	assert.equal(info.processedUpToMutation, 'mutation-1');
	assert.ok(!cf.index.has(`${A}:0`));
	assert.ok(cf.ops().filter((op) => op === 'info').length >= 2, 'it polled');
});

test('after another writer\'s mutation has passed it, the write\'s own deletes (or new IDs) decide', async () => {
	const cf = stand({ ids: [...idsOf(A, 3), ...idsOf(B, 1)], queued: true });
	const vectorize = remoteVectorize();
	const before = new Set(cf.index.keys());
	await outsideTestRun(() => vectorize.deleteByIds([`${A}:0`, `${A}:1000`, `${A}:99000`])); // the last was never there
	cf.otherWrite(() => cf.index.delete(`${B}:0`));
	cf.apply();
	const deletes = appliedCheck(vectorize.lastMutation, before);
	assert.deepEqual(deletes, { mutationId: 'mutation-1', deletedIds: [`${A}:0`, `${A}:1000`] });
	assert.equal((await waitUntilApplied(vectorize, deletes, { pollMs: 10, timeoutMs: 5000 })).processedUpToMutation, 'mutation-2');

	await outsideTestRun(() => vectorize.upsert([{ id: `${A}:2000`, values: [1, 1] }, { id: `${A}:50000`, values: [1, 1] }]));
	cf.otherWrite(() => {});
	cf.apply();
	const upserts = appliedCheck(vectorize.lastMutation, before);
	assert.deepEqual(upserts, { mutationId: 'mutation-3', newIds: [`${A}:50000`] });
	assert.equal((await waitUntilApplied(vectorize, upserts, { pollMs: 10, timeoutMs: 5000 })).processedUpToMutation, 'mutation-4');
});

test('waitUntilApplied gives up at its time limit while nothing shows', async () => {
	const cf = stand({ ids: idsOf(A, 3), queued: true });
	const vectorize = remoteVectorize();
	await outsideTestRun(() => vectorize.deleteByIds([`${A}:0`]));
	await assert.rejects(
		waitUntilApplied(vectorize, { mutationId: 'mutation-1', deletedIds: [`${A}:0`] }, { pollMs: 10, timeoutMs: 80 }),
		/Vectorize hasn't applied mutation mutation-1 after 0 s \(it has processed up to nothing yet\)/,
	);
	await assert.rejects(waitUntilApplied(vectorize, { mutationId: 'mutation-1' }, { pollMs: 10, timeoutMs: 50 }), /hasn't applied mutation mutation-1/);
	assert.equal(cf.queue.length, 1, 'never applied');
});

test('chunkEpisode gives a transcript file\'s windows as the Worker makes them', () => {
	const segments = [0, 10, 30, 50, 70].map((s, i, all) => ({ start_ms: s * 1000, end_ms: (all[i + 1] ?? 90) * 1000, text: `words spoken from ${s} seconds on` }));
	const file = { episode_id: A, title: 'Stairway Streets!', segments, meta: { audio_ms: 200_000 } };
	const windows = chunkSegments(A, segments, 200_000);
	assert.deepEqual(chunkEpisode(file), windows.map((w) => ({ ...w, episode_id: A, title: 'Stairway Streets!' })));
	assert.deepEqual(chunkEpisode({ episode_id: A, title: A, segments: [] }), []);
});

test('vectorsNdjson writes what wrangler vectorize upsert takes back: one {id, values, metadata} a line', () => {
	const text = vectorsNdjson([{ id: `${A}:0`, values: [1, 2], metadata: { text: 'hi' }, namespace: null }, { id: `${A}:5000`, values: [3], metadata: {} }]);
	assert.equal(text, `{"id":"${A}:0","values":[1,2],"metadata":{"text":"hi"}}\n{"id":"${A}:5000","values":[3],"metadata":{}}\n`);
	assert.equal(vectorsNdjson([]), '');
});
