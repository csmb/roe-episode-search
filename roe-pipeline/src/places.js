/**
 * Extract SF place names from episode transcript, geocode via Nominatim,
 * and seed D1 places + place_mentions tables.
 */

import { apiError, PermanentError, TIMEOUT_MS } from './limits.js';
import { mentionsPlace, normalizeForMatch } from './sentiment.js';

const SF_VIEWBOX = '-122.517,37.833,-122.355,37.708';
const NOMINATIM_DELAY_MS = 1100;
const MAX_PLACES = 150;          // far above a normal show's ~25
const IN_LIST_SIZE = 90;         // stays under D1's 100 bound parameters per query
const MAX_TRANSCRIPT_CHARS = 400_000; // ~100K tokens, inside GPT-4o-mini's 128K

const PLACES_SYSTEM_PROMPT = `You extract San Francisco place names from a local radio show transcript.
This is "Roll Over Easy," a show deeply rooted in SF culture — hosts frequently mention restaurants, cafes, bars, taquerias, bakeries, bookstores, music venues, record shops, community spaces, murals, parks, plazas, beaches, hilltops, streets, intersections, neighborhoods, landmarks, schools, libraries, transit stops, and local businesses.

Return ONLY a JSON array of strings. Be thorough — capture every SF place mentioned, including:
- Restaurants & food: taquerias, dim sum spots, bakeries, coffee shops, ice cream parlors, breweries
- Nightlife & culture: bars, dive bars, music venues, theaters, galleries, bookstores, record shops
- Neighborhoods: Mission, Castro, Sunset, Richmond, Tenderloin, SoMa, Dogpatch, Excelsior, etc.
- Parks & outdoor: Dolores Park, Golden Gate Park, Ocean Beach, Bernal Hill, Twin Peaks, etc.
- Landmarks: Ferry Building, Transamerica Pyramid, Sutro Tower, Coit Tower, City Hall, etc.
- Streets & intersections: Market Street, Valencia Street, 24th & Mission, etc.
- Transit: Muni stops, BART stations, cable car lines
- Community spaces: Manny's, BFF.fm Studios, libraries, rec centers

Only include places in San Francisco proper (not Oakland, Berkeley, Marin, or other Bay Area cities unless the place is an SF icon like the Golden Gate Bridge).
Normalise names to how they'd appear on a map:
- "17th and valencia" → "17th Street & Valencia Street"
- "dolores park" → "Dolores Park"
- "the mission" → "Mission District"
If nothing qualifies, return [].`;

/**
 * The transcript text GPT reads for places: the whole show except the intro
 * (the first 5%, at most 40 lines), as the local script has done since June.
 * It used to be five samples cut to 12,000 characters, which never reached the
 * interview: new episodes got about 14 places against 24 for older ones.
 */
export function transcriptForPlaces(segments) {
  const skip = segments.length < 50 ? 0 : Math.min(40, Math.floor(segments.length * 0.05));
  const text = segments.slice(skip).map(s => s.text).join(' ');
  if (text.length <= MAX_TRANSCRIPT_CHARS) return text;
  console.warn(`  Transcript is ${text.length} characters; sending the first ${MAX_TRANSCRIPT_CHARS} for places`);
  return text.slice(0, MAX_TRANSCRIPT_CHARS);
}

/** Unique, trimmed place names from GPT's reply, at most MAX_PLACES. */
export function cleanPlaceNames(names) {
  const unique = [...new Set(names.filter(n => typeof n === 'string').map(n => n.trim()).filter(Boolean))];
  if (unique.length > MAX_PLACES) console.warn(`  ${unique.length} place names; keeping the first ${MAX_PLACES}`);
  return unique.slice(0, MAX_PLACES);
}

/**
 * Keep only names the transcript mentions. GPT copies the examples in the
 * prompt (Ocean Beach, Dolores Park, Coit Tower…) into its answer: on episodes
 * since April, 46 of 206 place links named a place their transcript never
 * mentions. A name counts when the sentiment step would find it (mentionsPlace:
 * whole words, "Mission District" via "the Mission" but not via "Mission
 * Street", "Golden Gate Park" not via "Golden Gate Bridge", "Market Street" not
 * via "Supermarket"). An intersection counts only when its two streets are
 * named together ("17th and Valencia", "Valencia & 17th Street"), so
 * "24th & Mission" isn't kept because a show says "the 24th" and "Mission".
 */
