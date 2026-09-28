// node --test scripts/test/*.test.js
// rewrite-summaries.js: which episodes (the repair's progress.json), the summary-only write and its
// backup and restore.sql, run on schema.sql in node:sqlite, and one episode's new summary with a
// stubbed Ollama. Nothing reaches the network or D1.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roe-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.ROE_PERSIST_TO ??= tmp; // a test run: no keys from .env; backups go to <tmp>/transcripts/.backups
const {
	repairFinished, repairBusy, fromRepair, loadEpisodes, planEpisode, rewriteEpisode, summaryChanges, summaryUpdateSQL, restoreSQL,
	writeSummaries, reviewedSummaries, reviewMarkdown, sideBySide, whisperOnGpu, transcriptPrint,
} = await import('../rewrite-summaries.js');
const { retry, OLLAMA_REPLY_TOKENS } = await import('../summary-engines.js');
retry.ollamaWaitsMs = [0];
retry.openaiWaitsMs = [0, 0, 0];

const SCHEMA = fs.readFileSync(new URL('../../schema.sql', import.meta.url), 'utf-8');
const A = 'roll-over-easy_2014-03-20_07-30-00'; // reviewed; its transcript redone (T published)
const B = 'roll-over-easy_2020-01-16_07-30-00'; // not reviewed; junk lines deleted (L done)
const C = 'roll-over-easy_2026-03-26_07-30-00'; // no summary; duration fixed (M done)
const D = 'roll-over-easy_2014-01-16_07-30-00'; // set aside by the repair: nothing changed
const G = 'roll-over-easy_2025-11-13_07-30-00'; // published, but no longer in D1

const OLD_A = 'It was a sunny 65 degree morning. Brett Walker joined the show.';
const OLD_B = "It's a rainy morning; Cole from SketchFest -- joined.";
const NEW_A = "A foggy morning at the Ferry Building. Brett Walker, an artist from Four Barrel Coffee, talked about his murals; it's spring.";
const NEW_B = 'A rainy morning.\nCole from SketchFest joined the show.';

/** D1 as an in-memory SQLite with schema.sql: query() and a one-transaction importSQL(). */
function sqliteDb() {
	const sqlite = new DatabaseSync(':memory:');
	sqlite.exec('PRAGMA foreign_keys = ON');
	sqlite.exec(SCHEMA);
	return {
		sqlite,
		query: (sql) => sqlite.prepare(sql).all().map((r) => ({ ...r })),
		importSQL(sql) {
			sqlite.exec('BEGIN');
			try {
				sqlite.exec(sql);
				sqlite.exec('COMMIT');
			} catch (err) {
				sqlite.exec('ROLLBACK');
				throw err;
			}
		},
	};
}

const talk = (n, step = 20_000) => Array.from({ length: n }, (_, i) => ({ start_ms: i * step, end_ms: i * step + step - 1000, text: `Line ${i}: we talk about the fog and Four Barrel Coffee near the Ferry Building.` }));

