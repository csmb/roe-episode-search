#!/usr/bin/env node

/**
 * Delete junk lines from episodes' transcripts in D1, by rule, then redo each
 * episode's search embeddings so search matches D1 again. A dry run (a list of
 * the lines it would delete) unless --yes.
 *
 * Rules (transcript-checks.js junkLines):
 *   echo       the spelling-hint prompt read back as speech, with today's prompt
 *              or the one Whisper was sent until 2026-09-27 (16 lines in 6
 *              episodes that today's filter no longer sees)
 *   loops      the repeats in Whisper's repetition loops (each looping line keeps
 *              its first copy), e.g. 2026-04-30's "the" ×365
 *   urls       lines that are nothing but an http(s):// address, which Whisper
 *              invents over silence or music (2026-10-01's "https://www.youtube.com.com")
 *   non-latin  wrong-language lines in a show's first 10 minutes (not in the
 *              default rules: that stretch is then untranscribed; redoing the
 *              transcript fixes it properly)
 *
 * For each episode with junk, with --yes:
 *   1. a backup (episode-backup.js), with restore.sql
 *   2. the search window IDs of the lines as they were, kept as stale for the
 *      embeddings step to delete
 *   3. the junk lines deleted by ID (one statement per 1,000)
 *   4. the same rules run on the local transcript file, if there is one
 *   5. the embeddings step (process-episode.js with every other step skipped),
 *      unless --no-embed; with --local it is skipped (Vectorize has no local copy)
 * An episode whose embeddings step didn't finish in an earlier run (its stale
 * IDs are still waiting) gets it again, even with no junk left.
 *
 * The embeddings step embeds the lines D1 has and deletes the episode's other
 * vectors, so drag-and-drop shows, which have no local transcript file, are
 * covered too.
 *
 * Usage:
 *   node scripts/clean-junk-lines.js (--only <date|id>,… | --all) [--rules echo,loops,urls] [--yes] [--no-embed] [--local]
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { escapeSQL, loadEnv, parseFlags, projectRoot, queryJSON, runSQL, runSQLFile } from './lib.js';
import { chunkSegments } from '../roe-pipeline/src/embeddings.js';
import { backupEpisode } from './episode-backup.js';
import { chunkEpisode } from './generate-embeddings.js';
import { pickEpisodes } from './scan-transcripts.js';
import { JUNK_RULES, junkLines } from './transcript-checks.js';
import { readTranscript, rememberStaleVectors, staleVectors, transcriptPath } from './transcript-file.js';

const DELETE_IDS_PER_STATEMENT = 1000;
export const DEFAULT_RULES = ['echo', 'loops', 'urls'];

const USAGE = 'Usage: node scripts/clean-junk-lines.js (--only <date|id>,… | --all) [--rules echo,loops,urls,non-latin] [--yes] [--no-embed] [--local]';
const minutes = (ms) => (ms / 60_000).toFixed(1);

/** The DELETE statements for these line IDs of one episode. */
export function deleteStatements(episodeId, ids) {
	const out = [];
	for (let i = 0; i < ids.length; i += DELETE_IDS_PER_STATEMENT) {
		out.push(`DELETE FROM transcript_segments WHERE episode_id = '${escapeSQL(episodeId)}' AND id IN (${ids.slice(i, i + DELETE_IDS_PER_STATEMENT).map(Number).join(', ')});`);
	}
	return out;
}

/** The embeddings step for one episode, from process-episode.js (no audio file needed). */
export function embeddingsRun(episodeId, { isLocal = false } = {}) {
	return [path.join(projectRoot, 'scripts', 'process-episode.js'), '--episode-id', episodeId,
		'--skip', 'transcribe,seed-db,summary,guest-start,upload-audio', ...(isLocal ? ['--local'] : [])];
}

/**
 * Find (and with `apply`, delete) one episode's junk lines. Returns what it found and did.
 * @param {string} episodeId
 * @param {{rules?: string[], apply?: boolean, isLocal?: boolean, embed?: boolean, log?: (line: string) => void}} [opts]
 */
