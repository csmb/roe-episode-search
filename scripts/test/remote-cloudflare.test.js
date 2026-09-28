// node --test scripts/test/*.test.js
// remote-cloudflare.js against a stand-in for Cloudflare's REST API (helpers/fake-cloudflare.js): nothing reaches the network.
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
const { remoteAI, remoteVectorize, pacing } = await import('../remote-cloudflare.js');
const { deleteEpisodeVectors, replaceEmbeddings } = await import('../../roe-pipeline/src/embeddings.js');
pacing.gapMs = 0;
pacing.retryWaitsMs = [0, 0];

const A = 'roll-over-easy_2016-03-24_07-30-00';
const B = 'roll-over-easy_2016-03-24_07-56-07';
const idsOf = (episode, n, from = 0) => Array.from({ length: n }, (_, i) => `${episode}:${(from + i) * 1000}`);

function stand(options) {
	const cf = fakeCloudflare(options);
	globalThis.fetch = cf.fetch;
	return cf;
}

/** Run `fn` as a real run would: ROE_PERSIST_TO unset (the fetch is still the stand-in). */
async function outsideTestRun(fn) {
	const saved = process.env.ROE_PERSIST_TO;
	delete process.env.ROE_PERSIST_TO;
	try {
		return await fn();
	} finally {
		process.env.ROE_PERSIST_TO = saved;
	}
}

test('a test run refuses Vectorize writes before sending anything; reads are allowed', async () => {
	const cf = stand({ ids: idsOf(A, 3) });
	const vectorize = remoteVectorize();
	await assert.rejects(vectorize.upsert([{ id: `${A}:0`, values: [1, 2] }]), /ROE_PERSIST_TO is set \(a test run\): refusing to write to production Vectorize/);
	await assert.rejects(vectorize.deleteByIds([`${A}:0`]), /refusing to delete from production Vectorize/);
	assert.deepEqual(cf.requests, []);
	assert.equal(vectorize.lastMutation, null);
	assert.equal((await vectorize.info()).vectorCount, 3);
	assert.deepEqual((await vectorize.getByIds([`${A}:0`])).map((v) => v.id), [`${A}:0`]);
	assert.equal((await vectorize.listIds()).ids.length, 3);
	assert.deepEqual(cf.ops(), ['info', 'get_by_ids', 'list']);
});

test('listIds asks for 1,000 IDs a page and hands the cursor back exactly', async () => {
	const cf = stand({ ids: [...idsOf(A, 1500), ...idsOf(B, 1000)] });
	const vectorize = remoteVectorize();
	const pages = [];
	let cursor = null;
	do {
		const page = await vectorize.listIds({ cursor });
		pages.push(page);
		cursor = page.nextCursor;
	} while (cursor);
	assert.deepEqual(pages.map((p) => [p.ids.length, p.totalCount]), [[1000, 2500], [1000, 2500], [500, 2500]]);
	assert.deepEqual(cf.requests.map((r) => r.query), [
		{ count: '1000' },
		{ count: '1000', cursor: pages[0].nextCursor },
		{ count: '1000', cursor: pages[1].nextCursor },
	]);
	assert.equal(new Set(pages.flatMap((p) => p.ids)).size, 2500);
});

test('getByIds asks for 20 IDs at a time and leaves out the missing ones', async () => {
	const cf = stand({ ids: idsOf(A, 40) });
	const want = [...idsOf(A, 40), ...idsOf(A, 5, 100)];
	const found = await remoteVectorize().getByIds(want);
	assert.deepEqual(found.map((v) => v.id), idsOf(A, 40));
	assert.deepEqual(found[0], { id: `${A}:0`, values: [0.5, 0.25], metadata: { episode_id: A, text: `text of ${A}:0` } });
	assert.deepEqual(cf.requests.map((r) => JSON.parse(r.body).ids.length), [20, 20, 5]);
	assert.deepEqual(await remoteVectorize().getByIds([]), []);
	assert.equal(cf.requests.length, 3);
});

