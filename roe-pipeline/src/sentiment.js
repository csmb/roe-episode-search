/**
 * Pure helpers + OpenAI callers for per-place sentiment and narrative.
 * Pure functions are unit-tested; OpenAI callers are integration-tested via mocks.
 * scripts/backfill-place-sentiment.js imports this file too, so it runs in Node as well.
 */

import { apiError, TIMEOUT_MS } from './limits.js';

export const MIN_NARRATIVE_EPISODES = 3;
export const MIN_NARRATIVE_YEAR_SPAN = 2; // distinct calendar years

const CONTEXT_BEFORE = 2;
const CONTEXT_AFTER = 2;
const MAX_PASSAGE_CHARS = 6000; // ~1500 tokens

// Words for a kind of place. A shortened name followed by one of these is a
// different place: "Golden Gate" + "Bridge" isn't Golden Gate Park, "Mission"
// + "Street" isn't the Mission District.
const PLACE_KINDS = new Set([
  'bridge', 'street', 'st', 'avenue', 'ave', 'boulevard', 'blvd', 'road', 'way', 'lane', 'drive',
  'park', 'square', 'plaza', 'district', 'tower', 'beach', 'bay', 'station', 'hill', 'heights',
  'valley', 'garden', 'gardens', 'playground', 'field', 'center', 'library', 'school', 'hospital',
  'theater', 'theatre', 'hall', 'building',
]);
// What a shortened name may be followed by and still be the same place ("King St.").
const SAME_KIND = { street: ['street', 'st'], avenue: ['avenue', 'ave'] };
// One-word short names that are everyday words, other cities or common names:
// "Market Street" and "King Street" count only when "Street" (or "St") follows,
// never through "the F Market" or "the king".
const EVERYDAY_WORDS = new Set([
  'market', 'union', 'king', 'main', 'post', 'water', 'church', 'pine', 'bush', 'oak', 'page', 'clay',
  'grove', 'bay', 'beach', 'lake', 'ocean', 'pacific', 'california', 'washington', 'financial', 'design',
  'central', 'diamond', 'front', 'battery', 'mason', 'baker', 'grant', 'taylor', 'howard', 'harrison',
  'jackson', 'franklin', 'lincoln', 'scott', 'pierce', 'jones', 'irving', 'clement', 'bryant', 'cole',
  'fell', 'green', 'mint', 'sunset', 'south', 'north', 'east', 'west', 'stockton', 'sacramento',
  'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth',
]);
const isEveryday = word => EVERYDAY_WORDS.has(word) || /^\d+(?:st|nd|rd|th)$/.test(word);

/** Lower case, no accents, straight apostrophes, single spaces: how names and lines are compared. */
export function normalizeForMatch(text) {
  return String(text).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ');
}
const normalize = normalizeForMatch;

/**
 * The forms a place can be named by: its whole name, the name without a
 * trailing district/street/avenue/park/square/plaza ("Dolores" for Dolores
 * Park, with the kind it dropped), and each side of an intersection.
 */
function placeForms(name) {
  const base = normalize(name).trim();
  const forms = [];
  if (base.length >= 3) forms.push({ text: base });
  const m = /^(.*\S)\s+(district|street|avenue|park|square|plaza)$/.exec(base);
  if (m && m[1].length >= 3) forms.push({ text: m[1], kind: m[2], everyday: !m[1].includes(' ') && isEveryday(m[1]) });
  if (base.includes('&')) {
    for (const part of base.split('&')) {
      const p = part.trim();
      if (p.length >= 3) forms.push({ text: p });
    }
  }
  return forms;
}

export function placeMatchVariants(name) {
  return [...new Set(placeForms(name).map(f => f.text))];
}

