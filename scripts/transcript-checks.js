/**
 * Checks on transcript lines, shared by the transcript repair tools:
 * repair-archive.js (is a new transcript good enough to replace the live one?),
 * clean-junk-lines.js (which lines in D1 are junk) and scan-transcripts.js
 * (what is wrong with the transcripts on the site). No D1 and no files here.
 *
 * They use the pipelines' own checks: checkCoverage, findGaps (holes of 5+
 * minutes), findLoops, isMostlyNonLatin, isPromptEcho and isBareWebAddress, plus the same echo
 * rule with the terms of the prompt Whisper was sent until 2026-09-27.
 */

import { findLoops, isBareWebAddress, isMostlyNonLatin, isPromptEcho } from '../roe-pipeline/src/clean-segments.js';
import { checkCoverage, MIN_COVERAGE } from '../roe-pipeline/src/coverage.js';
import { findGaps, MIN_GAP_MS } from '../roe-pipeline/src/gap-retry.js';
import { normalizeTerm } from '../roe-pipeline/src/whisper-prompt.js';

// The spelling-hint prompt sent until 2026-09-27 (git show 9af504d^:roe-pipeline/src/transcribe.js).
// Whisper read it back during music on 6 episodes that are still live (16 lines), and
// isPromptEcho only knows today's prompt. Kept here rather than in isPromptEcho: new
// transcripts are made with today's prompt, and these names (Lazy Bear, Toronado,
// Critical Mass…) can come up in a real list on the show.
const OLD_PROMPT = [
	'Roll Over Easy, BFF.fm, Stroll Over Easy,',
	'SoMa, the Tenderloin, Dogpatch, Bernal Heights, Japantown, Visitacion Valley,',
	'Haight-Ashbury, Pac Heights, Noe Valley, Potrero Hill, the Fillmore, Bayview,',
	'the Ferry Building, Golden Gate Park, Sutro Baths, Lands End, McLaren Park,',
	'JFK Promenade, Crosstown Trail, Pier 70, Wave Organ, Transamerica Pyramid,',
	'Conservatory of Flowers, the Botanical Garden, Salesforce Park,',
	'Hamburger Haven, Club Fugazi, Manny\'s, The Lab, Spin City, Parklab,',
	'La Cocina, Bi-Rite, Tartine, Humphry Slocombe, Lazy Bear, Toronado,',
	'Wesburger, The New Wheel, Laughing Monk,',
	'Sequoia, The Early Bird,',
	'Emperor Norton, Herb Caen, Cosmic Amanda, Dr. Guacamole,',
	'Muni Diaries, Noise Pop, Litquake, Litcrawl, KQED, KALW, Hoodline,',
	'Mission Local, SFGate, Tablehopper, Total SF, Bay City Beacon,',
	'BAYCAT, ODC, YBCA, Gray Area, SFMOMA, the Exploratorium,',
	'Sisters of Perpetual Indulgence, Cacophony Society,',
	'Muni, BART, Caltrain, the N-Judah, the F-Market,',
	'Eichler Homes, Compton\'s Cafeteria, Critical Mass, Sketch Fest, Karl the Fog,',
	'NIMBYism, YIMBYism, Dungeness crab, cioppino, dim sum, sourdough,',
].join(' ');

export const OLD_PROMPT_TERMS = new Set(OLD_PROMPT.split(',').map(normalizeTerm).filter(Boolean));

/** isPromptEcho's rule (4+ comma-separated items, 60% of them prompt terms) with the old prompt's terms. */
export function isOldPromptEcho(text) {
	const items = text.split(',').map(normalizeTerm).filter(Boolean);
	if (items.length < 4) return false;
	return items.filter((t) => OLD_PROMPT_TERMS.has(t)).length / items.length >= 0.6;
}

/** A line that reads back today's prompt or the old one. */
export function isAnyPromptEcho(text) {
	return isPromptEcho(text) || isOldPromptEcho(text);
}

/** How many words the lines hold (tokens with a letter or a digit). */
export function countWords(lines) {
	let n = 0;
	for (const l of lines) {
		for (const token of l.text.split(/\s+/)) if (/[\p{L}\p{N}]/u.test(token)) n++;
	}
	return n;
}

export const JUNK_RULES = ['echo', 'loops', 'non-latin', 'urls'];
export const OPENING_MS = 10 * 60_000; // Whisper's wrong-language gibberish is at the start of a show

/**
 * The junk lines in an episode, by rule, in time order:
 * - echo: the spelling-hint prompt read back as speech (today's terms or the old ones)
 * - loops: the repeats in Whisper's repetition loops (findLoops; each looping line keeps its first copy)
 * - non-latin: lines mostly in another script, in the first `openingMs` of the show
 * - urls: lines that are nothing but an http(s):// address, which Whisper invents over silence
 *
 * @param {Array<{start_ms: number, end_ms: number, text: string}>} lines - in time order (D1 rows keep their id)
 * @returns {Array<{line: object, rule: string}>}
 */
