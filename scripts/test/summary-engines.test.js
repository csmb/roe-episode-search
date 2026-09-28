// node --test scripts/test/*.test.js
// summary-engines.js: the summary-only prompt, the Ollama and OpenAI requests and their replies (a
// stubbed fetch: nothing reaches the network), trimming a transcript to a context, and the notes.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roe-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.ROE_PERSIST_TO ??= tmp; // a test run: no keys from .env
const {
	summaryMessages, promptTokens, transcriptBudget, fitTranscript, parseSummaryReply, ollamaRequest, askOllama, askOpenAI,
	ollamaModels, withRetries, sunTimes, summaryNotes, retry, CHARS_PER_TOKEN, OLLAMA_REPLY_TOKENS, OLLAMA_THINKING_TOKENS,
} = await import('../summary-engines.js');
const { HOST_NAMES } = await import('../../roe-pipeline/src/hosts.js');
retry.openaiWaitsMs = [0, 0, 0];
retry.ollamaWaitsMs = [0];

const REVIEWED = { id: 'roll-over-easy_2014-03-20_07-30-00', reviewed: true, guests: ['Brett Walker'] };
const SUN = { sunrise: '7:13 AM', sunset: '7:23 PM' };

/** A stand-in for fetch (or httpRequest): hands out `replies` in turn and keeps each request. */
function stub(...replies) {
	const calls = [];
	const fn = async (url, init = {}) => {
		calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
		const reply = replies[Math.min(calls.length, replies.length) - 1];
		if (typeof reply === 'function') return reply(url, init);
		const { status = 200, json } = reply;
		return { ok: status < 300, status, text: async () => (typeof json === 'string' ? json : JSON.stringify(json)), json: async () => json };
	};
	fn.calls = calls;
	return fn;
}
const ollamaReply = (content, extra = {}) => ({ json: { model: 'qwen3:30b', message: { role: 'assistant', content }, done: true, done_reason: 'stop', prompt_eval_count: 25_000, eval_count: 150, total_duration: 95_300_000_000, ...extra } });
const openaiReply = (content, finish = 'stop') => ({ json: { choices: [{ message: { content }, finish_reason: finish }], usage: { prompt_tokens: 26_000, completion_tokens: 180 } } });
const SUMMARY = 'A foggy morning at the Ferry Building. Brett Walker, an artist from Four Barrel Coffee, joined the show.';

test('the prompt: the Worker\'s summary instructions, the hosts never guests, and a reviewed episode\'s guests', () => {
	const [system, user] = summaryMessages(REVIEWED, 'Good morning.\nIt is foggy.', SUN);
	assert.equal(system.role, 'system');
	assert.match(system.content, /^You summarize transcripts from "Roll Over Easy," a live morning radio show on BFF\.fm/);
	assert.match(system.content, /Respond with a JSON object with one field, "summary"/);
	assert.doesNotMatch(system.content, /"title"|"guests"/);
	assert.match(system.content, /Keep a warm, San Francisco tone\. Use 2-5 sentences total\./);
	assert.ok(system.content.includes(`never its guests: ${HOST_NAMES.join(', ')}.`));
	assert.match(system.content, /never make up weather, temperatures, guests, places or events/);
	assert.match(system.content, /- Date: March 20, 2014\n- Sunrise: 7:13 AM PT\n- Sunset: 7:23 PM PT\n- Guests, checked by hand \(spell their names this way\): Brett Walker/);
	assert.match(system.content, /never guess\. Also mention what time sunrise and sunset were that day\.$/);
	assert.deepEqual(user, { role: 'user', content: 'Summarize this Roll Over Easy episode transcript:\n\nGood morning.\nIt is foggy.' });
	// Unreviewed guests came from the old transcript: not given. No sunrise data: not asked for.
	const [plain] = summaryMessages({ ...REVIEWED, reviewed: false }, 'x', null);
	assert.doesNotMatch(plain.content, /Brett Walker|Sunrise|sunrise and sunset/);
	assert.match(plain.content, /- Date: March 20, 2014\nMention the weather and temperature only if the hosts talk about them in the transcript; never guess\.$/);
});