// Whether `hay` (normalized) names the place in this form, as whole words.
function namesIn(hay, { text, kind, everyday }) {
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])(?:\\s+(\\p{L}+))?`, 'gu');
  for (const hit of hay.matchAll(pattern)) {
    if (!kind) return true;
    const next = hit[1];
    if ((SAME_KIND[kind] || [kind]).includes(next)) return true;
    if (everyday || PLACE_KINDS.has(next)) continue;
    return true;
  }
  return false;
}

/** Whether `text` names the place: see placeForms, PLACE_KINDS and EVERYDAY_WORDS. */
export function mentionsPlace(text, name) {
  const hay = normalize(text);
  return placeForms(name).some(form => namesIn(hay, form));
}

export function findPlacePassages(segments, placeName) {
  if (placeForms(placeName).length === 0) return [];
  const hitIdx = [];
  segments.forEach((s, i) => {
    if (mentionsPlace(s.text || '', placeName)) hitIdx.push(i);
  });
  if (hitIdx.length === 0) return [];

  const windows = [];
  for (const i of hitIdx) {
    const start = Math.max(0, i - CONTEXT_BEFORE);
    const end = Math.min(segments.length - 1, i + CONTEXT_AFTER);
    const last = windows[windows.length - 1];
    if (last && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
    } else {
      windows.push({ start, end });
    }
  }

  const passages = windows.map(w => ({
    start_ms: segments[w.start].start_ms,
    text: segments.slice(w.start, w.end + 1).map(s => s.text).join(' ').trim(),
  }));

  let total = 0;
  const capped = [];
  for (const p of passages) {
    if (total + p.text.length > MAX_PASSAGE_CHARS && capped.length > 0) break;
    capped.push(p);
    total += p.text.length;
  }
  return capped;
}

export function buildScorePrompt(placeName, passages) {
  const user = passages.map((p, i) => `[${i + 1}] ${p.text}`).join('\n\n');
  const system =
    `You analyze how the hosts of the San Francisco radio show "Roll Over Easy" ` +
    `talk about a specific place. The excerpts below mention "${placeName}". ` +
    `Judge the hosts' attitude toward ${placeName} itself, ignoring unrelated topics. ` +
    `Respond ONLY with JSON: ` +
    `{"score": <number from -1 to 1>, "label": "positive"|"negative"|"neutral"|"mixed", ` +
    `"quote": "<the single most representative VERBATIM sentence from the excerpts>"}. ` +
    `score -1 = very negative, 0 = neutral, 1 = very positive. ` +
    `The quote MUST be copied verbatim from an excerpt.`;
  return { system, user };
}

export function parseScoreResponse(content) {
  const cleaned = String(content).trim()
    .replace(/^```json\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  const obj = JSON.parse(cleaned);
  const score = Number(obj.score);
  if (!Number.isFinite(score)) throw new Error('score not finite');
  const clamped = Math.max(-1, Math.min(1, score));
  const label = ['positive', 'negative', 'neutral', 'mixed'].includes(obj.label)
    ? obj.label : 'neutral';
  const quote = typeof obj.quote === 'string' ? obj.quote.slice(0, 600) : '';
  return { score: clamped, label, quote };
}

export function episodeYear(episodeId) {
  const m = String(episodeId).match(/(\d{4})-\d{2}-\d{2}/);
  return m ? parseInt(m[1], 10) : null;
}

export function meetsNarrativeThreshold(series) {
  const scored = series.filter(s => typeof s.score === 'number' && s.score !== null);
  if (scored.length < MIN_NARRATIVE_EPISODES) return false;
  const years = new Set(scored.map(s => episodeYear(s.episode_id)).filter(y => y !== null));
  return years.size >= MIN_NARRATIVE_YEAR_SPAN;
}

export function buildNarrativePrompt(placeName, series) {
  const user = series
    .filter(s => typeof s.score === 'number' && s.score !== null)
    .slice()
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .map(s => `${s.date} (score ${Number(s.score).toFixed(2)}, ${s.label}): "${s.snippet || ''}"`)
    .join('\n');
  const system =
    `You summarize how the hosts of "Roll Over Easy" have talked about ${placeName} over time. ` +
    `You are given dated snippets with sentiment scores in chronological order. ` +
    `Respond ONLY with JSON: ` +
    `{"early":"<1-2 sentences on their earliest take>","recent":"<1-2 sentences on their most recent take>",` +
    `"arc":"<one short sentence describing the overall change>"}. ` +
    `Be specific and grounded in the snippets. Do not invent details.`;
  return { system, user };
}

export function parseNarrativeResponse(content) {
  const cleaned = String(content).trim()
    .replace(/^```json\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  const obj = JSON.parse(cleaned);
  return {
    early: String(obj.early || '').slice(0, 600),
    recent: String(obj.recent || '').slice(0, 600),
    arc: String(obj.arc || '').slice(0, 300),
  };
}

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const RATE_LIMIT_WAITS_MS = [2_000, 8_000, 20_000];

async function openaiJson(system, user, apiKey) {
  // When OpenAI says "slow down" (429), wait and try again rather than lose
  // the score: in May hundreds of mentions were left unscored this way.
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0,
        max_tokens: 500,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS.sentiment),
    });
    if (res.status === 429 && attempt < RATE_LIMIT_WAITS_MS.length) {
      const after = Number(res.headers.get('retry-after')) * 1000;
      await new Promise(r => setTimeout(r, after > 0 && after < 60_000 ? after : RATE_LIMIT_WAITS_MS[attempt]));
      continue;
    }
    if (!res.ok) throw apiError('OpenAI', res.status, await res.text());
    const data = await res.json();
    return data.choices[0].message.content;
  }
}

