// node --test scripts/test/*.test.js
// repair-archive.js: the worklist, each episode's plan and cost, the publish run, the joins' time shift.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roe-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.ROE_PERSIST_TO ??= tmp; // a test run: no keys from .env
const {
	csvFields, parseWorklist, planRow, joinPartNumbers, sitePartNumber, openaiCost, attemptPlan, publishRun,
	shiftStatements, ftsSamples, resolveModel, otherModel, whisperMinutes, stamp,
} = await import('../repair-archive.js');
const { WHISPER_MODELS } = await import('../process-episode.js');

const HEADER = 'date,act,src,file,tags,show_min,patch_min,rev,gs_min,disk,note';
const WORKLIST = [
	HEADER,
	'2014-01-16,W,A,2014-01-16.mp3,H5 LP,122.1,33.7,1,,diff,"holes 90.6-95.7; loops 79.4-90.6 x308 Oh okay.; 95.7-118.2 x390 Oh okay."',
	'2014-02-06,W,A*,2014-02-06 1.mp3,H8,125.0,102.2,1,,=D1,holes 18.0-120.2',
	'2016-01-07,J,J,parts 1+2+3,SPb SE,118.2,53.1,1,57.9,=D1,site has part 2 only (65.1 of 118.2 min)',
	'2020-07-16,T,A,2020-07-16.mp3,SE DD,119.9,74.6,1,,diff,',
	'2025-11-13,O,R,R2 m4a,WL,111.2,4.3,1,110.9,diff,non-Latin 6 lines 0-4.3; site m4a is an edited cut',
	'2026-04-30,L,E,R2 raw mp3,LP,119.2,3.4,0,60.0,none,loops 78.2-79.3 x103 the; 79.8-82.0 x262 the',
	'2026-03-26,M,A,2026-03-26.mp3,DD,119.0,0.0,1,75.5,diff,duration_ms 116.98 -> 118.97 min only',
	'2025-09-11,X,A,2025-09-11.mp3,SE,32.1,27.9,1,,=D1,recording lost after 4:22 (silence); hand-written title',
].join('\n');

test('CSV fields: quoted commas and doubled quotes', () => {
	assert.deepEqual(csvFields('a,"b, c",,"say ""hi"""'), ['a', 'b, c', '', 'say "hi"']);
});

