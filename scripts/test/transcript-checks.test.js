// node --test scripts/test/*.test.js
// transcript-checks.js: junk lines, the new-transcript check and the scan, on made-up lines.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roe-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.ROE_PERSIST_TO ??= tmp; // a test run: no keys from .env
const { OLD_PROMPT_TERMS, isOldPromptEcho, isAnyPromptEcho, countWords, junkLines, realLines, checkNewTranscript, scanEpisode, sameShowShare } = await import('../transcript-checks.js');

const MIN = 60_000;
// A line every 4 s from `fromMs` to `toMs`, each with different words
const talk = (fromMs, toMs, words = 'we talked about the fog and the ferry') => {
	const out = [];
	for (let t = fromMs, i = 0; t < toMs; t += 4000, i++) out.push({ id: 1000 + out.length, start_ms: t, end_ms: t + 3500, text: `${words} ${i}` });
	return out;
};

test('the old prompt: 85 terms; its read-backs are echoes, a real list of three is not', () => {
	assert.equal(OLD_PROMPT_TERMS.size, 85);
	// Lines from 2026-06-04 and 2026-04-02 in D1 (today's isPromptEcho misses both)
	assert.ok(isOldPromptEcho('The New Wheel, Lazy Bear, Tartine, Humphry Slocombe, Lazy Bear, Toronado, Wesburger,'));
	assert.ok(isOldPromptEcho('The Early Bird, Tartine, Humphry Slocombe, Lazy Bear, Total SF, Bay City Beacon, BAYCAT, ODC, YBCA, Gray Area,'));
	assert.ok(isAnyPromptEcho('BFF.FM, Cole, Early Bird, Sequoia')); // today's terms
	assert.ok(!isAnyPromptEcho('We went to Tartine, Bi-Rite and Lazy Bear.'));
	assert.ok(!isAnyPromptEcho('Sketch Fest, Critical Mass, and then a long story about my bike that has nothing to do with it, really, at all'));
});

test('junk lines by rule: echoes, loop repeats (first copy kept), non-Latin lines in the opening only, bare https:// addresses', () => {
	const lines = [
		{ id: 1, start_ms: 0, end_ms: 3000, text: 'ආයුබෝවන් සුභ උදෑසනක්' },
		...talk(4000, 20 * MIN),
		{ id: 2, start_ms: 20 * MIN, end_ms: 20 * MIN + 3000, text: 'The New Wheel, Lazy Bear, Tartine, Humphry Slocombe, Lazy Bear, Toronado, Wesburger,' },
		...Array.from({ length: 80 }, (_, i) => ({ id: 3 + i, start_ms: 21 * MIN + i * 1000, end_ms: 21 * MIN + i * 1000 + 900, text: 'the' })),
		{ id: 99, start_ms: 40 * MIN, end_ms: 40 * MIN + 3000, text: 'ආයුබෝවන් සුභ උදෑසනක්' }, // past the opening
		{ id: 100, start_ms: 72 * MIN, end_ms: 72 * MIN + 30_000, text: 'https://www.youtube.com.com' }, // 2026-10-01
		{ id: 101, start_ms: 73 * MIN, end_ms: 73 * MIN + 2000, text: 'www.rollovereasy.org.' }, // said on air
	];
	const found = (rules) => junkLines(lines, { rules }).map(({ line, rule }) => `${line.id}:${rule}`);
	assert.deepEqual(found(['echo']), ['2:echo']);
	const loops = found(['loops']);
	assert.equal(loops.length, 79); // "the" x80: the repeats go, the first copy stays
	assert.ok(!loops.includes('3:loops') && loops.includes('4:loops'));
	assert.deepEqual(found(['non-latin']), ['1:non-latin']);
	assert.deepEqual(found(['urls']), ['100:urls']);
	assert.deepEqual(junkLines(lines).map(({ line, rule }) => `${line.id}:${rule}`).filter((x) => !x.endsWith(':loops')), ['2:echo', '100:urls']);
	assert.throws(() => junkLines(lines, { rules: ['echoes'] }), /No junk rule called echoes/);
	assert.equal(countWords([{ text: 'Hello, world — 7:30 !' }]), 3);
	assert.equal(realLines(lines).length, lines.length - 1 - 79 - 2 - 1);
});

const transcript = (segments, audioMs, loops = []) => ({ segments, meta: { audio_ms: audioMs, loops } });

test('a complete new transcript with more words, on the site\'s audio, passes', () => {
	const old = [...talk(0, 40 * MIN), ...Array.from({ length: 300 }, (_, i) => ({ start_ms: 40 * MIN + i * 1000, end_ms: 40 * MIN + i * 1000 + 900, text: 'Oh okay.' }))];
	const fresh = transcript(talk(0, 119.5 * MIN, 'a whole new line of talk'), 120 * MIN);
	const r = checkNewTranscript(fresh, { oldLines: old, siteAudioMs: 120 * MIN + 3000 });
	assert.deepEqual(r.problems, []);
	assert.ok(r.ok);
	assert.equal(r.facts.old_words, countWords(talk(0, 40 * MIN)) + 2); // the loop's repeats aren't counted; its first "Oh okay." is
});