export async function scoreMention(placeName, passages, apiKey) {
  const { system, user } = buildScorePrompt(placeName, passages);
  let content;
  try {
    content = await openaiJson(system, user, apiKey);
    return parseScoreResponse(content);
  } catch (err) {
    console.warn(`scoreMention retry for "${placeName}" after: ${err.message}`);
    // one retry, then give up (caller leaves analyzed_at so a rerun can retry)
    content = await openaiJson(system, user, apiKey);
    return parseScoreResponse(content);
  }
}

export async function synthesizeNarrative(placeName, series, apiKey) {
  const { system, user } = buildNarrativePrompt(placeName, series);
  const content = await openaiJson(system, user, apiKey);
  return parseNarrativeResponse(content);
}

/**
 * Score every place mentioned in one episode, write results to place_mentions,
 * and (re)generate place_narratives for affected places.
 *
 * @param {D1Database} db
 * @param {string} episodeId
 * @param {Array<{start_ms:number,text:string}>} segments
 * @param {string} openaiApiKey
 * @param {object} [opts]
 * @param {number} [opts.deadline] - epoch ms after which no new GPT call starts;
 *   unscored mentions keep analyzed_at NULL, so a later run can finish them
 * @param {(message: string) => void} [opts.warn] - notes for the run's warnings
 */
