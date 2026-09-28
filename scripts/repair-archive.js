#!/usr/bin/env node

/**
 * Redo the damaged transcripts on the site from a worklist (the research's
 * repair-worklist.csv): each show is transcribed again in full into a staging
 * folder, checked, and only then replaces the live transcript, one episode at
 * a time. Titles, summaries, guests and places stay as they are.
 *
 * The worklist's `act` column says what happens to each episode:
 *   W, O  redo the whole transcript (O: the wrong-language openings)
 *   J     a split show: join its parts (the `file` column, e.g. "parts 1+5"),
 *         redo the transcript, replace the site's audio with the whole show,
 *         and move the interview time and place-quote times by the length of
 *         the parts that now come before the one the site had
 *   T     install the ready transcript from transcripts/.trial-2026-09-27/
 *   L     delete junk lines only (clean-junk-lines.js: prompt echoes, loops)
 *   M     only correct duration_ms to the length of the site's audio
 *   X     leave alone
 * and `src` where the audio comes from: A / A* the archive file named in
 * `file`, J the archive's parts, R the site's .m4a (made into an MP3), E the
 * raw MP3 upload in R2.
 *
 * For each redo:
 *   1. the audio (joined, or fetched from R2, into transcripts/.repair/audio/)
 *   2. a transcript into transcripts/.repair/staging/, never over the live file:
 *      by default whisper.cpp with large-v3-turbo on the GPU (free, about 0.06-
 *      0.09x the show's length), or --engine openai (the pipeline's code, about
 *      $0.75 a show, paid); --parallel shows at a time
 *   3. checks: it covers the recording, no Whisper loops, at least
 *      --min-word-share of the old D1 transcript's words (loop repeats, echoes
 *      and wrong-language lines not counted; whisper.cpp leaves song lyrics
 *      out), its recording within 5 s of the site's audio, no junk lines left.
 *      Holes of 5+ minutes are noted for review, not refused (long songs).
 *      A whisper.cpp transcript that fails is made once more with the other
 *      model (--retry-model), then with OpenAI only with --fallback-openai and
 *      within --max-cost. A show that still fails is set aside for the owner
 *      (nothing on the site changes) and the run goes on; three set aside in a
 *      row stop it.
 *   Then, one episode at a time:
 *   4. a backup (episode-backup.js; with the .m4a for a join), which keeps the
 *      old local transcript and restore.sql
 *   5. the old local transcript's search window IDs kept as stale, and the new
 *      transcript installed in transcripts/
 *   6. process-episode.js --skip transcribe,summary,guest-start,upload-audio
 *      --force seed-db (a join also forces upload-audio): the seed (one D1
 *      import), then the embeddings step (skipped with --local)
 *   7. checks on D1: every line in and found by keyword search, duration_ms
 *      the recording's length, and the title, summary, guests, reviewed flag,
 *      interview time, audio and place quotes as they were (a join's times
 *      moved, a join's new .m4a the joined length)
 *
 * The run keeps its state in transcripts/.repair/progress.json, so it can be
 * stopped and run again: published episodes are skipped, a staged transcript
 * is published without being made again, and OpenAI resumes a show chunk by
 * chunk. Any failure while publishing (the step that changes the site) stops
 * the run at once; running transcriptions finish, and their transcripts wait
 * for the next run. So does OpenAI spending that would pass --max-cost
 * (default $0: nothing paid). Each episode has a log,
 * transcripts/.repair/logs/<date>.log. A run keeps the Mac awake (caffeinate).
 *
 * Usage:
 *   node scripts/repair-archive.js --worklist <file.csv> --dry-run
 *   node scripts/repair-archive.js --worklist <file.csv> [options]
 *
 * Options:
 *   --only <dates>          only these dates (YYYY-MM-DD, comma-separated)
 *   --except <dates>        leave these dates out
 *   --acts <letters>        only these acts, e.g. --acts J or --acts L,M
 *   --dry-run               show the plan, each episode's audio, the GPU time and any cost; change nothing
 *   --engine whisper.cpp|openai   how to transcribe the redos (default whisper.cpp; openai is paid)
 *   --model <name|file>     whisper.cpp's model: large-v3-turbo (default), large-v3, or a .bin
 *   --retry-model <name|file>   the model for a failed show's second try (default: the other one)
 *   --no-gpu                whisper.cpp on the CPU (much slower; when its GPU start-up hangs)
 *   --fallback-openai       a show whose local transcripts fail twice is done with OpenAI (paid)
 *   --max-cost <dollars>    the most this run may spend on OpenAI (default 0)
 *   --parallel <n>          shows transcribed at once (default 1; they share the GPU); publishing is one at a time
 *   --min-word-share <x>    the share of the old transcript's words a new one needs (default 0.8)
 *   --trial-dir <dir>       the T rows' transcripts (default transcripts/.trial-2026-09-27)
 *   --retry-failed          try again the shows an earlier run set aside
 *   --local                 the local D1 copy and R2 (Vectorize is left alone)
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { ARCHIVE_DIR, R2_PUBLIC_URL, escapeSQL, loadEnv, parseFlags, probeDurationMs, projectRoot, queryJSON, runSQL, transcriptsDir } from './lib.js';
import { joinParts } from '../roe-pipeline/src/mp3-join.js';
import { cleanEpisode, DEFAULT_RULES } from './clean-junk-lines.js';
import { backupEpisode } from './episode-backup.js';
import { chunkEpisode } from './generate-embeddings.js';
import { WHISPER_MODELS, whisperStartProblem } from './process-episode.js';
import { downloadR2Object, siteAudioKey, siteAudioMs } from './site-audio.js';
import { MIN_WORD_SHARE, SITE_AUDIO_SLACK_MS, checkNewTranscript, junkLines } from './transcript-checks.js';
import { readTranscript, writeTranscript } from './transcript-file.js';

const SCRIPT = path.join(projectRoot, 'scripts', 'repair-archive.js');
const PROCESS_EPISODE = path.join(projectRoot, 'scripts', 'process-episode.js');

const WHISPER_USD_PER_MIN = 0.006;
const GAP_RETRY_SHARE = 1.04; // the gap retries re-send about 4% more audio
const JOIN_SLACK_MS = 1_000; // a joined file against the sum of its parts
const FTS_SAMPLES = 5;
const SET_ASIDE_IN_A_ROW = 3; // this many shows set aside one after another: something is wrong, stop

export const DEFAULT_MODEL = 'large-v3-turbo'; // the owner's choice (2026-09-27): free, on the GPU
// whisper.cpp's time as a share of the show's length on this Mac (2026-09-27: four
// 25-29 minute stretches on the GPU; large-v3 on the CPU from L9's test). A fanless
// Mac slows down as it heats up over hours.
export const WHISPER_SPEED = {
	'ggml-large-v3-turbo': { gpu: [0.06, 0.09] },
	'ggml-large-v3': { gpu: [0.14, 0.21], cpu: [2.3, 2.6] },
};

export const ACTS = { W: 'redo', O: 'redo', J: 'join', T: 'trial', L: 'lines', M: 'duration', X: 'skip' };
const SOURCES = ['A', 'A*', 'J', 'R', 'E'];
const TRANSCRIBED = new Set(['redo', 'join', 'trial']);

const repairDir = () => path.join(transcriptsDir, '.repair');
const stagingPath = (id) => path.join(repairDir(), 'staging', `${id}.json`);
const resultPath = (id) => path.join(repairDir(), 'staging', `${id}.result.json`);
const audioPath = (id) => path.join(repairDir(), 'audio', `${id}.mp3`);
const audioFactsPath = (id) => path.join(repairDir(), 'audio', `${id}.json`);
const logPath = (date) => path.join(repairDir(), 'logs', `${date}.log`);
const progressPath = () => path.join(repairDir(), 'progress.json');

const minutes = (ms) => (ms / 60_000).toFixed(1);
const readJSON = (file) => JSON.parse(fs.readFileSync(file, 'utf-8'));

/** The last error in a child's output ('' if none). */
function lastError(output) {
	const line = output.split('\n').reverse().find((l) => /\b(Error|FATAL):/.test(l));
	return line ? line.slice(line.search(/\b(Error|FATAL):/)).replace(/^(Error|FATAL):\s*/, '').trim().slice(0, 300) : '';
}

function writeJSON(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 1));
	fs.renameSync(`${file}.tmp`, file);
}

/** "Sep 27 22:41:03", like the owner's `date "+%b %-d %H:%M:%S"`. */
export function stamp(d = new Date()) {
	return `${d.toLocaleString('en-US', { month: 'short' })} ${d.getDate()} ${d.toTimeString().slice(0, 8)}`;
}

