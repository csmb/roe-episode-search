// node --test scripts/test/*.test.js
// reanchor-place-quotes.js: finding a quote in new lines, which match counts, the SQL it writes (run
// on the real schema in SQLite), and its backup.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roe-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.ROE_PERSIST_TO ??= tmp; // a test run: no keys from .env
const {
	wordsOf, wordStream, findQuote, placeTimes, placeQuotes, moves, moveStatement, restoreStatement, writeBackup, episodeReport, movesReport, savedRows,
} = await import('../reanchor-place-quotes.js');

const SCHEMA = fs.readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8');
const EP = 'roll-over-easy_2014-03-06_07-30-00';
const min = (m, s = 0) => (m * 60 + s) * 1000;
const line = (ms, text) => ({ start_ms: ms, end_ms: ms + 2000, text });
// whisper.cpp's new lines: short, split mid-sentence, no capitals
const LINES = [
	line(min(12, 26), 'know you picture a scene with me here you go to whole foods right you go to the wall that has all'),
	line(min(12, 33), 'the coffee and there are literally dozens maybe tens of dozens of different types of coffee you'),
	line(min(12, 41), "have your starbucks your pete's your sight glass your de la plaza your four barrel your ritual bike"),
	line(min(13, 17), "i'm digging this yeah from ritual good stuff"),
	line(min(36, 0), "It's really cool."),
	line(min(39, 47), 'east side west tuesday night we met at east side west on a tuesday we chatted'),
	line(min(49, 29), 'the prettiness of a venue like the paramount in oakland castro theater great'),
	line(min(80, 10), 'Cause that was really cool.'),
	line(min(80, 12), 'Washington Square Park was packed.'),
];
const stream = wordStream(LINES);

test('words: case and punctuation ignored', () => {
	assert.deepEqual(wordsOf("I'm digging this. Yeah, from Ritual!"), ['i', 'm', 'digging', 'this', 'yeah', 'from', 'ritual']);
	assert.deepEqual(wordsOf(null), []);
});

test('word for word across line breaks: the time is the start of the line its first word is in', () => {
	const hit = findQuote("You go to Whole Foods, right? You go to the wall that has all the coffee", stream);
	assert.deepEqual([hit.ms, hit.how, hit.share], [min(12, 26), 'word for word', 1]);
	// 2014-03-06's quote for Ritual had a 10x time (125:12): found where it really is
	assert.equal(findQuote("I'm digging this. Yeah, from Ritual. Good stuff.", stream, min(125, 12), placeTimes(LINES, 'Ritual')).ms, min(13, 17));
});

test('found in more than one place: the one its old time leads into, else the nearest; none near it is no answer', () => {
	assert.equal(findQuote('really cool', stream, min(79)).ms, min(80, 10));
	assert.equal(findQuote('really cool', stream, min(37)).ms, min(36));
	// 9:40 leads into the one at 10:05 (25 s before it), though 9:25 is nearer
	const twice = wordStream([line(min(9, 25), 'It was great.'), line(min(9, 50), 'chatter'), line(min(10, 5), 'It was great.')]);
	assert.equal(findQuote('It was great.', twice, min(9, 40)).ms, min(10, 5));
	// No old time, or none within 3 minutes of one: which is it?
	assert.deepEqual(findQuote('really cool', stream), { ambiguous: true, how: 'word for word', places: 2 });
	assert.equal(findQuote('really cool', stream, min(58)).ambiguous, true);
	// One place said twice in a row is one place
	const echo = wordStream([line(min(20), 'oh yeah oh yeah oh yeah')]);
	assert.equal(findQuote('Oh yeah. Oh yeah.', echo).ms, min(20));
});

test('close: 75% of the words in order, for a quote of 6+ words; a shorter one only word for word', () => {
	// "Sightglass" and "De La Paz" came back as "sight glass" and "de la plaza"
	const hit = findQuote("You have your Starbucks, your Pete's, your Sightglass, your De La Paz, your Four Barrel", stream);
	assert.deepEqual([hit.ms, hit.how], [min(12, 33), 'close']); // its first word, "you", ends the 12:33 line
	assert.ok(hit.share >= 0.75 && hit.share < 1);
	assert.equal(findQuote('We met at Eastside West on a Tuesday.', stream).how, 'close');
	assert.equal(findQuote('Totally different words about the weather in the Sunset today', stream), null);
	assert.equal(findQuote('Really, really cool.', stream), null); // 3 words, not word for word
});

