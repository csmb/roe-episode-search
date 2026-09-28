// node --test scripts/test/*.test.js
// fill-interview-times.js: which interview times get a proposal, the SQL it writes (run on the real
// schema in SQLite), and its backup.
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
	fillable, inSignOff, proposeTime, fillStatement, restoreStatement, writeBackup, reportLines, movedPlaceholder, savedProposals, PLACEHOLDER_MS,
} = await import('../fill-interview-times.js');

const SCHEMA = fs.readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8');
const id = (date) => `roll-over-easy_${date}_07-30-00`;
const min = (m, s = 0) => (m * 60 + s) * 1000;
// A line every 5 s from one minute to another, "chatter" unless `said` has a line for that time
const talk = (from, to, said = {}) => {
	const out = [];
	for (let t = min(from); t < min(to); t += 5000) out.push({ start_ms: t, end_ms: t + 4000, text: said[t] ?? 'chatter chatter' });
	return out;
};
// A whole show: the interview after a song (left out, a gap) at 61:00, a closing song, a thank-you
const SHOW = [
	...talk(0, 58),
	...talk(61, 114, { [min(61)]: "We're back, and we're here with Casey Smith. Good morning, Casey." }),
	...talk(117, 120, { [min(118)]: 'Thank you so much, Casey.' }),
];
const episode = (date, guest_start_ms, guests_reviewed = 1, duration_ms = min(120)) => ({ id: id(date), duration_ms, guest_start_ms, guests_reviewed });

test('only an empty time or the old 60:00 placeholder may be filled', () => {
	assert.equal(PLACEHOLDER_MS, 3_600_000);
	assert.equal(fillable(null), true);
	assert.equal(fillable(undefined), true);
	assert.equal(fillable(3_600_000), true);
	assert.equal(fillable(4_637_000), false); // 2026-09-24, set by hand
	assert.equal(fillable(0), false);
});

test('a time in the last 10 minutes of a show 100+ minutes long is the old sign-off pick, and may be filled too', () => {
	assert.equal(inSignOff(7_198_000, 7_199_000), true); // 2026-05-28: 119:58 of 119:59
	assert.equal(inSignOff(min(110), min(120)), true);
	assert.equal(inSignOff(min(109, 59), min(120)), false);
	assert.equal(inSignOff(min(99, 27), min(103, 27)), true); // 2025-12-18
	assert.equal(inSignOff(min(95), min(99, 59)), false); // under 100 minutes: no sign-off to tell
	assert.equal(inSignOff(min(119), null), false); // no length: no telling
	assert.equal(inSignOff(null, min(120)), false);
	assert.equal(fillable(7_198_000, null, 7_199_000), true);
	assert.equal(fillable(4_637_000, null, min(120)), false); // 2026-09-24's hand-set 77:17 stays
	assert.equal(fillable(7_198_000), false); // without the show's length, never
});

test('a proposal is the detector on the lines D1 has, with the line it points to', () => {
	const empty = proposeTime(episode('2020-07-16', null), ['Casey Smith'], SHOW);
	assert.equal(empty.proposed, min(61));
	assert.equal(empty.line, "We're back, and we're here with Casey Smith. Good morning, Casey.");
	assert.deepEqual([empty.old, empty.reviewed, empty.reason, empty.date], [null, true, 'proposed', '2020-07-16']);
	const placeholder = proposeTime(episode('2014-09-04', PLACEHOLDER_MS, 0), ['Casey Smith'], SHOW);
	assert.deepEqual([placeholder.old, placeholder.proposed, placeholder.reviewed], [PLACEHOLDER_MS, min(61), false]);
});

test('no proposal: a time already set (reviewed or not), no guests, a short show, nothing after 50 minutes, nothing found, past the end', () => {
	const reason = (ep, guests = ['Casey Smith'], lines = SHOW) => {
		const p = proposeTime(ep, guests, lines);
		assert.equal(p.proposed, null);
		return p.reason;
	};
	assert.equal(reason(episode('2026-09-24', 4_637_000, 1)), 'has a time: kept');
	assert.equal(reason(episode('2026-05-28', min(105), 0)), 'has a time: kept'); // late, but before the sign-off
	assert.equal(reason(episode('2014-01-16', null), []), 'no guests');
	assert.equal(reason(episode('2016-01-07', null, 1, min(45))), 'shorter than 50 minutes');
	assert.equal(reason(episode('2014-05-08', null), ['Casey Smith'], talk(0, 38)), 'no lines after 50 minutes');
	assert.equal(reason(episode('2014-09-04', PLACEHOLDER_MS), ['Amanda Wallace']), 'the detector finds nothing (it would say 60:00 again)');
	assert.match(reason(episode('2020-07-16', null, 1, min(59))), /the detected 61:00 is past the end \(59:00\)/);
});

