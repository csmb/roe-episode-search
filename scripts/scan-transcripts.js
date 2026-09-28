#!/usr/bin/env node

/**
 * Scan the transcripts on the site (D1) for damage, read-only, to check each
 * stage of the transcript repair before and after it runs:
 *   - coverage: lines that stop before 90% of the show, or run past its end
 *     (against duration_ms, or the .m4a's real length with --m4a)
 *   - Whisper's repetition loops
 *   - holes of 5+ minutes, a late start, or 5+ minutes untranscribed at the end
 *   - wrong-language (non-Latin) lines
 *   - the spelling-hint prompt read back as speech (today's prompt or the old one)
 *   - duration_ms missing, or (with --m4a) more than 5 s off the .m4a
 *
 * Only SELECTs: one for the episodes, then the lines 20 episodes at a time
 * (never `wrangler d1 export`, which blocks the database while it runs).
 *
 * Usage:
 *   node scripts/scan-transcripts.js [--only <date|id>,…] [--m4a] [--all] [--json <file>] [--local]
 *
 *   --only    only these episodes (YYYY-MM-DD dates or episode IDs)
 *   --m4a     also measure each episode's .m4a (ffprobe over the public URL; the
 *             local R2 copy with --local) and check coverage against it
 *   --all     list the clean episodes too
 *   --json    also write every episode's findings to a file, to compare two scans
 *   --local   the local D1 copy (in a test run, the one under ROE_PERSIST_TO)
 */

import fs from 'node:fs';
import path from 'node:path';

import { escapeSQL, parseFlags, queryJSON } from './lib.js';
import { siteAudioMs } from './site-audio.js';
import { scanEpisode } from './transcript-checks.js';

const PAGE = 20; // episodes per query for the lines: ~40,000 rows
const PROBES_AT_ONCE = 8;

const USAGE = 'Usage: node scripts/scan-transcripts.js [--only <date|id>,…] [--m4a] [--all] [--json <file>] [--local]';

/** The episodes to scan, in ID order: all of them, or those `only` names by date or ID. */
export function pickEpisodes(episodes, only) {
	if (!only) return episodes;
	const wanted = only.split(',').map((s) => s.trim()).filter(Boolean);
	const picked = episodes.filter((e) => wanted.some((w) => e.id === w || e.id.includes(`_${w}_`)));
	const missing = wanted.filter((w) => !picked.some((e) => e.id === w || e.id.includes(`_${w}_`)));
	if (missing.length > 0) throw new Error(`Not in the database: ${missing.join(', ')}`);
	return picked;
}

/** Each episode's .m4a length (null when it has none), a few at a time. */
async function measureM4a(ids, isLocal) {
	const lengths = new Map();
	let next = 0;
	const worker = async () => {
		while (next < ids.length) {
			const id = ids[next++];
			try {
				lengths.set(id, await siteAudioMs(id, { isLocal }));
			} catch (err) {
				console.warn(`  ${id}: could not measure the .m4a (${err.message.split('\n')[0]})`);
				lengths.set(id, null);
			}
		}
	};
	await Promise.all(Array.from({ length: isLocal ? 1 : PROBES_AT_ONCE }, worker));
	return lengths;
}

async function main() {
	const { flags, rest } = parseFlags(process.argv.slice(2), {
		'--only': 'value', '--m4a': 'flag', '--all': 'flag', '--json': 'value', '--local': 'flag',
	}, USAGE);
	if (rest.length > 0) {
		console.error(USAGE);
		process.exit(1);
	}
	const target = { isLocal: !!flags.local };
	const started = new Date();

	const episodes = pickEpisodes(queryJSON('SELECT id, title, duration_ms, guests_reviewed, guest_start_ms FROM episodes ORDER BY id', target), flags.only);
	console.log(`Scanning ${episodes.length} episode${episodes.length === 1 ? '' : 's'} in the ${target.isLocal ? 'local D1 copy' : 'production database'}${flags.m4a ? ', with each .m4a measured' : ''}`);
	const m4a = flags.m4a ? await measureM4a(episodes.map((e) => e.id), target.isLocal) : new Map();

	const results = [];
	let lineCount = 0;
	for (let i = 0; i < episodes.length; i += PAGE) {
		const page = episodes.slice(i, i + PAGE);
		const rows = queryJSON(
			`SELECT id, episode_id, start_ms, end_ms, text FROM transcript_segments WHERE episode_id IN (${page.map((e) => `'${escapeSQL(e.id)}'`).join(', ')}) ORDER BY episode_id, start_ms, id`,
			target
		);
		lineCount += rows.length;
		const byEpisode = new Map(page.map((e) => [e.id, []]));
		for (const r of rows) byEpisode.get(r.episode_id).push(r);
		for (const e of page) {
			const lines = byEpisode.get(e.id);
			const audioMs = m4a.get(e.id) ?? null;
			const findings = scanEpisode(e, lines, { audioMs });
			if (flags.m4a && audioMs == null) findings.push({ kind: 'no-m4a', detail: 'no .m4a in R2' });
			results.push({ id: e.id, duration_ms: e.duration_ms, m4a_ms: flags.m4a ? audioMs : undefined, lines: lines.length, reviewed: e.guests_reviewed === 1, findings });
		}
		if (episodes.length > PAGE) process.stdout.write(`\r  ${Math.min(i + PAGE, episodes.length)}/${episodes.length} episodes read`);
	}
	if (episodes.length > PAGE) process.stdout.write('\n');

	console.log('');
	for (const r of results) {
		if (r.findings.length === 0 && !flags.all) continue;
		const date = r.id.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? r.id;
		console.log(`${date}  ${r.lines} lines  ${r.findings.length === 0 ? 'clean' : r.findings.map((f) => `${f.kind}: ${f.detail}`).join('; ')}`);
	}

	const kinds = {};
	for (const r of results) for (const k of new Set(r.findings.map((f) => f.kind))) kinds[k] = (kinds[k] ?? 0) + 1;
	const damaged = results.filter((r) => r.findings.length > 0).length;
	console.log(`\n${results.length} episodes, ${lineCount} lines: ${results.length - damaged} clean, ${damaged} with findings`);
	for (const [kind, n] of Object.entries(kinds).sort((a, b) => b[1] - a[1])) console.log(`  ${kind.padEnd(15)} ${n}`);

	if (flags.json) {
		const file = path.resolve(flags.json);
		fs.writeFileSync(file, JSON.stringify({ at: started.toISOString(), database: target.isLocal ? 'local' : 'production', m4a: !!flags.m4a, summary: { episodes: results.length, lines: lineCount, damaged, kinds }, episodes: results }, null, 1));
		console.log(`\nEvery episode's findings: ${file}`);
	}
}

if (import.meta.main) {
	main().catch((err) => {
		console.error('Error:', err.message);
		process.exit(1);
	});
}
