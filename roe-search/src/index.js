import FRONTEND_HTML from './frontend.html';
import EPISODES_HTML from './episodes.html';
import GUESTS_HTML from './guests.html';
import ADMIN_HTML from './admin.html';
import MAP_HTML from './map.html';

// ── Rate limiting ─────────────────────────────────────────────────────
// Simple sliding-window rate limiter per IP. Limits are per Worker isolate
// (not globally distributed), which is sufficient for basic cost protection.

const rateLimitState = new Map();
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT_SEMANTIC = 10; // semantic search: 10 req/min (uses Workers AI)
const RATE_LIMIT_SEARCH = 30;   // keyword search + timeline: 30 req/min

function checkRateLimit(ip, bucket, limit) {
	const key = `${bucket}:${ip}`;
	const now = Date.now();
	let timestamps = rateLimitState.get(key);
	if (!timestamps) {
		timestamps = [];
		rateLimitState.set(key, timestamps);
	}
	// Evict expired entries
	while (timestamps.length > 0 && timestamps[0] <= now - RATE_WINDOW_MS) {
		timestamps.shift();
	}
	if (timestamps.length >= limit) {
		return false;
	}
	timestamps.push(now);
	// Periodically prune stale keys (every ~100 checks)
	if (Math.random() < 0.01) {
		for (const [k, v] of rateLimitState) {
			if (v.length === 0 || v[v.length - 1] <= now - RATE_WINDOW_MS) {
				rateLimitState.delete(k);
			}
		}
	}
	return true;
}

// ── Security headers ──────────────────────────────────────────────────

const HTML_HEADERS = {
	'Content-Type': 'text/html; charset=utf-8',
	'X-Content-Type-Options': 'nosniff',
	'X-Frame-Options': 'DENY',
	'Referrer-Policy': 'strict-origin-when-cross-origin',
};

const ALLOWED_ORIGINS = ['https://rollovereasy.org', 'https://www.rollovereasy.org'];

function getCorsOrigin(request) {
	const origin = request.headers.get('Origin');
	if (!origin) return null;
	if (ALLOWED_ORIGINS.includes(origin)) return origin;
	// Allow localhost for development
	if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) return origin;
	return null;
}