test('a close match starts where the quote does, not at a stray copy of its first word just before it', () => {
	const lines = [
		line(min(32, 30), 'down on the embarcadero'),
		line(min(32, 36), 'Did I?'),
		line(min(32, 41), 'I was downtown and uh really had to use the restroom and walked into the'),
	];
	const hit = findQuote('I was downtown and really had to use the restroom and walked into the, I think it was', wordStream(lines));
	assert.deepEqual([hit.ms, hit.how], [min(32, 41), 'close']);
});

test('accents don\'t matter: "Beyoncé" is "Beyonce"', () => {
	const lines = [line(min(6, 17), 'you could look through that and watch Jay-Z and Beyoncé.')];
	assert.equal(findQuote('you could look through that and watch Jay-Z and Beyonce.', wordStream(lines)).how, 'word for word');
});

test('a place counts only near a line naming the place or near the old time: "It\'s really cool." said elsewhere is not it', () => {
	// 2015-07-16: the 17th Street quote at 22:56 isn't in the new lines there; another one at 36:00 is no match
	assert.equal(findQuote("It's really cool.", stream, min(22, 56), placeTimes(LINES, '17th Street')), null);
	assert.equal(findQuote("It's really cool.", stream, min(35), placeTimes(LINES, '17th Street')).ms, min(36)); // within 3 minutes of its old time
	assert.equal(findQuote('Cause that was really cool.', stream, null, placeTimes(LINES, 'Washington Square Park')).ms, min(80, 10)); // the place named 2 s later
	assert.equal(findQuote('Cause that was really cool.', stream, null, placeTimes(LINES, 'Coit Tower')), null);
});

test('place names: spaces, punctuation and theater/theatre don\'t matter; "Street" and "Park" may be left off', () => {
	assert.deepEqual(placeTimes(LINES, 'Sightglass'), [min(12, 41)]);
	assert.deepEqual(placeTimes(LINES, 'Eastside West'), [min(39, 47)]);
	assert.deepEqual(placeTimes(LINES, 'Castro Theatre'), [min(49, 29)]);
	assert.deepEqual(placeTimes(LINES, 'Washington Square Park'), [min(80, 12)]);
	assert.deepEqual(placeTimes(LINES, 'Coit Tower'), []);
	assert.deepEqual(placeTimes(LINES, null), []);
	// Whole words: SoMa is not in "so many", Muni not in "community"
	const more = [line(min(1), 'so many people'), line(min(2), 'the community garden'), line(min(3), 'over in SoMa, by Muni')];
	assert.deepEqual(placeTimes(more, 'SoMa'), [min(3)]);
	assert.deepEqual(placeTimes(more, 'Muni'), [min(3)]);
});

test('every row of an episode: quotes found move, quotes not found and rows with no quote keep their time', () => {
	const mentions = [
		{ place_id: 1, name: 'Ritual', episode_id: EP, snippet: "I'm digging this. Yeah, from Ritual. Good stuff.", snippet_start_ms: min(125, 12) },
		{ place_id: 2, name: 'Sightglass', episode_id: EP, snippet: "You have your Starbucks, your Pete's, your Sightglass, your De La Paz, your Four Barrel", snippet_start_ms: min(125, 12) },
		{ place_id: 3, name: '17th Street', episode_id: EP, snippet: "It's really cool.", snippet_start_ms: min(22, 56) },
		{ place_id: 4, name: 'Mission District', episode_id: EP, snippet: null, snippet_start_ms: min(5) },
		{ place_id: 5, name: 'Castro Theatre', episode_id: EP, snippet: 'the prettiness of a venue like the Paramount in Oakland, Castro Theatre, great', snippet_start_ms: null },
		{ place_id: 6, name: 'Whole Foods', episode_id: EP, snippet: 'You go to Whole Foods, right?', snippet_start_ms: min(12, 26) },
	];
	const rows = placeQuotes(mentions, LINES);
	assert.equal(rows.length, mentions.length);
	const got = rows.map((r) => [r.place_id, r.how, r.new]);
	assert.deepEqual(got, [
		[1, 'word for word', min(13, 17)],
		[2, 'close', min(12, 33)],
		[3, 'not found', null],
		[4, 'no quote', null],
		[5, 'close', min(49, 29)], // no time before: now it has one
		[6, 'word for word', min(12, 26)],
	]);
	assert.deepEqual(rows.filter(moves).map((r) => r.place_id), [1, 2, 5]); // 6 is already right
	assert.match(episodeReport(EP, rows)[0], /^2014-03-06 {2}6 quotes: 2 word for word, 2 close, 1 not found, 1 without a quote; 3 to move \(median 112:39, largest 112:39\)$/);
});

