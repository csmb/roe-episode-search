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
const { refusedBeforeRunning } = await import('../lib.js');

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

test('the 7403 refusal is sent again; any other failure is not', () => {
	assert.equal(refusedBeforeRunning(REFUSED), true);
	for (const other of [
		'D1_ERROR: no such table: episodes: SQLITE_ERROR [code: 7500]',
		'Authentication error [code: 10000]',
		'List vectors cursor appears to be corrupted [code: 40052]',
		'The given account is not valid or is not authorized to access this service', // no code
		'request 7403 of 9000 failed', // the number alone
		'',
	]) {
		assert.equal(refusedBeforeRunning(other), false, other);
	}
});