export function junkLines(lines, { rules = ['echo', 'loops', 'urls'], openingMs = OPENING_MS } = {}) {
	const unknown = rules.filter((r) => !JUNK_RULES.includes(r));
	if (unknown.length > 0) throw new Error(`No junk rule called ${unknown.join(', ')} (rules: ${JUNK_RULES.join(', ')})`);
	const found = new Map();
	if (rules.includes('echo')) {
		for (const l of lines) if (isAnyPromptEcho(l.text)) found.set(l, 'echo');
	}
	if (rules.includes('urls')) {
		for (const l of lines) if (isBareWebAddress(l.text) && !found.has(l)) found.set(l, 'urls');
	}
	if (rules.includes('non-latin')) {
		for (const l of lines) if (l.start_ms < openingMs && isMostlyNonLatin(l.text) && !found.has(l)) found.set(l, 'non-latin');
	}
	if (rules.includes('loops')) {
		const kept = new Set(findLoops(lines).segments);
		for (const l of lines) if (!kept.has(l) && !found.has(l)) found.set(l, 'loops');
	}
	return lines.filter((l) => found.has(l)).map((line) => ({ line, rule: found.get(line) }));
}

/** The lines that carry the show: no loop repeats, prompt echoes, wrong-language lines (anywhere) or invented addresses. */
export function realLines(lines) {
	const loopFree = findLoops(lines).segments;
	return loopFree.filter((l) => !isAnyPromptEcho(l.text) && !isMostlyNonLatin(l.text) && !isBareWebAddress(l.text));
}

const minutes = (ms) => (ms / 60_000).toFixed(1);
export const SITE_AUDIO_SLACK_MS = 5_000;
// whisper.cpp leaves song lyrics out (its voice detection), where OpenAI and many
// old transcripts have them: a local transcript of a fine show can have fewer words.
// In the engine test it had 86-111% of OpenAI's words for the same stretch.
export const MIN_WORD_SHARE = 0.8;
// The same show? The share of the live transcript's distinctive words (6+ letters,
// said twice or more) the new one has too. The four trial transcripts had 97-99% of
// their own show's; against 84 other shows they had 42-62% (2026-09-27).
export const MIN_SAME_SHOW = 0.7;
const SAME_SHOW_MIN_WORDS = 30; // fewer distinctive words than this: too few to tell

/** The share of the old lines' distinctive words the new ones have (null: too few to tell). */
export function sameShowShare(oldLines, newLines) {
	const counts = new Map();
	for (const l of realLines(oldLines)) for (const w of l.text.toLowerCase().match(/[a-z]{6,}/g) ?? []) counts.set(w, (counts.get(w) ?? 0) + 1);
	const distinctive = [...counts].filter(([, n]) => n >= 2).map(([w]) => w);
	if (distinctive.length < SAME_SHOW_MIN_WORDS) return null;
	const now = new Set(newLines.flatMap((l) => l.text.toLowerCase().match(/[a-z]{6,}/g) ?? []));
	return distinctive.filter((w) => now.has(w)).length / distinctive.length;
}

/**
 * Is a new transcript good enough to replace the one on the site?
 *
 * Refused unless:
 * - it covers its recording (checkCoverage) and Whisper didn't loop;
 * - it has at least `minWordShare` of the old transcript's words (loop repeats,
 *   prompt echoes and wrong-language lines not counted);
 * - its recording is as long as the audio the site plays, within 5 s (else
 *   every time in it would be off);
 * - it has at least `minSameShow` (70%) of the live transcript's distinctive
 *   words (the same show, not another recording of about the same length);
 * - no wrong-language or prompt-echo lines are left in it.
 * Holes of 5+ minutes are noted for review, not refused: whisper.cpp leaves a
 * long song out.
 *
 * @param {{segments: Array, meta: {audio_ms: number, loops?: Array}}} transcript
 * @param {object} against
 * @param {Array} against.oldLines - the episode's lines in D1 now
 * @param {number|null} against.siteAudioMs - the length of the audio the site plays (or will: a joined show's)
 * @returns {{ok: boolean, problems: string[], notes: string[], facts: object}}
 */