test('an old time that still leads into its quote stays: up to 30 s before its line, or within it', () => {
	const quote = (snippet_start_ms) => placeQuotes([{ place_id: 6, name: 'Whole Foods', episode_id: EP, snippet: 'You go to Whole Foods, right?', snippet_start_ms }], LINES)[0];
	const line = min(12, 26); // the line the quote starts in, 12:26-12:28
	assert.equal(quote(line - 30_000).new, line - 30_000); // the start of its passage, as the pipeline sets it
	assert.equal(quote(line + 2_000).new, line + 2_000);
	assert.equal(quote(line - 31_000).new, line);
	assert.equal(quote(line + 3_000).new, line);
	assert.equal(moves(quote(line - 30_000)), false);
	assert.equal(moves(quote(null)), true);
});

test('the statements change snippet_start_ms only, and only where the quote and its time are still the ones read', () => {
	const r = { place_id: 708, episode_id: EP, snippet: "I'm digging this.", old: min(125, 12), new: min(13, 17) };
	const row = `place_id = 708 AND episode_id = '${EP}' AND snippet = 'I''m digging this.'`;
	assert.equal(moveStatement(r), `UPDATE place_mentions SET snippet_start_ms = 797000 WHERE ${row} AND snippet_start_ms = 7512000;`);
	assert.equal(restoreStatement(r), `UPDATE place_mentions SET snippet_start_ms = 7512000 WHERE ${row} AND snippet_start_ms = 797000;`);
	assert.equal(moveStatement({ ...r, old: null }), `UPDATE place_mentions SET snippet_start_ms = 797000 WHERE ${row} AND snippet_start_ms IS NULL;`);
	assert.equal(restoreStatement({ ...r, old: null }), `UPDATE place_mentions SET snippet_start_ms = NULL WHERE ${row} AND snippet_start_ms = 797000;`);
	assert.throws(() => moveStatement({ ...r, new: null }), /Not a time in ms/);
	assert.throws(() => moveStatement({ ...r, snippet: null }), /no quote to move/);
});

test('on the real schema: only the moved times change, no row is added or deleted, restore.sql puts back what is still as set', () => {
	const db = new DatabaseSync(':memory:');
	db.exec(SCHEMA);
	db.prepare('INSERT INTO episodes (id, title) VALUES (?, ?)').run(EP, 'Coffee Talk!');
	for (const [pid, name] of [[1, 'Ritual'], [2, 'Sightglass'], [3, '17th Street'], [4, 'Mission District']]) db.prepare('INSERT INTO places (id, name, lat, lng) VALUES (?, ?, 37.76, -122.42)').run(pid, name);
	const rows = [[1, 7_512_000], [2, 7_512_000], [3, 1_376_000], [4, null]];
	for (const [pid, ms] of rows) db.prepare('INSERT INTO place_mentions (place_id, episode_id, snippet, snippet_start_ms) VALUES (?, ?, ?, ?)').run(pid, EP, `quote ${pid}`, ms);
	const times = () => db.prepare('SELECT place_id, snippet_start_ms FROM place_mentions ORDER BY place_id').all().map((r) => [r.place_id, r.snippet_start_ms]);
	const todo = [
		{ place_id: 1, name: 'Ritual', episode_id: EP, snippet: 'quote 1', old: 7_512_000, new: 797_000 },
		{ place_id: 2, name: 'Sightglass', episode_id: EP, snippet: 'quote 2', old: 7_512_000, new: 753_000 },
		{ place_id: 4, name: 'Mission District', episode_id: EP, snippet: 'quote 4', old: null, new: 323_000 },
	];
	const dir = fs.mkdtempSync(path.join(tmp, 'backup-'));
	db.exec(writeBackup(dir, todo));
	assert.deepEqual(times(), [[1, 797_000], [2, 753_000], [3, 1_376_000], [4, 323_000]]);
	db.prepare('UPDATE place_mentions SET snippet_start_ms = 760000 WHERE place_id = 2').run(); // changed by hand since
	db.exec(fs.readFileSync(path.join(dir, 'restore.sql'), 'utf8'));
	assert.deepEqual(times(), [[1, 7_512_000], [2, 760_000], [3, 1_376_000], [4, null]]);
	assert.equal(db.prepare('SELECT COUNT(*) AS n FROM place_mentions').get().n, 4);
	assert.deepEqual(db.prepare('SELECT snippet FROM place_mentions ORDER BY place_id').all().map((r) => r.snippet), ['quote 1', 'quote 2', 'quote 3', 'quote 4']);

	// Scored again since the read (a new quote, the same time): left alone
	db.prepare("UPDATE place_mentions SET snippet = 'a new quote' WHERE place_id = 1").run();
	db.exec(todo.map(moveStatement).join('\n'));
	assert.deepEqual(times(), [[1, 7_512_000], [2, 760_000], [3, 1_376_000], [4, 323_000]]);
});