// ── The worklist ──────────────────────────────────────────────────────

/** The fields of one CSV line ("quoted, fields" and "" inside quotes). */
export function csvFields(line) {
	const out = [];
	let field = '';
	let quoted = false;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (quoted) {
			if (c === '"' && line[i + 1] === '"') { field += '"'; i++; }
			else if (c === '"') quoted = false;
			else field += c;
		} else if (c === '"') quoted = true;
		else if (c === ',') { out.push(field); field = ''; }
		else field += c;
	}
	out.push(field);
	return out;
}

/**
 * The worklist's rows (columns date, act, src, file, tags, show_min, patch_min,
 * rev, gs_min, disk, note; an `id` column may name the episode, which is
 * otherwise roll-over-easy_<date>_07-30-00). A bad row stops the run.
 */
export function parseWorklist(text) {
	const lines = text.split(/\r?\n/).filter((l) => l.trim());
	const header = csvFields(lines[0] ?? '').map((h) => h.trim());
	for (const col of ['date', 'act', 'src', 'file']) {
		if (!header.includes(col)) throw new Error(`The worklist has no "${col}" column (it has: ${header.join(', ')})`);
	}
	return lines.slice(1).map((line, i) => {
		const f = csvFields(line);
		const row = Object.fromEntries(header.map((h, j) => [h, (f[j] ?? '').trim()]));
		const where = `worklist line ${i + 2} (${row.date || 'no date'})`;
		if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) throw new Error(`${where}: the date should be YYYY-MM-DD`);
		if (!ACTS[row.act]) throw new Error(`${where}: act "${row.act}" isn't one of ${Object.keys(ACTS).join(', ')}`);
		if (!SOURCES.includes(row.src)) throw new Error(`${where}: src "${row.src}" isn't one of ${SOURCES.join(', ')}`);
		return {
			...row,
			id: row.id || `roll-over-easy_${row.date}_07-30-00`,
			show_min: row.show_min ? Number(row.show_min) : null,
			rev: row.rev === '1',
			gs_min: row.gs_min ? Number(row.gs_min) : null,
		};
	});
}

/** A join's part numbers, from "parts 1+2+3". */
export function joinPartNumbers(file) {
	const m = /^parts\s+(\d+(?:\+\d+)+)$/i.exec(file.trim());
	if (!m) throw new Error(`"${file}" should list the parts to join, like "parts 1+2"`);
	return m[1].split('+').map(Number);
}

/** The part the site plays now, from a note like "site has part 2 only (65.1 of 118.2 min)". */
export function sitePartNumber(note) {
	const m = /site has part (\d+)/i.exec(note ?? '');
	if (!m) throw new Error(`the note should say which part the site has ("site has part N only"): "${note}"`);
	return Number(m[1]);
}

/**
 * What the driver does for one worklist row, and with what audio.
 * @returns {{id, date, act, action, src, reviewed, minutes, note, audio, join, trialFile}}
 */
export function planRow(row, { archiveDir = ARCHIVE_DIR, trialDir = path.join(transcriptsDir, '.trial-2026-09-27') } = {}) {
	const action = ACTS[row.act];
	const plan = { id: row.id, date: row.date, act: row.act, action, src: row.src, reviewed: row.rev, minutes: row.show_min, note: row.note ?? '', audio: null, join: null, trialFile: null };
	if (!TRANSCRIBED.has(action)) return plan;
	if ((action === 'join') !== (row.src === 'J')) throw new Error(`${row.date}: act J and src J go together (act ${row.act}, src ${row.src})`);
	if (action === 'trial') plan.trialFile = path.join(trialDir, `${row.id}.json`);
	if (row.src === 'A' || row.src === 'A*') {
		if (!/\.mp3$/i.test(row.file)) throw new Error(`${row.date}: src ${row.src} needs the archive file's name in "file" (got "${row.file}")`);
		plan.audio = { kind: 'archive', file: path.join(archiveDir, `Roll Over Easy ${row.file}`) };
	} else if (row.src === 'J') {
		const parts = joinPartNumbers(row.file);
		const sitePart = sitePartNumber(row.note);
		if (!parts.includes(sitePart)) throw new Error(`${row.date}: the site's part ${sitePart} isn't among the parts to join (${parts.join('+')})`);
		plan.audio = { kind: 'join', parts: parts.map((n) => ({ n, file: path.join(archiveDir, `Roll Over Easy ${row.date} ${n}.mp3`) })) };
		plan.join = { parts, sitePart, partsBefore: parts.slice(0, parts.indexOf(sitePart)) };
	} else if (row.src === 'R') {
		plan.audio = { kind: 'site-m4a', key: siteAudioKey(row.id) };
	} else {
		plan.audio = { kind: 'r2-mp3', key: `Roll Over Easy ${row.date}.mp3` };
	}
	return plan;
}

/** Whisper's price for `minutes` of audio, with the gap retries' extra. */
export function openaiCost(minutes) {
	return Math.round(minutes * WHISPER_USD_PER_MIN * GAP_RETRY_SHARE * 100) / 100;
}

/** The minutes an OpenAI run of this episode still has to send (a saved partial run is resumed). */
function minutesLeft(plan) {
	const partial = path.join(transcriptsDir, '.partial', `${plan.id}.json`);
	let done = 0;
	try {
		done = (readJSON(partial).tx?.timeOffset ?? 0) / 60;
	} catch { /* no partial run */ }
	return Math.max(0, (plan.minutes ?? 120) - done);
}

/** A whisper.cpp model by name (WHISPER_MODELS) or a path to a .bin file. */
export function resolveModel(name = DEFAULT_MODEL) {
	if (WHISPER_MODELS[name]) return WHISPER_MODELS[name];
	if (/\.bin$/.test(name)) return path.resolve(name);
	throw new Error(`--model: ${name} isn't one of ${Object.keys(WHISPER_MODELS).join(', ')} or a .bin file`);
}

/** The model for a failed show's second try: the other of large-v3 and large-v3-turbo (another file: the same). */
export function otherModel(modelPath) {
	if (modelPath === WHISPER_MODELS['large-v3-turbo']) return WHISPER_MODELS['large-v3'];
	if (modelPath === WHISPER_MODELS['large-v3']) return WHISPER_MODELS['large-v3-turbo'];
	return modelPath;
}

/** How long whisper.cpp takes for `minutes` of audio: [low, high] minutes, or null if not measured. */
export function whisperMinutes(minutes, modelPath, noGpu = false) {
	const speed = WHISPER_SPEED[path.basename(modelPath, '.bin')]?.[noGpu ? 'cpu' : 'gpu'];
	return speed ? [minutes * speed[0], minutes * speed[1]] : null;
}

/**
 * The transcription attempts for one episode, in order: the engine, a second
 * whisper.cpp try (retryModel), then OpenAI if the fallback is on. `tried`
 * counts the attempts earlier runs made.
 */
export function attemptPlan(plan, { engine, model, retryModel, fallbackOpenai }) {
	if (plan.action === 'trial') return [{ engine: 'trial' }];
	if (engine === 'openai') return [{ engine: 'openai' }];
	const steps = [{ engine: 'whisper.cpp', model }, { engine: 'whisper.cpp', model: retryModel ?? model }];
	if (fallbackOpenai) steps.push({ engine: 'openai' });
	return steps;
}

/** The process-episode.js run that publishes a checked transcript (node arguments). */
export function publishRun(plan, audio, { isLocal = false } = {}) {
	const join = plan.action === 'join';
	return [PROCESS_EPISODE, audio, '--episode-id', plan.id,
		'--skip', join ? 'transcribe,summary,guest-start' : 'transcribe,summary,guest-start,upload-audio',
		'--force', join ? 'seed-db,upload-audio' : 'seed-db',
		...(isLocal ? ['--local'] : [])];
}

/**
 * For a joined show, the statements that move the interview time and the place
 * quotes by `shiftMs`: the old times pointed into the part the site had, which
 * now starts later. Each one only changes a value still as the backup had it,
 * so a run that stopped halfway can't move anything twice.
 */
export function shiftStatements(episodeId, before, shiftMs) {
	const id = escapeSQL(episodeId);
	const ep = before.episodes[0];
	const sql = [];
	if (ep.guest_start_ms != null) {
		sql.push(`UPDATE episodes SET guest_start_ms = ${ep.guest_start_ms + shiftMs} WHERE id = '${id}' AND guest_start_ms = ${ep.guest_start_ms};`);
	}
	for (const m of before.place_mentions) {
		if (m.snippet_start_ms == null) continue;
		sql.push(`UPDATE place_mentions SET snippet_start_ms = ${m.snippet_start_ms + shiftMs} WHERE episode_id = '${id}' AND place_id = ${Number(m.place_id)} AND snippet_start_ms = ${m.snippet_start_ms};`);
	}
	return sql;
}

