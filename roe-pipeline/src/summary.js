/**
 * Generate episode title, summary, and guest list via GPT-4o-mini.
 * Nothing is written here: the seed-db step writes the result together with
 * the transcript, so an episode never appears on the site half-made.
 */

import { PROMPT_TERMS, normalizeTerm } from './whisper-prompt.js';
import { isHost } from './hosts.js';
import { apiError, TIMEOUT_MS } from './limits.js';

// Below either line the transcript is too thin to summarize honestly: GPT fills
// the gaps with invented weather and guests (1/1/2015 has one transcript line
// and a full summary). A healthy 2-hour show has ~2,000 segments.
export const THIN_MIN_SEGMENTS = 200;
export const THIN_MIN_COVERAGE = 0.3; // last transcript line / audio length

export function isThinTranscript(segments, durationMs) {
  if (segments.length < THIN_MIN_SEGMENTS) return true;
  if (!durationMs) return false;
  const lastEndMs = segments.reduce((max, s) => Math.max(max, s.end_ms), 0);
  return lastEndMs < THIN_MIN_COVERAGE * durationMs;
}

/** Plain title for an episode we won't summarize, e.g. "Roll Over Easy · October 1, 2026". */
export function neutralTitle(episodeId) {
  const m = episodeId.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return 'Roll Over Easy';
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  return 'Roll Over Easy · ' + date.toLocaleDateString('en-US', {
    timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric',
  });
}