export async function scoreAndSeedSentiment(db, episodeId, segments, openaiApiKey, { deadline = Infinity, warn = () => {} } = {}) {
  if (!openaiApiKey) {
    console.warn(`[${episodeId}] OPENAI_API_KEY not set — skipping sentiment`);
    return;
  }

  const { results: mentions } = await db
    .prepare(
      `SELECT pm.place_id, pm.episode_id, p.name
       FROM place_mentions pm JOIN places p ON p.id = pm.place_id
       WHERE pm.episode_id = ?`
    )
    .bind(episodeId)
    .all();

  const now = new Date().toISOString();
  const affectedPlaceIds = new Set();
  let unscored = 0;

  for (const m of mentions) {
    if (Date.now() > deadline) {
      unscored++;
      continue;
    }
    const passages = findPlacePassages(segments, m.name);
    let score = null;
    let label = 'unknown';
    let snippet = null;
    let snippetStartMs = null;

    if (passages.length > 0) {
      try {
        const r = await scoreMention(m.name, passages, openaiApiKey);
        score = r.score;
        label = r.label;
        snippet = r.quote;
        const hit = passages.find(p => snippet && p.text.includes(snippet)) || passages[0];
        snippetStartMs = hit.start_ms;
      } catch (err) {
        console.error(`[${episodeId}] score failed for "${m.name}": ${err.message}`);
        continue; // leave analyzed_at NULL so a later run retries
      }
    }

    await db
      .prepare(
        `UPDATE place_mentions
         SET sentiment = ?, sentiment_label = ?, snippet = ?, snippet_start_ms = ?, analyzed_at = ?
         WHERE place_id = ? AND episode_id = ?`
      )
      .bind(score, label, snippet, snippetStartMs, now, m.place_id, m.episode_id)
      .run();

    affectedPlaceIds.add(m.place_id);
  }

  let staleNarratives = 0;
  for (const placeId of affectedPlaceIds) {
    if (Date.now() > deadline) {
      staleNarratives++;
      continue;
    }
    // A failed narrative shouldn't send the whole step round again: every
    // mention above would be scored (and paid for) a second time.
    try {
      await regenerateNarrative(db, placeId, openaiApiKey);
    } catch (err) {
      console.error(`[${episodeId}] narrative failed for place ${placeId}: ${err.message}`);
      staleNarratives++;
    }
  }
  if (unscored > 0) warn(`Ran out of time: ${unscored} place mention(s) left unscored`);
  if (staleNarratives > 0) warn(`${staleNarratives} place narrative(s) not refreshed (out of time or failed)`);

  console.log(`[${episodeId}] sentiment scored for ${mentions.length - unscored} of ${mentions.length} mentions`);
}

/**
 * Pure narrative builder for callers that already have the mention rows
 * (e.g. the backfill script). Returns null if the threshold is not met.
 * @param {string} placeName
 * @param {Array<{episode_id:string,sentiment:number,sentiment_label:string,snippet:string}>} rows
 * @param {string} apiKey
 */
export async function regenerateNarrativeFromRows(placeName, rows, apiKey) {
  const series = rows.map(r => ({
    episode_id: r.episode_id,
    date: (String(r.episode_id).match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || '',
    score: r.sentiment,
    label: r.sentiment_label,
    snippet: r.snippet,
  }));
  if (!meetsNarrativeThreshold(series)) return null;
  const years = series.map(s => episodeYear(s.episode_id)).filter(y => y !== null);
  if (years.length === 0) return null;
  const narrative = await synthesizeNarrative(placeName, series, apiKey);
  return {
    ...narrative,
    episode_count: series.length,
    year_min: Math.min(...years),
    year_max: Math.max(...years),
  };
}

export async function regenerateNarrative(db, placeId, openaiApiKey) {
  const place = await db.prepare('SELECT id, name FROM places WHERE id = ?').bind(placeId).first();
  if (!place) return;

  const { results: rows } = await db
    .prepare(
      `SELECT pm.episode_id, pm.sentiment, pm.sentiment_label, pm.snippet
       FROM place_mentions pm
       WHERE pm.place_id = ? AND pm.sentiment IS NOT NULL`
    )
    .bind(placeId)
    .all();

  const series = rows.map(r => ({
    episode_id: r.episode_id,
    date: (String(r.episode_id).match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || '',
    score: r.sentiment,
    label: r.sentiment_label,
    snippet: r.snippet,
  }));

  if (!meetsNarrativeThreshold(series)) return;

  const years = series.map(s => episodeYear(s.episode_id)).filter(y => y !== null);
  if (years.length === 0) return;
  const narrative = await synthesizeNarrative(place.name, series, openaiApiKey);

  await db
    .prepare(
      `INSERT INTO place_narratives
         (place_id, early_text, recent_text, arc_text, episode_count, year_min, year_max, generated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(place_id) DO UPDATE SET
         early_text=excluded.early_text, recent_text=excluded.recent_text,
         arc_text=excluded.arc_text, episode_count=excluded.episode_count,
         year_min=excluded.year_min, year_max=excluded.year_max,
         generated_at=excluded.generated_at`
    )
    .bind(
      placeId, narrative.early, narrative.recent, narrative.arc,
      series.length, Math.min(...years), Math.max(...years), new Date().toISOString()
    )
    .run();
}
