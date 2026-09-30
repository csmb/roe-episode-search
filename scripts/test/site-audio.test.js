// node --test scripts/test/*.test.js
// site-audio.js: measuring the site's audio with ffprobe, through a stand-in ffprobe on PATH
// (nothing reaches the network).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roe-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.ROE_PERSIST_TO ??= tmp; // a test run: no keys from .env
const { probeUrlMs, probing } = await import('../site-audio.js');

// A stand-in ffprobe: each call counts itself, then does what the next word in the script says:
// "hang" (sleeps past the time limit), "fail", "404" or a length in seconds
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);
const counter = path.join(tmp, 'calls');
const plan = path.join(tmp, 'plan');
fs.writeFileSync(path.join(bin, 'ffprobe'), `#!/bin/sh
n=$(($(cat "${counter}" 2>/dev/null || echo 0) + 1))
echo $n > "${counter}"
step=$(sed -n "\${n}p" "${plan}")
case "$step" in
  hang) sleep 5 ;;
  fail) echo "Connection reset by peer" >&2; exit 1 ;;
  404) echo "Server returned 404 Not Found" >&2; exit 1 ;;
  *) echo "$step" ;;
esac
`, { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
probing.timeoutMs = 300;
probing.retryWaitsMs = [0, 0, 0];

function stand(...steps) {
	fs.writeFileSync(plan, steps.join('\n') + '\n');
	fs.rmSync(counter, { force: true });
}
const calls = () => Number(fs.readFileSync(counter, 'utf8'));
const URL = 'https://example.r2.dev/roll-over-easy_2019-07-18_07-30-00.m4a';

test('a probe that hangs past its time limit, or fails, is made again', async () => {
	stand('hang', 'fail', '7197.701995');
	assert.equal(await probeUrlMs(URL), 7_197_702);
	assert.equal(calls(), 3);
});

test('a missing object is an answer (null), not something to try again', async () => {
	stand('404', '7197.7');
	assert.equal(await probeUrlMs(URL), null);
	assert.equal(calls(), 1);
});

test('after the last try, the error says why', async () => {
	stand('fail', 'fail', 'hang', 'hang');
	await assert.rejects(probeUrlMs(URL), /no answer in 0\.3 s/);
	assert.equal(calls(), 4);
	stand('fail', 'fail', 'fail', 'fail');
	await assert.rejects(probeUrlMs(URL), /Connection reset by peer/);
});