const NAME_STOPWORDS = new Set(['the', 'and', 'from', 'with', 'of', 'dr', 'mr', 'mrs', 'ms']);
const WORD_SPLIT = /[^\p{L}\p{N}'’-]+/u;

// Edit distance, giving up early once it is over `max`.
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Keep only guests whose name has some support in the transcript, so a name GPT
 * made up can't reach the guest list or "Skip to interview". A guest is kept when:
 * - any name part of 3+ letters appears as a word, or
 * - a part of 5+ letters is a near-miss (1 edit; 2 edits at 7+ letters) of a
 *   capitalized word, since Whisper and GPT often spell names differently, or
 * - it is a regular from the spelling hints (e.g. Suldrew), or
 * - it has no part of 3+ letters ("DK", "2K"), which can't be checked.
 * Measured on 703 reviewed guests with local transcripts: 1 would be dropped.
 */
export function guestsInTranscript(guests, transcriptText) {
  const words = new Set(), capitalized = new Set();
  for (const tok of transcriptText.split(WORD_SPLIT)) {
    if (!tok) continue;
    const lower = tok.toLowerCase();
    words.add(lower);
    if (/^\p{Lu}/u.test(tok)) capitalized.add(lower);
  }
  return guests.filter(g => {
    if (typeof g !== 'string') return false;
    if (PROMPT_TERMS.has(normalizeTerm(g))) return true;
    const parts = g.toLowerCase().split(WORD_SPLIT).filter(p => p.length >= 3 && !NAME_STOPWORDS.has(p));
    if (parts.length === 0) return true;
    if (parts.some(p => words.has(p))) return true;
    return parts.some(p => {
      const max = p.length >= 7 ? 2 : p.length >= 5 ? 1 : 0;
      if (!max) return false;
      for (const w of capitalized) if (editDistance(p, w, max) <= max) return true;
      return false;
    });
  });
}

/**
 * @param {string} episodeId
 * @param {Array<{start_ms: number, end_ms: number, text: string}>} segments
 * @param {string} openaiApiKey
 * @param {number} [durationMs] - audio length, for the thin-transcript check
 * @returns {Promise<{title: string, summary: string|null, guests: string[], skipped?: boolean}>}
 *   Throws on a failed, cut-off or unreadable reply, so the step is retried and
 *   a raw or half reply never becomes the summary.
 */
export async function composeSummary(episodeId, segments, openaiApiKey, durationMs) {
  if (isThinTranscript(segments, durationMs)) {
    const title = neutralTitle(episodeId);
    console.warn(`  Transcript too thin to summarize (${segments.length} segments); titled "${title}", no summary or guests.`);
    return { title, summary: null, guests: [], skipped: true };
  }

  const transcriptText = segments.map(s => s.text).join('\n');

  // Extract date from episode ID
  const dateMatch = episodeId.match(/(\d{4}-\d{2}-\d{2})/);
  const dateStr = dateMatch ? dateMatch[1] : null;

  // Fetch sunrise/sunset for context
  let sunData = null;
  if (dateStr) {
    sunData = await fetchSunriseSunset(dateStr);
  }

  // System prompt. The local scripts use this function too (scripts/generate-summaries.js).
  const systemLines = [
    'You summarize transcripts from "Roll Over Easy," a live morning radio show on BFF.fm broadcast from the Ferry Building in San Francisco.',
    '',
    'Respond with a JSON object containing three fields:',
    '',
    '1. "title": A short, catchy episode title (3-8 words). Highlight the main guest or topic. Use an exclamation point for energy. Examples: "Super Bowl Thursday!", "Jane Natoli\'s San Francisco!", "Tree Twins and Muni Diaries".',
    '',
    '2. "summary": A concise summary in this format:',
    '   Line 1: The weather/vibe that morning (if mentioned \u2014 fog, sun, rain, cold, etc.). If not mentioned, skip this line.',
    '   Line 2: Who joined the show \u2014 name any guests who came on for a segment and briefly note who they are. The show is live on location, so random passersby sometimes hop on the mic for a few seconds to a few minutes \u2014 mention these folks too if they say something memorable or funny.',
    '   Line 3-4: What stories and topics came up \u2014 San Francisco news, local culture, neighborhood happenings, food, music, etc.',
    '   Keep a warm, San Francisco tone. Use 2-5 sentences total. Do not use bullet points or labels like "Weather:" \u2014 just weave it naturally.',
    '',
    '3. "guests": An array of guest full names mentioned in the episode. Exclude the hosts Sequoia and The Early Bird. Return an empty array if there are no guests.',
  ];

  if (dateStr || sunData) {
    systemLines.push('');
    systemLines.push('Additional context for this episode:');
    if (dateStr) {
      const formatted = new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric',
      });
      systemLines.push(`- Date: ${formatted}`);
    }
    if (sunData) {
      systemLines.push(`- Sunrise: ${sunData.sunrise} PT`);
      systemLines.push(`- Sunset: ${sunData.sunset} PT`);
    }
    systemLines.push('Mention the weather and temperature only if the hosts talk about them in the transcript; never guess. Also mention what time sunrise and sunset were that day.');
  }

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${openaiApiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemLines.join('\n') },
        { role: 'user', content: `Summarize this Roll Over Easy episode transcript:\n\n${transcriptText}` },
      ],
      temperature: 0.5,
      max_tokens: 600,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS.summary),
  });

  if (!res.ok) {
    throw apiError('OpenAI API', res.status, await res.text());
  }

  const data = await res.json();
  const choice = data.choices?.[0];
  if (choice?.finish_reason === 'length') throw new Error('The summary reply was cut off');

  let parsed;
  try {
    parsed = JSON.parse(choice.message.content.trim());
  } catch {
    throw new Error('The summary reply was not readable JSON');
  }
  const title = typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : neutralTitle(episodeId);
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
  if (!summary) throw new Error('The summary reply had no summary');

  const named = (Array.isArray(parsed.guests) ? parsed.guests : [])
    .filter(g => typeof g === 'string' && g.trim() && !isHost(g))
    .map(g => g.trim());
  const guests = [...new Set(guestsInTranscript(named, transcriptText))];
  if (guests.length < named.length) {
    const dropped = named.filter(g => !guests.includes(g));
    console.warn(`  Dropped guest names not found in the transcript: ${dropped.join(', ')}`);
  }

  console.log(`  Title: ${title}`);
  console.log(`  Summary: ${summary.slice(0, 100)}...`);
  if (guests.length > 0) console.log(`  Guests: ${guests.join(', ')}`);

  return { title, summary, guests };
}

function utcToPacific(isoString) {
  const date = new Date(isoString);
  return date.toLocaleTimeString('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: 'numeric',
    minute: '2-digit',
  });
}

async function fetchSunriseSunset(dateStr) {
  // Ferry Building coordinates
  const url = `https://api.sunrise-sunset.org/json?lat=37.7955&lng=-122.3937&date=${dateStr}&formatted=0`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS.sunrise) });
    const data = await res.json();
    if (data.status !== 'OK') return null;
    return {
      sunrise: utcToPacific(data.results.sunrise),
      sunset: utcToPacific(data.results.sunset),
    };
  } catch {
    return null;
  }
}