// ── Audio (in the transcription job) ──────────────────────────────────

/** A stand-in for an R2 bucket over local files, for the pipeline's own joiner (mp3-join.js). */
export function localFileBucket(dir) {
	const file = (key) => (path.isAbsolute(key) ? key : path.join(dir, key));
	return {
		async head(key) {
			const st = fs.statSync(file(key), { throwIfNoEntry: false });
			return st ? { size: st.size, etag: `${st.size}-${Math.round(st.mtimeMs)}` } : null;
		},
		async get(key, { range }) {
			const fd = fs.openSync(file(key), 'r');
			try {
				const buf = Buffer.alloc(range.length);
				const n = fs.readSync(fd, buf, 0, range.length, range.offset);
				return { arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + n) };
			} finally {
				fs.closeSync(fd);
			}
		},
		async createMultipartUpload(destKey) {
			const dest = file(destKey);
			const pieces = new Map();
			return {
				async uploadPart(n, data) {
					fs.writeFileSync(`${dest}.piece-${n}`, data);
					pieces.set(n, `${dest}.piece-${n}`);
					return { partNumber: n, etag: String(n) };
				},
				async complete(list) {
					const fd = fs.openSync(dest, 'w');
					try {
						for (const { partNumber } of [...list].sort((a, b) => a.partNumber - b.partNumber)) {
							fs.writeSync(fd, fs.readFileSync(pieces.get(partNumber)));
						}
					} finally {
						fs.closeSync(fd);
						for (const p of pieces.values()) fs.rmSync(p, { force: true });
					}
					return { size: fs.statSync(dest).size };
				},
				async abort() {
					for (const p of pieces.values()) fs.rmSync(p, { force: true });
				},
			};
		},
	};
}

/** The decoder's complaints about a file (empty: it decodes cleanly). */
function decodeErrors(file) {
	const r = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 });
	if (r.error) throw r.error;
	return `${r.stderr}`.trim().split('\n').filter(Boolean);
}

/**
 * The MP3 to transcribe, made ready in transcripts/.repair/audio/ when it isn't
 * an archive file: a join (the pipeline's joiner; checked against the sum of
 * the parts and with a full decode), the site's .m4a made into an MP3, or a raw
 * upload from R2. Made once and kept until the episode is published: a resumed
 * OpenAI run needs the very same file.
 * @returns {Promise<{file: string, facts: object}>}
 */
export async function prepareAudio(plan, { isLocal = false, log = console.log } = {}) {
	const { audio } = plan;
	if (audio.kind === 'archive') {
		if (!fs.existsSync(audio.file)) throw new Error(`The archive file is missing: ${audio.file}`);
		return { file: audio.file, facts: { kind: 'archive', file: audio.file } };
	}
	const out = audioPath(plan.id);
	if (fs.existsSync(out) && fs.existsSync(audioFactsPath(plan.id))) {
		log(`Audio: ${out} (made by an earlier run)`);
		return { file: out, facts: readJSON(audioFactsPath(plan.id)) };
	}
	fs.mkdirSync(path.dirname(out), { recursive: true });
	const tmp = `${out}.making.mp3`;
	let facts;
	try {
		if (audio.kind === 'join') {
			const missing = audio.parts.filter((p) => !fs.existsSync(p.file));
			if (missing.length > 0) throw new Error(`Parts missing from the archive: ${missing.map((p) => p.file).join(', ')}`);
			const parts = audio.parts.map((p) => ({ ...p, ms: probeDurationMs(p.file) }));
			log(`Joining parts ${parts.map((p) => `${p.n} (${minutes(p.ms)} min)`).join(' + ')} with the pipeline's joiner`);
			const bucket = localFileBucket(path.dirname(out));
			const heads = await Promise.all(parts.map((p) => bucket.head(p.file)));
			await joinParts(bucket, parts.map((p, i) => ({ key: p.file, ...heads[i] })), path.basename(tmp));
			const sumMs = parts.reduce((n, p) => n + p.ms, 0);
			const joinedMs = probeDurationMs(tmp);
			if (Math.abs(joinedMs - sumMs) > JOIN_SLACK_MS) {
				throw new Error(`The joined file is ${minutes(joinedMs)} min, the parts add up to ${minutes(sumMs)} min`);
			}
			const errors = decodeErrors(tmp);
			if (errors.length > 0) throw new Error(`The joined file doesn't decode cleanly: ${errors.slice(0, 3).join(' | ')}`);
			facts = { kind: 'join', parts: parts.map(({ n, file, ms }) => ({ n, file: path.basename(file), ms })), sum_ms: sumMs, joined_ms: joinedMs, decode: 'clean' };
			log(`Joined: ${minutes(joinedMs)} min (the parts add up to ${minutes(sumMs)} min), decodes cleanly`);
		} else if (audio.kind === 'site-m4a') {
			const m4a = `${out}.m4a`;
			try {
				if (!(await downloadR2Object(audio.key, m4a, { isLocal }))) throw new Error(`R2 has no ${audio.key}`);
				const m4aMs = probeDurationMs(m4a);
				execFileSync('ffmpeg', ['-nostdin', '-y', '-v', 'error', '-i', m4a, '-vn', '-c:a', 'libmp3lame', '-q:a', '2', tmp], { stdio: ['ignore', 'pipe', 'pipe'] });
				const mp3Ms = probeDurationMs(tmp);
				if (Math.abs(mp3Ms - m4aMs) > SITE_AUDIO_SLACK_MS) throw new Error(`The MP3 made from ${audio.key} is ${minutes(mp3Ms)} min, the .m4a ${minutes(m4aMs)} min`);
				facts = { kind: 'site-m4a', key: audio.key, m4a_ms: m4aMs, mp3_ms: mp3Ms };
				log(`The site's audio (${audio.key}, ${minutes(m4aMs)} min) made into an MP3`);
			} finally {
				fs.rmSync(m4a, { force: true });
			}
		} else {
			if (!(await downloadR2Object(audio.key, tmp, { isLocal }))) throw new Error(`R2 has no ${audio.key}`);
			facts = { kind: 'r2-mp3', key: audio.key, mp3_ms: probeDurationMs(tmp) };
			log(`Fetched ${audio.key} from R2 (${minutes(facts.mp3_ms)} min)`);
		}
		fs.renameSync(tmp, out);
		writeJSON(audioFactsPath(plan.id), facts);
		return { file: out, facts };
	} finally {
		fs.rmSync(tmp, { force: true });
	}
}

/** A problem with a show's audio that no other try would fix: the job exits with AUDIO_PROBLEM. */
class AudioProblem extends Error {}
const AUDIO_PROBLEM = 3;

/**
 * One transcription, run as its own process (so a long whisper.cpp or OpenAI
 * run never holds up the publishing): make the audio ready, transcribe it with
 * `job.engine` (or copy the trial transcript), and write the transcript and
 * what the checks need (its audio, and the length of the site's audio) to
 * transcripts/.repair/staging/. Nothing on the site changes.
 */