// Constant-time string compare. Plain `===` short-circuits at the first
// differing byte, leaking a timing signal about how many leading characters
// matched. HMAC-ing both sides with a fresh random key reduces the comparison
// to two fixed-length (32-byte) MACs that we diff in constant time.
async function timingSafeEqual(a, b) {
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey(
		'raw', crypto.getRandomValues(new Uint8Array(32)),
		{ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
	);
	const [macA, macB] = await Promise.all([
		crypto.subtle.sign('HMAC', key, enc.encode(a)),
		crypto.subtle.sign('HMAC', key, enc.encode(b)),
	]);
	const ua = new Uint8Array(macA), ub = new Uint8Array(macB);
	let diff = 0;
	for (let i = 0; i < ua.length; i++) diff |= ua[i] ^ ub[i];
	return diff === 0;
}

async function checkAdminPassword(request, env) {
	const password = request.headers.get('X-Admin-Password');
	if (!password || !env.ADMIN_PASSWORD) return false;
	return timingSafeEqual(password, env.ADMIN_PASSWORD);
}

// CORS preflight. The actual responses set Allow-Origin via json(); a preflight
// additionally needs Allow-Methods/Headers so cross-origin requests carrying
// the custom X-Admin-Password header (e.g. www. vs apex) aren't rejected.
function handleCorsPreflight(request) {
	const headers = {
		'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Password',
		'Access-Control-Max-Age': '86400',
	};
	const origin = getCorsOrigin(request);
	if (origin) {
		headers['Access-Control-Allow-Origin'] = origin;
		headers['Vary'] = 'Origin';
	}
	return new Response(null, { status: 204, headers });
}

// ── Router ────────────────────────────────────────────────────────────

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';

		// CORS preflight for cross-origin API requests
		if (request.method === 'OPTIONS') {
			return handleCorsPreflight(request);
		}

		// Admin routes — password protected
		if (url.pathname === '/admin') {
			return new Response(ADMIN_HTML, { headers: HTML_HEADERS });
		}
		if (url.pathname.startsWith('/api/admin/')) {
			if (!(await checkAdminPassword(request, env))) {
				return json({ error: 'Unauthorized' }, 401, request);
			}
			return handleAdminApi(url, env, request);
		}

		if (url.pathname === '/map') {
			return new Response(MAP_HTML, { headers: HTML_HEADERS });
		}
		if (url.pathname === '/api/map-places') {
			if (!checkRateLimit(clientIP, 'search', RATE_LIMIT_SEARCH)) {
				return json({ error: 'Rate limit exceeded. Try again in a minute.' }, 429, request);
			}
			return handleMapPlaces(env, request);
		}
		if (url.pathname === '/api/place-detail') {
			if (!checkRateLimit(clientIP, 'search', RATE_LIMIT_SEARCH)) {
				return json({ error: 'Rate limit exceeded. Try again in a minute.' }, 429, request);
			}
			return handlePlaceDetail(url, env, request);
		}

		if (url.pathname === '/api/search') {
			if (!checkRateLimit(clientIP, 'search', RATE_LIMIT_SEARCH)) {
				return json({ error: 'Rate limit exceeded. Try again in a minute.' }, 429, request);
			}
			return handleSearch(url, env, request);
		}
		if (url.pathname === '/api/semantic-search') {
			if (!checkRateLimit(clientIP, 'semantic', RATE_LIMIT_SEMANTIC)) {
				return json({ error: 'Rate limit exceeded. Try again in a minute.' }, 429, request);
			}
			return handleSemanticSearch(url, env, request);
		}
		if (url.pathname === '/api/timeline') {
			if (!checkRateLimit(clientIP, 'search', RATE_LIMIT_SEARCH)) {
				return json({ error: 'Rate limit exceeded. Try again in a minute.' }, 429, request);
			}
			return handleTimeline(url, env, request);
		}
		if (url.pathname === '/api/episodes') {
			if (!checkRateLimit(clientIP, 'search', RATE_LIMIT_SEARCH)) {
				return json({ error: 'Rate limit exceeded. Try again in a minute.' }, 429, request);
			}
			return handleEpisodes(env, request);
		}
		if (url.pathname === '/api/on-this-day') {
			return handleOnThisDay(url, env, request);
		}
		if (url.pathname === '/api/guests') {
			return handleGuests(env, request);
		}
		if (url.pathname.startsWith('/api/episode/')) {
			const episodeId = decodeURIComponent(url.pathname.slice('/api/episode/'.length));
			return handleEpisodeById(episodeId, env, request);
		}
		if (url.pathname === '/episodes') {
			return new Response(EPISODES_HTML, { headers: HTML_HEADERS });
		}
		if (url.pathname === '/guests') {
			return new Response(GUESTS_HTML, { headers: HTML_HEADERS });
		}
		if (url.pathname.startsWith('/audio/')) {
			return handleAudio(request, url, env);
		}
		// Serve frontend for everything else
		return new Response(FRONTEND_HTML, { headers: HTML_HEADERS });
	},
};