test('each check can fail it: coverage, loops, words, another recording, junk left in; a hole is only noted', () => {
	const old = talk(0, 119 * MIN);
	const good = talk(0, 119.5 * MIN);
	const problems = (t, extra = {}) => checkNewTranscript(t, { oldLines: old, siteAudioMs: 120 * MIN, ...extra }).problems.join(' | ');
	assert.match(problems(transcript(talk(0, 100 * MIN), 120 * MIN)), /stops at 100\.0 min/);
	assert.match(problems(transcript(good, 120 * MIN, [{ startMs: 60 * MIN, endMs: 62 * MIN, removed: 55, top: 'Yeah.' }])), /Whisper looped at 60\.0-62\.0 min \(55 lines of "Yeah\."\)/);
	// A long song whisper.cpp left out: noted for review, and 94% of the old words is enough
	const holed = checkNewTranscript(transcript([...talk(0, 50 * MIN), ...talk(57 * MIN, 119.5 * MIN)], 120 * MIN), { oldLines: old, siteAudioMs: 120 * MIN });
	assert.ok(holed.ok, holed.problems.join('; '));
	assert.match(holed.notes[0], /a 7\.0-minute hole at 50\.0-57\.0 min \(a long song\? listen to check\)/);
	const thin = transcript(good.map((s, i) => ({ ...s, text: `short ${i}` })), 120 * MIN); // 2 words a line, the old 9
	assert.match(problems(thin), /words, fewer than \d+ \(80% of the \d+ in the live transcript\)/);
	assert.equal(problems(thin, { minWordShare: 0.2 }), '');
	const fewer = transcript(good.map((s, i) => ({ ...s, text: `we talked about the fog and ${i}` })), 120 * MIN); // 7 words a line, the old 9: 78%
	assert.match(problems(fewer), /fewer than/);
	assert.equal(problems(fewer, { minWordShare: 0.75 }), '');
	assert.match(problems(transcript(good, 120 * MIN), { siteAudioMs: 113 * MIN }), /the site's audio 113\.0 min .*a different recording/);
	assert.match(problems(transcript(good, 120 * MIN), { siteAudioMs: null }), /length of the site's audio is unknown/);
	assert.match(problems(transcript([...good, { start_ms: 119.6 * MIN, end_ms: 119.7 * MIN, text: 'ආයුබෝවන් සුභ උදෑසනක්' }], 120 * MIN)), /1 wrong-language or prompt-echo line left/);
});

test('the same show: most of the live transcript\'s distinctive words, or refused', () => {
	const vocab = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}word`);
	const said = (words, fromMs) => words.flatMap((w, i) => [0, 1].map((k) => ({ start_ms: fromMs + (2 * i + k) * 4000, end_ms: fromMs + (2 * i + k) * 4000 + 3000, text: `we said ${w} again ${i}` })));
	const show = vocab('ferry', 40);
	const other = vocab('bakery', 40);
	assert.equal(sameShowShare(said(show, 0), said(show, 0)), 1);
	assert.equal(sameShowShare(said(show, 0), said([...show.slice(0, 20), ...other.slice(0, 20)], 0)), 0.5);
	assert.equal(sameShowShare(said(show.slice(0, 10), 0), said(other, 0)), null); // too few words to tell
	const old = [...said(show, 0), ...talk(10 * MIN, 119 * MIN)];
	const wrong = [...said(other, 0), ...talk(10 * MIN, 119.5 * MIN, 'a whole new line of talk')];
	const r = checkNewTranscript(transcript(wrong, 120 * MIN), { oldLines: old, siteAudioMs: 120 * MIN });
	assert.match(r.problems.join(' | '), /only 0% of the live transcript's distinctive words: another show\?/);
	assert.ok(checkNewTranscript(transcript([...said(show, 0), ...talk(10 * MIN, 119.5 * MIN)], 120 * MIN), { oldLines: old, siteAudioMs: 120 * MIN }).ok);
});

test('the scan names what is wrong with an episode on the site', () => {
	const kinds = (episode, lines, opts) => scanEpisode(episode, lines, opts).map((f) => f.kind);
	const ep = { id: 'e', duration_ms: 120 * MIN };
	assert.deepEqual(kinds(ep, talk(0, 119.5 * MIN)), []);
	assert.deepEqual(kinds(ep, talk(0, 80 * MIN)), ['stops-early']);
	assert.deepEqual(kinds(ep, talk(0, 400 * MIN)), ['past-end']);
	assert.deepEqual(kinds(ep, [...talk(9 * MIN, 50 * MIN), ...talk(60 * MIN, 113 * MIN)]), ['late-start', 'hole', 'end-gap']);
	assert.deepEqual(kinds({ ...ep, duration_ms: null }, talk(0, 119.5 * MIN)), ['no-duration']);
	assert.deepEqual(kinds({ ...ep, duration_ms: 117 * MIN }, talk(0, 119.5 * MIN), { audioMs: 120 * MIN }), ['wrong-duration']);
	assert.deepEqual(kinds(ep, []), ['no-lines']);
	const echo = scanEpisode(ep, [...talk(0, 119.5 * MIN), { id: 7, start_ms: 60 * MIN, end_ms: 60 * MIN + 1000, text: 'The New Wheel, Lazy Bear, Total SF, Bay City Beacon, BAYCAT, YBCA, Gray Area, SFMOMA, the' }]);
	assert.deepEqual(echo.map((f) => f.kind), ['echo']);
	assert.match(echo[0].detail, /1 line reading back the old prompt, at 60\.0 min \(ids 7\)/);
});