async function runJob(job) {
	const log = (line) => console.log(`[${stamp()}] ${line}`);
	const { plan } = job;
	log(`${plan.date}: ${job.engine === 'trial' ? 'the trial transcript' : `transcribing with ${job.engine}${job.model ? ` (${path.basename(job.model, '.bin')})` : ''}`}`);
	let file;
	let facts;
	try {
		({ file, facts } = await prepareAudio(plan, { isLocal: job.isLocal, log }));
	} catch (err) {
		throw new AudioProblem(err.message);
	}
	let trial = null;
	if (job.engine === 'trial') {
		if (!fs.existsSync(plan.trialFile)) throw new AudioProblem(`No trial transcript: ${plan.trialFile}`);
		trial = readJSON(plan.trialFile);
		if (trial.episode_id !== plan.id || !trial.meta?.audio_ms) throw new AudioProblem(`${plan.trialFile} isn't a transcript of ${plan.id} with a meta block`);
	}

	// Before any transcribing: the audio has to be the recording the site plays (for a join,
	// the site has to be playing the part the worklist names), or no transcript of it could pass
	const currentSiteMs = await siteAudioMs(plan.id, { isLocal: job.isLocal });
	if (!currentSiteMs) throw new AudioProblem(`R2 has no ${siteAudioKey(plan.id)}, so the length of the site's audio is unknown`);
	if (plan.action === 'join') {
		const part = facts.parts.find((p) => p.n === plan.join.sitePart);
		if (Math.abs(currentSiteMs - part.ms) > SITE_AUDIO_SLACK_MS) {
			throw new AudioProblem(`the site's audio (${minutes(currentSiteMs)} min) isn't part ${part.n} (${minutes(part.ms)} min), so the times can't be moved by the right amount`);
		}
	} else {
		const audioMs = trial ? trial.meta.audio_ms : probeDurationMs(file);
		if (Math.abs(audioMs - currentSiteMs) > SITE_AUDIO_SLACK_MS) {
			throw new AudioProblem(`${trial ? 'the trial transcript\'s recording' : path.basename(file)} is ${minutes(audioMs)} min, the site's audio ${minutes(currentSiteMs)} min: a different recording`);
		}
	}

	let transcript;
	if (trial) {
		transcript = trial;
	} else if (job.engine === 'openai') {
		const { transcribeFile } = await import('./transcribe.js');
		transcript = await transcribeFile(file, plan.id);
	} else {
		const { whisperCppTranscript } = await import('./process-episode.js');
		transcript = whisperCppTranscript(file, plan.id, job.noGpu, { modelPath: job.model });
	}

	// What the site will play: the joined show for a join (the upload replaces the site's audio)
	const result = {
		engine: job.engine,
		model: transcript.meta?.model ?? null,
		audio: file,
		audio_facts: facts,
		audio_ms: transcript.meta.audio_ms,
		current_site_ms: currentSiteMs,
		site_audio_ms: plan.action === 'join' ? facts.joined_ms : currentSiteMs,
		made_at: new Date().toISOString(),
	};
	writeJSON(stagingPath(plan.id), transcript);
	writeJSON(resultPath(plan.id), result);
	if (job.engine === 'openai') (await import('./transcribe.js')).clearPartial(plan.id);
	log(`${plan.date}: staged ${transcript.segments.length} lines to ${minutes(transcript.meta.audio_ms)} min; the site's audio is ${currentSiteMs ? `${minutes(currentSiteMs)} min` : 'missing'}`);
}

// ── The run ───────────────────────────────────────────────────────────

class Run {
	constructor(opts) {
		this.opts = opts;
		this.db = { isLocal: opts.local };
		this.progress = fs.existsSync(progressPath()) ? readJSON(progressPath()) : { started_at: new Date().toISOString(), episodes: {} };
		this.spent = 0; // this run's OpenAI spending, as estimated when each run started
		this.failure = null; // the first failure: nothing more starts or publishes
		this.capped = null; // the cost cap: no more transcriptions start; what is ready still publishes
		this.forReview = []; // holes to listen to
		this.shifted = []; // interview times moved
		this.setAsideList = []; // shows left for the owner
		this.setAsideInARow = 0;
		this.dbQueue = Promise.resolve();
	}

	/**
	 * One caller at a time on D1: a check waits while an episode publishes. Production D1
	 * answers no other queries during a seed's import, and a local copy is one SQLite file
	 * that two wrangler processes can't both open (SQLITE_BUSY).
	 */
	async withDb(fn) {
		const before = this.dbQueue;
		let release;
		this.dbQueue = new Promise((resolve) => { release = resolve; });
		await before;
		try {
			return await fn();
		} finally {
			release();
		}
	}

	rec(plan) {
		return (this.progress.episodes[plan.id] ??= { date: plan.date, act: plan.act, attempts: [] });
	}

	save() {
		writeJSON(progressPath(), this.progress);
	}

	/** A line on the console and in the episode's log. */
	note(plan, line) {
		console.log(`[${stamp()}] ${plan ? `${plan.date} ` : ''}${line}`);
		if (plan) {
			fs.mkdirSync(path.dirname(logPath(plan.date)), { recursive: true });
			fs.appendFileSync(logPath(plan.date), `[${stamp()}] ${line}\n`);
		}
	}

	/** Run a node script with its output going to the episode's log; resolves to its exit code and output. */
	child(plan, args, { env = process.env } = {}) {
		const log = logPath(plan.date);
		fs.mkdirSync(path.dirname(log), { recursive: true });
		const fd = fs.openSync(log, 'a');
		const from = fs.fstatSync(fd).size;
		return new Promise((resolve) => {
			const c = spawn(process.execPath, [...process.execArgv, ...args], { stdio: ['ignore', fd, fd], env });
			c.on('error', (err) => {
				fs.appendFileSync(log, `${err.message}\n`);
				resolve(1);
			});
			c.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
		}).then((code) => {
			fs.closeSync(fd);
			const output = fs.readFileSync(log).subarray(from).toString('utf-8');
			return { code, output };
		});
	}

	/** A failure while publishing (or before the run could start): the run stops. */
	fail(plan, stage, problem) {
		const r = this.rec(plan);
		Object.assign(r, { state: 'failed', stage, error: problem, updated_at: new Date().toISOString() });
		this.save();
		this.note(plan, `FAILED (${stage}): ${problem}`);
		this.failure ??= `${plan.date}: ${problem}`;
	}

	/**
	 * A show whose audio or transcripts didn't work out, before anything on the
	 * site changed: left for the owner, and the run goes on. Several in a row
	 * mean something is wrong: the run stops.
	 */
	setAside(plan, problem) {
		const r = this.rec(plan);
		Object.assign(r, { state: 'set-aside', stage: 'check', error: problem, updated_at: new Date().toISOString() });
		this.save();
		this.note(plan, `SET ASIDE for the owner: ${problem}`);
		this.setAsideList.push(`${plan.date}: ${problem}`);
		if (++this.setAsideInARow >= SET_ASIDE_IN_A_ROW) {
			this.failure ??= `${SET_ASIDE_IN_A_ROW} shows in a row were set aside (the last, ${plan.date}: ${problem}); something may be wrong`;
		}
	}

	// ── Transcribe and check (several at once) ──

	/** Get a checked transcript into staging. True when it's ready to publish. */
	async prepare(plan) {
		const r = this.rec(plan);
		const steps = attemptPlan(plan, this.opts);
		// A try an earlier run was stopped in the middle of runs again (OpenAI carries on
		// from its last chunk), unless it got as far as its transcript
		const unfinished = r.attempts.at(-1);
		if (unfinished && !unfinished.finished_at) {
			if (fs.existsSync(stagingPath(plan.id)) && fs.existsSync(resultPath(plan.id))) {
				unfinished.finished_at = new Date().toISOString();
			} else {
				r.attempts.pop();
				this.note(plan, `the ${unfinished.engine} run an earlier run stopped in the middle of runs again`);
			}
			this.save();
		}
		for (;;) {
			// A staged transcript (from this run or an earlier one) is checked first, even
			// when the run is stopping: a checked one is published by this run (at the cost
			// cap) or the next
			if (fs.existsSync(stagingPath(plan.id)) && fs.existsSync(resultPath(plan.id))) {
				const verdict = await this.withDb(() => this.check(plan));
				if (verdict.ok) {
					Object.assign(r, { state: 'staged', stage: null, error: null, updated_at: new Date().toISOString() });
					this.save();
					this.setAsideInARow = 0;
					return true;
				}
				// Kept for review (named by when and how it was made); the next attempt starts afresh
				const made = readJSON(resultPath(plan.id));
				const how = `${made.made_at.replace(/[:.]/g, '-')}-${made.model ?? made.engine}`;
				fs.renameSync(stagingPath(plan.id), path.join(repairDir(), 'staging', `${plan.id}.rejected-${how}.json`));
				fs.rmSync(resultPath(plan.id), { force: true });
				if (r.attempts.at(-1)) r.attempts.at(-1).problems = verdict.problems;
				this.save();
			}
			if (this.failure || this.capped) return false;
			const step = steps[r.attempts.length];
			if (!step) {
				const tries = r.attempts.map((a) => `${a.engine}${a.model ? ` ${a.model}` : ''}: ${a.problems?.join('; ') ?? a.error ?? 'no result'}`);
				this.setAside(plan, `no transcript passed the checks (${tries.join(' | ')})`);
				return false;
			}
			let reserved = 0; // this try's OpenAI estimate, counted against --max-cost
			if (step.engine === 'openai') {
				const cost = openaiCost(minutesLeft(plan));
				if (this.spent + cost > this.opts.maxCost) {
					if (r.attempts.length > 0) {
						this.setAside(plan, `its local transcripts failed the checks, and OpenAI ($${cost.toFixed(2)}) would take this run past --max-cost $${this.opts.maxCost.toFixed(2)} ($${this.spent.toFixed(2)} spent)`);
					} else {
						this.capped ??= `OpenAI for ${plan.date} ($${cost.toFixed(2)}) would pass --max-cost $${this.opts.maxCost.toFixed(2)} ($${this.spent.toFixed(2)} spent)`;
						Object.assign(r, { state: 'not-started', stage: null, updated_at: new Date().toISOString() });
						this.save();
						this.note(plan, `not started: ${this.capped}`);
					}
					return false;
				}
				reserved = cost;
				this.spent += cost;
				r.paid_usd = Math.round(((r.paid_usd ?? 0) + cost) * 100) / 100;
			}
			const attempt = { engine: step.engine, model: step.model ? path.basename(step.model, '.bin') : null, started_at: new Date().toISOString() };
			r.attempts.push(attempt);
			Object.assign(r, { state: 'transcribing', stage: 'transcribe', updated_at: attempt.started_at });
			this.save();
			this.note(plan, step.engine === 'trial' ? 'installing the trial transcript' : `transcribing (${step.engine}${attempt.model ? `, ${attempt.model}` : ''}${step.engine === 'openai' ? `, about $${openaiCost(minutesLeft(plan)).toFixed(2)}` : ''}); log: ${logPath(plan.date)}`);
			const job = { plan, engine: step.engine, model: step.model ?? null, noGpu: this.opts.noGpu, isLocal: this.opts.local };
			const { code, output } = await this.child(plan, [SCRIPT, '--job', JSON.stringify(job)]);
			attempt.finished_at = new Date().toISOString();
			if (code === AUDIO_PROBLEM) {
				// Found before any transcribing, and no other try would fix it: nothing was paid
				this.spent = Math.max(0, this.spent - reserved);
				r.paid_usd = Math.max(0, Math.round(((r.paid_usd ?? 0) - reserved) * 100) / 100);
				attempt.error = `the audio: ${lastError(output) || 'see the log'}`;
				this.save();
				this.setAside(plan, attempt.error);
				return false;
			}
			if (code !== 0 || !fs.existsSync(stagingPath(plan.id))) {
				attempt.error = `the ${step.engine} run failed: ${lastError(output) || `exit ${code}`}`;
				this.save();
				this.note(plan, `${attempt.error} (see ${logPath(plan.date)})`);
			}
		}
	}

