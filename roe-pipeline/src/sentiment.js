/**
 * Pure helpers + OpenAI callers for per-place sentiment and narrative.
 * Pure functions are unit-tested; OpenAI callers are integration-tested via mocks.
 */

export const MIN_NARRATIVE_EPISODES = 3;
export const MIN_NARRATIVE_YEAR_SPAN = 2; // distinct calendar years

const CONTEXT_BEFORE = 2;
const CONTEXT_AFTER = 2;
const MAX_PASSAGE_CHARS = 6000; // ~1500 tokens

export function placeMatchVariants(name) {
  const base = String(name).toLowerCase().trim();
  const variants = new Set();
  if (base.length >= 3) variants.add(base);
  const stripped = base
    .replace(/\b(district|street|avenue|park|square|plaza)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (stripped.length >= 3) variants.add(stripped);
  if (base.includes('&')) {
    for (const part of base.split('&')) {
      const p = part.trim();
      if (p.length >= 3) variants.add(p);
    }
  }
  return [...variants];
}

export function findPlacePassages(segments, placeName) {
  const variants = placeMatchVariants(placeName);
  if (variants.length === 0) return [];
  const hitIdx = [];
  segments.forEach((s, i) => {
    const t = (s.text || '').toLowerCase();
    if (variants.some(v => t.includes(v))) hitIdx.push(i);
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
