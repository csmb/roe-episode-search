// node --test scripts/test/*.test.js
// discover-episodes.js on a folder of empty files of set sizes (nothing is read but names and sizes).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roe-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.ROE_PERSIST_TO ??= tmp; // a test run: no keys from .env
const { discoverEpisodes } = await import('../discover-episodes.js');

const MB = 1024 * 1024;

function archive(files) {
	const dir = fs.mkdtempSync(path.join(tmp, 'archive-'));
	for (const [name, size] of Object.entries(files)) {
		const fd = fs.openSync(path.join(dir, name), 'w');
		fs.ftruncateSync(fd, Math.round(size));
		fs.closeSync(fd);
	}
	return dir;
}

const names = (list) => list.map((f) => path.basename(f.filePath));

test('a date keeps its preferred file, and lists its other recordings in the same order', () => {
	const dir = archive({
		'Roll Over Easy 2030-01-02.mp3': 100 * MB,
		'App Recording 20300102 0731.mp3': 90 * MB, // its own ID is _07-31-00
		'Roll Over Easy 2030-01-02 (1).mp3': 120 * MB, // a "(1)" name comes last despite its size
		'Roll Over Easy 2030-01-02 final.mp3': 80 * MB, // "final" comes first
		'Roll Over Easy 2030-01-02 short.mp3': 2 * MB, // under 5 MB: a fragment
	});
	const [e] = discoverEpisodes(dir).episodes;
	assert.equal(path.basename(e.filePath), 'Roll Over Easy 2030-01-02 final.mp3');
	assert.equal(e.episodeId, 'roll-over-easy_2030-01-02_07-30-00');
	assert.deepEqual(names(e.alternates), ['Roll Over Easy 2030-01-02.mp3', 'App Recording 20300102 0731.mp3', 'Roll Over Easy 2030-01-02 (1).mp3']);
	assert.equal(e.alternates[1].episodeId, 'roll-over-easy_2030-01-02_07-31-00');
	assert.deepEqual(e.alternates.map((a) => a.fileSize), [100 * MB, 90 * MB, 120 * MB]);
});

test('a copy (the size of a file before it) is not an alternate', () => {
	const dir = archive({
		'Roll Over Easy 2030-01-09 1.mp3': 150 * MB, // numbered copies of one size: not a split show
		'Roll Over Easy 2030-01-09 2.mp3': 150 * MB,
		'Roll Over Easy 2030-01-16.mp3': 110 * MB,
		'Roll Over Easy 2030-01-16 copy.mp3': 110 * MB,
		'Roll Over Easy 2030-01-16 (1).mp3': 100 * MB,
	});
	const [a, b] = discoverEpisodes(dir).episodes;
	assert.deepEqual(a.alternates, []);
	assert.deepEqual(names(b.alternates), ['Roll Over Easy 2030-01-16 (1).mp3']);
});

test('split shows, small dates and done dates are as before', () => {
	const dir = archive({
		'Roll Over Easy 2030-02-06 1.mp3': 30 * MB, // split: MULTI-PART, not an episode
		'Roll Over Easy 2030-02-06 2.mp3': 80 * MB,
		'Roll Over Easy 2030-02-13.mp3': 3 * MB, // only small files: the largest, no alternates
		'Roll Over Easy 2030-02-13 (1).mp3': 2 * MB,
		'Roll Over Easy 2030-02-20.mp3': 100 * MB, // already done
		'App Recording 20300220 0735.mp3': 90 * MB,
	});
	const found = discoverEpisodes(dir, { alreadyProcessed: new Set(['roll-over-easy_2030-02-20_07-30-00']) });
	assert.deepEqual(found.multiPart.map((m) => m.date), ['2030-02-06']);
	assert.deepEqual(found.episodes.map((e) => [e.date, path.basename(e.filePath), e.alternates.length]), [['2030-02-13', 'Roll Over Easy 2030-02-13.mp3', 0]]);
});
