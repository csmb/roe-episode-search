import FRONTEND_HTML from './frontend.html';
import EPISODES_HTML from './episodes.html';
import GUESTS_HTML from './guests.html';

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

// ── Router ────────────────────────────────────────────────────────────

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';

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

	// Embed the query
	const embeddingResult = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [query] });
	const queryVector = embeddingResult.data[0];

	// Query Vectorize
	const vectorResults = await env.VECTORIZE.query(queryVector, {
		topK: 20,
		returnMetadata: 'all',
	});

	// Collect unique episode IDs to enrich with D1 metadata
	const episodeIds = [...new Set(vectorResults.matches.map((m) => m.metadata.episode_id))];

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
	for (const match of vectorResults.matches) {
		const meta = match.metadata;
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
	const { results } = await env.DB.prepare(
		'SELECT id, title, duration_ms, published_at, summary FROM episodes ORDER BY id'
	).all();

	return json({ episodes: results }, 200, request);
}

async function handleAudio(request, url, env) {
	const key = url.pathname.slice('/audio/'.length);
	if (!key || !/^[\w-]+\.m4a$/.test(key)) {
		return new Response('Not found', { status: 404 });
	}

	const rangeHeader = request.headers.get('Range');

	const options = {};
	if (rangeHeader) {
		// Parse "bytes=START-END"
		const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
		if (match) {
			options.range = {
				offset: parseInt(match[1], 10),
				length: match[2] ? parseInt(match[2], 10) - parseInt(match[1], 10) + 1 : undefined,
			};
		}
	}

	const object = await env.AUDIO.get(key, options);

	if (!object) {
		return new Response('Not found', { status: 404 });
	}

	const headers = new Headers();
	const contentType = key.endsWith('.m4a') ? 'audio/mp4' : 'audio/mpeg';
	headers.set('Content-Type', contentType);
	headers.set('Accept-Ranges', 'bytes');
	headers.set('Cache-Control', 'public, max-age=86400');

	if (rangeHeader && options.range) {
		const offset = options.range.offset;
		const length = options.range.length || (object.size - offset);
		const end = offset + length - 1;
		headers.set('Content-Range', `bytes ${offset}-${end}/${object.size}`);
		headers.set('Content-Length', length);
		return new Response(object.body, { status: 206, headers });
	}

	headers.set('Content-Length', object.size);
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
			SELECT id, title, duration_ms, summary
			FROM episodes
			WHERE SUBSTR(id, 21, 5) = ?1
			ORDER BY id DESC
		`)
			.bind(todayMmDd)
			.all();

		return json({
			date: todayMmDd,
			episodes: results.map(ep => ({
				id: ep.id,
				title: ep.title,
				duration_ms: ep.duration_ms,
				summary: ep.summary,
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
