// node --test scripts/test/*.test.js
// prune-place-links.js: which map links the pipeline's own check says their show never names, and
// the SQL that removes them (run on the real schema in SQLite), with its undo.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roe-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.ROE_PERSIST_TO ??= tmp; // a test run: no keys from .env
const { linksToPrune, backupQueries, pruneSQL } = await import('../prune-place-links.js');

const SCHEMA = fs.readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8');
const A = 'roll-over-easy_2026-10-08_07-30-00';
const B = 'roll-over-easy_2014-03-06_07-30-00';
const line = (ms, text) => ({ start_ms: ms, end_ms: ms + 2000, text });

test('linksToPrune lists links whose show never names the place, with the line the old check matched', () => {
	const lines = new Map([
		[A, [line(0, 'I love San Francisco, and I love the Golden Gate Bridge'), line(5000, 'then a picnic in Dolores this morning')]],
		[B, [line(0, 'Meet me at 24th and Mission.')]],
	]);
	const links = [
		{ place_id: 1, name: 'Golden Gate Park', episode_id: A },
		{ place_id: 2, name: 'Dolores Park', episode_id: A },
		{ place_id: 3, name: '24th Street & Mission Street', episode_id: B },
		{ place_id: 4, name: 'Coit Tower', episode_id: B },
	];
	const out = linksToPrune(links, lines);
	assert.deepEqual(out.map((l) => [l.place_id, l.episode_id]), [[1, A], [4, B]]);
	assert.equal(out[0].hint, 'I love San Francisco, and I love the Golden Gate Bridge');
	assert.equal(out[0].hint_ms, 0);
	assert.equal(out[1].hint, null);
});

test('linksToPrune keeps a link whose stored quote names the place, though the repaired lines spell it otherwise', () => {
	const lines = new Map([[B, [line(0, 'as is the hate'), line(5000, 'over on Potrero')]]]);
	const links = [
		{ place_id: 5, name: 'Haight', episode_id: B, snippet: 'as is the Haight.' },
		{ place_id: 6, name: 'Market Street', episode_id: B, snippet: "It's just stuff taken out of context or maybe not." },
	];
	assert.deepEqual(linksToPrune(links, lines).map((l) => l.place_id), [6]);
});

test('linksToPrune leaves alone a link whose show has no lines to check', () => {
	assert.deepEqual(linksToPrune([{ place_id: 1, name: 'Coit Tower', episode_id: A }], new Map([[A, []]])), []);
});

function database() {
	const d = new DatabaseSync(':memory:');
	d.exec('PRAGMA foreign_keys = ON');
	d.exec(SCHEMA);
	d.exec(`
		INSERT INTO episodes (id, title) VALUES ('${A}', 'A'), ('${B}', 'B');
		INSERT INTO places (id, name, lat, lng) VALUES (1, 'Golden Gate Park', 37.77, -122.48), (2, 'Coit Tower', 37.80, -122.41), (3, 'Market Street', 37.79, -122.40);
		INSERT INTO place_mentions (place_id, episode_id, sentiment, sentiment_label, snippet, snippet_start_ms, analyzed_at) VALUES
			(1, '${A}', 0.8, 'positive', 'I love the Golden Gate Bridge', 5268590, '2026-10-08T19:40:00Z'),
			(2, '${A}', NULL, 'unknown', NULL, NULL, '2026-05-18T00:00:00Z'),
			(2, '${B}', 0.5, 'positive', 'Coit Tower at sunset', 1000, '2026-05-18T00:00:00Z'),
			(3, '${B}', NULL, 'unknown', NULL, NULL, NULL);
		INSERT INTO place_narratives (place_id, early_text, recent_text, arc_text, episode_count, year_min, year_max, generated_at) VALUES
			(1, 'e', 'r', 'a', 1, 2026, 2026, '2026-10-08'), (2, 'e2', 'r2', 'a2', 2, 2014, 2026, '2026-05-19');`);
	return d;
}
const dump = (d) => Object.fromEntries(['places', 'place_mentions', 'place_narratives']
	.map((t) => [t, d.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all().map((r) => ({ ...r }))]));
const rowsFor = (d, entries) => {
	const q = backupQueries(entries);
	const read = (list) => list.flatMap((sql) => d.prepare(sql).all().map((r) => ({ ...r })));
	return { place_mentions: read(q.place_mentions), places: read(q.places), place_narratives: read(q.place_narratives) };
};

test('pruneSQL removes exactly the listed links, then a place left with none and its narrative; the undo puts it all back', () => {
	const d = database();
	const before = dump(d);
	const entries = [{ place_id: 1, name: 'Golden Gate Park', episode_id: A }, { place_id: 2, name: 'Coit Tower', episode_id: A }];
	const { applied, undo, removed } = pruneSQL(entries, rowsFor(d, entries));
	assert.equal(removed.length, 2);
	d.exec(applied);
	const after = dump(d);
	assert.deepEqual(after.places.map((p) => p.name), ['Coit Tower', 'Market Street']); // Golden Gate Park had no other link
	assert.deepEqual(after.place_mentions.map((m) => [m.place_id, m.episode_id]), [[2, B], [3, B]]);
	assert.deepEqual(after.place_narratives.map((n) => n.place_id), [2]); // Coit Tower keeps its narrative
	d.exec(undo);
	assert.deepEqual(dump(d), before);
});

test('pruneSQL leaves a link alone when its place was renamed since the plan', () => {
	const d = database();
	const entries = [{ place_id: 1, name: 'Golden Gate Park', episode_id: A }];
	const { applied } = pruneSQL(entries, rowsFor(d, entries));
	d.exec("UPDATE places SET name = 'Golden Gate Park (west)' WHERE id = 1");
	d.exec(applied);
	assert.equal(d.prepare('SELECT COUNT(*) AS n FROM place_mentions WHERE place_id = 1').get().n, 1);
});

test('pruneSQL refuses an entry that is not a plain place id and episode id', () => {
	assert.throws(() => pruneSQL([{ place_id: '1; DROP TABLE places', name: 'x', episode_id: A }], { place_mentions: [], places: [], place_narratives: [] }), /bad entry/);
	assert.throws(() => pruneSQL([{ place_id: 1, name: 'x', episode_id: "a'; --" }], { place_mentions: [], places: [], place_narratives: [] }), /bad entry/);
});
