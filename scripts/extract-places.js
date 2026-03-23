#!/usr/bin/env node
/**
 * extract-places.js
 *
 * 1. Reads each transcript, samples text across the full episode
 * 2. Calls GPT-4o-mini to extract SF place names
 * 3. Geocodes unique places via Nominatim (OSM) with fallback strategies
 * 4. Writes scripts/places.json  ← input for seed-places.js
 *
 * Usage:
 *   OPENAI_API_KEY=... node scripts/extract-places.js [--reextract]
 *
 *   --reextract   Re-process all episodes, even those already in places.json
 */

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRANSCRIPTS_DIR = path.join(__dirname, '..', 'transcripts');
const OUT_PATH = path.join(__dirname, 'places.json');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) { console.error('OPENAI_API_KEY required'); process.exit(1); }

const REEXTRACT = process.argv.includes('--reextract');

// SF bounding box for Nominatim
const SF_VIEWBOX = '-122.517,37.833,-122.355,37.708'; // west,north,east,south

const CONCURRENCY = 8;
const NOMINATIM_DELAY_MS = 1100; // Nominatim rate limit: 1 req/sec

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpsGet(url) {
	return new Promise((resolve, reject) => {
		https.get(url, { headers: { 'User-Agent': 'roe-episode-search/1.0' } }, res => {
			let data = '';
			res.on('data', c => data += c);
			res.on('end', () => resolve(data));
		}).on('error', reject);
	});
}

