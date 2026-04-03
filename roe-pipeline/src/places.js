/**
 * Extract SF place names from episode transcript, geocode via Nominatim,
 * and seed D1 places + place_mentions tables.
 */

const SF_VIEWBOX = '-122.517,37.833,-122.355,37.708';
const NOMINATIM_DELAY_MS = 1100;

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

export function sampleTranscript(segments) {
  const total = segments.length;
  if (total < 50) return segments.map(s => s.text).join(' ');

  const start = Math.min(40, Math.floor(total * 0.05));
  const usable = total - start;
  const windowSize = Math.min(200, Math.floor(usable / 5));
  const windows = [];
  for (let i = 0; i < 5; i++) {
    const offset = start + Math.floor((usable / 5) * i);
    windows.push(segments.slice(offset, offset + windowSize));
  }
  return windows.flat().map(s => s.text).join(' ').slice(0, 12000);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function nominatimSearch(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'roe-episode-search/1.0' } });
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
 */
export async function extractAndSeedPlaces(db, episodeId, segments, openaiApiKey) {
  if (!openaiApiKey) {
    console.warn(`[${episodeId}] OPENAI_API_KEY not set — skipping places extraction`);
    return;
  }

  const text = sampleTranscript(segments);

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
      max_tokens: 1000,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${body}`);
  }

  const data = await res.json();
  const content = data.choices[0].message.content.trim()
    .replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();

  let placeNames = [];
  try {
    placeNames = JSON.parse(content);
    if (!Array.isArray(placeNames)) placeNames = [];
  } catch {
    console.warn(`[${episodeId}] Failed to parse places response, skipping`);
    return;
  }

  if (placeNames.length === 0) {
    console.log(`[${episodeId}] No places found`);
    return;
  }

  // Check D1 for already-known places to avoid re-geocoding
  const { results: existingPlaces } = await db.prepare('SELECT id, name FROM places').all();
  const knownPlaces = new Map(existingPlaces.map(p => [p.name, p.id]));

  const geocoded = [];
  for (const name of placeNames) {
    if (knownPlaces.has(name)) {
      geocoded.push(name);
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

  if (geocoded.length === 0) {
    console.log(`[${episodeId}] No places geocoded`);
    return;
  }

  // Re-query to get IDs for newly inserted places
  const { results: allPlaces } = await db.prepare('SELECT id, name FROM places').all();
  const placeIdMap = new Map(allPlaces.map(p => [p.name, p.id]));

  await db.prepare('DELETE FROM place_mentions WHERE episode_id = ?').bind(episodeId).run();
  for (const name of geocoded) {
    const placeId = placeIdMap.get(name);
    if (placeId != null) {
      await db.prepare('INSERT OR IGNORE INTO place_mentions (place_id, episode_id) VALUES (?, ?)')
        .bind(placeId, episodeId).run();
    }
  }

  console.log(`[${episodeId}] Seeded ${geocoded.length} places`);
}
