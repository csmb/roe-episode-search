/**
 * Workers AI and Vectorize bindings for Node scripts, over Cloudflare's REST
 * API, so a script can run the Worker's own embeddings code
 * (roe-pipeline/src/embeddings.js) instead of keeping a copy of it. The same
 * idea as remote-d1.js for D1.
 *
 * In a test run (ROE_PERSIST_TO) the Vectorize writes are refused: the index
 * has no local copy, so they could only reach production.
 */

import { VECTORIZE_INDEX } from './lib.js';

const TIMEOUT_MS = 60_000;

function api() {
	const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
	const token = process.env.CLOUDFLARE_API_TOKEN;
	if (!accountId || !token) throw new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set (in .env)');
	return {
		base: `https://api.cloudflare.com/client/v4/accounts/${accountId}`,
		headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'roe-scripts' },
	};
}

async function call(what, url, init) {
	const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
	if (!res.ok) throw new Error(`${what} error ${res.status}: ${(await res.text()).slice(0, 300)}`);
	return (await res.json()).result;
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
			});
		},
	};
}

/** Like the Worker's env.VECTORIZE, plus deleteByIds for the vectors a new transcript no longer has. */
export function remoteVectorize(index = VECTORIZE_INDEX) {
	return {
		async upsert(vectors) {
			refuseInTestRun('write to');
			const { base, headers } = api();
			return call('Vectorize upsert', `${base}/vectorize/v2/indexes/${index}/upsert`, {
				method: 'POST',
				headers: { ...headers, 'Content-Type': 'application/x-ndjson' },
				body: vectors.map((v) => JSON.stringify(v)).join('\n'),
			});
		},
		async deleteByIds(ids) {
			refuseInTestRun('delete from');
			const { base, headers } = api();
			return call('Vectorize delete', `${base}/vectorize/v2/indexes/${index}/delete_by_ids`, {
				method: 'POST',
				headers: { ...headers, 'Content-Type': 'application/json' },
				body: JSON.stringify({ ids }),
			});
		},
	};
}
