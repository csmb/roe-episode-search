/**
 * Clean Whisper transcription artifacts from segments.
 * Removes: zero-duration, consecutive duplicates, internal loops, hallucinations,
 * wrong-language lines and read-back spelling hints.
 */

import { PROMPT_TERMS, normalizeTerm } from './whisper-prompt.js';

/**
 * True when most of the letters are outside the Latin alphabet. Whisper returns
 * gibberish in another script (Sinhala, seen on 9 episodes) when it guesses the
 * wrong language, e.g. from a chunk that starts on music. Accented Latin
 * ("Café") is fine.
 */
export function isMostlyNonLatin(text) {
  const letters = text.match(/\p{L}/gu) || [];
  if (letters.length < 3) return false;
  const latin = text.match(/\p{Script=Latin}/gu) || [];
  return latin.length / letters.length < 0.5;
}

/**
 * True when a line is mostly the spelling-hint prompt read back as speech
 * ("Tartine, Humphry Slocombe, Lazy Bear, …"), which Whisper does during music.
 */
export function isPromptEcho(text) {
  const items = text.split(',').map(normalizeTerm).filter(Boolean);
  if (items.length < 4) return false;
  const hits = items.filter(t => PROMPT_TERMS.has(t)).length;
  return hits / items.length >= 0.6;
}

// Names Whisper consistently mishears. Keys are lowercase and match whole words
// (a phrase too); replacements are case-sensitive. Both pipelines apply these
// (the scripts through lib.js), and scripts/fix-spellings.js applies them to the
// lines D1 already has. The owner's corrections of 2026-09-30: it's "Suldrew"
// and "Bay to Breakers" ("sold Drew" is left out: it is also real speech).
export const WORD_CORRECTIONS = {
  soldier: 'Suldrew',
  soldrew: 'Suldrew',
  'soul drew': 'Suldrew',
  'sol drew': 'Suldrew',
  soldru: 'Suldrew',
  'beta breakers': 'Bay to Breakers',
  'beta breaker': 'Bay to Breakers',
  'beta-breakers': 'Bay to Breakers',
};

// Corrections that need more than whole words. "soldier" is Suldrew, the
// listener, except in "Toy Soldier" (a coffee shop) and "Soldier Boy" (a
// rapper): the owner, 2026-09-30, "it's mainly just to capture when we talk
// about him, the individual, not businesses or whatnot".
const CORRECTION_PATTERNS = {
  soldier: '(?<!\\btoy\\s)\\bsoldier\\b(?!\\s+boys?\\b)',
};

/** Where a correction applies in a text: its key as whole words, or its own pattern. */
export const correctionPattern = (key) => new RegExp(CORRECTION_PATTERNS[key] ?? `\\b${key}\\b`, 'gi');

export function applyWordCorrections(text) {
  for (const [wrong, right] of Object.entries(WORD_CORRECTIONS)) {
    text = text.replace(correctionPattern(wrong), right);
  }
  return text;
}

export function cleanSegments(segments) {
  // Build hallucination frequency map from original segments before any dedup.
  // This catches short phrases that Whisper repeated many times consecutively.
  const origFreq = new Map();
  for (const seg of segments) {
    const words = seg.text.trim().split(/\s+/);
    if (words.length <= 3) {
      const key = seg.text.trim().toLowerCase();
      origFreq.set(key, (origFreq.get(key) || 0) + 1);
    }
  }
  const origThreshold = Math.max(10, Math.floor(segments.length * 0.02));
  const hallucinated = new Set();
  for (const [text, count] of origFreq) {
    if (count > origThreshold) hallucinated.add(text);
  }

  const cleaned = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];

    // Drop zero-duration segments
    if (seg.start_ms === seg.end_ms) continue;

    // Drop consecutive duplicates
    if (cleaned.length > 0 && seg.text === cleaned[cleaned.length - 1].text) continue;

    // Drop segments with internal phrase looping
    if (hasInternalLoop(seg.text)) continue;

    // Drop hallucinated short phrases
    if (hallucinated.has(seg.text.trim().toLowerCase())) continue;

    // Drop wrong-language gibberish and read-back spelling hints
    if (isMostlyNonLatin(seg.text) || isPromptEcho(seg.text)) continue;

    cleaned.push(seg);
  }

  // Fix common Whisper mishearings of host name "Early Bird"
  for (const seg of cleaned) {
    seg.text = seg.text.replace(
      /\b(nearly|yearly|really|eerily|dearly)\s+(bird|beard)\b/gi,
      'Early Bird'
    );
  }

  return cleaned;
}

/**
 * Drop every copy of a line longer than 20 characters that appears more than 20
 * times: a lyric or phrase Whisper got stuck on across the show. This used to
 * run in D1 after seeding; running it here means the database, search and the
 * summary all see the same lines.
 */