export function checkNewTranscript(transcript, { oldLines, siteAudioMs, minWordShare = MIN_WORD_SHARE, minSameShow = MIN_SAME_SHOW }) {
	const segments = transcript.segments ?? [];
	const audioMs = transcript.meta?.audio_ms ?? null;
	const problems = [];
	const notes = [];

	const coverage = checkCoverage(segments, audioMs);
	problems.push(...coverage.problems);

	const loops = [...(transcript.meta?.loops ?? []), ...findLoops(segments).loops];
	for (const l of loops) problems.push(`Whisper looped at ${minutes(l.startMs)}-${minutes(l.endMs)} min (${l.removed} lines of "${l.top.slice(0, 40)}")`);

	const holes = audioMs > 0 ? findGaps(segments, 0, audioMs, MIN_GAP_MS) : [];
	for (const h of holes) notes.push(`a ${minutes(h.endMs - h.startMs)}-minute hole at ${minutes(h.startMs)}-${minutes(h.endMs)} min (a long song? listen to check)`);

	const words = countWords(segments);
	const oldWords = countWords(realLines(oldLines));
	const needed = Math.ceil(oldWords * minWordShare);
	if (words < needed) {
		problems.push(`${words} words, fewer than ${needed} (${Math.round(minWordShare * 100)}% of the ${oldWords} in the live transcript)`);
	}

	const offMs = siteAudioMs > 0 && audioMs > 0 ? Math.abs(audioMs - siteAudioMs) : null;
	if (!(siteAudioMs > 0)) {
		problems.push("the length of the site's audio is unknown");
	} else if (offMs > SITE_AUDIO_SLACK_MS) {
		problems.push(`its recording is ${minutes(audioMs)} min, the site's audio ${minutes(siteAudioMs)} min (${(offMs / 1000).toFixed(1)} s apart): a different recording`);
	}

	const sameShow = sameShowShare(oldLines, segments);
	if (sameShow != null && sameShow < minSameShow) {
		problems.push(`it has only ${Math.round(sameShow * 100)}% of the live transcript's distinctive words: another show?`);
	}

	const junk = segments.filter((s) => isMostlyNonLatin(s.text) || isAnyPromptEcho(s.text)).length;
	if (junk > 0) problems.push(`${junk} wrong-language or prompt-echo line${junk === 1 ? '' : 's'} left in it`);

	return {
		ok: problems.length === 0,
		problems,
		notes,
		facts: {
			lines: segments.length,
			words,
			old_lines: oldLines.length,
			old_words: oldWords,
			end_ms: coverage.endMs,
			audio_ms: audioMs,
			site_audio_ms: siteAudioMs,
			holes: holes.length,
			loops: loops.length,
			same_show: sameShow,
		},
	};
}

/**
 * What is wrong with one episode's transcript on the site. Coverage is measured
 * against `audioMs` (the m4a's real length) when given, else duration_ms.
 *
 * @param {{id: string, duration_ms: number|null}} episode
 * @param {Array<{start_ms, end_ms, text}>} lines - in time order
 * @param {{audioMs?: number|null}} [opts]
 * @returns {Array<{kind: string, detail: string}>} kinds: no-lines, no-duration, wrong-duration,
 *   past-end, stops-early, late-start, hole, end-gap, loops, non-latin, echo
 */
export function scanEpisode(episode, lines, { audioMs = null } = {}) {
	const found = [];
	const add = (kind, detail) => found.push({ kind, detail });
	const reference = audioMs ?? episode.duration_ms;

	if (episode.duration_ms == null) add('no-duration', 'duration_ms is empty');
	else if (audioMs != null && Math.abs(episode.duration_ms - audioMs) > SITE_AUDIO_SLACK_MS) {
		add('wrong-duration', `duration_ms ${minutes(episode.duration_ms)} min, the m4a ${minutes(audioMs)} min`);
	}
	if (lines.length === 0) {
		add('no-lines', 'no transcript lines');
		return found;
	}

	const endMs = lines.reduce((max, l) => Math.max(max, l.end_ms), 0);
	let timesOk = true;
	if (reference > 0) {
		const coverage = checkCoverage(lines, reference);
		if (endMs > reference + 30_000) {
			timesOk = false;
			add('past-end', `lines run to ${minutes(endMs)} min, past the ${minutes(reference)} min audio`);
		} else if (endMs < reference * MIN_COVERAGE) {
			add('stops-early', `stops at ${minutes(endMs)} of ${minutes(reference)} min (${Math.round((100 * endMs) / reference)}%)`);
		}
		if (timesOk) {
			const stopsEarly = !coverage.ok;
			for (const h of coverage.holes) {
				const where = `${minutes(h.startMs)}-${minutes(h.endMs)} min`;
				if (h.startMs === 0) add('late-start', `nothing until ${minutes(h.endMs)} min`);
				else if (h.endMs >= reference) { if (!stopsEarly) add('end-gap', `nothing after ${minutes(h.startMs)} min (${minutes(h.endMs - h.startMs)} min)`); }
				else add('hole', `${where} (${minutes(h.endMs - h.startMs)} min)`);
			}
		}
	}

	for (const l of findLoops(lines).loops) add('loops', `${minutes(l.startMs)}-${minutes(l.endMs)} min ×${l.removed} "${l.top.slice(0, 40)}"`);

	const nonLatin = lines.filter((l) => isMostlyNonLatin(l.text));
	if (nonLatin.length > 0) add('non-latin', `${nonLatin.length} line${nonLatin.length === 1 ? '' : 's'} at ${minutes(nonLatin[0].start_ms)}-${minutes(nonLatin.at(-1).end_ms)} min`);

	const echoes = lines.filter((l) => isAnyPromptEcho(l.text));
	if (echoes.length > 0) {
		const which = echoes.every((l) => !isPromptEcho(l.text)) ? 'the old prompt' : 'the prompt';
		add('echo', `${echoes.length} line${echoes.length === 1 ? '' : 's'} reading back ${which}, at ${echoes.map((l) => minutes(l.start_ms)).join(', ')} min${echoes[0].id != null ? ` (ids ${echoes.map((l) => l.id).join(', ')})` : ''}`);
	}
	return found;
}