export function placesInTranscript(names, text) {
  const haystack = normalizeForMatch(text);
  const STREET = '(?:street|avenue|st|ave|boulevard|blvd)';
  const bare = side => side.replace(new RegExp(`\\b${STREET}\\b`, 'g'), '').replace(/\s+/g, ' ').trim();
  const pattern = side => bare(side).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + `(?:\\s+${STREET}\\.?)?`;
  return names.filter(name => {
    const lower = normalizeForMatch(name).trim();
    const sides = lower.split('&').map(s => s.trim()).filter(Boolean);
    if (sides.length === 2 && bare(sides[0]) && bare(sides[1])) {
      const [a, b] = sides.map(pattern);
      const join = '\\s*(?:and|&|at|,)\\s*';
      return new RegExp(`\\b${a}${join}${b}\\b|\\b${b}${join}${a}\\b`).test(haystack);
    }
    return mentionsPlace(haystack, name);
  });
}

// SELECT id, name FROM places for many names, a few dozen at a time.
async function placeIds(db, names) {
  const ids = new Map();
  for (let i = 0; i < names.length; i += IN_LIST_SIZE) {
    const part = names.slice(i, i + IN_LIST_SIZE);
    const { results } = await db.prepare(`SELECT id, name FROM places WHERE name IN (${part.map(() => '?').join(', ')})`)
      .bind(...part).all();
    for (const p of results) ids.set(p.name, p.id);
  }
  return ids;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function nominatimSearch(url) {
  const res = await fetch(url, {
    // Nominatim's usage policy asks for a way to reach whoever sends the requests.
    headers: { 'User-Agent': 'roe-episode-search/1.0 (+https://rollovereasy.org)' },
    signal: AbortSignal.timeout(TIMEOUT_MS.geocode),
  });
  if (!res.ok) return [];
  return res.json();
}

async function geocodePlace(placeName) {
  const q1 = encodeURIComponent(placeName + ' San Francisco CA');
  try {
    const results = await nominatimSearch(
      `https://nominatim.openstreetmap.org/search?q=${q1}&format=json&limit=1&viewbox=${SF_VIEWBOX}&bounded=1`
    );
    if (results.length > 0) return { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) };
  } catch {}

  await sleep(NOMINATIM_DELAY_MS);

  if (placeName.includes('&') || placeName.includes(' and ')) {
    const parts = placeName.split(/\s*[&]\s*|\s+and\s+/i);
    if (parts.length === 2) {
      const q2 = encodeURIComponent(parts[0].trim() + ' and ' + parts[1].trim() + ', San Francisco');
      try {
        const results = await nominatimSearch(
          `https://nominatim.openstreetmap.org/search?q=${q2}&format=json&limit=1&viewbox=${SF_VIEWBOX}&bounded=1`
        );
        if (results.length > 0) return { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) };
      } catch {}
      await sleep(NOMINATIM_DELAY_MS);

      const q3 = encodeURIComponent(parts[0].trim() + ', San Francisco CA');
      try {
        const results = await nominatimSearch(
          `https://nominatim.openstreetmap.org/search?q=${q3}&format=json&limit=1&viewbox=${SF_VIEWBOX}&bounded=1`
        );
        if (results.length > 0) return { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) };
      } catch {}
      await sleep(NOMINATIM_DELAY_MS);
    }
  }

  // Strategy 4: Same query as strategy 1 but unbounded — catches places Nominatim
  // knows but places outside the strict SF viewport. Validate coordinates manually.
  const q4 = encodeURIComponent(placeName + ' San Francisco CA');
  try {
    const results = await nominatimSearch(
      `https://nominatim.openstreetmap.org/search?q=${q4}&format=json&limit=1&viewbox=${SF_VIEWBOX}&bounded=0`
    );
    if (results.length > 0) {
      const lat = parseFloat(results[0].lat);
      const lng = parseFloat(results[0].lon);
      if (lat >= 37.7 && lat <= 37.84 && lng >= -122.52 && lng <= -122.35) {
        return { lat, lng };
      }
    }
  } catch {}

  return null;
}