test('the statements set guest_start_ms only, and only where the time is still the one read', () => {
	const p = { id: id('2020-07-16'), old: null, proposed: 4_824_000 };
	assert.equal(fillStatement(p), `UPDATE episodes SET guest_start_ms = 4824000 WHERE id = '${id('2020-07-16')}' AND guest_start_ms IS NULL;`);
	assert.equal(fillStatement({ ...p, old: PLACEHOLDER_MS }), `UPDATE episodes SET guest_start_ms = 4824000 WHERE id = '${id('2020-07-16')}' AND guest_start_ms = 3600000;`);
	assert.equal(restoreStatement(p), `UPDATE episodes SET guest_start_ms = NULL WHERE id = '${id('2020-07-16')}' AND guest_start_ms = 4824000;`);
	assert.equal(restoreStatement({ ...p, old: PLACEHOLDER_MS }), `UPDATE episodes SET guest_start_ms = 3600000 WHERE id = '${id('2020-07-16')}' AND guest_start_ms = 4824000;`);
	assert.throws(() => fillStatement({ ...p, old: 4_637_000 }), /is not empty, 60:00 or in the sign-off; refusing to change it/);
	assert.throws(() => fillStatement({ ...p, old: 4_637_000, duration_ms: min(120) }), /refusing to change it/);
	assert.equal(fillStatement({ ...p, old: 7_198_000, duration_ms: 7_199_000 }), `UPDATE episodes SET guest_start_ms = 4824000 WHERE id = '${id('2020-07-16')}' AND guest_start_ms = 7198000;`);
	assert.throws(() => fillStatement({ ...p, proposed: 48.5 }), /Not a time in ms/);
	assert.match(fillStatement({ ...p, id: "it's" }), /WHERE id = 'it''s'/);
});

test('on the real schema: only the empty and 60:00 times change; restore.sql puts back what is still as set', () => {
	const db = new DatabaseSync(':memory:');
	db.exec(SCHEMA);
	const rows = [
		['2020-07-16', null, 1], ['2014-09-04', PLACEHOLDER_MS, 1], ['2025-03-13', null, 1], ['2026-09-24', 4_637_000, 1], ['2026-04-30', PLACEHOLDER_MS, 0],
	];
	for (const [date, ms, reviewed] of rows) db.prepare('INSERT INTO episodes (id, title, guest_start_ms, guests_reviewed) VALUES (?, ?, ?, ?)').run(id(date), `Show ${date}!`, ms, reviewed);
	const times = () => Object.fromEntries(db.prepare('SELECT id, guest_start_ms FROM episodes ORDER BY id').all().map((r) => [r.id.slice(15, 25), r.guest_start_ms]));
	const todo = [
		{ id: id('2020-07-16'), old: null, proposed: 4_824_000, reviewed: true },
		{ id: id('2014-09-04'), old: PLACEHOLDER_MS, proposed: 3_300_000, reviewed: true },
		{ id: id('2025-03-13'), old: null, proposed: 4_386_000, reviewed: true },
		// read as empty, but 60:00 again by the time of the write: left alone
		{ id: id('2026-04-30'), old: null, proposed: 5_024_000, reviewed: false },
	];
	const dir = fs.mkdtempSync(path.join(tmp, 'backup-'));
	db.exec(writeBackup(dir, todo));
	assert.deepEqual(times(), { '2014-09-04': 3_300_000, '2020-07-16': 4_824_000, '2025-03-13': 4_386_000, '2026-04-30': PLACEHOLDER_MS, '2026-09-24': 4_637_000 });

	// Set by hand since: restore.sql leaves it
	db.prepare('UPDATE episodes SET guest_start_ms = 4400000 WHERE id = ?').run(id('2025-03-13'));
	db.exec(fs.readFileSync(path.join(dir, 'restore.sql'), 'utf8'));
	assert.deepEqual(times(), { '2014-09-04': PLACEHOLDER_MS, '2020-07-16': null, '2025-03-13': 4_400_000, '2026-04-30': PLACEHOLDER_MS, '2026-09-24': 4_637_000 });
	assert.equal(db.prepare('SELECT COUNT(*) AS n FROM episodes').get().n, 5);
});

