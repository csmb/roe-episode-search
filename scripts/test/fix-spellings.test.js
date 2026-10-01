// node --test scripts/test/*.test.js
// fix-spellings.js: which D1 lines the word corrections change, and the SQL it writes (run on the
// real schema in SQLite, keyword search included).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roe-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.ROE_PERSIST_TO ??= tmp; // a test run: no keys from .env
const { candidateSQL, spellingChanges, updateStatement, restoreStatement, reportLines } = await import('../fix-spellings.js');

const SCHEMA = fs.readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8');
const EP = 'roll-over-easy_2018-07-19_07-30-00';

test('the SELECT looks for every correction, case aside, and quotes safely', () => {
	const sql = candidateSQL(['soul drew', 'beta breakers', "o'brien"]);
	assert.match(sql, /^SELECT id, episode_id, text FROM transcript_segments WHERE /);
	assert.ok(sql.includes("lower(text) LIKE '%soul drew%' OR lower(text) LIKE '%beta breakers%' OR lower(text) LIKE '%o''brien%'"));
	assert.ok(candidateSQL().includes("LIKE '%soldrew%'"));
	assert.throws(() => candidateSQL([]), /No word corrections/);
});

test('only lines the corrections really change, each with the corrections that did it', () => {
	const changes = spellingChanges([
		{ id: 1, episode_id: EP, text: 'Hey, Soul Drew.' },
		{ id: 2, episode_id: EP, text: "It sold Drew's hints last night" }, // found by no key: real speech
		{ id: 3, episode_id: EP, text: 'Soldrew ran Beta Breakers again' },
		{ id: 4, episode_id: EP, text: 'Suldrew at Bay to Breakers' }, // already right
		{ id: 5, episode_id: EP, text: 'the soldering iron' }, // "sol..." inside a word
	]);
	assert.deepEqual(changes.map((c) => [c.id, c.new, c.keys]), [
		[1, 'Hey, Suldrew.', ['soul drew']],
		[3, 'Suldrew ran Bay to Breakers again', ['soldrew', 'beta breakers']],
	]);
	const report = reportLines(changes).join('\n');
	assert.match(report, /^2 lines to correct in 1 episode:/);
	assert.match(report, /"soul drew" -> "Suldrew": 1 line\n\s+2018-07-19 {2}"Hey, Soul Drew\." -> "Hey, Suldrew\."/);
});

test('on the real schema: the lines change, keyword search follows, and restore.sql puts them back', () => {
	const db = new DatabaseSync(':memory:');
	db.exec(SCHEMA);
	db.prepare('INSERT INTO episodes (id, title) VALUES (?, ?)').run(EP, 'Show');
	const add = db.prepare('INSERT INTO transcript_segments (episode_id, start_ms, end_ms, text) VALUES (?, ?, ?, ?)');
	for (const [i, text] of ['Hey, Soul Drew.', "Soul Drew's photo of Beta Breakers", 'Nothing to fix here'].entries()) add.run(EP, i * 5000, i * 5000 + 4000, text);
	const rows = db.prepare('SELECT id, episode_id, text FROM transcript_segments ORDER BY id').all();
	const changes = spellingChanges(rows);
	assert.equal(changes.length, 2);
	const found = (word) => db.prepare('SELECT rowid FROM transcript_fts WHERE transcript_fts MATCH ? ORDER BY rowid').all(word).map((r) => r.rowid);
	assert.deepEqual(found('Soul'), [1, 2]);

	// A line edited after it was read is left alone
	db.prepare('UPDATE transcript_segments SET text = ? WHERE id = 2').run('Edited by hand meanwhile');
	db.exec(changes.map(updateStatement).join('\n'));
	const texts = () => db.prepare('SELECT text FROM transcript_segments ORDER BY id').all().map((r) => r.text);
	assert.deepEqual(texts(), ['Hey, Suldrew.', 'Edited by hand meanwhile', 'Nothing to fix here']);
	assert.deepEqual(found('Suldrew'), [1]);
	assert.deepEqual(found('Soul'), []);

	db.exec(changes.map(restoreStatement).join('\n'));
	assert.deepEqual(texts(), ['Hey, Soul Drew.', 'Edited by hand meanwhile', 'Nothing to fix here']);
	assert.deepEqual(found('Soul'), [1]);
	assert.throws(() => updateStatement({ id: 'x', old: 'a', new: 'b' }), /Not a line id/);
	assert.match(updateStatement({ id: 7, old: "Soul Drew's", new: "Suldrew's" }), /SET text = 'Suldrew''s' WHERE id = 7 AND text = 'Soul Drew''s';$/);
});