test('the backup: the rows as read, what was run (UPDATEs of snippet_start_ms only), how to undo it', () => {
	const dir = fs.mkdtempSync(path.join(tmp, 'backup-'));
	const todo = [{ place_id: 708, name: 'Ritual', episode_id: EP, snippet: "I'm digging this.", old: 7_512_000, new: 797_000 }];
	const applied = writeBackup(dir, todo, { isLocal: true });
	assert.deepEqual(fs.readdirSync(dir).sort(), ['README.txt', 'applied.sql', 'before.json', 'restore.sql']);
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'before.json'), 'utf8')), [{ place_id: 708, name: 'Ritual', episode_id: EP, snippet: "I'm digging this.", snippet_start_ms: 7_512_000 }]);
	assert.equal(fs.readFileSync(path.join(dir, 'applied.sql'), 'utf8'), applied);
	assert.ok(applied.split('\n').filter(Boolean).every((s) => s.startsWith('UPDATE place_mentions SET snippet_start_ms = ')));
	assert.ok(!/\b(INSERT|DELETE|DROP)\b/i.test(applied + fs.readFileSync(path.join(dir, 'restore.sql'), 'utf8')));
	const readme = fs.readFileSync(path.join(dir, 'README.txt'), 'utf8');
	assert.match(readme, /local D1 copy \(--local\)/);
	assert.ok(readme.includes(`npx wrangler d1 execute roe-episodes --local --file "${path.join(dir, 'restore.sql')}"`));
});

test('--apply takes the saved rows as they are, on the database they were read from', () => {
	const saved = { at: '2026-09-28T21:12:58.000Z', database: 'local', rows: [{ place_id: 1, episode_id: EP, snippet: 'x', old: 7_512_000, new: 797_000 }] };
	assert.equal(savedRows(saved, { database: 'local' }).filter(moves).length, 1);
	assert.throws(() => savedRows(saved, { database: 'production' }), /made on the local database, not the production one/);
	assert.throws(() => savedRows({ proposals: [] }, { database: 'production' }), /Not a quotes.json/);
});

test('moves.txt: only the quotes that move, each with the line it is in now', () => {
	const rows = placeQuotes([
		{ place_id: 1, name: 'Ritual', episode_id: EP, snippet: "I'm digging this. Yeah, from Ritual. Good stuff.", snippet_start_ms: min(125, 12) },
		{ place_id: 3, name: '17th Street', episode_id: EP, snippet: "It's really cool.", snippet_start_ms: min(22, 56) },
		{ place_id: 5, name: 'Castro Theatre', episode_id: EP, snippet: 'the prettiness of a venue like the Paramount in Oakland, Castro Theatre, great', snippet_start_ms: null },
		{ place_id: 6, name: 'Whole Foods', episode_id: EP, snippet: 'You go to Whole Foods, right?', snippet_start_ms: min(12, 26) },
	], LINES);
	assert.deepEqual(movesReport(rows), [
		`2014-03-06  125:12 ->  13:17 (-111:55)  word for word  Ritual: "I'm digging this. Yeah, from Ritual. Good stuff."`,
		`             line: "i'm digging this yeah from ritual good stuff"`,
		`2014-03-06   empty ->  49:29  close 92%  Castro Theatre: "the prettiness of a venue like the Paramount in Oakland, Castro Theatre, great"`,
		`             line: "the prettiness of a venue like the paramount in oakland castro theater great"`,
	]);
	assert.deepEqual(movesReport(rows.filter((r) => !moves(r))), []);
});
