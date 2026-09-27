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