function seeded() {
	const db = sqliteDb();
	const episode = db.sqlite.prepare('INSERT INTO episodes (id, title, audio_file, duration_ms, published_at, summary, guests_reviewed, guest_start_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
	episode.run(A, 'Spring has Sprung with Brett Walker!', 'https://audio/a.m4a', 6_000_000, '2014-03-20', OLD_A, 1, 5_635_690);
	episode.run(B, 'SketchFest 2020 is Here!', 'https://audio/b.m4a', 5_000_000, '2020-01-16', OLD_B, 0, null);
	episode.run(C, 'Roll Over Easy · March 26, 2026', null, 5_000_000, '2026-03-26', null, null, null);
	episode.run(D, 'Wet Wednesday!', null, 7_000_000, '2014-01-16', 'A wet one.', 1, 100_000);
	const guest = db.sqlite.prepare('INSERT INTO episode_guests (episode_id, guest_name) VALUES (?, ?)');
	guest.run(A, 'Brett Walker');
	guest.run(A, 'Anna Lee');
	guest.run(B, 'Cole');
	const line = db.sqlite.prepare('INSERT INTO transcript_segments (episode_id, start_ms, end_ms, text) VALUES (?, ?, ?, ?)');
	for (const [id, n] of [[A, 300], [B, 250], [C, 250], [D, 10]]) for (const l of talk(n)) line.run(id, l.start_ms, l.end_ms, l.text);
	return db;
}

const everything = (db) => ({
	episodes: db.query('SELECT * FROM episodes ORDER BY id'),
	guests: db.query('SELECT * FROM episode_guests ORDER BY episode_id, guest_name'),
	lines: db.query('SELECT COUNT(*) AS n FROM transcript_segments')[0].n,
});
const withoutSummary = (rows) => rows.map(({ summary, ...rest }) => rest);

const PROGRESS = {
	started_at: '2026-09-28T11:00:00.000Z',
	database: 'production',
	episodes: {
		[A]: { date: '2014-03-20', act: 'T', state: 'published', attempts: [] },
		[B]: { date: '2020-01-16', act: 'L', state: 'done', deleted: 1 },
		[C]: { date: '2026-03-26', act: 'M', state: 'done' },
		[D]: { date: '2014-01-16', act: 'W', state: 'set-aside', error: 'no transcript passed the checks' },
		[G]: { date: '2025-11-13', act: 'O', state: 'published' },
		'roll-over-easy_2016-01-07_07-30-00': { act: 'J', state: 'transcribing' },
		'roll-over-easy_2016-02-04_07-30-00': { act: 'W', state: 'staged' },
		'roll-over-easy_2016-03-03_07-30-00': { act: 'W', state: 'publishing', stage: 'publish' },
		'roll-over-easy_2016-04-07_07-30-00': { act: 'W', state: 'failed', stage: 'publish' },
		'roll-over-easy_2016-05-05_07-30-00': { act: 'X', state: 'skipped' },
		'roll-over-easy_2016-06-02_07-30-00': { act: 'W', attempts: [], previous: { act: 'L', state: 'done' } }, // its act changed: starting afresh
	},
};

test('--from-repair: the published episodes and the finished lines-only and duration fixes, if D1 has them', () => {
	assert.deepEqual(repairFinished(PROGRESS).map((e) => `${e.id} ${e.repair}`), [`${A} T published`, `${B} L done`, `${G} O published`, `${C} M done`]
		.sort());
	const { picked, notInD1 } = fromRepair(PROGRESS, seeded());
	assert.deepEqual(picked, [{ id: A, repair: 'T published' }, { id: B, repair: 'L done' }, { id: C, repair: 'M done' }]);
	assert.deepEqual(notInD1, [G]);
	assert.deepEqual(fromRepair({ episodes: {} }, seeded()), { picked: [], notInD1: [] });
});

test('what the repair is working on is left alone; what it finished, set aside or skipped is not', () => {
	assert.deepEqual(Object.fromEntries(repairBusy(PROGRESS)), {
		'roll-over-easy_2016-01-07_07-30-00': 'transcribing',
		'roll-over-easy_2016-02-04_07-30-00': 'staged',
		'roll-over-easy_2016-03-03_07-30-00': 'publishing',
		'roll-over-easy_2016-04-07_07-30-00': 'failed',
		'roll-over-easy_2016-06-02_07-30-00': 'starting afresh',
	});
	assert.equal(repairBusy(null).size, 0);
});

test('the episodes as read: reviewed ones included, with their guests and line counts', () => {
	const eps = loadEpisodes(seeded(), [A, B, C, 'roll-over-easy_2030-01-02_07-30-00']);
	assert.deepEqual([...eps.keys()].sort(), [A, B, C]);
	const a = eps.get(A);
	assert.deepEqual([a.reviewed, a.guests, a.line_count, a.summary, a.guest_start_ms], [true, ['Anna Lee', 'Brett Walker'], 300, OLD_A, 5_635_690]);
	assert.equal(a.last_end_ms, 299 * 20_000 + 19_000);
	assert.deepEqual([eps.get(B).reviewed, eps.get(C).reviewed, eps.get(C).summary], [false, false, null]);
});

test('the summary-only write changes the summary column and nothing else, reviewed episodes included', () => {
	const db = seeded();
	const before = everything(db);
	const changes = [
		{ id: A, old_summary: OLD_A, new_summary: NEW_A },
		{ id: B, old_summary: OLD_B, new_summary: NEW_B },
		{ id: C, old_summary: null, new_summary: 'A quiet one.' },
	];
	const sql = summaryUpdateSQL(changes);
	assert.equal(sql.split(/;\n/).length - 1, 3);
	for (const statement of sql.trim().split(/;\n(?=UPDATE)/)) {
		assert.match(statement, /^UPDATE episodes SET summary = '[^]*' WHERE id = '[^']+' AND summary IS (?:NULL|'[^]*');?$/);
	}
	assert.ok(sql.includes(`WHERE id = '${C}' AND summary IS NULL;`));
	db.importSQL(sql);
	const now = everything(db);
	assert.deepEqual(now.episodes.map((e) => e.summary), [D, A, B, C].sort().map((id) => ({ [A]: NEW_A, [B]: NEW_B, [C]: 'A quiet one.', [D]: 'A wet one.' })[id]));
	assert.deepEqual(withoutSummary(now.episodes), withoutSummary(before.episodes)); // title, guests_reviewed, guest_start_ms, audio_file…
	assert.deepEqual(now.guests, before.guests);
	assert.equal(now.lines, before.lines);
	// A summary changed after it was read is left as it is
	db.sqlite.exec(`UPDATE episodes SET summary = 'Written by hand.' WHERE id = '${A}'`);
	db.importSQL(summaryUpdateSQL([{ id: A, old_summary: NEW_A, new_summary: 'Yet another.' }]));
	assert.equal(db.query(`SELECT summary FROM episodes WHERE id = '${A}'`)[0].summary, 'Written by hand.');
});

test('which summaries get written: only where D1 still has the old summary and the same transcript', () => {
	const db = seeded();
	const now = loadEpisodes(db, [A, B, C, D]);
	const printOf = (id) => transcriptPrint(db.query(`SELECT start_ms, end_ms, text FROM transcript_segments WHERE episode_id = '${id}' ORDER BY start_ms, id`));
	assert.deepEqual(printOf(A), { lines: 300, chars: now.get(A).chars, last_end_ms: 299 * 20_000 + 19_000 });
	const { changes, leftAlone, already } = summaryChanges([
		{ id: A, old_summary: OLD_A, new_summary: NEW_A, transcript: printOf(A) },
		{ id: B, old_summary: 'What it said last week', new_summary: NEW_B },
		{ id: C, old_summary: null, new_summary: 'A quiet one.' },
		{ id: D, old_summary: 'A wet one.', new_summary: 'A wet one, redone.', transcript: { ...printOf(D), lines: 9 } }, // made from an older transcript
		{ id: G, old_summary: 'x', new_summary: 'y' },
	], now);
	assert.deepEqual(changes, [{ id: A, old_summary: OLD_A, new_summary: NEW_A }, { id: C, old_summary: null, new_summary: 'A quiet one.' }]);
	assert.deepEqual(leftAlone, [
		{ id: B, why: 'its summary changed after the new one was made' },
		{ id: D, why: 'its transcript changed after the new summary was made from it' },
		{ id: G, why: 'not in the database' },
	]);
	assert.deepEqual(already, []);
	// Written before (an --apply run twice): already there, not "changed"
	assert.deepEqual(summaryChanges([{ id: A, old_summary: 'what it was', new_summary: OLD_A }], now), { changes: [], leftAlone: [], already: [A] });
});

test('writing: the old summaries backed up first, one import, checked; restore.sql puts them back exactly', () => {
	const db = seeded();
	const before = everything(db);
	const result = writeSummaries(db, [
		{ id: A, old_summary: OLD_A, new_summary: NEW_A },
		{ id: B, old_summary: OLD_B, new_summary: NEW_B },
		{ id: C, old_summary: null, new_summary: 'A quiet one.' },
		{ id: D, old_summary: 'Changed since', new_summary: 'Not written' },
	], { database: 'production', source: 'test.json (ollama qwen3:30b)' });
	assert.deepEqual(result.written, [A, B, C]);
	assert.deepEqual(result.problems, []);
	assert.deepEqual(result.leftAlone, [{ id: D, why: 'its summary changed after the new one was made' }]);
	assert.equal(path.dirname(result.dir), path.join(path.resolve(process.env.ROE_PERSIST_TO), 'transcripts', '.backups'));
	assert.match(path.basename(result.dir), /^\d{4}-\d{2}-\d{2}-summaries(-\d+)?$/);
	const saved = JSON.parse(fs.readFileSync(path.join(result.dir, 'summaries.json'), 'utf-8'));
	assert.equal(saved.database, 'production');
	assert.deepEqual(saved.episodes, [
		{ id: A, summary: OLD_A, new_summary: NEW_A },
		{ id: B, summary: OLD_B, new_summary: NEW_B },
		{ id: C, summary: null, new_summary: 'A quiet one.' },
	]);
	const readme = fs.readFileSync(path.join(result.dir, 'README.txt'), 'utf-8');
	assert.ok(readme.includes(`npx wrangler d1 execute roe-episodes --remote --file "${path.join(result.dir, 'restore.sql')}"`));
	const restore = fs.readFileSync(path.join(result.dir, 'restore.sql'), 'utf-8');
	assert.equal(restore, restoreSQL([
		{ id: A, old_summary: OLD_A, new_summary: NEW_A },
		{ id: B, old_summary: OLD_B, new_summary: NEW_B },
		{ id: C, old_summary: null, new_summary: 'A quiet one.' },
	]));
	assert.ok(restore.includes(`UPDATE episodes SET summary = NULL WHERE id = '${C}' AND summary IS 'A quiet one.';`));
	assert.ok(restore.includes(`UPDATE episodes SET summary = 'It''s a rainy morning; Cole from SketchFest -- joined.' WHERE id = '${B}' AND summary IS 'A rainy morning.\nCole from SketchFest joined the show.';`));
	// Written: only the summaries differ
	const written = everything(db);
	assert.deepEqual(withoutSummary(written.episodes), withoutSummary(before.episodes));
	assert.deepEqual(written.guests, before.guests);
	// Written twice: the second time finds them there and backs nothing up
	const again = writeSummaries(db, [{ id: A, old_summary: OLD_A, new_summary: NEW_A }]);
	assert.deepEqual(again, { dir: null, written: [], leftAlone: [], already: [A], problems: [] });
	// Put back, except a summary changed since (it stays)
	db.sqlite.exec(`UPDATE episodes SET summary = 'Fixed by hand.' WHERE id = '${B}'`);
	db.importSQL(restore);
	const restored = everything(db);
	assert.deepEqual(restored.episodes.map((e) => e.summary), [D, A, B, C].sort().map((id) => ({ [A]: OLD_A, [B]: 'Fixed by hand.', [C]: null, [D]: 'A wet one.' })[id]));
	assert.deepEqual(withoutSummary(restored.episodes), withoutSummary(before.episodes));
	assert.deepEqual(restored.guests, before.guests);
});

test('an import that reports an error is checked all the same: D1 may have taken it', () => {
	const db = seeded();
	const flaky = { ...db, importSQL(sql) { db.importSQL(sql); throw new Error('fetch failed (the reply was lost)\nmore'); } };
	const result = writeSummaries(flaky, [{ id: A, old_summary: OLD_A, new_summary: NEW_A }]);
	assert.deepEqual(result.written, [A]);
	assert.deepEqual(result.problems, ['the import reported an error (fetch failed (the reply was lost)); what D1 holds now is checked below']);
	const lost = { ...db, importSQL() { throw new Error('D1 is down'); } };
	const none = writeSummaries(lost, [{ id: B, old_summary: OLD_B, new_summary: NEW_B }]);
	assert.deepEqual(none.written, []);
	assert.equal(none.problems.length, 2);
	assert.match(none.problems[1], /summary isn't the new one/);
	assert.ok(fs.existsSync(path.join(none.dir, 'restore.sql'))); // the backup came first
});

test('the plan: too thin to summarize, too long for a local model\'s context, and what OpenAI would cost', () => {
	const eps = loadEpisodes(seeded(), [A, D]);
	const a = planEpisode(eps.get(A));
	assert.equal(a.thin, false);
	assert.equal(a.overBy, 0);
	assert.ok(a.tokens > 300 * 70 / 3.5 && a.tokens < 300 * 90 / 3.5 + 1000, `${a.tokens}`);
	assert.equal(a.usd.toFixed(6), (a.tokens * 0.15e-6 + 600 * 0.6e-6).toFixed(6));
	assert.equal(planEpisode(eps.get(D)).thin, true); // 10 lines
	assert.equal(planEpisode(eps.get(D)).usd, 0);
	// A small context: a long show's transcript is over it
	const small = planEpisode(eps.get(A), { numCtx: 4096 });
	assert.ok(small.overBy > 0);
	// Two hours of talk against a 32k context
	const long = { ...eps.get(A), line_count: 2400, chars: 118_000 };
	assert.ok(planEpisode(long).overBy > 0);
	assert.equal(planEpisode(long, { numCtx: 40_960 }).overBy, 0);
});

test('one episode: a thin transcript keeps its summary; Ollama gets the transcript fitted to its context, and the answer is checked', async () => {
	const db = seeded();
	const eps = loadEpisodes(db, [A, D]);
	const lines = (id) => db.query(`SELECT start_ms, end_ms, text FROM transcript_segments WHERE episode_id = '${id}' ORDER BY start_ms, id`);
	const nothing = async () => { throw new Error('nothing should be asked'); };
	const thin = await rewriteEpisode({ ...eps.get(D), repair: 'W set-aside' }, lines(D), { engine: 'ollama', request: nothing, fetchImpl: nothing });
	assert.deepEqual([thin.status, thin.reason, thin.old_summary], ['kept', 'the transcript is too thin to summarize (10 lines)', 'A wet one.']);

	const sunrise = async () => ({ json: async () => ({ status: 'OK', results: { sunrise: '2014-03-20T14:13:05+00:00', sunset: '2014-03-21T02:23:40+00:00' } }) });
	const sent = [];
	const ollama = async (url, init) => {
		sent.push(JSON.parse(init.body));
		const content = sent.length === 1 ? 'Okay, let me think.' : JSON.stringify({ summary: NEW_A });
		return { ok: true, status: 200, json: async () => ({ message: { content }, done_reason: 'stop', prompt_eval_count: 2500, eval_count: 60, total_duration: 42e9 }) };
	};
	const logged = [];
	const record = await rewriteEpisode({ ...eps.get(A), repair: 'T published' }, lines(A), { engine: 'ollama', numCtx: 4096, request: ollama, fetchImpl: sunrise, log: (l) => logged.push(l) });
	assert.equal(sent.length, 2); // the malformed first answer was asked for again
	assert.match(logged[0], /not readable JSON; asking again/);
	const [system, user] = sent[1].messages;
	assert.match(system.content, /- Sunrise: 7:13 AM PT\n- Sunset: 7:23 PM PT\n- Guests, checked by hand \(spell their names this way\): Anna Lee, Brett Walker/);
	assert.equal(sent[1].options.num_ctx, 4096);
	// 300 lines don't fit next to the reply in 4,096 tokens: some are left out, the rest in order
	const kept = user.content.split('\n\n')[1].split('\n');
	assert.ok(record.left_out_lines > 0 && kept.length === 300 - record.left_out_lines);
	assert.ok(Math.ceil(system.content.length / 3.5) + Math.ceil(user.content.length / 3.5) + 64 <= 4096 - OLLAMA_REPLY_TOKENS);
	assert.deepEqual(kept, [...kept].sort((x, y) => Number(x.match(/\d+/)[0]) - Number(y.match(/\d+/)[0])));
	assert.deepEqual({ ...record, notes: undefined, old_notes: undefined }, {
		id: A, date: '2014-03-20', title: 'Spring has Sprung with Brett Walker!', reviewed: true, guests: ['Anna Lee', 'Brett Walker'],
		repair: 'T published', line_count: 300, transcript: transcriptPrint(lines(A)), old_summary: OLD_A, status: 'rewritten', new_summary: NEW_A,
		notes: undefined, old_notes: undefined, left_out_lines: record.left_out_lines, prompt_tokens: 2500, reply_tokens: 60, seconds: 42, usd: 0,
	});
	assert.deepEqual(record.notes, []);
	assert.deepEqual(record.old_notes, ['weather the transcript doesn\'t mention: "sunny"', 'a temperature the transcript doesn\'t give: 65 degrees']);

	// Ollama not running, or no answer in the time limit (asked twice): the episode fails, and the run should stop
	const down = async () => { throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' }); };
	const failed = await rewriteEpisode(eps.get(A), lines(A), { engine: 'ollama', request: down, fetchImpl: sunrise });
	assert.deepEqual([failed.status, failed.stopRun], ['failed', true]);
	assert.match(failed.error, /Ollama isn't answering/);
	const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
	const slow = await rewriteEpisode(eps.get(A), lines(A), { engine: 'ollama', request: hang, fetchImpl: sunrise, timeoutMs: 20, log: () => {} });
	assert.deepEqual([slow.status, slow.stopRun], ['failed', true]);
	assert.match(slow.error, /gave no answer within 20 ms/);

	// OpenAI: every answer counts toward the cost, one refused (cut off) included
	const answers = [{ content: '{"summary": "A fo', finish: 'length' }, { content: JSON.stringify({ summary: NEW_A }), finish: 'stop' }];
	const openai = async (url, init) => {
		if (url.includes('sunrise-sunset')) return sunrise();
		const a = answers.shift();
		return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: a.content }, finish_reason: a.finish }], usage: { prompt_tokens: 10_000, completion_tokens: 100 } }) };
	};
	const paid = await rewriteEpisode(eps.get(A), lines(A), { engine: 'openai', apiKey: 'test-key', fetchImpl: openai, log: () => {} });
	assert.equal(paid.status, 'rewritten');
	assert.equal(paid.usd.toFixed(6), (2 * (10_000 * 0.15e-6 + 100 * 0.6e-6)).toFixed(6));
	assert.equal(paid.left_out_lines, 0); // GPT-4o-mini gets the whole transcript
});

