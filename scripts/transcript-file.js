/**
 * The transcript files in transcripts/ (<episode-id>.json), written the same
 * way by both engines: whisper.cpp (process-episode.js) and OpenAI
 * (transcribe.js).
 *
 * - Spelling fixes and loop removal happen before the file is saved, so the
 *   file, D1 and the search vectors all hold the same lines.
 * - A `meta` block records how the transcript was made (engine, model,
 *   settings, the recording's real length, what was removed, holes, and
 *   whether it covers the recording).
 * - An episode that lost 50+ lines to a loop, or has a hole of 5+ minutes, goes
 *   on the re-transcribe list, transcripts/.retranscribe/episodes.json (a folder,
 *   so scripts that read every transcripts/*.json never mistake it for one).
 * - When a transcript is replaced, its old vector IDs are kept in
 *   transcripts/.stale-vectors/<id>.json until the new ones are uploaded, so
 *   the embeddings step can delete the ones the new transcript doesn't have.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { findLoops } from '../roe-pipeline/src/clean-segments.js';
import { checkCoverage } from '../roe-pipeline/src/coverage.js';
import { SF_VOCAB_PROMPT } from '../roe-pipeline/src/whisper-prompt.js';
import { applyWordCorrections, transcriptsDir } from './lib.js';

const RETRANSCRIBE_LIST = () => path.join(transcriptsDir, '.retranscribe', 'episodes.json');
const STALE_DIR = () => path.join(transcriptsDir, '.stale-vectors');
const RETRANSCRIBE_AT_LINES = 50;

export const PROMPT_SHA1 = crypto.createHash('sha1').update(SF_VOCAB_PROMPT).digest('hex').slice(0, 12);

export function transcriptPath(episodeId) {
	return path.join(transcriptsDir, `${episodeId}.json`);
}

export function readTranscript(episodeId) {
	const file = transcriptPath(episodeId);
	return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : null;
}

/**
 * The transcript for an episode, from an engine's cleaned lines.
 *
 * @param {object} run
 * @param {string} run.episodeId
 * @param {Array<{start_ms, end_ms, text}>} run.segments - in time order
 * @param {number} run.audioMs - the recording's real length (ffprobe)
 * @param {string} run.engine - "openai" or "whisper.cpp"
 * @param {string} run.model
 * @param {object} [run.settings] - what the engine was run with
 * @param {string} [run.audioFile]
 * @param {number} [run.removedByCleaning] - lines the engine's cleaning dropped
 * @param {Array} [run.knownLoops] - loops the engine's cleaning already dropped (the Worker's finishTranscription)
 */
export function buildTranscript({ episodeId, title = episodeId, segments, audioMs, engine, model, settings = {}, audioFile = null, removedByCleaning = 0, knownLoops = [] }) {
	const corrected = segments.map((s) => ({ ...s, text: applyWordCorrections(s.text) }));
	const { segments: kept, loops: found } = findLoops(corrected);
	const loops = [...knownLoops, ...found]; // knownLoops: already dropped by the engine's own cleaning
	const coverage = checkCoverage(kept, audioMs);
	return {
		episode_id: episodeId,
		title,
		segments: kept,
		meta: {
			engine,
			model,
			created_at: new Date().toISOString(),
			settings,
			audio_file: audioFile ? path.basename(audioFile) : null,
			audio_ms: audioMs,
			lines_removed: { cleaning: removedByCleaning - knownLoops.reduce((n, l) => n + l.removed, 0), loops: loops.reduce((n, l) => n + l.removed, 0) },
			loops,
			holes: coverage.holes,
			coverage: { ok: coverage.ok, problems: coverage.problems },
		},
	};
}

/** Why an episode should be transcribed again, from its transcript's meta (empty: it shouldn't). */
export function retranscribeReasons(meta) {
	const reasons = [...(meta.coverage?.problems ?? [])];
	const loopLines = meta.lines_removed?.loops ?? 0;
	if (loopLines >= RETRANSCRIBE_AT_LINES) reasons.push(`${loopLines} lines of Whisper looping removed`);
	if (meta.holes?.length) reasons.push(`${meta.holes.length} hole(s) of 5+ minutes`);
	return reasons;
}

/**
 * Save a transcript, keeping the vector IDs of the one it replaces for the
 * embeddings step, and update the re-transcribe list. Returns the reasons it
 * went on the list (empty if none).
 */
export function writeTranscript(transcript, { oldVectorIds = [] } = {}) {
	fs.mkdirSync(transcriptsDir, { recursive: true });
	if (oldVectorIds.length > 0) rememberStaleVectors(transcript.episode_id, oldVectorIds);
	fs.writeFileSync(transcriptPath(transcript.episode_id), JSON.stringify(transcript, null, 2));
	const reasons = retranscribeReasons(transcript.meta);
	noteRetranscribe(transcript.episode_id, reasons, transcript.meta);
	return reasons;
}

function noteRetranscribe(episodeId, reasons, meta) {
	const file = RETRANSCRIBE_LIST();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const list = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : {};
	if (reasons.length > 0) {
		list[episodeId] = { reasons, loops: meta.loops, holes: meta.holes, noted_at: new Date().toISOString() };
	} else if (!list[episodeId]) {
		return;
	} else {
		delete list[episodeId];
	}
	fs.writeFileSync(file, JSON.stringify(list, null, 2));
}

/** Vector IDs an episode had before its transcript or D1 lines were replaced (kept until they're deleted). */
export function rememberStaleVectors(episodeId, ids) {
	fs.mkdirSync(STALE_DIR(), { recursive: true });
	const file = path.join(STALE_DIR(), `${episodeId}.json`);
	const had = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : [];
	fs.writeFileSync(file, JSON.stringify([...new Set([...had, ...ids])], null, 2));
}

export function staleVectors(episodeId) {
	const file = path.join(STALE_DIR(), `${episodeId}.json`);
	return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : [];
}

export function forgetStaleVectors(episodeId) {
	fs.rmSync(path.join(STALE_DIR(), `${episodeId}.json`), { force: true });
}