test('a 429, a 5xx or no answer is tried again, 3 tries in all; a 400 is not', async () => {
	const cf = stand({ ids: idsOf(A, 2) });
	const vectorize = remoteVectorize();
	cf.failNext(429);
	assert.equal((await vectorize.info()).vectorCount, 2);
	assert.equal(cf.requests.length, 2);

	cf.failNext(503, 'network');
	assert.equal((await vectorize.info()).vectorCount, 2);
	assert.equal(cf.requests.length, 5);

	cf.failNext(429, 500, 429);
	await assert.rejects(vectorize.info(), /Vectorize info error 429 \(Cloudflare's API limit, 1,200 requests per 5 minutes: wait 5 minutes\)/);
	assert.equal(cf.requests.length, 8);

	cf.failNext('network', 'network', 'network');
	await assert.rejects(vectorize.info(), /Vectorize info failed: fetch failed/);
	assert.equal(cf.requests.length, 11);

	cf.failNext(400);
	await assert.rejects(vectorize.getByIds([`${A}:0`]), /Vectorize get error 400/);
	assert.equal(cf.requests.length, 12);
});

test('a write or Workers AI call only gets the tries that fit in its budget, so none is left going after it fails', async () => {
	const cf = stand({ ids: idsOf(A, 1) });
	const hangs = (op) => (url, init) => (String(url).endsWith(op)
		? new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))
		: cf.fetch(url, init));
	const vectorize = remoteVectorize();
	const saved = pacing.budgetMs;
	pacing.budgetMs = 150;
	try {
		const started = Date.now();
		globalThis.fetch = hangs('/upsert');
		await assert.rejects(outsideTestRun(() => vectorize.upsert([{ id: `${A}:5000`, values: [1, 1] }])), /Vectorize upsert failed: The operation was aborted due to timeout/);
		globalThis.fetch = hangs('/delete_by_ids');
		await assert.rejects(outsideTestRun(() => vectorize.deleteByIds([`${A}:0`])), /Vectorize delete failed/);
		globalThis.fetch = hangs('/ai/run/@cf/baai/bge-base-en-v1.5');
		await assert.rejects(remoteAI().run('@cf/baai/bge-base-en-v1.5', { text: ['hi'] }), /Workers AI failed/);
		assert.ok(Date.now() - started < 2_000, `three calls with a 150 ms budget took ${Date.now() - started} ms`);
		const sent = cf.requests.length;
		await new Promise((r) => setTimeout(r, 300));
		assert.equal(cf.requests.length, sent, 'no try after the budget ran out');
		assert.equal(vectorize.lastMutation, null);

		// A quick failure inside the budget is still tried again
		globalThis.fetch = cf.fetch;
		pacing.budgetMs = 5_000;
		cf.failNext(503);
		await outsideTestRun(() => vectorize.upsert([{ id: `${A}:5000`, values: [1, 1] }]));
		assert.ok(cf.index.has(`${A}:5000`));
		// Reads have no budget: a read's tries aren't cut short
		cf.failNext(503, 503);
		assert.equal((await vectorize.info()).vectorCount, 2);
	} finally {
		pacing.budgetMs = saved;
	}
});

test('one process starts at most one request every pacing.gapMs, from any caller', async () => {
	const cf = stand({ ids: idsOf(A, 1) });
	pacing.gapMs = 60;
	try {
		await Promise.all([remoteVectorize().info(), remoteVectorize().info(), remoteVectorize().listIds(), remoteAI().run('@cf/baai/bge-base-en-v1.5', { text: ['hi'] })]);
	} finally {
		pacing.gapMs = 0;
	}
	const gaps = cf.requests.slice(1).map((r, i) => r.at - cf.requests[i].at);
	assert.equal(gaps.length, 3);
	for (const gap of gaps) assert.ok(gap >= 55, `requests ${gap} ms apart`);
});

test('deletes go 100 IDs a request, and the last write is remembered', async () => {
	const cf = stand({ ids: [...idsOf(A, 250), ...idsOf(B, 2)] });
	const vectorize = remoteVectorize();
	await outsideTestRun(() => deleteEpisodeVectors(vectorize, A, idsOf(A, 250)));
	assert.deepEqual(cf.requests.map((r) => [r.op, JSON.parse(r.body).ids.length]), [['delete_by_ids', 100], ['delete_by_ids', 100], ['delete_by_ids', 50]]);
	assert.deepEqual([...cf.index.keys()], idsOf(B, 2));
	assert.deepEqual(vectorize.lastMutation, { mutationId: 'mutation-3', kind: 'delete', ids: idsOf(A, 50, 200), sentAt: vectorize.lastMutation.sentAt });
});

test('replaceEmbeddings through the REST stand-ins: embed, upsert, then delete, and nothing of the neighbour\'s', async () => {
	const cf = stand({ ids: [`${A}:0`, `${A}:5000`, `${A}:40000`, `${B}:0`] });
	const vectorize = remoteVectorize();
	const lines = [0, 10, 30, 50, 70].map((s, i, all) => ({ start_ms: s * 1000, end_ms: (all[i + 1] ?? 90) * 1000, text: `words spoken from ${s} seconds on` }));
	const result = await outsideTestRun(() => replaceEmbeddings(remoteAI(), vectorize, A, lines, 90000, [`${A}:0`, `${A}:5000`, `${A}:40000`, `${B}:0`]));
	assert.deepEqual(result, { upserted: 3, deleted: 2, ids: [`${A}:0`, `${A}:30000`, `${A}:70000`] });
	assert.deepEqual(cf.ops(), ['ai', 'upsert', 'delete_by_ids']);
	assert.deepEqual(JSON.parse(cf.requests[2].body), { ids: [`${A}:5000`, `${A}:40000`] });
	assert.deepEqual([...cf.index.keys()].sort(), [`${A}:0`, `${A}:30000`, `${A}:70000`, `${B}:0`].sort());
	assert.deepEqual(cf.index.get(`${A}:30000`).metadata, { episode_id: A, title: A, start_ms: 30000, end_ms: 90000, text: 'words spoken from 30 seconds on words spoken from 50 seconds on words spoken from 70 seconds on' });
	assert.equal(vectorize.lastMutation.kind, 'delete');
});

test('every request carried the key and a time limit, and went to the account\'s API', async () => {
	const cf = stand({ ids: idsOf(A, 25) });
	const vectorize = remoteVectorize();
	await vectorize.info();
	await vectorize.listIds({ count: 10 });
	await vectorize.getByIds(idsOf(A, 25));
	await outsideTestRun(() => vectorize.upsert([{ id: `${A}:99000`, values: [1, 1] }]));
	assert.equal(cf.requests.length, 5);
	assert.ok(cf.requests.every((r) => r.auth && r.hasTimeout));
	assert.ok(cf.requests.every((r) => r.path.startsWith('vectorize/v2/indexes/roe-transcripts/')));
});
