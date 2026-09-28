/**
 * A stand-in for the parts of Cloudflare's REST API the scripts call
 * (remote-cloudflare.js), for tests: one Vectorize index and Workers AI
 * embeddings, behind a fetch() to put in place of the real one.
 *
 * As strict as the real API: at most 20 IDs a get_by_ids, 100 a
 * delete_by_ids, 1,000 a list page. It lists the way the real index does: a
 * few sorted runs one after another (never in ID order), from a snapshot taken
 * at the first page. Writes go into a queue, as in Vectorize, and are applied
 * at once unless `queued: true` (then apply() applies them, in order).
 * Every request is recorded in `requests`; failNext() makes the next ones fail.
 */

const MAX = { get_by_ids: 20, delete_by_ids: 100, list: 1000, upsert: 5000 };

export const vector = (id) => ({ id, values: [0.5, 0.25], metadata: { episode_id: id.slice(0, id.lastIndexOf(':')), text: `text of ${id}` } });

export function fakeCloudflare({ ids = [], runs = 3, queued = false, accountId = 'test-account' } = {}) {
	const index = new Map(ids.map((id) => [id, vector(id)]));
	const requests = [];
	const failures = [];
	const queue = [];
	const listings = new Map();
	let mutations = 0;
	let processedUpToMutation = null;
	let processedUpToDatetime = null;

	const json = (result, status = 200) => new Response(JSON.stringify(status === 200 ? { success: true, errors: [], result } : { success: false, errors: [result] }), { status, headers: { 'Content-Type': 'application/json' } });

	function apply() {
		for (const write of queue.splice(0)) {
			write.run();
			processedUpToMutation = write.mutationId;
			processedUpToDatetime = new Date().toISOString();
		}
	}

	function write(run) {
		const mutationId = `mutation-${++mutations}`;
		queue.push({ mutationId, run });
		if (!queued) apply();
		return mutationId;
	}

	/** The index's IDs in list order: `runs` sorted runs, one after another. */
	function listOrder() {
		const groups = Array.from({ length: runs }, () => []);
		for (const id of index.keys()) {
			let h = 0;
			for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 1_000_003;
			groups[h % runs].push(id);
		}
		return groups.flatMap((g) => g.sort());
	}

	async function fetch(url, init = {}) {
		const u = new URL(url);
		const prefix = `/client/v4/accounts/${accountId}/`;
		if (u.origin !== 'https://api.cloudflare.com' || !u.pathname.startsWith(prefix)) throw new Error(`unexpected fetch: ${url}`);
		const path = u.pathname.slice(prefix.length);
		const request = {
			method: init.method ?? 'GET',
			op: path.startsWith('ai/run/') ? 'ai' : path.split('/').at(-1),
			path,
			query: Object.fromEntries(u.searchParams),
			body: init.body,
			auth: init.headers?.Authorization === 'Bearer test-token',
			hasTimeout: init.signal instanceof AbortSignal,
			at: Date.now(),
		};
		requests.push(request);

		if (failures.length > 0) {
			const failure = failures.shift();
			if (failure === 'network') throw new TypeError('fetch failed');
			return json({ code: failure, message: `made-up error ${failure}` }, failure);
		}

		if (request.op === 'ai') {
			const { text } = JSON.parse(init.body);
			return json({ shape: [text.length, 2], data: text.map(() => [0.5, 0.25]) });
		}
		if (!path.startsWith('vectorize/v2/indexes/')) throw new Error(`unexpected fetch: ${url}`);

		switch (request.op) {
			case 'list': {
				const count = Number(request.query.count ?? 100);
				if (count < 1 || count > MAX.list) return json({ code: 40004, message: 'count must be 1-1000' }, 400);
				let key = String(listings.size + 1);
				let offset = 0;
				if (request.query.cursor) {
					[key, offset] = request.query.cursor.split('.');
					offset = Number(offset);
					if (!listings.has(key)) return json({ code: 40010, message: 'unknown cursor' }, 400);
				} else {
					listings.set(key, listOrder());
				}
				const snapshot = listings.get(key);
				const page = snapshot.slice(offset, offset + count);
				const isTruncated = offset + count < snapshot.length;
				return json({
					count: page.length,
					totalCount: snapshot.length,
					isTruncated,
					nextCursor: isTruncated ? `${key}.${offset + count}` : null,
					cursorExpirationTimestamp: new Date(Date.now() + 3_600_000).toISOString(),
					vectors: page.map((id) => ({ id })),
				});
			}
			case 'get_by_ids': {
				const { ids: want } = JSON.parse(init.body);
				if (want.length > MAX.get_by_ids) return json({ code: 40007, message: 'too many ids in payload; max id count is 20' }, 400);
				return json(want.filter((id) => index.has(id)).map((id) => index.get(id)));
			}
			case 'delete_by_ids': {
				const { ids: gone } = JSON.parse(init.body);
				if (gone.length > MAX.delete_by_ids) return json({ code: 40007, message: 'too many ids in payload' }, 400);
				return json({ mutationId: write(() => gone.forEach((id) => index.delete(id))) });
			}
			case 'upsert': {
				const vectors = init.body.split('\n').filter(Boolean).map((l) => JSON.parse(l));
				if (vectors.length > MAX.upsert) return json({ code: 40005, message: 'too many vectors' }, 400);
				return json({ mutationId: write(() => vectors.forEach((v) => index.set(v.id, v))) });
			}
			case 'info':
				return json({ dimensions: 2, vectorCount: index.size, processedUpToMutation, processedUpToDatetime });
			default:
				throw new Error(`unexpected fetch: ${url}`);
		}
	}

	return {
		fetch,
		index,
		requests,
		queue,
		apply,
		/** The next requests get these answers instead: an HTTP status, or 'network' for no answer. */
		failNext: (...answers) => failures.push(...answers),
		/** Another writer's write (a function that changes `index`), into the queue; returns its mutation ID. */
		otherWrite: (run) => write(run),
		ops: () => requests.map((r) => r.op),
	};
}
