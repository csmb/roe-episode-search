/**
 * The search index's vector IDs, for the scripts. A vector's ID is its episode
 * and its window's start ("<episode-id>:<ms>", see chunkSegments), so an
 * episode's vectors are the IDs that start with "<episode-id>:".
 *
 * Vectorize can't be asked for one episode's IDs: the only way is to list the
 * whole index (about 100 requests and half a minute for 98,000 IDs, in no
 * useful order), and the Worker's binding can't list at all. So a script lists
 * once per run and keeps its snapshot up to date as it writes: each episode's
 * IDs are only ever written by that episode's own step.
 *
 * Writes are queued by Vectorize (under 30 s as a rule) and a listing doesn't
 * see them until they're applied; waitUntilApplied() waits for them.
 *
 * Loads no .env, so tests and other scripts can import it.
 */

import { chunkSegments, isEpisodeVectorId } from '../roe-pipeline/src/embeddings.js';

const LIST_PAGE = 1000; // the most one list request returns

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The windows a transcript file ({episode_id, title, segments}) is embedded
 * in, exactly as the Worker makes them: what its vector IDs are.
 */
export function chunkEpisode(transcript) {
	const { episode_id, title, segments } = transcript;
	if (!segments || segments.length === 0) return [];
	return chunkSegments(episode_id, segments, transcript.meta?.audio_ms).map((c) => ({ ...c, episode_id, title }));
}

/** Every vector ID in the index, in the order the index lists them (not by ID). */
export async function listAllVectorIds(vectorize) {
	const ids = [];
	const seen = new Set();
	let cursor = null;
	do {
		const page = await vectorize.listIds({ count: LIST_PAGE, cursor });
		ids.push(...page.ids);
		if (page.nextCursor && seen.has(page.nextCursor)) throw new Error('The Vectorize listing sent the same page twice; try again');
		seen.add(page.nextCursor);
		cursor = page.nextCursor;
	} while (cursor);
	return ids;
}

/** The episode an ID names: everything before its last ':' ('' when the ID isn't "<episode>:<digits>"). */
export function episodeOf(id) {
	const at = id.lastIndexOf(':');
	const episode = at > 0 ? id.slice(0, at) : '';
	return episode && !episode.includes(':') && isEpisodeVectorId(episode, id) ? episode : '';
}

/**
 * One listing of the index, grouped by episode, for a run to keep up to date
 * as it writes (replace, drop).
 *
 * - forEpisode(id): the episode's IDs, exactly "<id>:<digits>"
 * - replace(id, ids) / drop(id): after the run has written the episode
 * - episodes(): every episode with IDs; prefixesNotIn(ids): those not in a Set
 * - unrecognised(): IDs that aren't "<episode>:<digits>" (no tool touches them)
 * - all(): every ID as the snapshot has it now
 */
export async function vectorIdSnapshot(vectorize) {
	const listed = await listAllVectorIds(vectorize);
	const byEpisode = new Map();
	const unrecognised = [];
	for (const id of listed) {
		const episode = episodeOf(id);
		if (!episode) {
			unrecognised.push(id);
			continue;
		}
		if (!byEpisode.has(episode)) byEpisode.set(episode, []);
		byEpisode.get(episode).push(id);
	}
	return {
		takenAt: new Date(),
		count: listed.length,
		forEpisode: (episodeId) => [...(byEpisode.get(episodeId) ?? [])],
		replace(episodeId, ids) {
			const own = [...new Set(ids)].filter((id) => isEpisodeVectorId(episodeId, id));
			if (own.length > 0) byEpisode.set(episodeId, own);
			else byEpisode.delete(episodeId);
		},
		drop: (episodeId) => void byEpisode.delete(episodeId),
		episodes: () => [...byEpisode.keys()],
		prefixesNotIn: (episodeIds) => [...byEpisode.keys()].filter((e) => !episodeIds.has(e)),
		unrecognised: () => [...unrecognised],
		all: () => [...[...byEpisode.values()].flat(), ...unrecognised],
	};
}

/**
 * Wait until Vectorize has applied a write (a listing can't see it before).
 * Done when the index has processed up to its mutation, or, when another
 * writer's later mutation has already taken that place, when the write shows:
 * the IDs it deleted are gone (a run sends its deletes after its upserts, and
 * the queue is applied in order), or, for an upsert, the IDs it added are there.
 *
 * @param {{mutationId: string, deletedIds?: string[], newIds?: string[]}} write -
 *   deletedIds: IDs it deleted that the index had (from a listing); newIds: IDs
 *   it added that the index didn't have. With neither, only the mutation counts.
 */
export async function waitUntilApplied(vectorize, { mutationId, deletedIds = [], newIds = [] }, { timeoutMs = 10 * 60_000, pollMs = 5_000 } = {}) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const info = await vectorize.info();
		if (info.processedUpToMutation === mutationId) return info;
		const probe = (deletedIds.length > 0 ? deletedIds : newIds).slice(0, 20);
		if (probe.length > 0) {
			const found = (await vectorize.getByIds(probe)).length;
			if (deletedIds.length > 0 ? found === 0 : found === probe.length) return info;
		}
		if (Date.now() >= deadline) {
			throw new Error(`Vectorize hasn't applied mutation ${mutationId} after ${Math.round(timeoutMs / 1000)} s (it has processed up to ${info.processedUpToDatetime ?? 'nothing yet'})`);
		}
		await sleep(pollMs);
	}
}

/**
 * What waitUntilApplied needs to know about remoteVectorize's lastMutation,
 * given the IDs the index had before the run wrote anything.
 */
export function appliedCheck(lastMutation, hadBefore) {
	const { mutationId, kind, ids } = lastMutation;
	return kind === 'delete'
		? { mutationId, deletedIds: ids.filter((id) => hadBefore.has(id)) }
		: { mutationId, newIds: ids.filter((id) => !hadBefore.has(id)) };
}

/** Vectors as the NDJSON lines `wrangler vectorize upsert --file` takes back. */
export function vectorsNdjson(vectors) {
	return vectors.map(({ id, values, metadata }) => `${JSON.stringify({ id, values, metadata })}\n`).join('');
}