test('Ollama: the request asks for the whole JSON answer, with the context size set and thinking off', async () => {
	const request = stub(ollamaReply(JSON.stringify({ summary: SUMMARY })));
	const messages = summaryMessages(REVIEWED, 'Good morning.', SUN);
	const answer = await askOllama(messages, { request });
	assert.equal(request.calls.length, 1);
	const { url, init, body } = request.calls[0];
	assert.equal(url, 'http://127.0.0.1:11434/api/chat');
	assert.equal(init.method, 'POST');
	assert.equal(init.headers['Content-Type'], 'application/json');
	assert.ok(init.signal instanceof AbortSignal);
	assert.deepEqual(body, {
		model: 'qwen3:30b',
		messages,
		stream: false,
		think: false,
		format: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
		truncate: false,
		shift: false,
		options: { num_ctx: 32_768, num_predict: OLLAMA_REPLY_TOKENS, temperature: 0.5 },
	});
	assert.deepEqual(answer, { summary: SUMMARY, promptTokens: 25_000, replyTokens: 150, thinkingChars: 0, seconds: 95.3, usd: 0 });
	// Another model, context and thinking on: the reply gets room for the reasoning
	const thinking = ollamaRequest(messages, { model: 'gemma4:26b', numCtx: 40_960, think: true });
	assert.deepEqual([thinking.model, thinking.think, thinking.options.num_ctx, thinking.options.num_predict], ['gemma4:26b', true, 40_960, OLLAMA_THINKING_TOKENS]);
});

test('a reply: plain JSON, JSON after <think>…</think>, after a </think> the prompt opened, or in a fence', async () => {
	assert.equal(parseSummaryReply(JSON.stringify({ summary: `  ${SUMMARY}\n` })), SUMMARY);
	assert.equal(parseSummaryReply(`<think>\nThe hosts mention fog. {"summary": "draft"}\n</think>\n\n{"summary": ${JSON.stringify(SUMMARY)}}`), SUMMARY);
	assert.equal(parseSummaryReply(`Okay, the user wants a summary. It was foggy.\n</think>\n\n{"summary": ${JSON.stringify(SUMMARY)}}`), SUMMARY);
	assert.equal(parseSummaryReply(`Here it is:\n\`\`\`json\n{"summary": ${JSON.stringify(SUMMARY)}}\n\`\`\``), SUMMARY);
	// Through Ollama, with the reasoning apart (think on): only the answer counts
	const request = stub(ollamaReply(`{"summary": ${JSON.stringify(SUMMARY)}}`, { message: { role: 'assistant', content: `{"summary": ${JSON.stringify(SUMMARY)}}`, thinking: 'Let me think about the fog.' } }));
	const answer = await askOllama(summaryMessages(REVIEWED, 'x', null), { request, think: true });
	assert.equal(answer.summary, SUMMARY);
	assert.equal(answer.thinkingChars, 'Let me think about the fog.'.length);
});

test('a malformed reply is refused, and asked for once more', async () => {
	assert.throws(() => parseSummaryReply('A foggy morning at the Ferry Building.'), /not readable JSON/);
	assert.throws(() => parseSummaryReply('{"summary": "A foggy'), /not readable JSON/);
	assert.throws(() => parseSummaryReply('{"summary": "  "}'), /had no summary/);
	assert.throws(() => parseSummaryReply('{"title": "Fog!"}'), /had no summary/);
	assert.throws(() => parseSummaryReply('["A foggy morning"]'), /not readable JSON/);
	assert.throws(() => parseSummaryReply('<think>The summary should say {"summary": "draft"} and'), /in the middle of the model's thinking/);
	assert.throws(() => parseSummaryReply(undefined), /not readable JSON/);

	const messages = summaryMessages(REVIEWED, 'x', null);
	const logged = [];
	const once = stub(ollamaReply('Sure! It was foggy.'), ollamaReply(`{"summary": ${JSON.stringify(SUMMARY)}}`));
	const answer = await withRetries(() => askOllama(messages, { request: once }), retry.ollamaWaitsMs, (l) => logged.push(l));
	assert.equal(answer.summary, SUMMARY);
	assert.equal(once.calls.length, 2);
	assert.match(logged[0], /not readable JSON; asking again in 0 s/);
	const twice = stub(ollamaReply('Sure! It was foggy.'));
	await assert.rejects(withRetries(() => askOllama(messages, { request: twice }), retry.ollamaWaitsMs, () => {}), /not readable JSON/);
	assert.equal(twice.calls.length, 2);
	// Cut off at num_predict: asked again too
	const cut = stub(ollamaReply('{"summary": "A fog', { done_reason: 'length', eval_count: 1024 }));
	await assert.rejects(withRetries(() => askOllama(messages, { request: cut }), retry.ollamaWaitsMs, () => {}), /cut off at 1024 tokens/);
	assert.equal(cut.calls.length, 2);
});

test('Ollama that doesn\'t answer in time is stopped, and asked once more', async () => {
	const hang = stub((url, init) => new Promise((_, reject) => {
		init.signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })));
	}));
	const messages = summaryMessages(REVIEWED, 'x', null);
	const started = Date.now();
	await assert.rejects(askOllama(messages, { request: hang, timeoutMs: 30 }), (err) => err.name === 'TimeoutError' && /Ollama \(qwen3:30b\) gave no answer within 30 ms/.test(err.message));
	assert.ok(Date.now() - started < 2000);
	await assert.rejects(withRetries(() => askOllama(messages, { request: hang, timeoutMs: 30 }), retry.ollamaWaitsMs, () => {}), { name: 'TimeoutError' });
	assert.equal(hang.calls.length, 3);
});

