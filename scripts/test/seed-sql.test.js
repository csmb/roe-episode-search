// node --test scripts/test/*.test.js
// process-episode.js seedSQL: the one import that replaces an episode's transcript lines.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roe-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.ROE_PERSIST_TO ??= tmp; // a test run: no keys from .env
const { seedSQL } = await import('../process-episode.js');

const lines = (n) => Array.from({ length: n }, (_, i) => ({ start_ms: i * 1000, end_ms: i * 1000 + 900, text: `Line ${i}` }));
const statements = (sql) => sql.trim().split('\n');

test('the row comes first (the lines point at it), then the delete, the lines 50 at a time, and the length last', () => {
	const sql = statements(seedSQL('roll-over-easy_2030-01-02_07-30-00', lines(120), 7_200_000));
	assert.equal(sql.length, 2 + 3 + 1);
	assert.equal(sql[0], "INSERT OR IGNORE INTO episodes (id, title) VALUES ('roll-over-easy_2030-01-02_07-30-00', 'roll-over-easy_2030-01-02_07-30-00');");
	assert.equal(sql[1], "DELETE FROM transcript_segments WHERE episode_id = 'roll-over-easy_2030-01-02_07-30-00';");
	assert.deepEqual(sql.slice(2, 5).map((s) => s.match(/\('/g).length), [50, 50, 20]);
	assert.match(sql[2], /^INSERT INTO transcript_segments \(episode_id, start_ms, end_ms, text\) VALUES \('roll-over-easy_2030-01-02_07-30-00', 0, 900, 'Line 0'\), /);
	assert.equal(sql.at(-1), "UPDATE episodes SET duration_ms = 7200000 WHERE id = 'roll-over-easy_2030-01-02_07-30-00';");
});

test('quotes are escaped, spelling fixes applied, and every statement ends its line', () => {
	const sql = seedSQL("it's-an-id", [{ start_ms: 5, end_ms: 9, text: "The soldier's; it's 7:30" }], 10);
	assert.match(sql, /VALUES \('it''s-an-id', 5, 9, 'The Suldrew''s; it''s 7:30'\);/);
	assert.ok(statements(sql).every((s) => s.endsWith(';')));
});
