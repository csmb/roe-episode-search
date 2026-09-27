#!/usr/bin/env node
/**
 * Smoke test for the live site: requests every route the pages rely on and
 * checks the fields they read, so a deploy that silently drops a route (as
 * 34357ed did in April) fails loudly. Read-only; about 17 requests.
 *
 *   npm run smoke                 # https://rollovereasy.org
 *   node smoke-test.mjs http://roe.localhost:8791
 */

const BASE = (process.argv[2] || 'https://rollovereasy.org').replace(/\/$/, '');
const failures = [];
let passed = 0;

async function check(name, path, test, init) {
	try {
		const res = await fetch(BASE + path, init);
		const type = res.headers.get('content-type') || '';
		const body = type.includes('json') ? await res.json() : await res.text();
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
for (const [name, path] of [['homepage', '/'], ['episodes page', '/episodes'], ['map page', '/map'], ['admin page', '/admin']]) {
	await check(name, path, (res, body) => res.status !== 200 ? `status ${res.status}` : !String(body).includes('<html') ? 'not HTML' : null);
}
await check('robots.txt', '/robots.txt', (res, body) =>
	res.status !== 200 ? `status ${res.status}` : !/Disallow: \//.test(body) ? 'does not block crawlers' : null);
await check('unknown API path', '/api/no-such-route', status(404));
await check('unknown page', '/no-such-page', status(404));
await check('admin API without password', '/api/admin/unreviewed', status(401));

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
await check('/api/guests', '/api/guests', (res, body) =>
	res.status !== 200 ? `status ${res.status}` : !Array.isArray(body?.guests) || body.guests.length === 0 ? 'no guests' : null);
const map = await check('/api/map-places', '/api/map-places', (res, body) =>
	res.status !== 200 ? `status ${res.status}` : !Array.isArray(body?.places) || body.places.length === 0 ? 'no places' : null);
const placeName = map?.places?.[0]?.name;
if (placeName) {
	await check('/api/place-detail', `/api/place-detail?name=${encodeURIComponent(placeName)}`, status(200));
}
await check('/api/episodes/latest', '/api/episodes/latest', status(200));
await check('/api/episodes/stats', '/api/episodes/stats', status(200));

if (failures.length) {
	console.error(`Smoke test FAILED against ${BASE}: ${failures.length} problem(s), ${passed} passed`);
	for (const f of failures) console.error('  ✗ ' + f);
	process.exit(1);
}
console.log(`Smoke test passed against ${BASE}: ${passed} checks`);
