// node --test scripts/test/*.test.js
// lib.js: which wrangler failures are sent again.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roe-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.ROE_PERSIST_TO ??= tmp; // a test run: no keys from .env
const { refusedBeforeRunning, REFUSED_RETRY_WAITS_MS } = await import('../lib.js');

// What wrangler printed on 2026-09-28 at the pilot's first D1 query (IDs replaced)
const REFUSED = `Command failed: wrangler d1 execute roe-episodes --remote --json --command SELECT 1
{
  "error": {
    "text": "A request to the Cloudflare API (/accounts/ACCOUNT/d1/database/DATABASE/query) failed.",
    "notes": [
      {
        "text": "The given account is not valid or is not authorized to access this service [code: 7403]"
      }
    ],
    "kind": "error",
    "name": "APIError",
    "code": 7403
  }
}`;

// And at 17:55 that day, with a login 55 minutes old (wrangler renews it after an hour)
const AUTH = `Command failed: wrangler d1 execute roe-episodes --remote --json --command=SELECT guest_name FROM episode_guests
{
  "error": {
    "text": "A request to the Cloudflare API (/accounts/ACCOUNT/d1/database/DATABASE/query) failed.",
    "notes": [
      {
        "text": "Authentication error [code: 10000]"
      }
    ],
    "kind": "error",
    "name": "APIError",
    "code": 10000,
    "accountTag": "ACCOUNT"
  }
}`;

test('the 7403 and 10000 refusals are sent again; any other failure is not', () => {
	assert.equal(refusedBeforeRunning(REFUSED), 7403);
	assert.equal(refusedBeforeRunning(AUTH), 10000);
	for (const other of [
		'D1_ERROR: no such table: episodes: SQLITE_ERROR [code: 7500]',
		'List vectors cursor appears to be corrupted [code: 40052]',
		'The given account is not valid or is not authorized to access this service', // no code
		'Authentication error', // no code
		'request 7403 of 9000 failed', // the number alone
		'upserted 10000 vectors, then the network dropped',
		'',
	]) {
		assert.equal(refusedBeforeRunning(other), null, other);
	}
});

test('the tries outlast a login\'s last minutes, and a stop waits at most 3 minutes', () => {
	const total = REFUSED_RETRY_WAITS_MS.reduce((a, b) => a + b, 0);
	assert.ok(total >= 6 * 60_000, `${total} ms`);
	assert.ok(REFUSED_RETRY_WAITS_MS.every((ms) => ms <= 3 * 60_000));
	assert.equal(REFUSED_RETRY_WAITS_MS[0], 5_000); // a login just renewed works again within seconds
});
