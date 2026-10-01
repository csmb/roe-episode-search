#!/usr/bin/env node
/**
 * Smoke test for the live site: requests every route the pages rely on and
 * checks the fields they read, so a deploy that silently drops a route (as
 * 34357ed did in April) fails loudly. A few checks also pin behaviour: search
 * ranking, the On This Day fallback, /latest skipping unfinished episodes, the
 * header photo the pages use and the map's cache header. Read-only; 22 requests,
 * 23 with ADMIN_PASSWORD set (search ranking needs the admin password).
 *
 *   npm run smoke                 # https://rollovereasy.org
 *   node smoke-test.mjs http://roe.localhost:8791
 *   ADMIN_PASSWORD=… npm run smoke   # also checks search ranking
 */

const BASE = (process.argv[2] || 'https://rollovereasy.org').replace(/\/$/, '');
const failures = [];
const skipped = [];
let passed = 0;

async function check(name, path, test, init) {
	try {
		const res = await fetch(BASE + path, init);
		const type = res.headers.get('content-type') || '';
		const body = type.includes('json') ? await res.json()
			: type.startsWith('image/') ? await res.arrayBuffer()
			: await res.text();
		const problem = test(res, body);
		if (problem) failures.push(`${name}: ${problem}`);
		else passed++;
		return body;
	} catch (err) {
		failures.push(`${name}: ${err.message}`);
		return null;
	}
}
const status = code => res => res.status === code ? null : `status ${res.status}, expected ${code}`;

// Pages
const pages = {};
for (const [name, path] of [['homepage', '/'], ['episodes page', '/episodes'], ['map page', '/map'], ['admin page', '/admin']]) {
	pages[path] = await check(name, path, (res, body) => res.status !== 200 ? `status ${res.status}` : !String(body).includes('<html') ? 'not HTML' : null);
}
// The header photo the homepage points at: served by the Worker as a small WebP.
const hero = String(pages['/'] || '').match(/class="hero-image" src="([^"]+)"/)?.[1];
if (!hero?.startsWith('/')) failures.push(`header image: the homepage points at ${hero ?? 'nothing'}, not the Worker`);
else {
	await check('header image', hero, (res, body) =>
		res.status !== 200 ? `status ${res.status}`
			: res.headers.get('content-type') !== 'image/webp' ? `content-type ${res.headers.get('content-type')}`
			: !(body?.byteLength > 0 && body.byteLength < 300 * 1024) ? `${body?.byteLength} bytes, expected under 300 KB` : null);
}
await check('robots.txt', '/robots.txt', (res, body) =>
	res.status !== 200 ? `status ${res.status}` : !/Disallow: \//.test(body) ? 'does not block crawlers' : null);
await check('unknown API path', '/api/no-such-route', status(404));
await check('unknown page', '/no-such-page', status(404));
await check('admin API without password', '/api/admin/unreviewed', status(401));
await check('upload log without password', '/api/admin/ingest-log', status(401));

// Episode list and one episode
const list = await check('/api/episodes', '/api/episodes', (res, body) => {
	if (res.status !== 200) return `status ${res.status}`;
	const eps = body?.episodes;
	if (!Array.isArray(eps) || eps.length < 500) return `only ${eps?.length ?? 0} episodes`;
	for (const f of ['id', 'title', 'duration_ms', 'guest_start_ms', 'guests', 'place_count']) {
		if (!(f in eps[0])) return `episodes lack "${f}"`;
	}
	return null;
});
const latest = list?.episodes?.[list.episodes.length - 1]?.id;
if (latest) {
	await check('/api/episode/{id}', `/api/episode/${latest}`, (res, body) => {
		if (res.status !== 200) return `status ${res.status}`;
		for (const f of ['title', 'audio_file', 'guests', 'guest_start_ms']) if (!(f in (body?.episode || {}))) return `episode lacks "${f}"`;
		return null;
	});
	await check('/api/episode/{id}/places', `/api/episode/${latest}/places`, (res, body) =>
		res.status !== 200 ? `status ${res.status}` : !Array.isArray(body?.places) ? 'no places array' : null);
	await check('audio (range request)', `/audio/${latest}.m4a`, res =>
		res.status !== 206 ? `status ${res.status}, expected 206` : null, { headers: { Range: 'bytes=0-99' } });
}
await check('/api/on-this-day', '/api/on-this-day', (res, body) =>
	res.status !== 200 ? `status ${res.status}` : !Array.isArray(body?.episodes) ? 'no episodes array' : null);
// No show has aired on January 2, so the section falls back to a nearby day with
// one (12-31 since the only January 1 show, 2015's all-music one, came off the site).
const NEAR_JAN_2 = ['12-29', '12-30', '12-31', '01-01', '01-03', '01-04', '01-05'];
await check('/api/on-this-day fallback', '/api/on-this-day?date=01-02', (res, body) =>
	res.status !== 200 ? `status ${res.status}`
		: !NEAR_JAN_2.includes(body?.shown_date) ? `shown_date ${body?.shown_date}, expected a day near 01-02`
		: !(body.episodes?.length >= 1) ? 'no episodes' : null);
// Transcript search needs the admin password. A request without one isn't
// counted as a wrong guess, so this never trips the guess limit.
await check('keyword search without password', '/api/search?q=stairway', status(401));
await check('semantic search without password', '/api/semantic-search?q=coffee', status(401));
// Keyword search ranks episodes by matching lines: the 2016 staircase show says "stairway" most.
if (process.env.ADMIN_PASSWORD) {
	await check('/api/search', '/api/search?q=stairway', (res, body) => {
		if (res.status !== 200) return `status ${res.status}`;
		const first = body?.results?.[0]?.episode_id;
		if (!first?.includes('_2016-03-03_')) return `first result is ${first}, expected the 2016-03-03 show`;
		return body.has_more === true ? null : `has_more is ${body.has_more}, expected true`;
	}, { headers: { 'X-Admin-Password': process.env.ADMIN_PASSWORD } });
} else {
	skipped.push('search ranking (set ADMIN_PASSWORD to run it)');
}
await check('/api/guests', '/api/guests', (res, body) =>
	res.status !== 200 ? `status ${res.status}` : !Array.isArray(body?.guests) || body.guests.length === 0 ? 'no guests' : null);
// About 1 MB, so browsers should keep a copy.
const map = await check('/api/map-places', '/api/map-places', (res, body) =>
	res.status !== 200 ? `status ${res.status}`
		: !Array.isArray(body?.places) || body.places.length === 0 ? 'no places'
		: !/max-age=[1-9]/.test(res.headers.get('cache-control') || '') ? `Cache-Control is ${JSON.stringify(res.headers.get('cache-control'))}, expected a max-age` : null);
const placeName = map?.places?.[0]?.name;
if (placeName) {
	await check('/api/place-detail', `/api/place-detail?name=${encodeURIComponent(placeName)}`, status(200));
}
// An unfinished episode still has its id as its title; /latest must skip it.
await check('/api/episodes/latest', '/api/episodes/latest', (res, body) =>
	res.status !== 200 ? `status ${res.status}`
		: !body?.episode?.title || body.episode.title === body.episode.id ? `title is ${JSON.stringify(body?.episode?.title)}` : null);
await check('/api/episodes/stats', '/api/episodes/stats', status(200));

if (failures.length) {
	console.error(`Smoke test FAILED against ${BASE}: ${failures.length} problem(s), ${passed} passed`);
	for (const f of failures) console.error('  ✗ ' + f);
	process.exit(1);
}
console.log(`Smoke test passed against ${BASE}: ${passed} checks` + (skipped.length ? `; skipped ${skipped.join(', ')}` : ''));
