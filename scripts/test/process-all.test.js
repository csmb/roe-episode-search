// node --test scripts/test/*.test.js
// process-all.js: which of a date's recordings a run tries, and the process-episode runs it starts.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roe-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.ROE_PERSIST_TO ??= tmp; // a test run: no keys from .env
const { recordingsToTry, episodeRuns } = await import('../process-all.js');

const DIR = '/archive';
const file = (name, fileSize, episodeId = 'roll-over-easy_2030-01-02_07-30-00') => ({ episodeId, filePath: `${DIR}/${name}`, fileSize });
const episode = {
	...file('Roll Over Easy 2030-01-02.mp3', 6000),
	date: '2030-01-02',
	alternates: [file('App Recording 20300102 0731.mp3', 5000, 'roll-over-easy_2030-01-02_07-31-00'), file('Roll Over Easy 2030-01-02 (1).mp3', 4000)],
};
const noProgress = { completed: {}, failed: {}, skipped: {}, timings: [] };
const tryNames = (progress) => recordingsToTry(episode, progress).map((f) => path.basename(f.filePath));
const rejected = (file, size) => ({ file, size, reason: 'Only 10 segments (minimum 100) — likely failed transcription', timestamp: '2030-01-02T10:00:00.000Z' });

test('with nothing rejected, the preferred file comes first, then the alternates', () => {
	assert.deepEqual(tryNames(noProgress), ['Roll Over Easy 2030-01-02.mp3', 'App Recording 20300102 0731.mp3', 'Roll Over Easy 2030-01-02 (1).mp3']);
	assert.equal(recordingsToTry(episode, noProgress)[1].episodeId, 'roll-over-easy_2030-01-02_07-31-00');
});

test('rejected files are left out; when every one was rejected, nothing is left to try', () => {
	const some = { ...noProgress, skipped: { 'roll-over-easy_2030-01-02_07-30-00': { date: '2030-01-02', rejected: [rejected('Roll Over Easy 2030-01-02.mp3', 6000)] } } };
	assert.deepEqual(tryNames(some), ['App Recording 20300102 0731.mp3', 'Roll Over Easy 2030-01-02 (1).mp3']);
	const all = { ...noProgress, skipped: { 'roll-over-easy_2030-01-02_07-30-00': { date: '2030-01-02', rejected: [rejected('Roll Over Easy 2030-01-02.mp3', 6000), rejected('App Recording 20300102 0731.mp3', 5000), rejected('Roll Over Easy 2030-01-02 (1).mp3', 4000)] } } };
	assert.deepEqual(tryNames(all), []);
});

test('a file replaced under the same name (a new size) is tried again', () => {
	const progress = { ...noProgress, skipped: { 'roll-over-easy_2030-01-02_07-30-00': { date: '2030-01-02', rejected: [rejected('Roll Over Easy 2030-01-02.mp3', 5999), rejected('App Recording 20300102 0731.mp3', 5000), rejected('Roll Over Easy 2030-01-02 (1).mp3', 4000)] } } };
	assert.deepEqual(tryNames(progress), ['Roll Over Easy 2030-01-02.mp3']);
});

test('an entry from before the list (a name, no size) and one under another ID of the date count; other dates don\'t', () => {
	const progress = {
		...noProgress,
		skipped: {
			'roll-over-easy_2030-01-02_07-30-00': { date: '2030-01-02', reason: 'Only 3 segments', file: 'Roll Over Easy 2030-01-02.mp3', timestamp: '2026-03-04T11:47:29.375Z' },
			'roll-over-easy_2030-01-02_07-31-00': { date: '2030-01-02', reason: 'Only 0 segments', file: 'App Recording 20300102 0731.mp3', timestamp: '2026-03-04T11:50:00.000Z' },
			'roll-over-easy_2030-01-09_07-30-00': { date: '2030-01-09', reason: 'Only 1 segments', file: 'Roll Over Easy 2030-01-02 (1).mp3', timestamp: '2026-03-04T12:00:00.000Z' },
		},
	};
	assert.deepEqual(tryNames(progress), ['Roll Over Easy 2030-01-02 (1).mp3']);
});

test('the process-episode runs: an alternate goes in as the date\'s episode, in both phases', () => {
	const f = `${DIR}/App Recording 20300102 0731.mp3`;
	const [p1, p2] = episodeRuns(f, { episodeId: 'roll-over-easy_2030-01-02_07-30-00', noGpu: true, local: true });
	assert.deepEqual(p1.slice(1), [f, '--episode-id', 'roll-over-easy_2030-01-02_07-30-00', '--skip', 'seed-db,embeddings,summary,guest-start,upload-audio', '--no-gpu']);
	assert.deepEqual(p2.slice(1), [f, '--episode-id', 'roll-over-easy_2030-01-02_07-30-00', '--skip', 'transcribe', '--local']);
	const [d1, d2] = episodeRuns(f, {});
	assert.deepEqual(d1.slice(1), [f, '--skip', 'seed-db,embeddings,summary,guest-start,upload-audio']);
	assert.deepEqual(d2.slice(1), [f, '--skip', 'transcribe']);
});
