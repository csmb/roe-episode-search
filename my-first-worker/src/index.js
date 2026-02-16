import FRONTEND_HTML from './frontend.html';
import EPISODES_HTML from './episodes.html';

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
		if (url.pathname === '/episodes') {
			return new Response(EPISODES_HTML, {
				headers: { 'Content-Type': 'text/html; charset=utf-8' },
			});
		}
		if (url.pathname.startsWith('/audio/')) {
			return handleAudio(request, url, env);
		}
		// Serve frontend for everything else
		return new Response(FRONTEND_HTML, {
			headers: { 'Content-Type': 'text/html; charset=utf-8' },
		});
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

async function handleSearch(url, env) {
	const query = url.searchParams.get('q')?.trim();
	if (!query) {
		return json({ error: 'Missing ?q= parameter' }, 400);
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
			ORDER BY best_rank
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
		ORDER BY me.best_rank, s.start_ms
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
		results: Array.from(episodeMap.values()),
		has_more: false,
	});
}

async function handleTimeline(url, env) {
	const query = url.searchParams.get('q')?.trim();
	if (!query) {
		return json({ error: 'Missing ?q= parameter' }, 400);
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
	const { results } = await env.DB.prepare(
		'SELECT id, title, duration_ms, published_at, summary FROM episodes ORDER BY id'
	).all();

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

function json(data, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'Content-Type': 'application/json',
			'Access-Control-Allow-Origin': '*',
		},
	});
}
