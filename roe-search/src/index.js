import FRONTEND_HTML from './frontend.html';
import EPISODES_HTML from './episodes.html';
import GUESTS_HTML from './guests.html';
import ADMIN_HTML from './admin.html';
import MAP_HTML from './map.html';
import STARS_HTML from './stars.html';

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		if (url.pathname === '/api/search') {
			return handleSearch(url, env);
		}
		if (url.pathname === '/api/semantic-search') {
			return handleSemanticSearch(url, env);
		}
		if (url.pathname === '/api/timeline') {
			return handleTimeline(url, env);
		}
		if (url.pathname === '/api/episodes') {
			return handleEpisodes(env);
		}
		if (url.pathname === '/api/on-this-day') {
			return handleOnThisDay(url, env);
		}
		if (url.pathname === '/api/guests') {
			return handleGuests(env);
		}
		if (url.pathname === '/api/stars') {
			return handleStars(env);
		}
		if (url.pathname.startsWith('/api/episode/')) {
			const rest = url.pathname.slice('/api/episode/'.length);
			if (rest.endsWith('/places')) {
				const episodeId = decodeURIComponent(rest.slice(0, -'/places'.length));
				return handleEpisodePlaces(episodeId, env);
			}
			const episodeId = decodeURIComponent(rest);
			return handleEpisodeById(episodeId, env);
		}
		if (url.pathname === '/episodes') {
			return new Response(EPISODES_HTML, {
				headers: { 'Content-Type': 'text/html; charset=utf-8' },
			});
		}
		if (url.pathname === '/guests') {
			return new Response(GUESTS_HTML, {
				headers: { 'Content-Type': 'text/html; charset=utf-8' },
			});
		}
		if (url.pathname === '/admin') {
			return new Response(ADMIN_HTML, {
				headers: { 'Content-Type': 'text/html; charset=utf-8' },
			});
		}
		if (url.pathname === '/map') {
			return new Response(MAP_HTML, {
				headers: { 'Content-Type': 'text/html; charset=utf-8' },
			});
		}
		if (url.pathname === '/stars') {
			return new Response(STARS_HTML, {
				headers: { 'Content-Type': 'text/html; charset=utf-8' },
			});
		}
		if (url.pathname === '/api/map-places') {
			return handleMapPlaces(env);
		}
		if (url.pathname === '/api/admin/unreviewed') {
			return handleAdminUnreviewed(env);
		}
		if (url.pathname === '/api/admin/guest/rename' && request.method === 'POST') {
			return handleAdminGuestRename(request, env);
		}
		if (url.pathname === '/api/admin/guest/delete' && request.method === 'POST') {
			return handleAdminGuestDelete(request, env);
		}
		if (url.pathname === '/api/admin/episode/reviewed' && request.method === 'POST') {
			return handleAdminEpisodeReviewed(request, env);
		}
		if (url.pathname === '/api/admin/episode/duration' && request.method === 'POST') {
			return handleAdminUpdateDuration(request, env);
		}
		if (url.pathname.startsWith('/audio/')) {
			return handleAudio(request, url, env);
		}
		if (url.pathname === '/robots.txt') {
			return new Response('User-agent: *\nDisallow: /\n', {
				headers: { 'Content-Type': 'text/plain' },
			});
		}
		// Serve frontend for everything else
		return new Response(FRONTEND_HTML, {
			headers: { 'Content-Type': 'text/html; charset=utf-8' },
		});
	},
};

const BLOCKED_WORDS = new Set([
	'fuck', 'shit', 'ass', 'asshole', 'bitch', 'cunt', 'cock', 'dick', 'pussy',
	'nigger', 'nigga', 'faggot', 'fag', 'whore', 'slut', 'bastard', 'motherfucker',
	'piss', 'damn', 'crap',
]);

function containsBlockedWord(query) {
	const tokens = query.toLowerCase().split(/\s+/);
	return tokens.some(t => BLOCKED_WORDS.has(t));
}