test('the worklist: typed rows with the episode ID, and a bad row stops the run', () => {
	const rows = parseWorklist(WORKLIST + '\n');
	assert.equal(rows.length, 8);
	assert.deepEqual([rows[0].id, rows[0].show_min, rows[0].rev, rows[0].gs_min], ['roll-over-easy_2014-01-16_07-30-00', 122.1, true, null]);
	assert.equal(rows[0].note, 'holes 90.6-95.7; loops 79.4-90.6 x308 Oh okay.; 95.7-118.2 x390 Oh okay.');
	assert.deepEqual([rows[5].rev, rows[5].gs_min], [false, 60]);
	assert.throws(() => parseWorklist(`${HEADER}\n2014-01-16,Z,A,x.mp3`), /act "Z" isn't one of/);
	assert.throws(() => parseWorklist(`${HEADER}\n2014-1-16,W,A,x.mp3`), /the date should be YYYY-MM-DD/);
	assert.throws(() => parseWorklist(`${HEADER}\n2014-01-16,W,Q,x.mp3`), /src "Q" isn't one of/);
	assert.throws(() => parseWorklist('date,act,file\n'), /no "src" column/);
	assert.equal(parseWorklist(`${HEADER},id\n2016-03-24,W,A,2016-03-24.mp3,,,,,,,,roll-over-easy_2016-03-24_07-56-07`)[0].id, 'roll-over-easy_2016-03-24_07-56-07');
});

test('each act and source gets its plan and audio', () => {
	const rows = parseWorklist(WORKLIST);
	const plan = (i) => planRow(rows[i], { archiveDir: '/archive', trialDir: '/trials' });
	assert.deepEqual(plan(0).audio, { kind: 'archive', file: '/archive/Roll Over Easy 2014-01-16.mp3' });
	assert.equal(plan(1).audio.file, '/archive/Roll Over Easy 2014-02-06 1.mp3');
	const join = plan(2);
	assert.equal(join.action, 'join');
	assert.deepEqual(join.audio.parts.map((p) => p.file), [1, 2, 3].map((n) => `/archive/Roll Over Easy 2016-01-07 ${n}.mp3`));
	assert.deepEqual(join.join, { parts: [1, 2, 3], sitePart: 2, partsBefore: [1] });
	const trial = plan(3);
	assert.deepEqual([trial.action, trial.trialFile, trial.audio.file], ['trial', '/trials/roll-over-easy_2020-07-16_07-30-00.json', '/archive/Roll Over Easy 2020-07-16.mp3']);
	assert.deepEqual([plan(4).action, plan(4).audio], ['redo', { kind: 'site-m4a', key: 'roll-over-easy_2025-11-13_07-30-00.m4a' }]);
	assert.deepEqual([plan(5).action, plan(5).audio], ['lines', null]); // lines-only needs no audio, even from R2
	assert.deepEqual([plan(6).action, plan(6).audio], ['duration', null]);
	assert.deepEqual([plan(7).action, plan(7).audio], ['skip', null]);
	assert.deepEqual(planRow({ ...rows[0], src: 'E' }).audio, { kind: 'r2-mp3', key: 'Roll Over Easy 2014-01-16.mp3' });
	assert.throws(() => planRow({ ...rows[0], act: 'J' }), /act J and src J go together/);
	assert.throws(() => planRow({ ...rows[2], note: 'site has part 5 only' }), /the site's part 5 isn't among the parts to join \(1\+2\+3\)/);
	assert.throws(() => planRow({ ...rows[0], file: 'R2 m4a' }), /needs the archive file's name/);
});

test('join parts and the site\'s part come from the worklist\'s words', () => {
	assert.deepEqual(joinPartNumbers('parts 1+5'), [1, 5]);
	assert.throws(() => joinPartNumbers('2014-12-11.mp3'), /should list the parts to join/);
	assert.equal(sitePartNumber('site has part 5 only (102.5 of 108.1 min)'), 5);
	assert.throws(() => sitePartNumber(''), /which part the site has/);
});

test('OpenAI costs $0.006 a minute plus 4% for the gap retries', () => {
	assert.equal(openaiCost(120), 0.75);
	assert.equal(openaiCost(108.1), 0.67);
	assert.equal(openaiCost(0), 0);
});

test('the tries: OpenAI once; whisper.cpp twice (the retry model second), then OpenAI only with the fallback', () => {
	const redo = { action: 'redo' };
	assert.deepEqual(attemptPlan(redo, { engine: 'openai' }), [{ engine: 'openai' }]);
	assert.deepEqual(attemptPlan(redo, { engine: 'whisper.cpp', model: 'turbo.bin' }), [{ engine: 'whisper.cpp', model: 'turbo.bin' }, { engine: 'whisper.cpp', model: 'turbo.bin' }]);
	assert.deepEqual(attemptPlan(redo, { engine: 'whisper.cpp', model: 'turbo.bin', retryModel: 'v3.bin', fallbackOpenai: true }).map((s) => s.model ?? s.engine), ['turbo.bin', 'v3.bin', 'openai']);
	assert.deepEqual(attemptPlan({ action: 'trial' }, { engine: 'openai' }), [{ engine: 'trial' }]);
});

test('models: large-v3-turbo by default, the other one for the second try; the GPU time from the measured speed', () => {
	assert.equal(resolveModel(undefined), WHISPER_MODELS['large-v3-turbo']);
	assert.equal(resolveModel('large-v3'), WHISPER_MODELS['large-v3']);
	assert.equal(resolveModel('/m/ggml-small.bin'), '/m/ggml-small.bin');
	assert.throws(() => resolveModel('small'), /isn't one of large-v3, large-v3-turbo or a \.bin file/);
	assert.equal(otherModel(WHISPER_MODELS['large-v3-turbo']), WHISPER_MODELS['large-v3']);
	assert.equal(otherModel(WHISPER_MODELS['large-v3']), WHISPER_MODELS['large-v3-turbo']);
	assert.equal(otherModel('/m/ggml-small.bin'), '/m/ggml-small.bin');
	const [lo, hi] = whisperMinutes(1000, WHISPER_MODELS['large-v3-turbo']);
	assert.equal(Math.round(lo), 60);
	assert.equal(Math.round(hi), 90);
	assert.equal(Math.round(whisperMinutes(100, WHISPER_MODELS['large-v3'], true)[1]), 260);
	assert.equal(whisperMinutes(100, WHISPER_MODELS['large-v3-turbo'], true), null); // not measured on the CPU
});

test('publishing: a forced seed with summary and interview time left alone; a join also replaces the audio', () => {
	const redo = publishRun({ id: 'e1', action: 'redo' }, '/a.mp3');
	assert.match(redo[0], /scripts\/process-episode\.js$/);
	assert.deepEqual(redo.slice(1), ['/a.mp3', '--episode-id', 'e1', '--skip', 'transcribe,summary,guest-start,upload-audio', '--force', 'seed-db']);
	assert.deepEqual(publishRun({ id: 'e2', action: 'join' }, '/j.mp3', { isLocal: true }).slice(1), ['/j.mp3', '--episode-id', 'e2', '--skip', 'transcribe,summary,guest-start', '--force', 'seed-db,upload-audio', '--local']);
});

test('a join\'s times move once: each update only lands on the value the backup had', () => {
	const before = {
		episodes: [{ id: 'e', guest_start_ms: 3_042_000 }],
		place_mentions: [{ place_id: 7, snippet_start_ms: 600_000 }, { place_id: 9, snippet_start_ms: null }, { place_id: 12, snippet_start_ms: 0 }],
	};
	assert.deepEqual(shiftStatements("it's", before, 337_737), [
		"UPDATE episodes SET guest_start_ms = 3379737 WHERE id = 'it''s' AND guest_start_ms = 3042000;",
		"UPDATE place_mentions SET snippet_start_ms = 937737 WHERE episode_id = 'it''s' AND place_id = 7 AND snippet_start_ms = 600000;",
		"UPDATE place_mentions SET snippet_start_ms = 337737 WHERE episode_id = 'it''s' AND place_id = 12 AND snippet_start_ms = 0;",
	]);
	assert.deepEqual(shiftStatements('e', { episodes: [{ guest_start_ms: null }], place_mentions: [] }, 1000), []);
});

test('keyword-search samples: plain lines spread through the show, their first four words as a phrase', () => {
	const segs = Array.from({ length: 100 }, (_, i) => ({ start_ms: i * 1000, text: i % 2 ? `Café number ${i} is open` : `We're at the Ferry Building, line ${i}` }));
	const picked = ftsSamples(segs, 5);
	assert.equal(picked.length, 5);
	assert.deepEqual(picked[0], { start_ms: 10_000, match: '"we re at the"' });
	assert.ok(picked.every((p) => (p.start_ms / 1000) % 2 === 0)); // "Café" lines are left out
	assert.deepEqual(ftsSamples([{ start_ms: 0, text: 'Hi.' }], 5), []);
	assert.match(stamp(new Date(2026, 8, 27, 22, 41, 3)), /^Sep 27 22:41:03$/);
});