	/** The checks on a staged transcript against the live one and the site's audio. */
	check(plan) {
		const transcript = readJSON(stagingPath(plan.id));
		const result = readJSON(resultPath(plan.id));
		const oldLines = queryJSON(`SELECT start_ms, end_ms, text FROM transcript_segments WHERE episode_id = '${escapeSQL(plan.id)}' ORDER BY start_ms, id`, this.db);
		const verdict = checkNewTranscript(transcript, { oldLines, siteAudioMs: result.site_audio_ms, minWordShare: this.opts.minWordShare });
		if (plan.action === 'join') {
			// The site has to be playing the part the worklist says, or the times would move by the wrong amount
			const part = result.audio_facts.parts.find((p) => p.n === plan.join.sitePart);
			if (!(result.current_site_ms > 0) || Math.abs(result.current_site_ms - part.ms) > SITE_AUDIO_SLACK_MS) {
				verdict.ok = false;
				verdict.problems.push(`the site's audio (${result.current_site_ms ? `${minutes(result.current_site_ms)} min` : 'missing'}) isn't part ${plan.join.sitePart} (${minutes(part.ms)} min)`);
			}
		}
		const f = verdict.facts;
		this.note(plan, `check (${result.engine}${result.model ? `, ${result.model}` : ''}): ${f.lines} lines, ${f.words} words (the live transcript: ${f.old_words}), to ${minutes(f.end_ms)} of ${minutes(f.audio_ms)} min; the site's audio ${f.site_audio_ms ? `${minutes(f.site_audio_ms)} min` : 'missing'}${verdict.notes.length ? `; for review: ${verdict.notes.join('; ')}` : ''}${verdict.ok ? ': passed' : `: FAILED: ${verdict.problems.join('; ')}`}`);
		this.rec(plan).review = verdict.notes;
		return verdict;
	}

	// ── Publish (one at a time) ──