function sanitizeFtsQuery(input) {
	const terms = input
		.replace(/["\*\(\)\{\}\[\]:^~]/g, ' ')
		.split(/\s+/)
		.filter(t => t.length > 0)
		.map(t => '"' + t.replace(/"/g, '') + '"');
	if (terms.length === 0) return null;
	return terms.join(' ');
}

async function handleSearch(url, env) {
	const query = url.searchParams.get('q')?.trim();
	if (!query) {
		return json({ error: 'Missing ?q= parameter' }, 400);
	}

	if (containsBlockedWord(query)) {
		return json({ query, page: 1, results: [], has_more: false });
	}

	const sanitized = sanitizeFtsQuery(query);
	if (!sanitized) {
		return json({ error: 'Invalid search query' }, 400);
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
	});
	} catch (err) {
		return json({ error: 'Search failed. Try simplifying your query.' }, 400);
	}
}

async function handleSemanticSearch(url, env) {
	const query = url.searchParams.get('q')?.trim();
	if (!query) {
		return json({ error: 'Missing ?q= parameter' }, 400);
	}

	if (containsBlockedWord(query)) {
		return json({ query, page: 1, results: [], has_more: false });
	}

	const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
	const pageSize = 20;

	// Embed the query
	const embeddingResult = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [query] });
	const queryVector = embeddingResult.data[0];

	// Query Vectorize — max topK with returnMetadata:'all' is 50
	const vectorResults = await env.VECTORIZE.query(queryVector, {
		topK: 50,
		returnMetadata: 'all',
	});

	// Group all matches by episode, keeping the best score per episode
	const episodeMatchMap = new Map();
	for (const match of vectorResults.matches) {
		const meta = match.metadata;
		const epId = meta.episode_id;
		if (!episodeMatchMap.has(epId)) {
			episodeMatchMap.set(epId, { bestScore: match.score, matches: [] });
		}
		const ep = episodeMatchMap.get(epId);
		if (match.score > ep.bestScore) ep.bestScore = match.score;
		ep.matches.push({ start_ms: meta.start_ms, end_ms: meta.end_ms, text: meta.text, score: match.score });
	}

	// Sort episodes by best score descending, then paginate
	const allEpisodeIds = Array.from(episodeMatchMap.entries())
		.sort((a, b) => b[1].bestScore - a[1].bestScore)
		.map(([id]) => id);

	const offset = (page - 1) * pageSize;
	const pageEpisodeIds = allEpisodeIds.slice(offset, offset + pageSize);
	const has_more = allEpisodeIds.length > offset + pageSize;

	// Enrich only the current page's episodes with D1 metadata
	let episodeMeta = {};
	if (pageEpisodeIds.length > 0) {
		const placeholders = pageEpisodeIds.map(() => '?').join(', ');
		const { results } = await env.DB.prepare(
			`SELECT id, title, duration_ms, summary FROM episodes WHERE id IN (${placeholders})`
		)
			.bind(...pageEpisodeIds)
			.all();
		for (const row of results) {
			episodeMeta[row.id] = row;
		}
	}

	// Build result objects for this page
	const results = pageEpisodeIds.map((epId) => {
		const { matches } = episodeMatchMap.get(epId);
		const dbMeta = episodeMeta[epId] || {};
		matches.sort((a, b) => a.start_ms - b.start_ms);
		return {
			episode_id: epId,
			title: dbMeta.title || null,
			duration_ms: dbMeta.duration_ms || null,
			summary: dbMeta.summary || null,
			audio_file: `/audio/${epId}.m4a`,
			matches,
		};
	});

	return json({ query, page, results, has_more });
}

async function handleTimeline(url, env) {
	const query = url.searchParams.get('q')?.trim();
	if (!query) {
		return json({ error: 'Missing ?q= parameter' }, 400);
	}

	if (containsBlockedWord(query)) {
		return json({ query, timeline: [], total_mentions: 0 });
	}

	const sanitized = sanitizeFtsQuery(query);
	if (!sanitized) {
		return json({ error: 'Invalid search query' }, 400);
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
	});
	} catch (err) {
		return json({ error: 'Search failed. Try simplifying your query.' }, 400);
	}
}

async function handleEpisodes(env) {
	const { results } = await env.DB.prepare(`
		SELECT e.id, e.title, e.duration_ms, e.published_at, e.summary,
		       COALESCE(pc.cnt, 0) as place_count
		FROM episodes e
		LEFT JOIN (SELECT episode_id, COUNT(*) as cnt FROM place_mentions GROUP BY episode_id) pc
		  ON pc.episode_id = e.id
		ORDER BY e.id
	`).all();

	return json({ episodes: results });
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

async function handleEpisodeById(episodeId, env) {
	try {
		const { results } = await env.DB.prepare(
			'SELECT id, title, duration_ms, summary FROM episodes WHERE id = ?1'
		)
			.bind(episodeId)
			.all();

		if (results.length === 0) {
			return json({ error: 'Episode not found' }, 404);
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
		});
	} catch (err) {
		return json({ error: 'Failed to fetch episode' }, 500);
	}
}

