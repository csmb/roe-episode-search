import FRONTEND_HTML from './frontend.html';
import EPISODES_HTML from './episodes.html';

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		if (url.pathname === '/api/search') {
			return handleSearch(url, env);
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

async function handleSearch(url, env) {
	const query = url.searchParams.get('q')?.trim();
	if (!query) {
		return json({ error: 'Missing ?q= parameter' }, 400);
	}

	const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
	const pageSize = 50;
	const offset = (page - 1) * pageSize;

	// FTS5 search — join back to segments and episodes for full context
	const { results } = await env.DB.prepare(`
		SELECT
			e.id AS episode_id,
			e.title AS episode_title,
			e.duration_ms AS episode_duration_ms,
			e.summary AS episode_summary,
			e.audio_file,
			s.start_ms,
			s.end_ms,
			s.text,
			fts.rank
		FROM transcript_fts fts
		JOIN transcript_segments s ON s.rowid = fts.rowid
		JOIN episodes e ON e.id = s.episode_id
		WHERE transcript_fts MATCH ?1
		ORDER BY fts.rank
		LIMIT ?2 OFFSET ?3
	`)
		.bind(query, pageSize, offset)
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
		has_more: results.length === pageSize,
	});
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