function sanitizeFtsQuery(input) {
	const terms = input
		.replace(/["\*\(\)\{\}\[\]:^~]/g, ' ')
		.split(/\s+/)
		.filter(t => t.length > 0)
		.map(t => '"' + t.replace(/"/g, '') + '"');
	if (terms.length === 0) return null;
	return terms.join(' ');
}

async function handleSearch(url, env, request) {
	const query = url.searchParams.get('q')?.trim();
	if (!query) {
		return json({ error: 'Missing ?q= parameter' }, 400, request);
	}

	const sanitized = sanitizeFtsQuery(query);
	if (!sanitized) {
		return json({ error: 'Invalid search query' }, 400, request);
	}

	const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
	const pageSize = 20;
	const offset = (page - 1) * pageSize;

	try {
	// Paginate by episodes, not segments — avoids duplicate episode cards
	const { results } = await env.DB.prepare(`
		WITH matched_episodes AS (
			SELECT
				e.id AS episode_id,
				MIN(fts.rank) AS best_rank
			FROM transcript_fts fts
			JOIN transcript_segments s ON s.rowid = fts.rowid
			JOIN episodes e ON e.id = s.episode_id
			WHERE transcript_fts MATCH ?1
			GROUP BY e.id
			ORDER BY e.id DESC
			LIMIT ?2 OFFSET ?3
		)
		SELECT
			me.episode_id,
			e.title AS episode_title,
			e.duration_ms AS episode_duration_ms,
			e.summary AS episode_summary,
			e.audio_file,
			s.start_ms,
			s.end_ms,
			s.text,
			me.best_rank
		FROM matched_episodes me
		JOIN episodes e ON e.id = me.episode_id
		JOIN transcript_segments s ON e.id = s.episode_id
		JOIN transcript_fts fts ON s.rowid = fts.rowid
		WHERE transcript_fts MATCH ?1
		ORDER BY me.episode_id DESC, s.start_ms
	`)
		.bind(sanitized, pageSize, offset)
		.all();

	// Group results by episode
	const episodeMap = new Map();
	for (const row of results) {
		if (!episodeMap.has(row.episode_id)) {
			episodeMap.set(row.episode_id, {
				episode_id: row.episode_id,
				title: row.episode_title,
				duration_ms: row.episode_duration_ms,
				summary: row.episode_summary,
				audio_file: `/audio/${row.episode_id}.m4a`,
				matches: [],
			});
		}
		episodeMap.get(row.episode_id).matches.push({
			start_ms: row.start_ms,
			end_ms: row.end_ms,
			text: row.text,
		});
	}

	// Sort matches chronologically within each episode
	for (const ep of episodeMap.values()) {
		ep.matches.sort((a, b) => a.start_ms - b.start_ms);
	}

	return json({
		query,
		page,
		results: Array.from(episodeMap.values()),
		has_more: episodeMap.size === pageSize,
	}, 200, request);
	} catch (err) {
		return json({ error: 'Search failed. Try simplifying your query.' }, 400, request);
	}
}

async function handleSemanticSearch(url, env, request) {
	const query = url.searchParams.get('q')?.trim();
	if (!query) {
		return json({ error: 'Missing ?q= parameter' }, 400, request);
	}

	try {
		// Embed the query
		const embeddingResult = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [query] });
		const queryVector = embeddingResult?.data?.[0];
		if (!queryVector) {
			return json({ error: 'Could not embed the query. Try again.' }, 502, request);
		}

		// Query Vectorize
		const vectorResults = await env.VECTORIZE.query(queryVector, {
			topK: 20,
			returnMetadata: 'all',
		});
		const matches = vectorResults?.matches || [];

		// Collect unique episode IDs to enrich with D1 metadata. Skip any
		// vector that's missing metadata or an episode_id rather than letting
		// `undefined` leak into the response (e.g. "/audio/undefined.m4a").
		const episodeIds = [...new Set(matches.map((m) => m.metadata?.episode_id).filter(Boolean))];

		let episodeMeta = {};
		if (episodeIds.length > 0) {
			const placeholders = episodeIds.map(() => '?').join(', ');
			const { results } = await env.DB.prepare(
				`SELECT id, title, duration_ms, summary FROM episodes WHERE id IN (${placeholders})`
			)
				.bind(...episodeIds)
				.all();
			for (const row of results) {
				episodeMeta[row.id] = row;
			}
		}

		// Group results by episode (same pattern as handleSearch)
		const episodeMap = new Map();
		for (const match of matches) {
			const meta = match.metadata;
			if (!meta || !meta.episode_id) continue;
			const epId = meta.episode_id;

			if (!episodeMap.has(epId)) {
				const dbMeta = episodeMeta[epId] || {};
				episodeMap.set(epId, {
					episode_id: epId,
					title: dbMeta.title || meta.title,
					duration_ms: dbMeta.duration_ms || null,
					summary: dbMeta.summary || null,
					audio_file: `/audio/${epId}.m4a`,
					matches: [],
				});
			}
			episodeMap.get(epId).matches.push({
				start_ms: meta.start_ms,
				end_ms: meta.end_ms,
				text: meta.text,
				score: match.score,
			});
		}

		// Sort matches chronologically within each episode
		for (const ep of episodeMap.values()) {
			ep.matches.sort((a, b) => a.start_ms - b.start_ms);
		}

		return json({
			query,
			page: 1,
			results: Array.from(episodeMap.values()).sort((a, b) => b.episode_id.localeCompare(a.episode_id)),
			has_more: false,
		}, 200, request);
	} catch (err) {
		return json({ error: 'Semantic search failed. Try again.' }, 500, request);
	}
}

async function handleTimeline(url, env, request) {
	const query = url.searchParams.get('q')?.trim();
	if (!query) {
		return json({ error: 'Missing ?q= parameter' }, 400, request);
	}

	const sanitized = sanitizeFtsQuery(query);
	if (!sanitized) {
		return json({ error: 'Invalid search query' }, 400, request);
	}

	try {
	const [timelineResult, rangeResult] = await Promise.all([
		env.DB.prepare(`
			SELECT
				SUBSTR(e.id, 16, 7) AS month,
				COUNT(*) AS mention_count,
				COUNT(DISTINCT e.id) AS episode_count
			FROM transcript_fts fts
			JOIN transcript_segments s ON s.rowid = fts.rowid
			JOIN episodes e ON e.id = s.episode_id
			WHERE transcript_fts MATCH ?1
			GROUP BY SUBSTR(e.id, 16, 7)
			ORDER BY month
		`).bind(sanitized).all(),
		env.DB.prepare(`
			SELECT
				MIN(SUBSTR(id, 16, 7)) AS first_month,
				MAX(SUBSTR(id, 16, 7)) AS last_month
			FROM episodes
		`).all(),
	]);

	const timeline = timelineResult.results.map(row => ({
		month: row.month,
		mentions: row.mention_count,
		episodes: row.episode_count,
	}));

	const totalMentions = timeline.reduce((sum, t) => sum + t.mentions, 0);
	const range = rangeResult.results[0] || {};

	return json({
		query,
		timeline,
		total_mentions: totalMentions,
		first_month: range.first_month,
		last_month: range.last_month,
	}, 200, request);
	} catch (err) {
		return json({ error: 'Search failed. Try simplifying your query.' }, 400, request);
	}
}

async function handleEpisodes(env, request) {
	try {
		const [{ results: episodes }, { results: guestRows }] = await Promise.all([
			env.DB.prepare(
				'SELECT id, title, duration_ms, published_at, summary, guest_start_ms FROM episodes ORDER BY id'
			).all(),
			env.DB.prepare('SELECT episode_id, guest_name FROM episode_guests').all(),
		]);

		const guestsByEp = new Map();
		for (const row of guestRows) {
			if (!guestsByEp.has(row.episode_id)) guestsByEp.set(row.episode_id, []);
			guestsByEp.get(row.episode_id).push(row.guest_name);
		}

		const enriched = episodes.map(ep => ({
			...ep,
			guests: guestsByEp.get(ep.id) || [],
		}));

		return json({ episodes: enriched }, 200, request);
	} catch (err) {
		return json({ error: 'Failed to load episodes.' }, 500, request);
	}
}

async function handleAudio(request, url, env) {
	const key = url.pathname.slice('/audio/'.length);
	if (!key || !/^[\w-]+\.m4a$/.test(key)) {
		return new Response('Not found', { status: 404 });
	}

	const rangeHeader = request.headers.get('Range');

	// Parse the Range header. Supports normal (bytes=START-END / bytes=START-)
	// and suffix (bytes=-N, "last N bytes") forms. The old regex required a
	// digit before the dash, so suffix ranges fell through to a full 200.
	let r2Range = null;     // option passed to R2
	let suffixLen = null;   // set when this is a suffix range
	if (rangeHeader) {
		const m = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
		if (m) {
			const start = m[1], end = m[2];
			if (start === '' && end !== '') {
				suffixLen = parseInt(end, 10);
				if (suffixLen > 0) r2Range = { suffix: suffixLen };
			} else if (start !== '') {
				const offset = parseInt(start, 10);
				r2Range = end !== ''
					? { offset, length: parseInt(end, 10) - offset + 1 }
					: { offset };
			}
		}
	}

	let object;
	try {
		object = await env.AUDIO.get(key, r2Range ? { range: r2Range } : {});
	} catch {
		// R2 throws on an unsatisfiable range (e.g. offset past EOF) — answer
		// with 416 + the object size instead of a 500.
		const head = await env.AUDIO.head(key);
		if (!head) return new Response('Not found', { status: 404 });
		return new Response('Range Not Satisfiable', {
			status: 416,
			headers: { 'Content-Range': `bytes */${head.size}`, 'Accept-Ranges': 'bytes' },
		});
	}

	if (!object) {
		return new Response('Not found', { status: 404 });
	}

	const headers = new Headers();
	headers.set('Content-Type', 'audio/mp4');
	headers.set('Accept-Ranges', 'bytes');
	headers.set('Cache-Control', 'public, max-age=86400');

	if (r2Range) {
		const size = object.size; // full object size, not the slice length
		let offset, length;
		if (suffixLen !== null) {
			length = Math.min(suffixLen, size);
			offset = size - length;
		} else {
			offset = r2Range.offset;
			length = r2Range.length != null ? Math.min(r2Range.length, size - offset) : (size - offset);
		}
		if (offset >= size || length <= 0) {
			return new Response('Range Not Satisfiable', {
				status: 416,
				headers: { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' },
			});
		}
		const end = offset + length - 1;
		headers.set('Content-Range', `bytes ${offset}-${end}/${size}`);
		headers.set('Content-Length', String(length));
		return new Response(object.body, { status: 206, headers });
	}

	headers.set('Content-Length', String(object.size));
	return new Response(object.body, { status: 200, headers });
}

async function handleEpisodeById(episodeId, env, request) {
	try {
		const { results } = await env.DB.prepare(
			'SELECT id, title, duration_ms, summary FROM episodes WHERE id = ?1'
		)
			.bind(episodeId)
			.all();

		if (results.length === 0) {
			return json({ error: 'Episode not found' }, 404, request);
		}

		const ep = results[0];
		return json({
			episode: {
				id: ep.id,
				title: ep.title,
				duration_ms: ep.duration_ms,
				summary: ep.summary,
				audio_file: `/audio/${ep.id}.m4a`,
			},
		}, 200, request);
	} catch (err) {
		return json({ error: 'Failed to fetch episode' }, 500, request);
	}
}

async function handleOnThisDay(url, env, request) {
	// Use Pacific time for "today"
	const now = new Date();
	const pacificDate = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
	const month = String(pacificDate.getMonth() + 1).padStart(2, '0');
	const day = String(pacificDate.getDate()).padStart(2, '0');
	const todayMmDd = url.searchParams.get('date') || `${month}-${day}`;

	try {
		const { results } = await env.DB.prepare(`
			SELECT id, title, duration_ms, summary, guest_start_ms
			FROM episodes
			WHERE SUBSTR(id, 21, 5) = ?1
			ORDER BY id DESC
		`)
			.bind(todayMmDd)
			.all();

		const ids = results.map(r => r.id);
		const guestsByEp = new Map();
		if (ids.length > 0) {
			const placeholders = ids.map(() => '?').join(',');
			const { results: guestRows } = await env.DB.prepare(
				`SELECT episode_id, guest_name FROM episode_guests WHERE episode_id IN (${placeholders})`
			).bind(...ids).all();
			for (const row of guestRows) {
				if (!guestsByEp.has(row.episode_id)) guestsByEp.set(row.episode_id, []);
				guestsByEp.get(row.episode_id).push(row.guest_name);
			}
		}

		return json({
			date: todayMmDd,
			episodes: results.map(ep => ({
				id: ep.id,
				title: ep.title,
				duration_ms: ep.duration_ms,
				summary: ep.summary,
				guest_start_ms: ep.guest_start_ms,
				guests: guestsByEp.get(ep.id) || [],
				audio_file: `/audio/${ep.id}.m4a`,
			})),
		}, 200, request);
	} catch (err) {
		return json({ error: 'Failed to fetch episodes' }, 500, request);
	}
}

async function handleGuests(env, request) {
	try {
		const { results } = await env.DB.prepare(`
			SELECT g.guest_name, e.id, e.title, e.duration_ms
			FROM episode_guests g
			JOIN episodes e ON e.id = g.episode_id
			ORDER BY g.guest_name COLLATE NOCASE, e.id DESC
		`).all();

		const guestMap = new Map();
		for (const row of results) {
			if (!guestMap.has(row.guest_name)) {
				guestMap.set(row.guest_name, { name: row.guest_name, episodes: [] });
			}
			guestMap.get(row.guest_name).episodes.push({
				id: row.id,
				title: row.title,
				duration_ms: row.duration_ms,
			});
		}

		const guests = Array.from(guestMap.values());
		return json({ guests, total_guests: guests.length }, 200, request);
	} catch (err) {
		return json({ guests: [], total_guests: 0 }, 200, request);
	}
}

async function handleMapPlaces(env, request) {
	try {
		const { results } = await env.DB.prepare(`
			SELECT
				p.id,
				p.name,
				p.lat,
				p.lng,
				COUNT(pm.episode_id) AS episode_count
			FROM places p
			JOIN place_mentions pm ON pm.place_id = p.id
			GROUP BY p.id
			ORDER BY episode_count DESC
		`).all();

		if (results.length === 0) {
			return json({ places: [], total_mentions: 0 }, 200, request);
		}

		const { results: mentions } = await env.DB.prepare(`
			SELECT pm.place_id, pm.episode_id, e.title
			FROM place_mentions pm
			JOIN episodes e ON e.id = pm.episode_id
		`).all();

		const { results: narrativeRows } = await env.DB.prepare(
			`SELECT place_id FROM place_narratives`
		).all();
		const narrativeSet = new Set(narrativeRows.map(r => r.place_id));

		const episodesByPlace = {};
		for (const m of mentions) {
			if (!episodesByPlace[m.place_id]) episodesByPlace[m.place_id] = [];
			episodesByPlace[m.place_id].push({ id: m.episode_id, title: m.title });
		}

		const places = results.map(p => ({
			name: p.name,
			lat: p.lat,
			lng: p.lng,
			episode_count: p.episode_count,
			has_narrative: narrativeSet.has(p.id),
			episodes: episodesByPlace[p.id] || [],
		}));

		const total_mentions = places.reduce((s, p) => s + p.episode_count, 0);
		return json({ places, total_mentions }, 200, request);
	} catch (err) {
		return json({ error: 'Failed to load places.' }, 500, request);
	}
}

async function handlePlaceDetail(url, env, request) {
	const name = url.searchParams.get('name')?.trim();
	if (!name) return json({ error: 'Missing ?name= parameter' }, 400, request);

	const place = await env.DB.prepare('SELECT id, name FROM places WHERE name = ?1')
		.bind(name).first();
	if (!place) return json({ error: 'Place not found' }, 404, request);

	const { results: rows } = await env.DB.prepare(
		`SELECT pm.episode_id, e.title, pm.sentiment, pm.sentiment_label,
		        pm.snippet, pm.snippet_start_ms
		 FROM place_mentions pm JOIN episodes e ON e.id = pm.episode_id
		 WHERE pm.place_id = ?1`
	).bind(place.id).all();

	const series = rows.map(r => ({
		episode_id: r.episode_id,
		date: (String(r.episode_id).match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || '',
		title: r.title,
		score: r.sentiment,
		label: r.sentiment_label,
		snippet: r.snippet,
		snippet_start_ms: r.snippet_start_ms,
	})).sort((a, b) => a.date.localeCompare(b.date));

	const n = await env.DB.prepare(
		'SELECT early_text, recent_text, arc_text FROM place_narratives WHERE place_id = ?1'
	).bind(place.id).first();
	const narrative = n
		? { early: n.early_text, recent: n.recent_text, arc: n.arc_text }
		: null;

	return json({ name: place.name, episode_count: series.length, series, narrative }, 200, request);
}

async function handleAdminApi(url, env, request) {
	const path = url.pathname.slice('/api/admin/'.length);

	if (path === 'unreviewed') {
		try {
			const { results } = await env.DB.prepare(`
				SELECT e.id, e.title, e.published_at
				FROM episodes e
				WHERE e.guests_reviewed = 0
				ORDER BY e.id DESC
			`).all();

			const episodes = [];
			for (const ep of results) {
				const { results: guests } = await env.DB.prepare(
					'SELECT guest_name FROM episode_guests WHERE episode_id = ?1'
				).bind(ep.id).all();
				episodes.push({
					id: ep.id,
					title: ep.title,
					published_at: ep.published_at,
					guests: guests.map(g => g.guest_name),
				});
			}
			return json({ episodes }, 200, request);
		} catch (err) {
			return json({ error: 'Failed to fetch unreviewed episodes' }, 500, request);
		}
	}

	if (path === 'guest/rename' && request.method === 'POST') {
		try {
			const body = await request.json();
			const { old_name, new_name } = body;
			if (!old_name || !new_name) return json({ error: 'Missing old_name or new_name' }, 400, request);
			await env.DB.prepare('UPDATE episode_guests SET guest_name = ?1 WHERE guest_name = ?2')
				.bind(new_name, old_name).run();
			return json({ ok: true }, 200, request);
		} catch (err) {
			return json({ error: 'Rename failed' }, 500, request);
		}
	}

	if (path === 'guest/delete' && request.method === 'POST') {
		try {
			const body = await request.json();
			const { guest_name } = body;
			if (!guest_name) return json({ error: 'Missing guest_name' }, 400, request);
			await env.DB.prepare('DELETE FROM episode_guests WHERE guest_name = ?1')
				.bind(guest_name).run();
			return json({ ok: true }, 200, request);
		} catch (err) {
			return json({ error: 'Delete failed' }, 500, request);
		}
	}

	if (path === 'episode/reviewed' && request.method === 'POST') {
		try {
			const body = await request.json();
			const { episode_id } = body;
			if (!episode_id) return json({ error: 'Missing episode_id' }, 400, request);
			await env.DB.prepare('UPDATE episodes SET guests_reviewed = 1 WHERE id = ?1')
				.bind(episode_id).run();
			return json({ ok: true }, 200, request);
		} catch (err) {
			return json({ error: 'Update failed' }, 500, request);
		}
	}

	if (path === 'episode/duration' && request.method === 'POST') {
		try {
			const body = await request.json();
			const { episode_id, duration_ms } = body;
			if (!episode_id || !duration_ms) return json({ error: 'Missing episode_id or duration_ms' }, 400, request);
			await env.DB.prepare('UPDATE episodes SET duration_ms = ?1 WHERE id = ?2')
				.bind(duration_ms, episode_id).run();
			return json({ ok: true }, 200, request);
		} catch (err) {
			return json({ error: 'Update failed' }, 500, request);
		}
	}

	return json({ error: 'Not found' }, 404, request);
}

function json(data, status = 200, request) {
	const headers = {
		'Content-Type': 'application/json',
		'X-Content-Type-Options': 'nosniff',
	};
	if (request) {
		const origin = getCorsOrigin(request);
		if (origin) {
			headers['Access-Control-Allow-Origin'] = origin;
			headers['Vary'] = 'Origin';
		}
	}
	return new Response(JSON.stringify(data), { status, headers });
}