test('--apply: the file\'s new summaries (trimmed), not those failed, kept, emptied or the repair is working on', () => {
	const review = {
		engine: 'ollama', model: 'qwen3:30b', database: 'production',
		episodes: [
			{ id: A, status: 'rewritten', old_summary: OLD_A, new_summary: `  ${NEW_A}\n`, transcript: { lines: 300, chars: 22_000, last_end_ms: 5_999_000 } },
			{ id: B, status: 'rewritten', old_summary: OLD_B, new_summary: '' },
			{ id: C, status: 'kept', old_summary: null },
			{ id: D, status: 'failed', old_summary: 'A wet one.', error: 'timeout' },
			{ id: 'roll-over-easy_2016-03-03_07-30-00', status: 'rewritten', old_summary: 'x', new_summary: 'y' },
		],
	};
	const { wanted, skipped } = reviewedSummaries(review, repairBusy(PROGRESS));
	assert.deepEqual(wanted, [{ id: A, old_summary: OLD_A, new_summary: NEW_A, transcript: { lines: 300, chars: 22_000, last_end_ms: 5_999_000 } }]);
	assert.deepEqual(skipped, [
		{ id: B, why: 'no new summary in the file' },
		{ id: 'roll-over-easy_2016-03-03_07-30-00', why: 'the repair is working on it (publishing)' },
	]);
});

