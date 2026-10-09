// node --test scripts/test/*.test.js
// repair-missing-m4a.js: where an episode's MP3 is, and the audio_file change it makes and undoes
// (run on the real schema in SQLite).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roe-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.ROE_PERSIST_TO ??= tmp; // a test run: no keys from .env
const { recordedMp3Key, audioFileUpdate, audioFileRestore } = await import('../repair-missing-m4a.js');
const { R2_PUBLIC_URL } = await import('../lib.js');

const SCHEMA = fs.readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8');
const EP = 'roll-over-easy_2026-10-01_07-30-00';
const MP3 = `${R2_PUBLIC_URL}/Roll%20Over%20Easy%202026-10-01.mp3`;
const M4A = `${R2_PUBLIC_URL}/${EP}.m4a`;

test('the MP3 an episode records is found in the bucket by its key', () => {
	assert.equal(recordedMp3Key(MP3), 'Roll Over Easy 2026-10-01.mp3');
	assert.equal(recordedMp3Key(`${R2_PUBLIC_URL}/joined/Roll%20Over%20Easy%202026-10-01.MP3`), 'joined/Roll Over Easy 2026-10-01.MP3');
	assert.equal(recordedMp3Key(M4A), null);
	assert.equal(recordedMp3Key('https://elsewhere.example/a.mp3'), null);
	assert.equal(recordedMp3Key(null), null);
});

test('audio_file changes only where it is still the value read, and restore.sql puts it back', () => {
	const db = new DatabaseSync(':memory:');
	db.exec(SCHEMA);
	const add = db.prepare('INSERT INTO episodes (id, title, audio_file) VALUES (?, ?, ?)');
	add.run(EP, 'Show', MP3);
	add.run('roll-over-easy_2026-10-08_07-30-00', 'Other', null);
	add.run("o'brien", 'Quote', 'x');
	const audio = (id) => db.prepare('SELECT audio_file FROM episodes WHERE id = ?').get(id).audio_file;

	const job = { id: EP, audio_file: MP3 };
	db.exec(audioFileUpdate(job));
	assert.equal(audio(EP), M4A);
	db.exec(audioFileRestore(job));
	assert.equal(audio(EP), MP3);

	// Changed by something else since it was read: left alone, both ways
	db.prepare('UPDATE episodes SET audio_file = ? WHERE id = ?').run('edited', EP);
	db.exec(audioFileUpdate(job));
	db.exec(audioFileRestore(job));
	assert.equal(audio(EP), 'edited');

	// A null audio_file is matched as null, and ids are quoted safely
	db.exec(audioFileUpdate({ id: 'roll-over-easy_2026-10-08_07-30-00', audio_file: null }));
	assert.equal(audio('roll-over-easy_2026-10-08_07-30-00'), `${R2_PUBLIC_URL}/roll-over-easy_2026-10-08_07-30-00.m4a`);
	assert.match(audioFileUpdate({ id: "o'brien", audio_file: 'x' }), /WHERE id = 'o''brien' AND audio_file IS 'x';$/);
});