test('the backup: the times as read, what was run, how to undo it', () => {
	const dir = fs.mkdtempSync(path.join(tmp, 'backup-'));
	const todo = [{ id: id('2020-07-16'), old: null, proposed: 4_824_000, reviewed: true }, { id: id('2014-09-04'), old: PLACEHOLDER_MS, proposed: 3_300_000, reviewed: false }];
	const applied = writeBackup(dir, todo, { isLocal: false });
	assert.deepEqual(fs.readdirSync(dir).sort(), ['README.txt', 'applied.sql', 'before.json', 'restore.sql']);
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'before.json'), 'utf8')), [
		{ id: id('2020-07-16'), guest_start_ms: null, guests_reviewed: 1 },
		{ id: id('2014-09-04'), guest_start_ms: PLACEHOLDER_MS, guests_reviewed: 0 },
	]);
	assert.equal(fs.readFileSync(path.join(dir, 'applied.sql'), 'utf8'), applied);
	assert.deepEqual(applied.trim().split('\n'), todo.map(fillStatement));
	assert.ok(applied.split('\n').filter(Boolean).every((s) => /^UPDATE episodes SET guest_start_ms = \d+ WHERE id = '[^']+' AND guest_start_ms (IS NULL|= 3600000);$/.test(s)));
	const readme = fs.readFileSync(path.join(dir, 'README.txt'), 'utf8');
	assert.match(readme, /production D1 database/);
	assert.ok(readme.includes(`npx wrangler d1 execute roe-episodes --remote --file "${path.join(dir, 'restore.sql')}"`));
});

test('a joined show\'s 60:00, as the join moved it, is still the placeholder (and only that one)', () => {
	const progress = { episodes: {
		[id('2015-05-14')]: { state: 'published', shift: { ms: 2_066_400, guest_start_ms: [PLACEHOLDER_MS, PLACEHOLDER_MS + 2_066_400], place_quotes: 4 } },
		[id('2016-02-25')]: { state: 'published', shift: { ms: 337_737, guest_start_ms: [3_043_480, 3_381_217], place_quotes: 27 } },
		[id('2020-05-21')]: { state: 'published', shift: { ms: 264_600, guest_start_ms: null, place_quotes: 0 } },
	} };
	const moved = movedPlaceholder(progress, id('2015-05-14'));
	assert.equal(moved, 5_666_400);
	assert.equal(movedPlaceholder(progress, id('2016-02-25')), null); // a real time, moved: kept
	assert.equal(movedPlaceholder(progress, id('2020-05-21')), null);
	assert.equal(movedPlaceholder(null, id('2015-05-14')), null);
	assert.equal(fillable(5_666_400, moved), true);
	assert.equal(fillable(5_666_400), false);
	const p = proposeTime(episode('2015-05-14', 5_666_400, 0), ['Casey Smith'], SHOW, { moved });
	assert.deepEqual([p.proposed, p.moved60], [min(61), moved]);
	assert.equal(fillStatement(p), `UPDATE episodes SET guest_start_ms = ${min(61)} WHERE id = '${id('2015-05-14')}' AND guest_start_ms = 5666400;`);
	assert.match(reportLines([p]).join('\n'), /94:26 \(60:00 moved by the join\) ->\s+61:00/);
	assert.equal(proposeTime(episode('2016-02-25', 3_381_217), ['Casey Smith'], SHOW, { moved: movedPlaceholder(progress, id('2016-02-25')) }).reason, 'has a time: kept');
});

test('--apply takes the saved list as it is, on the database it was made on', () => {
	const saved = { at: '2026-09-28T21:09:44.000Z', database: 'production', proposals: [
		{ id: id('2020-07-16'), old: null, proposed: 4_522_850, reviewed: true },
		{ id: id('2026-09-24'), old: 4_637_000, proposed: null, reason: 'has a time: kept' },
	] };
	assert.equal(savedProposals(saved, { database: 'production' }).length, 2);
	assert.throws(() => savedProposals(saved, { database: 'local' }), /made on the production database, not the local one/);
	assert.throws(() => savedProposals({ rows: [] }, { database: 'production' }), /Not a proposals.json/);
	// An edited list can't sneak in a time that isn't empty or 60:00
	assert.throws(() => fillStatement({ id: id('2026-09-24'), old: 4_637_000, proposed: 4_700_000 }), /refusing to change it/);
});