export function dropRepeatedLines(segments) {
  const counts = new Map();
  for (const seg of segments) counts.set(seg.text, (counts.get(seg.text) || 0) + 1);
  const looped = new Set([...counts].filter(([text, n]) => n > 20 && text.length > 20).map(([text]) => text));
  if (looped.size === 0) return segments;
  const kept = segments.filter(seg => !looped.has(seg.text));
  console.log(`  Dropped ${segments.length - kept.length} repeated lines (${looped.size} phrase(s))`);
  return kept;
}

const LOOP_RECENT_MS = 5 * 60_000; // a line heard again this soon is a repeat
const LOOP_LINES = 20;             // judged 20 lines at a time
const LOOP_SHARE = 0.5;            // half of them repeats: a loop, not a conversation
const LOOP_MIN_REPEATS = 50;       // fewer is a chorus or a quick back-and-forth; left alone
const LOOP_SILENCE_MS = 60_000;    // a minute with no lines ends a stretch

const loopKey = text => text.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();

/**
 * Find Whisper's repetition loops ("Something to wear." 2,236 times, or two or
 * three lines taking turns) and drop the repeats, keeping each line's first copy.
 *
 * A line is a repeat when the same words were heard in the last five minutes.
 * A stretch where half or more of every 20 lines are repeats, with 50+ repeats
 * in all, is a loop. Normal talk never gets that dense: a show's "yeah"s and
 * "you know"s stay well under it. A song's chorus, or a quick "Yep." / "Nope."
 * exchange, can be as dense but stays under 50 (the loops in the archive have
 * 55 to 4,469), so those lines are all kept.
 *
 * @param {Array<{start_ms: number, end_ms: number, text: string}>} segments - in time order
 * @returns {{segments: Array, loops: Array<{startMs: number, endMs: number, removed: number, top: string}>}}
 *   the kept lines, and each loop's stretch (to transcribe again), with its most repeated line
 */
export function findLoops(segments) {
  const n = segments.length;
  const keys = segments.map(seg => loopKey(seg.text));
  const repeat = new Array(n).fill(false);
  const lastHeard = new Map();
  segments.forEach((seg, i) => {
    if (!keys[i]) return;
    const prev = lastHeard.get(keys[i]);
    if (prev !== undefined && seg.start_ms - prev <= LOOP_RECENT_MS) repeat[i] = true;
    lastHeard.set(keys[i], seg.start_ms);
  });

  // Every window of LOOP_LINES lines that is at least half repeats is in a loop
  const inLoop = new Array(n).fill(false);
  let repeats = 0;
  for (let i = 0; i < n; i++) {
    if (repeat[i]) repeats++;
    if (i >= LOOP_LINES && repeat[i - LOOP_LINES]) repeats--;
    if (i >= LOOP_LINES - 1 && repeats >= LOOP_LINES * LOOP_SHARE) inLoop.fill(true, i - LOOP_LINES + 1, i + 1);
  }

  // Each run of lines in a loop, with the repeats it holds
  const stretches = [];
  for (let i = 0; i < n; i++) {
    if (!inLoop[i]) continue;
    const silence = i > 0 && segments[i].start_ms - segments[i - 1].end_ms > LOOP_SILENCE_MS;
    if (!inLoop[i - 1] || silence) stretches.push({ from: i, repeats: [] });
    if (repeat[i]) stretches.at(-1).repeats.push(i);
  }

  const drop = new Set();
  const loops = [];
  for (const { from, repeats } of stretches) {
    if (repeats.length < LOOP_MIN_REPEATS) continue;
    const counts = new Map();
    for (const i of repeats) {
      drop.add(i);
      counts.set(segments[i].text, (counts.get(segments[i].text) || 0) + 1);
    }
    // The loop starts at the first copy of the line that repeats first
    let first = repeats[0];
    for (let j = from; j < repeats[0]; j++) if (keys[j] === keys[repeats[0]]) { first = j; break; }
    let endMs = 0;
    for (const i of repeats) endMs = Math.max(endMs, segments[i].end_ms);
    loops.push({
      startMs: segments[first].start_ms,
      endMs,
      removed: repeats.length,
      top: [...counts].sort((a, b) => b[1] - a[1])[0][0],
    });
  }
  return { segments: segments.filter((_, i) => !drop.has(i)), loops };
}

/**
 * Detect internal looping: a phrase of 3-8 words repeating 4+ times consecutively.
 */
function hasInternalLoop(text) {
  const words = text.toLowerCase().split(/\s+/);
  if (words.length < 12) return false;

  for (let phraseLen = 3; phraseLen <= 8 && phraseLen <= words.length / 4; phraseLen++) {
    for (let start = 0; start <= words.length - phraseLen * 4; start++) {
      const phrase = words.slice(start, start + phraseLen).join(' ');
      let repeats = 1;
      let pos = start + phraseLen;
      while (pos + phraseLen <= words.length) {
        const next = words.slice(pos, pos + phraseLen).join(' ');
        if (next === phrase) {
          repeats++;
          pos += phraseLen;
        } else {
          break;
        }
      }
      if (repeats >= 4) return true;
    }
  }

  return false;
}