test('a local model waits for whisper.cpp on the GPU (the repair\'s), not for one on the CPU', () => {
	const ps = [
		'  101 /sbin/launchd',
		'27735 whisper-cli -m /Users/x/.cache/whisper-cpp/ggml-large-v3-turbo.bin --language en --output-json-full -f /tmp/a.wav',
		'27800 /opt/homebrew/bin/whisper-cli -ng -m /Users/x/.cache/whisper-cpp/ggml-large-v3.bin -f /tmp/b.wav',
		'27900 /opt/homebrew/bin/whisper-cli -m /Users/x/.cache/whisper-cpp/ggml-large-v3.bin -f /tmp/c.wav',
		'24485 /bin/zsh -c pgrep -fl whisper-cli',
		'24500 node scripts/repair-archive.js --worklist repair-worklist.csv',
		'',
	].join('\n');
	assert.deepEqual(whisperOnGpu(ps), [27735, 27900]);
	assert.deepEqual(whisperOnGpu(''), []);
});

test('the review: each summary before and after, what to check, and how to write them', () => {
	const review = {
		made_at: '2026-09-28T20:00:00.000Z', engine: 'ollama', model: 'qwen3:30b', num_ctx: 32_768, think: false, database: 'production', picked: '--only 2014-03-20',
		episodes: [
			{ id: A, date: '2014-03-20', title: 'Spring has Sprung with Brett Walker!', reviewed: true, guests: ['Brett Walker'], repair: 'T published', line_count: 300, old_summary: OLD_A, status: 'rewritten', new_summary: NEW_A, notes: [], old_notes: ['a temperature the transcript doesn\'t give: 65 degrees'], left_out_lines: 0, prompt_tokens: 25_000, reply_tokens: 90, seconds: 184.2, usd: 0 },
			{ id: D, date: '2014-01-16', title: 'Wet Wednesday!', reviewed: true, guests: [], repair: null, line_count: 10, old_summary: 'A wet one.', status: 'kept', reason: 'the transcript is too thin to summarize (10 lines)' },
		],
	};
	const md = reviewMarkdown(review, path.join(tmp, 'transcripts', '.summaries', 'x.json'));
	assert.match(md, /^# New summaries: ollama qwen3:30b\n/);
	assert.match(md, /2 episodes: 1 rewritten, 1 kept as they are, 0 failed\./);
	assert.match(md, /node scripts\/rewrite-summaries\.js --apply ".*x\.json" --yes/);
	assert.match(md, /## 2014-03-20: Spring has Sprung with Brett Walker!\n\n`roll-over-easy_2014-03-20_07-30-00` · reviewed · guests: Brett Walker · repair: T published · 300 lines · 25,000 tokens in · 3\.1 min\n\n\*\*Before\*\*\n\nIt was a sunny 65 degree morning\. Brett Walker joined the show\.\n\n- Check: a temperature the transcript doesn't give: 65 degrees\n\n\*\*After\*\*\n\nA foggy morning/);
	assert.match(md, /\*\*Kept as it is:\*\* the transcript is too thin to summarize \(10 lines\)\.\n\nA wet one\.\n$/);
	// Once written, it says when and where the old ones went, and no longer how to write them
	const writtenMd = reviewMarkdown({ ...review, writes: [{ at: '2026-09-28T21:00:00.000Z', backup: '/backups/2026-09-28-summaries', ids: [A] }] }, 'x.json');
	assert.match(writtenMd, /Written .*: 1 summary\. The old ones: \/backups\/2026-09-28-summaries \(its restore\.sql puts them back\)\./);
	assert.doesNotMatch(writtenMd, /Nothing has been written|--apply/);
	// Two 24-character columns in 40, the divider all the way down
	assert.deepEqual(sideBySide('one two three four five six', 'uno dos', 40), [`${'one two three four five'.padEnd(24)} | uno dos`, `${'six'.padEnd(24)} |`]);
});