export async function cleanEpisode(episodeId, { rules = DEFAULT_RULES, apply = false, isLocal = false, embed = true, log = console.log } = {}) {
	const target = { isLocal };
	const id = escapeSQL(episodeId);
	const lines = queryJSON(`SELECT id, start_ms, end_ms, text FROM transcript_segments WHERE episode_id = '${id}' ORDER BY start_ms, id`, target);
	const junk = junkLines(lines, { rules });
	const pendingEmbed = staleVectors(episodeId).length > 0;
	const result = { episodeId, lines: lines.length, junk: junk.length, byRule: {}, deleted: 0, fileLinesRemoved: 0, embedded: false, backup: null };
	for (const { rule } of junk) result.byRule[rule] = (result.byRule[rule] ?? 0) + 1;

	if (junk.length === 0) {
		log(`  ${episodeId}: no junk lines (${rules.join(', ')})${pendingEmbed ? '; its embeddings step is still to do' : ''}`);
	} else {
		log(`  ${episodeId}: ${junk.length} junk line${junk.length === 1 ? '' : 's'} of ${lines.length} (${Object.entries(result.byRule).map(([r, n]) => `${r} ${n}`).join(', ')})`);
		const shown = junk.length > 12 ? [...junk.slice(0, 6), null, ...junk.slice(-3)] : junk;
		for (const j of shown) {
			log(j ? `    ${minutes(j.line.start_ms).padStart(6)} min  ${j.rule.padEnd(9)} #${j.line.id}  "${j.line.text.slice(0, 90)}"` : `    … ${junk.length - 9} more`);
		}
	}
	if (!apply || (junk.length === 0 && !pendingEmbed)) return result;

	if (junk.length > 0) {
		// Works whether episode-backup's backupEpisode is sync or async
		const backup = await backupEpisode(episodeId, { isLocal, reason: 'before junk lines were deleted (clean-junk-lines.js)' });
		result.backup = backup.dir;

		// The windows these lines (and the local file) were embedded in go once the new ones are up
		rememberStaleVectors(episodeId, chunkSegments(episodeId, lines).map((c) => c.id));
		const file = readTranscript(episodeId);
		if (file?.segments?.length) rememberStaleVectors(episodeId, chunkEpisode({ ...file, episode_id: episodeId }).map((c) => c.id));

		const ids = junk.map((j) => j.line.id);
		const statements = deleteStatements(episodeId, ids);
		if (statements.length === 1) runSQL(statements[0], target);
		else runSQLFile(statements.join('\n') + '\n', target);
		const [after] = queryJSON(`SELECT COUNT(*) AS lines, (SELECT COUNT(*) FROM transcript_segments WHERE id IN (${ids.map(Number).join(', ')})) AS left_over FROM transcript_segments WHERE episode_id = '${id}'`, target);
		if (after.left_over !== 0 || after.lines !== lines.length - ids.length) {
			throw new Error(`${episodeId}: the delete did not land (${after.lines} lines, ${after.left_over} junk lines left); restore with ${path.join(backup.dir, 'restore.sql')}`);
		}
		result.deleted = ids.length;
		log(`    deleted ${ids.length} line${ids.length === 1 ? '' : 's'}; ${after.lines} left (backup: ${backup.dir})`);

		// The local transcript file gets the same rules, so it matches (the backup has the original)
		if (file?.segments?.length) {
			const fileJunk = new Set(junkLines(file.segments, { rules }).map((j) => j.line));
			if (fileJunk.size > 0) {
				const cleaned = { ...file, segments: file.segments.filter((s) => !fileJunk.has(s)) };
				if (cleaned.meta) cleaned.meta = { ...cleaned.meta, junk_removed: [...(cleaned.meta.junk_removed ?? []), { at: new Date().toISOString(), rules, lines: fileJunk.size }] };
				fs.writeFileSync(transcriptPath(episodeId), JSON.stringify(cleaned, null, 2));
				result.fileLinesRemoved = fileJunk.size;
				log(`    removed ${fileJunk.size} line${fileJunk.size === 1 ? '' : 's'} from the local transcript file too`);
			}
		}
	}

	if (!embed) {
		log(`    embeddings not redone (--no-embed): node ${embeddingsRun(episodeId, { isLocal }).map((a) => (a.includes(' ') ? `"${path.relative(process.cwd(), a)}"` : a)).join(' ')}`);
		return result;
	}
	if (isLocal) {
		log('    embeddings skipped: --local (Vectorize has no local copy)');
		return result;
	}
	log('    redoing its embeddings (process-episode.js, every other step skipped)…');
	try {
		execFileSync(process.execPath, embeddingsRun(episodeId, { isLocal }), { stdio: 'inherit', env: process.env });
	} catch {
		throw new Error(`${episodeId}: the embeddings step failed. Its lines are deleted and its old window IDs are kept; run it again: node scripts/process-episode.js --episode-id ${episodeId} --skip transcribe,seed-db,summary,guest-start,upload-audio`);
	}
	result.embedded = true;
	return result;
}

async function main() {
	loadEnv();
	const { flags, rest } = parseFlags(process.argv.slice(2), {
		'--only': 'value', '--all': 'flag', '--rules': 'value', '--yes': 'flag', '--no-embed': 'flag', '--local': 'flag',
	}, USAGE);
	if (rest.length > 0 || !flags.only === !flags.all) {
		console.error(USAGE);
		process.exit(1);
	}
	const rules = flags.rules ? flags.rules.split(',').map((r) => r.trim()).filter(Boolean) : DEFAULT_RULES;
	const unknown = rules.filter((r) => !JUNK_RULES.includes(r));
	if (unknown.length > 0 || rules.length === 0) {
		console.error(`--rules: ${unknown.length ? `no rule called ${unknown.join(', ')}` : 'name at least one'} (rules: ${JUNK_RULES.join(', ')})\n\n${USAGE}`);
		process.exit(1);
	}
	const isLocal = !!flags.local;
	const episodes = pickEpisodes(queryJSON('SELECT id FROM episodes ORDER BY id', { isLocal }), flags.only);

	console.log(`${flags.yes ? 'Cleaning' : 'Dry run (--yes to delete):'} ${episodes.length} episode${episodes.length === 1 ? '' : 's'} in the ${isLocal ? 'local D1 copy' : 'production database'}, rules: ${rules.join(', ')}\n`);
	const results = [];
	for (const { id } of episodes) {
		results.push(await cleanEpisode(id, { rules, apply: !!flags.yes, isLocal, embed: !flags['no-embed'] }));
	}
	const withJunk = results.filter((r) => r.junk > 0);
	const lines = withJunk.reduce((n, r) => n + r.junk, 0);
	console.log(`\n${withJunk.length} episode${withJunk.length === 1 ? '' : 's'} with junk, ${lines} line${lines === 1 ? '' : 's'}${flags.yes ? `: ${results.reduce((n, r) => n + r.deleted, 0)} deleted, ${results.filter((r) => r.embedded).length} re-embedded` : ' (nothing changed: add --yes)'}`);
}

if (import.meta.main) {
	main().catch((err) => {
		console.error(`\nError: ${err.message}`);
		process.exit(1);
	});
}
