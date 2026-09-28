// node --test scripts/test/*.test.js
// repaired-episodes.js: which episodes the repair's follow-ups (interview times, place quotes) work on.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roe-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.ROE_PERSIST_TO ??= tmp; // a test run: no keys from .env
const { repairedIds, repairBusy, chooseEpisodes, loadRepairState, leaveOutBusy, repairProgressPath, mmss, dateOf } = await import('../repaired-episodes.js');

const id = (date) => `roll-over-easy_${date}_07-30-00`;
const EPISODES = ['2014-01-16', '2014-01-23', '2014-09-04', '2020-07-16', '2026-04-30', '2026-09-24'].map((d) => ({ id: id(d) }));
const PROGRESS = {
	started_at: '2026-09-28T12:25:52.711Z',
	episodes: {
		[id('2014-01-16')]: { state: 'published' },
		[id('2014-09-04')]: { state: 'published' },
		[id('2015-01-01')]: { state: 'set-aside' },
		[id('2020-07-16')]: { state: 'staged' },
		[id('2026-04-30')]: { state: 'done' },
		[id('2014-01-23')]: { state: 'transcribing' },
		[id('2026-09-24')]: { state: 'skipped' },
	},
	database: 'production',
};
const dates = (episodes) => episodes.map((e) => dateOf(e.id));

test('the repair has finished the published and done episodes; it is working on the rest but those skipped or set aside', () => {
	assert.deepEqual(repairedIds(PROGRESS), [id('2014-01-16'), id('2014-09-04'), id('2026-04-30')]);
	assert.deepEqual([...repairBusy(PROGRESS)], [[id('2020-07-16'), 'staged'], [id('2014-01-23'), 'transcribing']]);
	assert.deepEqual(repairedIds(null), []);
	assert.equal(repairBusy(null).size, 0);
});

test('--only by date or ID, --from-repair from the progress, --except leaves some out', () => {
	const pick = (opts) => chooseEpisodes(EPISODES, { progress: PROGRESS, ...opts });
	assert.deepEqual(dates(pick({ only: `2026-09-24, ${id('2014-09-04')}` }).chosen), ['2014-09-04', '2026-09-24']);
	const all = pick({ fromRepair: true });
	assert.deepEqual(dates(all.chosen), ['2014-01-16', '2014-09-04', '2026-04-30']);
	assert.deepEqual(all.notInD1, []);
	assert.deepEqual(dates(pick({ fromRepair: true, except: '2014-09-04' }).chosen), ['2014-01-16', '2026-04-30']);
	// 2015-01-01 was taken off the site after the repair set it aside; one it published and then deleted is listed
	const gone = chooseEpisodes(EPISODES.filter((e) => e.id !== id('2014-09-04')), { fromRepair: true, progress: PROGRESS });
	assert.deepEqual(gone.notInD1, [id('2014-09-04')]);
});

test('an episode the repair is working on is left out, even by name', () => {
	const { chosen, busy } = chooseEpisodes(EPISODES, { only: '2014-01-23,2020-07-16,2026-09-24', progress: PROGRESS });
	assert.deepEqual(dates(chosen), ['2026-09-24']);
	assert.deepEqual(busy, [{ id: id('2014-01-23'), state: 'transcribing' }, { id: id('2020-07-16'), state: 'staged' }]);
	assert.deepEqual(dates(chooseEpisodes(EPISODES, { only: '2014-01-23', progress: null }).chosen), ['2014-01-23']); // no repair state: nothing to leave out
});

test('a saved list (--apply) loses the rows of an episode the repair has started working on since', () => {
	const rows = [{ id: id('2014-01-16') }, { id: id('2020-07-16') }, { id: id('2014-01-23') }];
	assert.deepEqual(dates(leaveOutBusy(rows, PROGRESS)), ['2014-01-16']);
	assert.deepEqual(dates(leaveOutBusy(rows, null)), ['2014-01-16', '2020-07-16', '2014-01-23']);
	const quotes = [{ episode_id: id('2014-01-16') }, { episode_id: id('2020-07-16') }];
	assert.equal(leaveOutBusy(quotes, PROGRESS, (r) => r.episode_id).length, 1);
});

test('one of --only and --from-repair; a name that matches no episode stops the run', () => {
	assert.throws(() => chooseEpisodes(EPISODES, {}), /--only <dates> or --from-repair/);
	assert.throws(() => chooseEpisodes(EPISODES, { only: '2014-01-16', fromRepair: true, progress: PROGRESS }), /--only <dates> or --from-repair/);
	assert.throws(() => chooseEpisodes(EPISODES, { only: '2014-01-17' }), /Not in the database: 2014-01-17/);
	assert.throws(() => chooseEpisodes(EPISODES, { fromRepair: true, progress: PROGRESS, except: '2031-01-01' }), /Not in the database: 2031-01-01/);
});

test('the repair state: the transcripts folder\'s (a test run: its own), or --progress; only for its own database', () => {
	assert.equal(repairProgressPath(), path.join(path.resolve(process.env.ROE_PERSIST_TO), 'transcripts', '.repair', 'progress.json'));
	assert.throws(() => loadRepairState({ fromRepair: true }), /No repair progress at .*: use --only <dates>/);
	assert.equal(loadRepairState({}), null);
	fs.mkdirSync(path.dirname(repairProgressPath()), { recursive: true });
	fs.writeFileSync(repairProgressPath(), JSON.stringify(PROGRESS));
	assert.deepEqual(repairedIds(loadRepairState({ fromRepair: true })), [id('2014-01-16'), id('2014-09-04'), id('2026-04-30')]);
	// production's state is no use for a --local run: --from-repair stops, --only runs without it
	assert.throws(() => loadRepairState({ isLocal: true, fromRepair: true }), /is the repair's state on the production database, not the local one/);
	assert.equal(loadRepairState({ isLocal: true }), null);
	const local = path.join(tmp, 'local-progress.json');
	fs.writeFileSync(local, JSON.stringify({ ...PROGRESS, database: 'local' }));
	assert.equal(loadRepairState({ file: local, isLocal: true, fromRepair: true }).database, 'local');
	assert.throws(() => loadRepairState({ file: local, fromRepair: true }), /on the local database, not the production one/);
	const { database, ...noDatabase } = PROGRESS; // an older file without the field is production's
	fs.writeFileSync(local, JSON.stringify(noDatabase));
	assert.equal(database, 'production');
	assert.ok(loadRepairState({ file: local, fromRepair: true }));
});

test('times as m:ss, and dates from IDs', () => {
	assert.equal(mmss(4_637_000), '77:17');
	assert.equal(mmss(3_600_000), '60:00');
	assert.equal(mmss(59_999), '0:59');
	assert.equal(mmss(null), 'empty');
	assert.equal(dateOf(id('2026-09-24')), '2026-09-24');
});