async function openaiExtract(text) {
	const body = JSON.stringify({
		model: 'gpt-4o-mini',
		messages: [
			{
				role: 'system',
				content: `You extract San Francisco place names from a local radio show transcript.
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
If nothing qualifies, return [].`,
			},
			{ role: 'user', content: text },
		],
		temperature: 0,
		max_tokens: 1000,
	});

	return new Promise((resolve, reject) => {
		const req = https.request(
			{
				hostname: 'api.openai.com',
				path: '/v1/chat/completions',
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${OPENAI_API_KEY}`,
					'Content-Length': Buffer.byteLength(body),
				},
			},
			res => {
				let data = '';
				res.on('data', c => data += c);
				res.on('end', () => {
					try {
						const json = JSON.parse(data);
						const content = json.choices?.[0]?.message?.content?.trim() || '[]';
						// Strip markdown code fences if present
						const cleaned = content.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
						resolve(JSON.parse(cleaned));
					} catch {
						resolve([]);
					}
				});
			}
		);
		req.on('error', reject);
		req.write(body);
		req.end();
	});
}

async function geocode(placeName) {
	// Strategy 1: Standard search within SF bounding box
	const q1 = encodeURIComponent(placeName + ' San Francisco CA');
	const url1 = `https://nominatim.openstreetmap.org/search?q=${q1}&format=json&limit=1&viewbox=${SF_VIEWBOX}&bounded=1`;
	try {
		const data = await httpsGet(url1);
		const results = JSON.parse(data);
		if (results.length > 0) {
			return { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) };
		}
	} catch {}

	await sleep(NOMINATIM_DELAY_MS);

	// Strategy 2: For intersections ("X Street & Y Street"), search for just the intersection
	if (placeName.includes('&') || placeName.includes(' and ')) {
		const parts = placeName.split(/\s*[&]\s*|\s+and\s+/i);
		if (parts.length === 2) {
			const q2 = encodeURIComponent(parts[0].trim() + ' and ' + parts[1].trim() + ', San Francisco');
			const url2 = `https://nominatim.openstreetmap.org/search?q=${q2}&format=json&limit=1&viewbox=${SF_VIEWBOX}&bounded=1`;
			try {
				const data = await httpsGet(url2);
				const results = JSON.parse(data);
				if (results.length > 0) {
					return { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) };
				}
			} catch {}

			await sleep(NOMINATIM_DELAY_MS);

			// Strategy 3: Search for just the first street (approximate location)
			const q3 = encodeURIComponent(parts[0].trim() + ', San Francisco CA');
			const url3 = `https://nominatim.openstreetmap.org/search?q=${q3}&format=json&limit=1&viewbox=${SF_VIEWBOX}&bounded=1`;
			try {
				const data = await httpsGet(url3);
				const results = JSON.parse(data);
				if (results.length > 0) {
					return { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) };
				}
			} catch {}

			await sleep(NOMINATIM_DELAY_MS);
		}
	}

	// Strategy 4: Unbounded search (prefer SF but accept nearby)
	const q4 = encodeURIComponent(placeName + ' San Francisco CA');
	const url4 = `https://nominatim.openstreetmap.org/search?q=${q4}&format=json&limit=1&viewbox=${SF_VIEWBOX}&bounded=0`;
	try {
		const data = await httpsGet(url4);
		const results = JSON.parse(data);
		if (results.length > 0) {
			const lat = parseFloat(results[0].lat);
			const lng = parseFloat(results[0].lon);
			// Only accept if roughly in SF area
			if (lat >= 37.7 && lat <= 37.84 && lng >= -122.52 && lng <= -122.35) {
				return { lat, lng };
			}
		}
	} catch {}

	return null;
}

function sampleTranscript(segments) {
	// Take 5 evenly-spaced windows across the full episode, skipping the first minute
	const total = segments.length;
	if (total < 50) return segments.map(s => s.text).join(' ');

	const start = Math.min(40, Math.floor(total * 0.05)); // skip intro music
	const usable = total - start;
	const windowSize = Math.min(200, Math.floor(usable / 5));
	const windows = [];
	for (let i = 0; i < 5; i++) {
		const offset = start + Math.floor((usable / 5) * i);
		windows.push(segments.slice(offset, offset + windowSize));
	}
	return windows.flat().map(s => s.text).join(' ').slice(0, 12000);
}

async function processChunk(files, results, done, total) {
	await Promise.all(files.map(async (file) => {
		const episodeId = path.basename(file, '.json');
		try {
			const d = JSON.parse(fs.readFileSync(path.join(TRANSCRIPTS_DIR, file)));
			const text = sampleTranscript(d.segments);
			const places = await openaiExtract(text);
			results[episodeId] = places.length > 0 ? places : [];
		} catch (err) {
			// skip on error
		}
		done.count++;
		process.stdout.write(`\r  ${done.count}/${total} episodes processed`);
	}));
}

async function main() {
	const files = fs.readdirSync(TRANSCRIPTS_DIR).filter(f => f.endsWith('.json'));
	console.log(`Extracting SF places from ${files.length} transcripts...`);
	if (REEXTRACT) console.log('  --reextract: re-processing all episodes');

	// Check for existing partial results
	let episodeResults = {};
	if (!REEXTRACT && fs.existsSync(OUT_PATH)) {
		const existing = JSON.parse(fs.readFileSync(OUT_PATH));
		if (existing.episodeResults) {
			episodeResults = existing.episodeResults;
			console.log(`  Resuming — ${Object.keys(episodeResults).length} already done`);
		}
	}

	const remaining = REEXTRACT ? files : files.filter(f => !episodeResults[path.basename(f, '.json')]);
	const done = { count: REEXTRACT ? 0 : Object.keys(episodeResults).length };
	const total = files.length;

	// Process in batches of CONCURRENCY
	for (let i = 0; i < remaining.length; i += CONCURRENCY) {
		const chunk = remaining.slice(i, i + CONCURRENCY);
		await processChunk(chunk, episodeResults, done, total);
		// Save progress after each batch
		fs.writeFileSync(OUT_PATH, JSON.stringify({ episodeResults }, null, 2));
	}
	console.log(`\n  Done extracting.\n`);

	// Deduplicate and count place→episodes
	const placeMap = {}; // normalized name → Set of episode IDs
	for (const [episodeId, places] of Object.entries(episodeResults)) {
		for (const place of places) {
			const key = place.trim();
			if (!key) continue;
			if (!placeMap[key]) placeMap[key] = new Set();
			placeMap[key].add(episodeId);
		}
	}

	const uniquePlaces = Object.keys(placeMap).sort();
	console.log(`Geocoding ${uniquePlaces.length} unique places via Nominatim...`);

	// Load previously geocoded results to skip re-geocoding
	let prevGeocoded = {};
	if (fs.existsSync(OUT_PATH)) {
		try {
			const existing = JSON.parse(fs.readFileSync(OUT_PATH));
			if (existing.places) {
				for (const p of existing.places) {
					prevGeocoded[p.name] = { lat: p.lat, lng: p.lng };
				}
			}
		} catch {}
	}

	const geocoded = [];
	let gDone = 0;
	let skipped = 0;
	for (const name of uniquePlaces) {
		// Reuse previous geocode result if available
		if (prevGeocoded[name]) {
			geocoded.push({
				name,
				lat: prevGeocoded[name].lat,
				lng: prevGeocoded[name].lng,
				episodes: [...placeMap[name]],
			});
			skipped++;
		} else {
			const coords = await geocode(name);
			if (coords) {
				geocoded.push({
					name,
					lat: coords.lat,
					lng: coords.lng,
					episodes: [...placeMap[name]],
				});
			}
			await sleep(NOMINATIM_DELAY_MS);
		}
		gDone++;
		process.stdout.write(`\r  ${gDone}/${uniquePlaces.length} geocoded (${geocoded.length} matched, ${skipped} cached)`);
	}
	console.log('\n  Done geocoding.\n');

	// Save final output
	const output = { episodeResults, places: geocoded };
	fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));
	console.log(`Saved ${geocoded.length} geocoded places to ${OUT_PATH}`);
	console.log(`Total place-episode links: ${geocoded.reduce((s, p) => s + p.episodes.length, 0)}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
