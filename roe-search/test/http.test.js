// node --test roe-search/test/
// The site Worker's request helpers (src/http.js): rate-limit keys, episode IDs in paths, byte ranges.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { rateLimitKey, decodePathPart, parseRange, rangeBounds, ifRangeMatches } from '../src/http.js';

test('an IPv4 address is its own key; an IPv6 address counts as its /64, however it is written', () => {
	assert.equal(rateLimitKey('203.0.113.7'), '203.0.113.7');
	const net = '2001:db8:85a3:42::/64';
	for (const ip of ['2001:db8:85a3:42::1', '2001:0db8:85a3:0042:ffff:1:2:3', '2001:DB8:85A3:42:0:0:0:9', '2001:db8:85a3:42::']) {
		assert.equal(rateLimitKey(ip), net, ip);
	}
	assert.equal(rateLimitKey('2001:db8::1'), '2001:db8:0:0::/64');
	assert.equal(rateLimitKey('::1'), '0:0:0:0::/64');
	assert.equal(rateLimitKey('fe80::1%en0'), 'fe80:0:0:0::/64');
	assert.equal(rateLimitKey('::ffff:198.51.100.4'), '198.51.100.4'); // IPv4, written as IPv6
	assert.equal(rateLimitKey('unknown'), 'unknown');
	assert.equal(rateLimitKey('1:2:3:4:5:6:7:8:9'), '1:2:3:4:5:6:7:8:9'); // not an address: left as it is
});

test('an episode ID in a path is decoded, and a broken percent-escape is no ID at all', () => {
	assert.equal(decodePathPart('roll-over-easy_2026-10-08_07-30-00'), 'roll-over-easy_2026-10-08_07-30-00');
	assert.equal(decodePathPart('a%20b'), 'a b');
	assert.equal(decodePathPart('%C0%AF'), null);
	assert.equal(decodePathPart('%E0%A4%A'), null);
});

test('Range headers: start-end, start-, the last N bytes; anything else is no range', () => {
	assert.deepEqual(parseRange('bytes=0-99'), { offset: 0, length: 100 });
	assert.deepEqual(parseRange('bytes=500-'), { offset: 500 });
	assert.deepEqual(parseRange('bytes=-200'), { suffix: 200 });
	for (const h of [null, '', 'bytes=-0', 'bytes=5-2', 'bytes=0-1,5-9', 'items=0-9', 'bytes=x-',
		'bytes=0-99999999999999999999', 'bytes=99999999999999999999-', 'bytes=-99999999999999999999']) assert.equal(parseRange(h), null, String(h));
	assert.deepEqual(parseRange('bytes=0-999999999999'), { offset: 0, length: 1e12 }); // past the end: rangeBounds trims it
});

test('where a range lands in a file of a given size, or null when it starts past the end', () => {
	assert.deepEqual(rangeBounds({ offset: 0, length: 100 }, 1000), { start: 0, end: 99, length: 100 });
	assert.deepEqual(rangeBounds({ offset: 900, length: 500 }, 1000), { start: 900, end: 999, length: 100 });
	assert.deepEqual(rangeBounds({ offset: 10 }, 1000), { start: 10, end: 999, length: 990 });
	assert.deepEqual(rangeBounds({ suffix: 200 }, 1000), { start: 800, end: 999, length: 200 });
	assert.deepEqual(rangeBounds({ suffix: 5000 }, 1000), { start: 0, end: 999, length: 1000 });
	assert.equal(rangeBounds({ offset: 1000 }, 1000), null);
	assert.equal(rangeBounds({ offset: 2000, length: 10 }, 1000), null);
});

test('If-Range: the range stands only for the same file (its ETag, strongly, or its exact date)', () => {
	const etag = '"abc123"';
	const uploaded = new Date('2026-10-02T16:54:01.000Z');
	assert.equal(ifRangeMatches(null, etag, uploaded), true); // none sent
	assert.equal(ifRangeMatches('"abc123"', etag, uploaded), true);
	assert.equal(ifRangeMatches('"old999"', etag, uploaded), false);
	assert.equal(ifRangeMatches('W/"abc123"', etag, uploaded), false); // a weak tag never matches
	assert.equal(ifRangeMatches('Fri, 02 Oct 2026 16:54:01 GMT', etag, uploaded), true);
	assert.equal(ifRangeMatches('Thu, 01 Oct 2026 09:00:00 GMT', etag, uploaded), false);
	assert.equal(ifRangeMatches('nonsense', etag, uploaded), false);
});
