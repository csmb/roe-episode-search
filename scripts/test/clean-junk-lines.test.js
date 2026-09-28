// node --test scripts/test/*.test.js
// clean-junk-lines.js: its delete statements and the embeddings run it starts.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roe-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.ROE_PERSIST_TO ??= tmp; // a test run: no keys from .env
const { deleteStatements, embeddingsRun, DEFAULT_RULES } = await import('../clean-junk-lines.js');
const { pickEpisodes } = await import('../scan-transcripts.js');

test('junk lines are deleted by ID within their episode, 1,000 to a statement', () => {
	const ids = Array.from({ length: 2345 }, (_, i) => 5000 + i);
	const sql = deleteStatements("roll-over-easy_2026-04-30_07-30-00", ids);
	assert.equal(sql.length, 3);
	assert.match(sql[0], /^DELETE FROM transcript_segments WHERE episode_id = 'roll-over-easy_2026-04-30_07-30-00' AND id IN \(5000, 5001, /);
	assert.deepEqual(sql.map((s) => s.split(',').length), [1000, 1000, 345]);
	assert.deepEqual(DEFAULT_RULES, ['echo', 'loops']);
});

test('the embeddings are redone by process-episode with every other step skipped, and no audio file', () => {
	const run = embeddingsRun('roll-over-easy_2020-01-16_07-30-00', { isLocal: true });
	assert.match(run[0], /scripts\/process-episode\.js$/);
	assert.deepEqual(run.slice(1), ['--episode-id', 'roll-over-easy_2020-01-16_07-30-00', '--skip', 'transcribe,seed-db,summary,guest-start,upload-audio', '--local']);
});

test('episodes are picked by date or ID, and a name that matches none stops the run', () => {
	const episodes = ['roll-over-easy_2020-01-16_07-30-00', 'roll-over-easy_2026-04-30_07-30-00', 'roll-over-easy_2026-09-24_07-30-00'].map((id) => ({ id }));
	assert.deepEqual(pickEpisodes(episodes, '2026-04-30, roll-over-easy_2020-01-16_07-30-00').map((e) => e.id), ['roll-over-easy_2020-01-16_07-30-00', 'roll-over-easy_2026-04-30_07-30-00']);
	assert.equal(pickEpisodes(episodes, undefined).length, 3);
	assert.throws(() => pickEpisodes(episodes, '2026-04-31'), /Not in the database: 2026-04-31/);
});