/**
 * @param {D1Database} db
 * @param {string} episodeId
 * @param {Array<{text: string}>} segments
 * @param {string} openaiApiKey
 * @param {object} [opts]
 * @param {number} [opts.deadline] - epoch ms after which no new place is geocoded
 * @param {(message: string) => void} [opts.warn] - notes for the run's warnings
 * Throws on a failed, cut-off or unreadable reply rather than seeding nothing.
 */
export async function extractAndSeedPlaces(db, episodeId, segments, openaiApiKey, { deadline = Infinity, warn = () => {} } = {}) {
  if (!openaiApiKey) {
    console.warn(`[${episodeId}] OPENAI_API_KEY not set — skipping places extraction`);
    return;
  }

  const text = transcriptForPlaces(segments);

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openaiApiKey}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: PLACES_SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
      temperature: 0,
      max_tokens: 4000,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS.places),
  });

  if (!res.ok) {
    throw apiError('OpenAI API', res.status, await res.text());
  }

  const data = await res.json();
  const choice = data.choices?.[0];
  // A cut-off list isn't valid JSON, and used to count as "no places".
  if (choice?.finish_reason === 'length') throw new PermanentError('The places reply was cut off');
  const content = (choice?.message?.content || '').trim()
    .replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new PermanentError('The places reply was not readable JSON');
  }
  if (!Array.isArray(parsed)) throw new PermanentError('The places reply was not a list');
  const named = cleanPlaceNames(parsed);
  const placeNames = placesInTranscript(named, text);
  if (placeNames.length < named.length) {
    console.log(`[${episodeId}] Dropped places the transcript never mentions: ${named.filter(n => !placeNames.includes(n)).join(', ')}`);
  }

  if (placeNames.length === 0) {
    console.log(`[${episodeId}] No places found`);
    return;
  }

  // Check D1 for already-known places to avoid re-geocoding
  const knownPlaces = await placeIds(db, placeNames);

  const geocoded = [];
  let skipped = 0;
  for (const name of placeNames) {
    if (knownPlaces.has(name)) {
      geocoded.push(name);
      continue;
    }
    // Geocoding is slow (Nominatim allows one request a second); stop in time
    // for the alarm to finish. Places already on the map are still linked.
    if (Date.now() > deadline) {
      skipped++;
      continue;
    }
    await sleep(NOMINATIM_DELAY_MS);
    const coords = await geocodePlace(name);
    if (coords) {
      await db.prepare('INSERT OR IGNORE INTO places (name, lat, lng) VALUES (?, ?, ?)')
        .bind(name, coords.lat, coords.lng).run();
      geocoded.push(name);
    } else {
      console.log(`[${episodeId}] Could not geocode: ${name}`);
    }
  }
  if (skipped > 0) warn(`Ran out of time: ${skipped} new place name(s) were not geocoded`);

  if (geocoded.length === 0) {
    console.log(`[${episodeId}] No places geocoded`);
    return;
  }

  // Re-query to get IDs for newly inserted places
  const placeIdMap = await placeIds(db, geocoded);

  // Replace this episode's links in one transaction
  const statements = [db.prepare('DELETE FROM place_mentions WHERE episode_id = ?').bind(episodeId)];
  for (const name of geocoded) {
    const placeId = placeIdMap.get(name);
    // placeId could be absent if a known place was deleted between the two queries,
    // or if INSERT OR IGNORE silently skipped due to a race. Guard is intentional.
    if (placeId != null) {
      statements.push(db.prepare('INSERT OR IGNORE INTO place_mentions (place_id, episode_id) VALUES (?, ?)')
        .bind(placeId, episodeId));
    }
  }
  await db.batch(statements);

  console.log(`[${episodeId}] Seeded ${geocoded.length} places`);
}