	async publish(plan) {
		const r = this.rec(plan);
		Object.assign(r, { state: 'publishing', stage: 'publish', updated_at: new Date().toISOString() });
		this.save();
		const transcript = readJSON(stagingPath(plan.id));
		const result = readJSON(resultPath(plan.id));
		const isLocal = this.opts.local;

		// 1. Backup, once per repair: a rerun after a failure keeps the first one (the true "before")
		if (!r.backup) {
			const backup = await backupEpisode(plan.id, { isLocal, reason: 'before its transcript was redone (repair-archive.js)', withAudio: plan.action === 'join' });
			r.backup = backup.dir;
			this.save();
			this.note(plan, `backed up to ${backup.dir}`);
		}
		const before = readJSON(path.join(r.backup, 'd1-rows.json'));

		// 2. The old local transcript's search windows count as stale; the new transcript goes in
		if (!r.installed_at) {
			const old = readTranscript(plan.id);
			const oldIds = old?.segments?.length ? chunkEpisode({ ...old, episode_id: plan.id }).map((c) => c.id) : [];
			writeTranscript(transcript, { oldVectorIds: oldIds });
			r.installed_at = new Date().toISOString();
			this.save();
			this.note(plan, `installed transcripts/${plan.id}.json${oldIds.length ? ` (the old file's ${oldIds.length} window IDs kept as stale)` : ''}`);
		}

		// 3. Seed (and for a join, upload the joined audio), then the embeddings step
		this.note(plan, `publishing: process-episode.js ${publishRun(plan, result.audio, { isLocal }).slice(2).join(' ')}`);
		const { code, output } = await this.child(plan, publishRun(plan, result.audio, { isLocal }));
		if (code !== 0) return this.fail(plan, 'publish', `process-episode.js failed (${lastError(output) || `exit ${code}`}; see ${logPath(plan.date)}). D1 has the old transcript or the new one, never part of one; run this again to finish, or restore ${path.join(r.backup, 'restore.sql')}`);
		if (isLocal) this.note(plan, 'embeddings skipped: --local (Vectorize has no local copy)');

		// 4. A join's times move by the parts that now come first
		let shiftMs = 0;
		if (plan.join) {
			shiftMs = result.audio_facts.parts.filter((p) => plan.join.partsBefore.includes(p.n)).reduce((n, p) => n + p.ms, 0);
			const statements = shiftStatements(plan.id, before, shiftMs);
			if (shiftMs > 0 && statements.length > 0) runSQL(statements.join('\n'), this.db);
			const gs = before.episodes[0].guest_start_ms;
			r.shift = { ms: shiftMs, guest_start_ms: gs == null ? null : [gs, gs + shiftMs], place_quotes: before.place_mentions.filter((m) => m.snippet_start_ms != null).length };
			if (shiftMs > 0) {
				const line = `times moved by ${minutes(shiftMs)} min (part${plan.join.partsBefore.length > 1 ? 's' : ''} ${plan.join.partsBefore.join('+')} now come${plan.join.partsBefore.length > 1 ? '' : 's'} first): the interview time ${gs == null ? 'is empty' : `${minutes(gs)} -> ${minutes(gs + shiftMs)} min`}${before.episodes[0].guests_reviewed ? ' (a REVIEWED episode: check it)' : ''}, ${r.shift.place_quotes} place quote${r.shift.place_quotes === 1 ? '' : 's'}`;
				this.note(plan, line);
				if (gs != null) this.shifted.push(`${plan.date}: ${line}`);
			}
			this.save();
		}

		// 5. D1 as expected?
		const problems = await this.afterChecks(plan, transcript, result, before, shiftMs);
		if (problems.length > 0) return this.fail(plan, 'publish', `after publishing: ${problems.join('; ')}. The backup: ${r.backup}`);

		Object.assign(r, { state: 'published', stage: null, error: null, published_at: new Date().toISOString(), lines: transcript.segments.length, audio_ms: transcript.meta.audio_ms });
		if (r.review?.length) this.forReview.push(`${plan.date}: ${r.review.join('; ')}`);
		this.save();
		for (const f of [stagingPath(plan.id), resultPath(plan.id), audioFactsPath(plan.id), audioPath(plan.id)]) fs.rmSync(f, { force: true });
		this.note(plan, `published: ${transcript.segments.length} lines, ${minutes(transcript.meta.audio_ms)} min`);
	}

	/** After publishing: what D1 (and for a join, R2) should now hold. Returns the problems. */
	async afterChecks(plan, transcript, result, before, shiftMs) {
		const id = escapeSQL(plan.id);
		const problems = [];
		const [row] = queryJSON(`SELECT * FROM episodes WHERE id = '${id}'`, this.db);
		const [{ lines }] = queryJSON(`SELECT COUNT(*) AS lines FROM transcript_segments WHERE episode_id = '${id}'`, this.db);
		if (lines !== transcript.segments.length) problems.push(`D1 has ${lines} lines, the transcript ${transcript.segments.length}`);
		if (row.duration_ms !== transcript.meta.audio_ms) problems.push(`duration_ms is ${row.duration_ms}, the recording ${transcript.meta.audio_ms}`);

		// Keyword search finds lines from all through the new transcript
		const samples = ftsSamples(transcript.segments, FTS_SAMPLES);
		if (samples.length > 0) {
			const found = queryJSON(`SELECT ${samples.map((s, i) => `(SELECT COUNT(*) FROM transcript_fts f JOIN transcript_segments s ON s.rowid = f.rowid WHERE transcript_fts MATCH '${escapeSQL(s.match)}' AND s.episode_id = '${id}' AND s.start_ms = ${s.start_ms}) AS s${i}`).join(', ')}`, this.db)[0];
			const missing = samples.filter((_, i) => !(found[`s${i}`] > 0));
			if (missing.length > 0) problems.push(`keyword search doesn't find ${missing.length} of ${samples.length} sample lines (e.g. ${missing[0].match} at ${minutes(missing[0].start_ms)} min)`);
		}

		// Everything else on the episode as it was (a join: its audio and times moved)
		const old = before.episodes[0];
		for (const col of ['title', 'summary', 'guests_reviewed', 'published_at']) {
			if (row[col] !== old[col]) problems.push(`${col} changed`);
		}
		const expectGs = old.guest_start_ms == null ? null : old.guest_start_ms + shiftMs;
		if (row.guest_start_ms !== expectGs) problems.push(`the interview time is ${row.guest_start_ms}, expected ${expectGs}`);
		const expectAudio = plan.action === 'join' ? `${R2_PUBLIC_URL}/${plan.id}.m4a` : old.audio_file;
		if (row.audio_file !== expectAudio) problems.push(`audio_file is ${row.audio_file}, expected ${expectAudio}`);
		const guests = queryJSON(`SELECT guest_name FROM episode_guests WHERE episode_id = '${id}' ORDER BY guest_name`, this.db).map((g) => g.guest_name);
		const oldGuests = before.episode_guests.map((g) => g.guest_name).sort();
		if (JSON.stringify(guests) !== JSON.stringify([...oldGuests].sort())) problems.push(`the guests changed (${oldGuests.join(', ') || 'none'} -> ${guests.join(', ') || 'none'})`);
		const mentions = queryJSON(`SELECT place_id, snippet, snippet_start_ms FROM place_mentions WHERE episode_id = '${id}' ORDER BY place_id`, this.db);
		const oldMentions = [...before.place_mentions].sort((a, b) => a.place_id - b.place_id);
		const expected = JSON.stringify(oldMentions.map((m) => [m.place_id, m.snippet, m.snippet_start_ms == null ? null : m.snippet_start_ms + shiftMs]));
		if (JSON.stringify(mentions.map((m) => [m.place_id, m.snippet, m.snippet_start_ms])) !== expected) problems.push('the place quotes changed');

		// A join's new audio on the site: the whole show
		if (plan.action === 'join') {
			const siteMs = await siteAudioMs(plan.id, { isLocal: this.opts.local });
			if (!siteMs || Math.abs(siteMs - result.site_audio_ms) > SITE_AUDIO_SLACK_MS) {
				problems.push(`the site's audio is ${siteMs ? `${minutes(siteMs)} min` : 'missing'}, the joined show ${minutes(result.site_audio_ms)} min`);
			}
		}
		return problems;
	}

	/** L rows: delete the junk lines (clean-junk-lines.js), then check none are left. */
	async cleanLines(plan) {
		const r = this.rec(plan);
		Object.assign(r, { state: 'publishing', stage: 'publish', updated_at: new Date().toISOString() });
		this.save();
		const log = (line) => this.note(plan, line.trim());
		try {
			const done = await cleanEpisode(plan.id, { rules: DEFAULT_RULES, apply: true, isLocal: this.opts.local, log });
			const again = queryJSON(`SELECT id, start_ms, end_ms, text FROM transcript_segments WHERE episode_id = '${escapeSQL(plan.id)}' ORDER BY start_ms, id`, this.db);
			const left = junkLines(again, { rules: DEFAULT_RULES }).length;
			if (left > 0) return this.fail(plan, 'publish', `${left} junk lines are still there`);
			Object.assign(r, { state: 'done', stage: null, error: null, deleted: (r.deleted ?? 0) + done.deleted, backup: r.backup ?? done.backup, updated_at: new Date().toISOString() });
			this.save();
			this.note(plan, `done: ${done.deleted} junk line${done.deleted === 1 ? '' : 's'} deleted${done.embedded ? ', embeddings redone' : ''}`);
		} catch (err) {
			this.fail(plan, 'publish', err.message);
		}
	}

	/** M rows: duration_ms becomes the length of the site's audio. */
	async fixDuration(plan) {
		const r = this.rec(plan);
		const id = escapeSQL(plan.id);
		const siteMs = await siteAudioMs(plan.id, { isLocal: this.opts.local });
		if (!siteMs) return this.fail(plan, 'publish', "R2 has no .m4a for it: the site's length is unknown");
		const [row] = queryJSON(`SELECT * FROM episodes WHERE id = '${id}'`, this.db);
		if (row.duration_ms === siteMs) {
			Object.assign(r, { state: 'done', stage: null, error: null, updated_at: new Date().toISOString() });
			this.save();
			return this.note(plan, `duration_ms is already ${siteMs} (${minutes(siteMs)} min), the site's audio`);
		}
		if (!r.backup) r.backup = (await backupEpisode(plan.id, { isLocal: this.opts.local, reason: 'before its duration was corrected (repair-archive.js)' })).dir;
		this.save();
		runSQL(`UPDATE episodes SET duration_ms = ${siteMs} WHERE id = '${id}'`, this.db);
		const [after] = queryJSON(`SELECT * FROM episodes WHERE id = '${id}'`, this.db);
		const changed = Object.keys(row).filter((k) => k !== 'duration_ms' && after[k] !== row[k]);
		if (after.duration_ms !== siteMs || changed.length > 0) return this.fail(plan, 'publish', `duration_ms is ${after.duration_ms}${changed.length ? `; ${changed.join(', ')} changed too` : ''}`);
		Object.assign(r, { state: 'done', stage: null, error: null, duration_ms: [row.duration_ms, siteMs], updated_at: new Date().toISOString() });
		this.save();
		this.note(plan, `duration_ms ${row.duration_ms} -> ${siteMs} (${minutes(row.duration_ms ?? 0)} -> ${minutes(siteMs)} min, the site's audio)`);
	}

	// ── The whole run ──

	async go(plans) {
		const todo = [];
		for (const plan of plans) {
			const r = this.progress.episodes[plan.id];
			if (['published', 'done', 'skipped'].includes(r?.state)) {
				console.log(`[${stamp()}] ${plan.date} already ${r.state}: skipped`);
				continue;
			}
			if (plan.action === 'skip') {
				Object.assign(this.rec(plan), { state: 'skipped', updated_at: new Date().toISOString() });
				this.save();
				this.note(plan, 'left alone (act X)');
				continue;
			}
			if (r?.state === 'set-aside') {
				if (!this.opts.retryFailed) {
					console.log(`[${stamp()}] ${plan.date} set aside by an earlier run (${r.error}): skipped (--retry-failed to try again)`);
					continue;
				}
				// A fresh start: every try again (an OpenAI one only with --fallback-openai or --engine openai)
				Object.assign(r, { attempts: [], state: null, stage: null, error: null });
				this.save();
			}
			todo.push(plan);
		}

		// Transcriptions run --parallel at a time; publishing is one at a time, as they come ready
		const waiting = todo.filter((p) => TRANSCRIBED.has(p.action) && this.progress.episodes[p.id]?.stage !== 'publish');
		const ready = todo.filter((p) => !TRANSCRIBED.has(p.action) || this.progress.episodes[p.id]?.stage === 'publish');
		let running = 0;
		let wake = () => {};
		const startMore = () => {
			while (!this.failure && !this.capped && running < this.opts.parallel && waiting.length > 0) {
				const plan = waiting.shift();
				running++;
				this.prepare(plan)
					.then((ok) => { if (ok) ready.push(plan); })
					.catch((err) => this.fail(plan, 'transcribe', err.message))
					.finally(() => { running--; wake(); });
			}
		};
		for (;;) {
			startMore();
			if (!this.failure && ready.length > 0) {
				const plan = ready.shift();
				try {
					if (plan.action === 'lines') await this.withDb(() => this.cleanLines(plan));
					else if (plan.action === 'duration') await this.withDb(() => this.fixDuration(plan));
					else await this.withDb(() => this.publish(plan));
				} catch (err) {
					this.fail(plan, 'publish', err.message);
				}
				continue;
			}
			if (running === 0 && (waiting.length === 0 || this.failure || this.capped) && (ready.length === 0 || this.failure)) break;
			await new Promise((resolve) => { wake = resolve; });
		}
		return this.summary(plans);
	}

	summary(plans) {
		const count = (state) => plans.filter((p) => this.progress.episodes[p.id]?.state === state).length;
		console.log(`\n[${stamp()}] ${this.failure ? `Stopped at a failure: ${this.failure}` : this.capped ? `Stopped at the cost cap: ${this.capped}` : 'Done.'}`);
		const states = ['published', 'done', 'skipped', 'staged', 'set-aside', 'failed'];
		const other = plans.length - states.reduce((n, s) => n + count(s), 0);
		console.log(`  published ${count('published')}, lines-only and duration fixes ${count('done')}, left alone ${count('skipped')}, transcribed and waiting to publish ${count('staged')}, set aside for you ${count('set-aside')}, failed ${count('failed')}, not done yet ${other}`);
		const total = Object.values(this.progress.episodes).reduce((n, e) => n + (e.paid_usd ?? 0), 0);
		console.log(`  OpenAI: $${this.spent.toFixed(2)} this run (cap $${this.opts.maxCost.toFixed(2)}), $${total.toFixed(2)} in all runs (estimates)`);
		if (this.setAsideList.length > 0) {
			console.log('  Set aside for you (nothing on the site changed; --retry-failed --only <date> tries again):');
			for (const line of this.setAsideList) console.log(`    ${line}`);
		}
		if (this.forReview.length > 0) {
			console.log('  Holes to listen to (probably songs):');
			for (const line of this.forReview) console.log(`    ${line}`);
		}
		if (this.shifted.length > 0) {
			console.log('  Interview times moved for the joined shows (check them):');
			for (const line of this.shifted) console.log(`    ${line}`);
		}
		console.log(`  State: ${progressPath()}; logs: ${path.join(repairDir(), 'logs')}`);
		return this.failure ? 1 : 0;
	}
}

/**
 * Up to `n` lines spread through a transcript, as keyword-search phrases: each
 * line's first four words, from plain-ASCII lines (so the words split exactly
 * as the full-text index splits them).
 */
export function ftsSamples(segments, n) {
	const usable = segments
		.filter((s) => /^[\x20-\x7E]+$/.test(s.text))
		.map((s) => ({ start_ms: s.start_ms, words: s.text.toLowerCase().match(/[a-z0-9]+/g) ?? [] }))
		.filter((s) => s.words.length >= 3);
	const picked = [];
	for (let i = 0; i < n && usable.length > 0; i++) {
		const s = usable[Math.floor(((i + 0.5) * usable.length) / n)];
		if (!picked.some((p) => p.start_ms === s.start_ms)) picked.push({ start_ms: s.start_ms, match: `"${s.words.slice(0, 4).join(' ')}"` });
	}
	return picked;
}

// ── The dry run ───────────────────────────────────────────────────────

function describeAudio(plan) {
	const a = plan.audio;
	if (!a) return plan.action === 'duration' ? "(the site's .m4a length)" : '(no audio needed)';
	const local = (file) => {
		const st = fs.statSync(file, { throwIfNoEntry: false });
		if (!st) return ' MISSING';
		return st.blocks === 0 && st.size > 0 ? ' (in iCloud only: downloads when read)' : '';
	};
	if (a.kind === 'archive') return `${path.basename(a.file)}${local(a.file)}`;
	if (a.kind === 'join') {
		return `parts ${a.parts.map((p) => `${p.n}${local(p.file)}`).join(' + ')} (the site has part ${plan.join.sitePart}${plan.join.partsBefore.length ? `: times move by part${plan.join.partsBefore.length > 1 ? 's' : ''} ${plan.join.partsBefore.join('+')}` : ''})`;
	}
	if (a.kind === 'site-m4a') return `the site's ${a.key} (R2) as an MP3`;
	return `${a.key} (R2)`;
}

function dryRun(plans, run) {
	const o = run.opts;
	const local = o.engine === 'whisper.cpp'
		? `whisper.cpp ${[...new Set([o.model, o.retryModel])].map((m) => path.basename(m, '.bin')).join(', then ')}${o.fallbackOpenai ? ', then OpenAI' : ''}${o.noGpu ? ' on the CPU' : ' on the GPU'}`
		: 'OpenAI (paid)';
	console.log(`Plan: ${plans.length} episodes; ${local}; ${o.parallel} at a time; OpenAI cap $${o.maxCost.toFixed(2)}; ${o.local ? 'the local D1 copy' : 'PRODUCTION'}\n`);
	let paid = 0;
	let openaiAll = 0;
	let over = null;
	let transcribeMinutes = 0;
	const warnings = [];
	const what = { redo: 'redo', join: 'join + redo', trial: 'install the trial', lines: 'delete junk lines', duration: 'fix duration_ms', skip: 'leave alone' };
	for (const plan of plans) {
		const r = run.progress.episodes[plan.id];
		const done = ['published', 'done', 'skipped', 'set-aside'].includes(r?.state);
		const transcribes = TRANSCRIBED.has(plan.action) && plan.action !== 'trial';
		const todo = transcribes && !done && !fs.existsSync(stagingPath(plan.id));
		const cost = transcribes ? openaiCost(minutesLeft(plan)) : 0;
		if (todo) {
			openaiAll += cost;
			transcribeMinutes += plan.minutes ?? 120;
		}
		const thisRun = todo && o.engine === 'openai' ? cost : 0;
		if (thisRun > 0 && over == null && paid + thisRun > o.maxCost) over = plan.date;
		if (over == null) paid += thisRun;
		let audio = TRANSCRIBED.has(plan.action) ? describeAudio(plan) : describeAudio({ ...plan, audio: null });
		if (plan.action === 'trial') audio = `${path.basename(path.dirname(plan.trialFile))}/${path.basename(plan.trialFile)}${fs.existsSync(plan.trialFile) ? '' : ' MISSING'}, with ${audio}`;
		if (/MISSING/.test(audio)) warnings.push(`${plan.date}: ${audio}`);
		const state = r?.state ? ` [${r.state}${r.stage ? ` at ${r.stage}` : ''}]` : '';
		const length = TRANSCRIBED.has(plan.action) && plan.minutes ? `${plan.minutes.toFixed(1)} min` : '';
		const price = thisRun > 0 ? `$${cost.toFixed(2)}` : '$0';
		console.log(`  ${plan.date}  ${plan.act}  ${what[plan.action].padEnd(17)} ${length.padStart(9)}  ${price.padStart(6)}  ${audio}${state}`);
	}
	const n = (action) => plans.filter((p) => p.action === action).length;
	const hours = (m) => (m / 60).toFixed(1);
	console.log(`\n${n('redo')} redos, ${n('join')} joins, ${n('trial')} trials, ${n('lines')} lines-only, ${n('duration')} duration fixes, ${n('skip')} left alone`);
	console.log(`To transcribe: ${Math.round(transcribeMinutes)} min of audio (${hours(transcribeMinutes)} h)`);
	if (o.engine === 'whisper.cpp') {
		const time = whisperMinutes(transcribeMinutes, o.model, o.noGpu);
		console.log(time
			? `  whisper.cpp time at the measured ${WHISPER_SPEED[path.basename(o.model, '.bin')][o.noGpu ? 'cpu' : 'gpu'].join('-')}x real time: ${hours(time[0])}-${hours(time[1])} h${o.parallel > 1 ? ' (shows running side by side share the GPU, so not much less)' : ''}; more if the Mac slows down as it heats up, and a failed show's second try with ${path.basename(o.retryModel, '.bin')} comes on top`
			: `  whisper.cpp time: not measured for ${path.basename(o.model, '.bin')}${o.noGpu ? ' on the CPU' : ''}`);
		console.log(`  Paid: $0${o.fallbackOpenai ? `; OpenAI only for a show whose local transcripts both fail, within the $${o.maxCost.toFixed(2)} cap` : ' (no OpenAI: --fallback-openai is off)'}`);
	} else {
		console.log(`  Paid: $${paid.toFixed(2)} of OpenAI this run, within the $${o.maxCost.toFixed(2)} cap${over ? `; it would stop before ${over} (raise --max-cost to go further)` : ''}`);
	}
	console.log(`  (All of them with OpenAI instead: $${openaiAll.toFixed(2)})`);
	for (const w of warnings) console.log(`  warning: ${w}`);
	console.log('\nNothing was changed (--dry-run).');
}

// ── CLI ───────────────────────────────────────────────────────────────

const USAGE = `Usage: node scripts/repair-archive.js --worklist <file.csv> [--dry-run] [options]
  --only <dates> | --except <dates> | --acts <letters>   which episodes
  --model <name|file> --retry-model <name|file> --no-gpu  whisper.cpp (default ${DEFAULT_MODEL}, then the other; models: ${Object.keys(WHISPER_MODELS).join(', ')})
  --engine openai | --fallback-openai                     OpenAI for every show, or for a show whose local tries fail (paid)
  --max-cost <dollars>                                    the most this run may spend on OpenAI (default 0)
  --parallel <n>  --min-word-share <x>  --trial-dir <dir>  --retry-failed  --local`;

function listOf(value) {
	return value ? value.split(',').map((s) => s.trim()).filter(Boolean) : null;
}

/** Start caffeinate so the Mac doesn't sleep while this run lasts (macOS only). */
function keepAwake() {
	if (process.platform !== 'darwin') return;
	const c = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore', detached: true });
	c.on('error', () => {});
	c.unref();
}

async function main() {
	const argv = process.argv.slice(2);
	if (argv[0] === '--job') {
		try {
			await runJob(JSON.parse(argv[1]));
		} catch (err) {
			console.error(`[${stamp()}] Error: ${err.message}`);
			process.exit(err instanceof AudioProblem ? AUDIO_PROBLEM : 1);
		}
		return;
	}
	loadEnv();
	const { flags, rest } = parseFlags(argv, {
		'--worklist': 'value', '--only': 'value', '--except': 'value', '--acts': 'value', '--dry-run': 'flag',
		'--engine': 'value', '--model': 'value', '--retry-model': 'value', '--no-gpu': 'flag', '--fallback-openai': 'flag',
		'--max-cost': 'value', '--parallel': 'value', '--min-word-share': 'value', '--trial-dir': 'value',
		'--retry-failed': 'flag', '--local': 'flag',
	}, USAGE);
	const stop = (problem) => {
		console.error(`${problem}\n\n${USAGE}`);
		process.exit(1);
	};
	if (rest.length > 0 || !flags.worklist) stop('--worklist is needed');
	if (flags.engine && !['openai', 'whisper.cpp'].includes(flags.engine)) stop('--engine is openai or whisper.cpp');
	const number = (flag, fallback, ok) => {
		if (flags[flag] === undefined) return fallback;
		const v = Number(flags[flag]);
		if (!ok(v)) stop(`--${flag} needs a valid number`);
		return v;
	};
	let model;
	let retryModel;
	try {
		model = resolveModel(flags.model);
		retryModel = flags['retry-model'] ? resolveModel(flags['retry-model']) : otherModel(model);
	} catch (err) {
		stop(err.message);
	}
	const opts = {
		engine: flags.engine ?? 'whisper.cpp',
		model,
		retryModel,
		noGpu: !!flags['no-gpu'],
		fallbackOpenai: !!flags['fallback-openai'],
		maxCost: number('max-cost', 0, (v) => v >= 0),
		parallel: number('parallel', 1, (v) => Number.isInteger(v) && v >= 1),
		minWordShare: number('min-word-share', MIN_WORD_SHARE, (v) => v >= 0 && v <= 2),
		retryFailed: !!flags['retry-failed'],
		local: !!flags.local,
	};
	if (process.env.ROE_PERSIST_TO && !opts.local && !flags['dry-run']) stop('ROE_PERSIST_TO is set (a test run): add --local');
	if (opts.fallbackOpenai && opts.engine !== 'whisper.cpp') stop('--fallback-openai goes with --engine whisper.cpp');

	const rows = parseWorklist(fs.readFileSync(path.resolve(flags.worklist), 'utf-8'));
	const only = listOf(flags.only);
	const except = new Set(listOf(flags.except) ?? []);
	const acts = listOf(flags.acts);
	const unknownDates = [...(only ?? []), ...except].filter((d) => !rows.some((r) => r.date === d));
	if (unknownDates.length > 0) stop(`Not on the worklist: ${unknownDates.join(', ')}`);
	const unknownActs = (acts ?? []).filter((a) => !ACTS[a]);
	if (unknownActs.length > 0) stop(`--acts: no act called ${unknownActs.join(', ')} (acts: ${Object.keys(ACTS).join(', ')})`);
	const trialDir = flags['trial-dir'] ? path.resolve(flags['trial-dir']) : undefined;
	const plans = rows
		.filter((r) => (!only || only.includes(r.date)) && !except.has(r.date) && (!acts || acts.includes(r.act)))
		.map((r) => planRow(r, { trialDir }));
	const run = new Run(opts);

	if (flags['dry-run']) return dryRun(plans, run);

	// Before anything changes: every episode is in D1 (a typo would otherwise be transcribed first),
	// the audio is there, and the engine can run
	const listed = plans.filter((p) => p.action !== 'skip').map((p) => `'${escapeSQL(p.id)}'`);
	const inD1 = new Set(listed.length ? queryJSON(`SELECT id FROM episodes WHERE id IN (${listed.join(', ')})`, { isLocal: opts.local }).map((r) => r.id) : []);
	const notInD1 = plans.filter((p) => p.action !== 'skip' && !inD1.has(p.id)).map((p) => p.id);
	if (notInD1.length > 0) stop(`Not in the ${opts.local ? 'local' : 'production'} database: ${notInD1.join(', ')}`);
	const toTranscribe = plans.filter((p) => TRANSCRIBED.has(p.action) && p.action !== 'trial'
		&& !['published', 'set-aside'].includes(run.progress.episodes[p.id]?.state) && !fs.existsSync(stagingPath(p.id)));
	const missing = plans.flatMap((p) => (p.audio?.kind === 'archive' ? [p.audio.file] : p.audio?.kind === 'join' ? p.audio.parts.map((x) => x.file) : []))
		.filter((f) => !fs.existsSync(f));
	if (missing.length > 0) stop(`Audio missing from the archive:\n  ${missing.join('\n  ')}`);
	if ((opts.engine === 'openai' || opts.fallbackOpenai) && toTranscribe.length > 0 && !process.env.OPENAI_API_KEY) stop('OPENAI_API_KEY is not set (add it to .env)');
	keepAwake();
	const models = opts.engine === 'whisper.cpp' ? ` (${[...new Set([opts.model, opts.retryModel])].map((m) => path.basename(m, '.bin')).join(', then ')}${opts.fallbackOpenai ? ', then OpenAI' : ''}${opts.noGpu ? '; on the CPU' : ''})` : '';
	console.log(`[${stamp()}] ${plans.length} episodes from ${path.basename(flags.worklist)} on ${opts.local ? 'the local D1 copy' : 'PRODUCTION'}; engine ${opts.engine}${models}, ${opts.parallel} at a time; OpenAI cap $${opts.maxCost.toFixed(2)}`);
	if (opts.engine === 'whisper.cpp' && toTranscribe.length > 0) {
		// L9's start-up test, for each model, before the first show
		for (const m of new Set([opts.model, opts.retryModel])) {
			if (!fs.existsSync(m)) stop(`The whisper.cpp model isn't there: ${m}`);
			const problem = whisperStartProblem(opts.noGpu, m);
			if (problem) stop(`${problem}.\nCheck that no whisper-cli is left running (pgrep -fl whisper-cli), then try again${opts.noGpu ? '' : ' with --no-gpu'}.`);
		}
		console.log(`[${stamp()}] whisper.cpp starts`);
	}
	process.exitCode = await run.go(plans);
}

if (import.meta.main) {
	main().catch((err) => {
		console.error(`\n[${stamp()}] Error: ${err.message}`);
		process.exit(1);
	});
}
