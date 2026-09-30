/**
 * Workers AI and Vectorize bindings for Node scripts, over Cloudflare's REST
 * API, so a script can run the Worker's own embeddings code
 * (roe-pipeline/src/embeddings.js) instead of keeping a copy of it. The same
 * idea as remote-d1.js for D1. Vectorize also gets what the Worker's binding
 * can't do: list the index's IDs (vector-ids.js).
 *
 * Cloudflare allows 1,200 API requests per 5 minutes per user, and going over
 * blocks every call (wrangler's too) for 5 minutes. So a process sends at most
 * about 3 requests a second, and a 429, a 5xx or no answer is tried again (3
 * tries in all) before it fails. A write or a Workers AI call gets only the
 * tries that fit in the time the pipeline's code allows it, so none is still
 * going after the caller has given up on it.
 *
 * In a test run (ROE_PERSIST_TO) the Vectorize writes are refused: the index
 * has no local copy, so they could only reach production. Reads are allowed.
 */

import { TIMEOUT_MS as PIPELINE_TIMEOUT_MS } from '../roe-pipeline/src/limits.js';
import { VECTORIZE_INDEX } from './lib.js';

const TIMEOUT_MS = 60_000; // one request
const GET_BATCH_SIZE = 20; // get_by_ids takes at most 20 IDs (21 gets a 400)

// How far apart one process's requests start, how long to wait before each
// retry, and how long a write or Workers AI call may take in all, retries
// included: embeddings.js gives each of those PIPELINE_TIMEOUT_MS.ai (60 s),
// then counts it failed, so a write only gets the retries that fit. Reads get
// them all: from 23:30 on 2026-09-29, Vectorize answered 13 list and get
// requests with 504s over four hours, and one read needed its last spare try.
// Tests set them lower.
export const pacing = { gapMs: 340, retryWaitsMs: [2_000, 10_000, 30_000, 60_000], budgetMs: PIPELINE_TIMEOUT_MS.ai - 5_000 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let nextTurn = 0;

/** Wait until this request may start: pacing.gapMs after the one before, from any caller. */
async function waitTurn() {
	const now = Date.now();
	const at = Math.max(now, nextTurn);
	nextTurn = at + pacing.gapMs;
	if (at > now) await sleep(at - now);
}

function api() {
	const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
	const token = process.env.CLOUDFLARE_API_TOKEN;
	if (!accountId || !token) throw new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set (in .env)');
	return {
		base: `https://api.cloudflare.com/client/v4/accounts/${accountId}`,
		headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'roe-scripts' },
	};
}

/** One API call, tried again on a 429, a 5xx or no answer; every try ends by `budgetMs` from the start. */
async function call(what, url, init, { budgetMs = Infinity } = {}) {
	const deadline = Date.now() + budgetMs;
	for (let attempt = 1; ; attempt++) {
		const retryWait = pacing.retryWaitsMs[attempt - 1];
		const canRetry = () => retryWait !== undefined && Date.now() + retryWait < deadline;
		await waitTurn();
		let res;
		try {
			res = await fetch(url, { ...init, signal: AbortSignal.timeout(Math.max(1, Math.min(TIMEOUT_MS, deadline - Date.now()))) });
		} catch (err) {
			// No answer (the network, or the time limit)
			if (!canRetry()) throw new Error(`${what} failed: ${err.message}`);
			console.warn(`  ${what} failed (${err.message}); trying again in ${retryWait / 1000} s`);
			await sleep(retryWait);
			continue;
		}
		if (res.ok) return (await res.json()).result;
		const body = (await res.text()).slice(0, 300);
		if ((res.status === 429 || res.status >= 500) && canRetry()) {
			console.warn(`  ${what} error ${res.status}; trying again in ${retryWait / 1000} s`);
			await sleep(retryWait);
			continue;
		}
		const limit = res.status === 429 ? ' (Cloudflare\'s API limit, 1,200 requests per 5 minutes: wait 5 minutes)' : '';
		throw new Error(`${what} error ${res.status}${limit}: ${body}`);
	}
}

function refuseInTestRun(what) {
	if (process.env.ROE_PERSIST_TO) throw new Error(`ROE_PERSIST_TO is set (a test run): refusing to ${what} production Vectorize`);
}

/** Like the Worker's env.AI: run(model, input) returns the model's result ({shape, data} for embeddings). */
export function remoteAI() {
	return {
		async run(model, input) {
			const { base, headers } = api();
			return call('Workers AI', `${base}/ai/run/${model}`, {
				method: 'POST',
				headers: { ...headers, 'Content-Type': 'application/json' },
				body: JSON.stringify(input),
			}, { budgetMs: pacing.budgetMs });
		},
	};
}

/**
 * Like the Worker's env.VECTORIZE (upsert, deleteByIds, getByIds), plus listIds
 * and info. `lastMutation` is the last write this one sent ({mutationId, kind,
 * ids, sentAt}), for vector-ids.js's waitUntilApplied.
 */
export function remoteVectorize(index = VECTORIZE_INDEX) {
	const indexUrl = (op) => `${api().base}/vectorize/v2/indexes/${index}/${op}`;
	const send = (what, op, contentType, body, options) => call(what, indexUrl(op), {
		method: 'POST',
		headers: { ...api().headers, 'Content-Type': contentType },
		body,
	}, options);
	const write = () => ({ budgetMs: pacing.budgetMs }); // see pacing: embeddings.js gives a write 60 s in all

	const vectorize = {
		lastMutation: null,

		async upsert(vectors) {
			refuseInTestRun('write to');
			const result = await send('Vectorize upsert', 'upsert', 'application/x-ndjson', vectors.map((v) => JSON.stringify(v)).join('\n'), write());
			vectorize.lastMutation = { mutationId: result?.mutationId ?? null, kind: 'upsert', ids: vectors.map((v) => v.id), sentAt: new Date().toISOString() };
			return result;
		},

		async deleteByIds(ids) {
			refuseInTestRun('delete from');
			const result = await send('Vectorize delete', 'delete_by_ids', 'application/json', JSON.stringify({ ids }), write());
			vectorize.lastMutation = { mutationId: result?.mutationId ?? null, kind: 'delete', ids: [...ids], sentAt: new Date().toISOString() };
			return result;
		},

		/** One page (at most 1,000) of the index's IDs, in the index's own order, not by ID. A read. */
		async listIds({ count = 1000, cursor = null } = {}) {
			const query = new URLSearchParams({ count: String(count) });
			if (cursor) query.set('cursor', cursor);
			const page = await call('Vectorize list', `${indexUrl('list')}?${query}`, { headers: api().headers });
			if (page.isTruncated && !page.nextCursor) throw new Error('The Vectorize listing says there is more but gives no cursor to get it; try again');
			return { ids: page.vectors.map((v) => v.id), nextCursor: page.isTruncated ? page.nextCursor : null, totalCount: page.totalCount };
		},

		/** The vectors ({id, values, metadata}) that exist for these IDs, 20 a request; missing IDs are left out. A read. */
		async getByIds(ids) {
			const found = [];
			for (let i = 0; i < ids.length; i += GET_BATCH_SIZE) {
				found.push(...await send('Vectorize get', 'get_by_ids', 'application/json', JSON.stringify({ ids: ids.slice(i, i + GET_BATCH_SIZE) })));
			}
			return found;
		},

		/** {dimensions, vectorCount, processedUpToMutation, processedUpToDatetime}. A read. */
		async info() {
			return call('Vectorize info', indexUrl('info'), { headers: api().headers });
		},
	};
	return vectorize;
}