test('the list for the owner: old -> proposed with the line, then what was left alone and why', () => {
	const out = reportLines([
		proposeTime(episode('2020-07-16', null), ['Casey Smith'], SHOW),
		proposeTime(episode('2026-09-24', 4_637_000), ['Cyrus', 'Kat'], SHOW),
	]).join('\n');
	assert.match(out, /2020-07-16\s+empty ->\s+61:00\s+reviewed\s+Casey Smith\n\s+"We're back, and we're here with Casey Smith\. Good morning, Casey\."/);
	assert.match(out, /Left as they are \(1\):\n\s+2026-09-24\s+77:17\s+has a time: kept/);
});

test('a sign-off time gets the detector\'s time, or 60:00 when it finds nothing; the list says which', () => {
	// 2026-05-28: 119:58, the old detector's pick of the thank-you after the closing song
	const found = proposeTime(episode('2026-05-28', 7_198_000, 0, 7_199_000), ['Casey Smith'], SHOW);
	assert.deepEqual([found.signOff, found.proposed, found.reason], [true, min(61), 'proposed']);
	assert.equal(found.line, "We're back, and we're here with Casey Smith. Good morning, Casey.");
	assert.equal(fillStatement(found), `UPDATE episodes SET guest_start_ms = ${min(61)} WHERE id = '${id('2026-05-28')}' AND guest_start_ms = 7198000;`);
	// The guest is never named: the goodbye is still not the interview
	const nothing = proposeTime(episode('2016-12-29', min(119, 53), 1, min(119, 59)), ['Andrew Chapello'], SHOW);
	assert.deepEqual([nothing.signOff, nothing.proposed, nothing.line], [true, PLACEHOLDER_MS, null]);
	assert.equal(nothing.reason, 'proposed 60:00: the detector finds nothing (it would say 60:00 again)');
	const short = proposeTime(episode('2016-12-29', min(119, 53), 1, min(119, 59)), ['Casey Smith'], talk(0, 40));
	assert.deepEqual([short.proposed, short.reason], [PLACEHOLDER_MS, 'proposed 60:00: no lines after 50 minutes']);
	// An empty or 60:00 time is not a sign-off, and still gets no 60:00
	assert.equal(proposeTime(episode('2014-09-04', PLACEHOLDER_MS, 1, min(120)), ['Amanda Wallace'], SHOW).proposed, null);
	const out = reportLines([found, nothing]).join('\n');
	assert.match(out, /2026-05-28\s+119:58 \(sign-off, of 119:59\) ->\s+61:00\s+not reviewed\s+Casey Smith\n\s+"We're back, and we're here with Casey Smith\. Good morning, Casey\."/);
	assert.match(out, /2016-12-29\s+119:53 \(sign-off, of 119:59\) ->\s+60:00\s+reviewed\s+Andrew Chapello\n\s+\(proposed 60:00: the detector finds nothing \(it would say 60:00 again\)\)/);
});

test('on the real schema: a sign-off time changes, a hand-set one next to it does not', () => {
	const db = new DatabaseSync(':memory:');
	db.exec(SCHEMA);
	for (const [date, ms] of [['2026-05-28', 7_198_000], ['2026-09-24', 4_637_000]]) {
		db.prepare('INSERT INTO episodes (id, title, duration_ms, guest_start_ms, guests_reviewed) VALUES (?, ?, ?, ?, 1)').run(id(date), `Show ${date}`, 7_199_000, ms);
	}
	const p = proposeTime(episode('2026-05-28', 7_198_000, 1, 7_199_000), ['Casey Smith'], SHOW);
	const kept = proposeTime(episode('2026-09-24', 4_637_000, 1, 7_199_000), ['Casey Smith'], SHOW);
	assert.equal(kept.proposed, null);
	db.exec(writeBackup(fs.mkdtempSync(path.join(tmp, 'backup-')), [p]));
	const times = Object.fromEntries(db.prepare('SELECT id, guest_start_ms FROM episodes ORDER BY id').all().map((r) => [r.id.slice(15, 25), r.guest_start_ms]));
	assert.deepEqual(times, { '2026-05-28': min(61), '2026-09-24': 4_637_000 });
});