async function handleEpisodePlaces(episodeId, env) {
	try {
		const { results } = await env.DB.prepare(
			`SELECT p.name, p.lat, p.lng FROM places p
			 JOIN place_mentions pm ON pm.place_id = p.id
			 LEFT JOIN (SELECT place_id, COUNT(*) AS total FROM place_mentions GROUP BY place_id) pc ON pc.place_id = p.id
			 WHERE pm.episode_id = ?1
			 ORDER BY pc.total DESC, p.name`
		)
			.bind(episodeId)
			.all();

		return json({ episode_id: episodeId, places: results });
	} catch (err) {
		return json({ episode_id: episodeId, places: [] });
	}
}

async function handleOnThisDay(url, env) {
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
		});
	} catch (err) {
		return json({ error: 'Failed to fetch episodes' }, 500);
	}
}

async function handleGuests(env) {
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
		return json({ guests, total_guests: guests.length });
	} catch (err) {
		return json({ guests: [], total_guests: 0 });
	}
}

async function handleAdminUnreviewed(env) {
	try {
		const { results } = await env.DB.prepare(`
			SELECT e.id, e.title, e.published_at, g.guest_name
			FROM episodes e
			LEFT JOIN episode_guests g ON g.episode_id = e.id
			WHERE e.guests_reviewed = 0
			ORDER BY e.id DESC
		`).all();

		const episodeMap = new Map();
		for (const row of results) {
			if (!episodeMap.has(row.id)) {
				episodeMap.set(row.id, {
					id: row.id,
					title: row.title,
					published_at: row.published_at,
					guests: [],
				});
			}
			if (row.guest_name) {
				episodeMap.get(row.id).guests.push(row.guest_name);
			}
		}

		return json({ episodes: Array.from(episodeMap.values()) });
	} catch (err) {
		return json({ episodes: [] });
	}
}

async function handleAdminGuestRename(request, env) {
	let body;
	try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

	const { old_name, new_name } = body;
	if (!old_name || !new_name) return json({ error: 'Missing old_name or new_name' }, 400);

	await env.DB.prepare(
		'INSERT OR IGNORE INTO episode_guests SELECT episode_id, ? FROM episode_guests WHERE guest_name = ?'
	).bind(new_name, old_name).run();

	await env.DB.prepare(
		'DELETE FROM episode_guests WHERE guest_name = ?'
	).bind(old_name).run();

	return json({ ok: true });
}

async function handleAdminGuestDelete(request, env) {
	let body;
	try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

	const { guest_name } = body;
	if (!guest_name) return json({ error: 'Missing guest_name' }, 400);

	await env.DB.prepare(
		'DELETE FROM episode_guests WHERE guest_name = ?'
	).bind(guest_name).run();

	return json({ ok: true });
}

async function handleAdminEpisodeReviewed(request, env) {
	let body;
	try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

	const { episode_id } = body;
	if (!episode_id) return json({ error: 'Missing episode_id' }, 400);

	await env.DB.prepare(
		'UPDATE episodes SET guests_reviewed = 1 WHERE id = ?'
	).bind(episode_id).run();

	return json({ ok: true });
}

async function handleAdminUpdateDuration(request, env) {
	let body;
	try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

	const { episode_id, duration_ms } = body;
	if (!episode_id || !duration_ms) return json({ error: 'Missing episode_id or duration_ms' }, 400);

	await env.DB.prepare(
		'UPDATE episodes SET duration_ms = ? WHERE id = ?'
	).bind(Math.round(duration_ms), episode_id).run();

	return json({ ok: true });
}

async function handleMapPlaces(env) {
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
		return json({ places: [], total_mentions: 0 });
	}

	// Fetch all episode titles for mentioned episodes
	const { results: mentions } = await env.DB.prepare(`
		SELECT pm.place_id, pm.episode_id, e.title
		FROM place_mentions pm
		JOIN episodes e ON e.id = pm.episode_id
	`).all();

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
		episodes: episodesByPlace[p.id] || [],
	}));

	const total_mentions = places.reduce((s, p) => s + p.episode_count, 0);
	return json({ places, total_mentions });
}

async function handleStars(env) {
	try {
		const obj = await env.AUDIO.get('data/stars.json');
		if (!obj) {
			return json({ error: 'Star data not generated yet' }, 404);
		}
		return new Response(obj.body, {
			headers: {
				'Content-Type': 'application/json',
				'Access-Control-Allow-Origin': '*',
				'Cache-Control': 'public, max-age=86400',
			},
		});
	} catch (err) {
		return json({ error: 'Failed to load star data' }, 500);
	}
}

function json(data, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'Content-Type': 'application/json',
			'Access-Control-Allow-Origin': '*',
		},
	});
}