test('Ollama: a prompt too long for the context fails that episode; not running or no such model stops the run', async () => {
	const messages = summaryMessages(REVIEWED, 'x', null);
	// Refused (truncate off), or filled the context (an Ollama that ignores truncate): not asked again
	const refused = stub({ status: 400, json: '{"error":"the input length exceeds the context length"}' });
	await assert.rejects(withRetries(() => askOllama(messages, { request: refused }), retry.ollamaWaitsMs, () => {}), (err) => err.permanent && !err.stopRun && /longer than the model's 32768-token context/.test(err.message));
	assert.equal(refused.calls.length, 1);
	const full = stub(ollamaReply(`{"summary": ${JSON.stringify(SUMMARY)}}`, { prompt_eval_count: 32_700, eval_count: 68 }));
	await assert.rejects(withRetries(() => askOllama(messages, { request: full }), retry.ollamaWaitsMs, () => {}), (err) => err.permanent && /took all of the model's 32768-token context \(32768\)/.test(err.message));
	assert.equal(full.calls.length, 1);
	// No such model
	const missing = stub({ status: 404, json: '{"error":"model \\"qwen3:30b\\" not found, try pulling it first"}' });
	await assert.rejects(askOllama(messages, { request: missing }), (err) => err.permanent && err.stopRun && /Ollama error 404/.test(err.message));
	// Not running
	const refusedConnection = stub(() => Promise.reject(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' })));
	await assert.rejects(askOllama(messages, { request: refusedConnection }), (err) => err.stopRun && /Ollama isn't answering at http:\/\/127\.0\.0\.1:11434 \(ECONNREFUSED\)/.test(err.message));
	await assert.rejects(ollamaModels(undefined, { request: refusedConnection }), (err) => err.stopRun);
	// A server hiccup is asked again
	const hiccup = stub({ status: 500, json: '{"error":"llama runner process has terminated"}' }, ollamaReply(`{"summary": ${JSON.stringify(SUMMARY)}}`));
	assert.equal((await withRetries(() => askOllama(messages, { request: hiccup }), retry.ollamaWaitsMs, () => {})).summary, SUMMARY);
	// The models it has
	assert.deepEqual(await ollamaModels('http://127.0.0.1:11500', { request: stub({ json: { models: [{ name: 'qwen3:30b' }, { model: 'gemma4:26b' }] } }) }), ['qwen3:30b', 'gemma4:26b']);
});

test('OpenAI: GPT-4o-mini as the Worker asks it, its cost, and its refusals', async () => {
	const fetchImpl = stub(openaiReply(JSON.stringify({ summary: SUMMARY })));
	const messages = summaryMessages(REVIEWED, 'Good morning.', SUN);
	const answer = await askOpenAI(messages, { apiKey: 'test-key', fetchImpl });
	const { url, init, body } = fetchImpl.calls[0];
	assert.equal(url, 'https://api.openai.com/v1/chat/completions');
	assert.equal(init.headers.Authorization, 'Bearer test-key');
	assert.deepEqual(body, { model: 'gpt-4o-mini', messages, temperature: 0.5, max_tokens: 600, response_format: { type: 'json_object' } });
	assert.equal(answer.summary, SUMMARY);
	assert.equal(answer.usd.toFixed(6), (26_000 * 0.15e-6 + 180 * 0.6e-6).toFixed(6));
	await assert.rejects(askOpenAI(messages, { apiKey: 'k', fetchImpl: stub(openaiReply('{"summary": "A fo', 'length')) }), /cut off/);
	await assert.rejects(askOpenAI(messages, { apiKey: 'k', fetchImpl: stub({ status: 401, json: '{"error":{"message":"Incorrect API key"}}' }) }), (err) => err.permanent && err.stopRun);
	// A rate limit is asked again (up to three times)
	const limited = stub({ status: 429, json: '{"error":{"message":"Rate limit"}}' }, openaiReply(JSON.stringify({ summary: SUMMARY })));
	assert.equal((await withRetries(() => askOpenAI(messages, { apiKey: 'k', fetchImpl: limited }), retry.openaiWaitsMs, () => {})).summary, SUMMARY);
	assert.equal(limited.calls.length, 2);
});

test('a transcript too long for the context loses its shortest lines first, the rest in order', () => {
	const lines = ['Good morning, San Francisco, this is Roll Over Easy.', 'Yeah.', 'It is a foggy one out here at the Ferry Building.', 'Mm-hmm.', 'Okay.', 'Our guest today is Brett Walker from Four Barrel.']
		.map((text, i) => ({ start_ms: i * 1000, end_ms: i * 1000 + 900, text }));
	const whole = lines.map((l) => l.text).join('\n');
	assert.deepEqual(fitTranscript(lines, Math.ceil(whole.length / CHARS_PER_TOKEN)), { text: whole, leftOut: 0 });
	// 172 characters into 46 tokens (161): "Yeah." and "Okay." go, "Mm-hmm." can stay
	const fit = fitTranscript(lines, 46);
	assert.deepEqual(fit, { text: [lines[0], lines[2], lines[3], lines[5]].map((l) => l.text).join('\n'), leftOut: 2 });
	assert.ok(fit.text.length <= 46 * CHARS_PER_TOKEN);
	assert.equal(fitTranscript(lines, 44).leftOut, 3); // 154: "Mm-hmm." too
	// The budget is the context less the reply and the rest of the prompt
	const prefix = promptTokens(summaryMessages(REVIEWED, '', SUN));
	assert.equal(transcriptBudget(REVIEWED, SUN, { numCtx: 32_768 }), 32_768 - OLLAMA_REPLY_TOKENS - prefix);
	assert.equal(transcriptBudget(REVIEWED, SUN, { numCtx: 40_960, think: true }), 40_960 - OLLAMA_THINKING_TOKENS - prefix);
});

test('sunrise and sunset come in Pacific time, or not at all', async () => {
	const fetchImpl = stub({ json: { status: 'OK', results: { sunrise: '2014-03-20T14:13:05+00:00', sunset: '2014-03-21T02:23:40+00:00' } } });
	assert.deepEqual(await sunTimes('2014-03-20', { fetchImpl }), { sunrise: '7:13 AM', sunset: '7:23 PM' });
	assert.match(fetchImpl.calls[0].url, /^https:\/\/api\.sunrise-sunset\.org\/json\?lat=37\.7955&lng=-122\.3937&date=2014-03-20&formatted=0$/);
	assert.equal(await sunTimes('2014-03-20', { fetchImpl: stub(() => Promise.reject(new Error('offline'))) }), null);
	assert.equal(await sunTimes(null, { fetchImpl }), null);
});

test('the notes: invented weather or temperature, names the transcript lacks, a host as a guest, reasoning', () => {
	const transcript = 'Good morning from the Ferry Building.\nIt is foggy, maybe 52 degrees.\nJane Natolie is here from the Tenderloin.';
	const context = summaryMessages({ ...REVIEWED, guests: ['Jane Natoli'] }, '', SUN)[0].content;
	// Near spellings count, and the prompt's own words (the guests given, the place, the date) are there
	assert.deepEqual(summaryNotes('A foggy 52 degree morning at the Ferry Building. Jane Natoli from the Tenderloin joined the show on March 20.', transcript, context), []);
	// (The Whisper prompt's spelling terms, like Muni, count as known)
	assert.deepEqual(summaryNotes('A sunny, 65 degree morning. Joining the show was Brett Walker. Later Papa Sequoia made a special appearance from the Pickle Club on Muni.', transcript, context), [
		'weather the transcript doesn\'t mention: "sunny"',
		'a temperature the transcript doesn\'t give: 65 degrees',
		'not in the transcript: Brett, Walker, Pickle, Club',
		'a host may be called a guest: "Later Papa Sequoia made a special appearance from the Pickle Club on Muni."',
	]);
	assert.deepEqual(summaryNotes('Sequoia and The Early Bird welcomed Jane Natoli. We had a visit from The Early Bird.', transcript, context), [
		'a host may be called a guest: "We had a visit from The Early Bird."',
	]);
	assert.deepEqual(summaryNotes('Okay, let me summarize the fog at the Ferry Building.', transcript, context), ['reads like the model\'s reasoning, not a summary']);
});
