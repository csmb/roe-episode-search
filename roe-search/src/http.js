// Small request helpers for the site Worker (src/index.js), kept apart so
// node --test can check them (test/http.test.js): index.js imports the pages.

/**
 * The key a client's requests are counted under (rate limits, wrong admin
 * passwords): an IPv4 address as it is, an IPv6 address as its /64. One home
 * or server usually has a whole /64 and can pick any address in it, so
 * counting single IPv6 addresses would give it billions of fresh budgets.
 */
export function rateLimitKey(ip) {
	if (!ip.includes(':')) return ip;
	const address = ip.split('%')[0].toLowerCase();
	const mapped = address.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
	if (mapped) return mapped[1];
	const halves = address.split('::');
	if (halves.length > 2) return ip;
	const groups = (part) => (part ? part.split(':') : []);
	const head = groups(halves[0]);
	const tail = halves.length === 2 ? groups(halves[1]) : [];
	const missing = 8 - head.length - tail.length;
	if (halves.length === 2 ? missing < 1 : missing !== 0) return ip;
	const all = [...head, ...Array(missing).fill('0'), ...tail];
	if (!all.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return ip;
	return `${all.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

/** A path part decoded, or null when its percent-escapes aren't valid UTF-8 (bots send "%C0%AF"). */
export function decodePathPart(part) {
	try {
		return decodeURIComponent(part);
	} catch {
		return null;
	}
}

/**
 * A Range header as R2 takes it: {offset, length} (bytes=START-END),
 * {offset} (bytes=START-) or {suffix} (bytes=-N, the last N bytes). Null for no
 * header, several ranges, numbers too big to count exactly, or anything
 * malformed: the whole file is sent.
 */
export function parseRange(header) {
	const m = header?.match(/^bytes=(\d*)-(\d*)$/);
	if (!m) return null;
	const [start, end] = [m[1], m[2]].map((d) => (d === '' ? null : Number(d)));
	if ([start, end].some((n) => n !== null && !Number.isSafeInteger(n))) return null;
	if (start === null) return end > 0 ? { suffix: end } : null;
	if (end === null) return { offset: start };
	return end >= start ? { offset: start, length: end - start + 1 } : null;
}

/** Where a range lands in a file of `size` bytes ({start, end, length}), or null if it starts past the end (a 416). */
export function rangeBounds(range, size) {
	if (range.suffix != null) {
		const length = Math.min(range.suffix, size);
		return length > 0 ? { start: size - length, end: size - 1, length } : null;
	}
	if (range.offset >= size) return null;
	const length = range.length != null ? Math.min(range.length, size - range.offset) : size - range.offset;
	return { start: range.offset, end: range.offset + length - 1, length };
}

/**
 * Whether a request's If-Range lets its Range stand: no If-Range, the file's
 * own ETag (compared strongly: a weak tag never matches), or exactly its
 * Last-Modified date. Otherwise the client's earlier bytes came from another
 * version of the file, and it must get the whole new one.
 */
export function ifRangeMatches(ifRange, etag, uploaded) {
	if (ifRange == null) return true;
	if (ifRange.startsWith('"') || ifRange.startsWith('W/')) return ifRange === etag;
	const date = Date.parse(ifRange);
	return !Number.isNaN(date) && Math.floor(date / 1000) === Math.floor(uploaded.getTime() / 1000);
}
