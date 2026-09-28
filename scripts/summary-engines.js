/**
 * A new summary for an episode that keeps its title and guests: a summary-only
 * prompt made from the Worker's summary instructions (roe-pipeline/src/summary.js),
 * and two engines to send it to:
 *   openai  GPT-4o-mini with the Worker's settings (temperature 0.5, at most 600
 *           tokens, a JSON reply, 90 s): paid, about half a cent a 2-hour show
 *   ollama  a local model through Ollama's /api/chat: free, and slow
 * Both get the same prompt, and their replies the same checks: a JSON object with
 * a non-empty "summary", not cut off. A failed reply is asked for again (OpenAI up
 * to three times, as generate-summaries.js does; Ollama once).
 *
 * The prompt asks for the summary alone, names the hosts (never guests), gives a
 * reviewed episode's hand-checked guests (for their spelling) and the date and
 * sunrise/sunset, and says to invent nothing. summaryNotes() then lists what the
 * owner should check in a new summary. Nothing here reads or writes D1
 * (rewrite-summaries.js does).
 */

import http from 'node:http';
import https from 'node:https';

import { HOST_NAMES } from '../roe-pipeline/src/hosts.js';
import { apiError, PermanentError, TIMEOUT_MS } from '../roe-pipeline/src/limits.js';
import { guestsInTranscript } from '../roe-pipeline/src/summary.js';

export const OPENAI_MODEL = 'gpt-4o-mini';
export const OPENAI_REPLY_TOKENS = 600; // the Worker's max_tokens
export const OPENAI_USD_PER_TOKEN = { in: 0.15 / 1e6, out: 0.6 / 1e6 }; // GPT-4o-mini's price

export const OLLAMA_URL = 'http://127.0.0.1:11434';
export const OLLAMA_MODEL = 'qwen3:30b';
export const OLLAMA_NUM_CTX = 32_768;
export const OLLAMA_NUM_CTX_THINKING = 40_960; // room for the reasoning too
export const OLLAMA_REPLY_TOKENS = 1024; // a 2-5 sentence summary, with room to spare
export const OLLAMA_THINKING_TOKENS = 8192; // a thinking model's reasoning and its summary
// A 2-hour transcript (~27,000 tokens) takes a local model minutes to read on this Mac,
// more if part of it runs on the CPU (qwen3:30b is 18.6 GB, likely more than macOS lets
// the GPU have of 24 GB)
export const OLLAMA_TIMEOUT_MS = 30 * 60_000;

// English runs about 4 characters a token (these transcripts: 5.2 characters a word).
// 3.5 errs on the side of a prompt that fits: Ollama silently drops what doesn't.
export const CHARS_PER_TOKEN = 3.5;
const TEMPLATE_TOKENS = 64; // the chat template's own tokens around the messages

// Waits before asking again; tests set them to 0
export const retry = { openaiWaitsMs: [2_000, 8_000, 20_000], ollamaWaitsMs: [5_000] };

const SUMMARY_SCHEMA = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] };

// ── The prompt ────────────────────────────────────────────────────────

/** "March 20, 2014" from an episode ID (null without a date). */
function showDate(episodeId) {
	const m = /(\d{4})-(\d{2})-(\d{2})/.exec(episodeId);
	if (!m) return null;
	return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12))
		.toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' });
}

/**
 * The Worker's summary instructions (roe-pipeline/src/summary.js, composeSummary), word
 * for word. Copied, not shared: summary.js asks for a title and guests too, and it is the
 * Worker's and process-episode's code. A test checks the copy still matches it.
 */
export const WORKER_SUMMARY_LINES = {
	intro: 'You summarize transcripts from "Roll Over Easy," a live morning radio show on BFF.fm broadcast from the Ferry Building in San Francisco.',
	format: [
		'   Line 1: The weather/vibe that morning (if mentioned — fog, sun, rain, cold, etc.). If not mentioned, skip this line.',
		'   Line 2: Who joined the show — name any guests who came on for a segment and briefly note who they are. The show is live on location, so random passersby sometimes hop on the mic for a few seconds to a few minutes — mention these folks too if they say something memorable or funny.',
		'   Line 3-4: What stories and topics came up — San Francisco news, local culture, neighborhood happenings, food, music, etc.',
		'   Keep a warm, San Francisco tone. Use 2-5 sentences total. Do not use bullet points or labels like "Weather:" — just weave it naturally.',
	],
	weather: 'Mention the weather and temperature only if the hosts talk about them in the transcript; never guess.',
	sun: 'Also mention what time sunrise and sunset were that day.',
	user: 'Summarize this Roll Over Easy episode transcript:',
};

/**
 * The chat messages for one episode's summary: the Worker's summary instructions,
 * asking for the summary only.
 * @param {{id: string, reviewed?: boolean, guests?: string[]}} episode - a reviewed
 *   episode's guests are given as checked by hand; an unreviewed one's came from the
 *   old transcript, so they are left out
 * @param {string} transcriptText - the lines, one per line
 * @param {{sunrise: string, sunset: string}|null} [sun]
 */
export function summaryMessages(episode, transcriptText, sun = null) {
	const w = WORKER_SUMMARY_LINES;
	const system = [
		w.intro,
		'',
		'Respond with a JSON object with one field, "summary": a concise summary of the episode in this format:',
		...w.format,
		'',
		`These are the show's hosts, never its guests: ${HOST_NAMES.join(', ')}. Never say a host joined, visited or was a guest.`,
		'Write only what the transcript says: never make up weather, temperatures, guests, places or events.',
	];
	const date = showDate(episode.id);
	const guests = episode.reviewed ? (episode.guests ?? []) : [];
	if (date || sun || guests.length > 0) {
		system.push('', 'Additional context for this episode:');
		if (date) system.push(`- Date: ${date}`);
		if (sun) system.push(`- Sunrise: ${sun.sunrise} PT`, `- Sunset: ${sun.sunset} PT`);
		if (guests.length > 0) system.push(`- Guests, checked by hand (spell their names this way): ${guests.join(', ')}`);
	}
	// Only with the times to hand: the Worker asks for them even when the lookup failed
	system.push(sun ? `${w.weather} ${w.sun}` : w.weather);
	return [
		{ role: 'system', content: system.join('\n') },
		{ role: 'user', content: `${w.user}\n\n${transcriptText}` },
	];
}

export const estimateTokens = (text) => Math.ceil(text.length / CHARS_PER_TOKEN);

/** A prompt's size in tokens (an estimate on the high side). */
export function promptTokens(messages) {
	return messages.reduce((n, m) => n + estimateTokens(m.content), TEMPLATE_TOKENS);
}

/** How many tokens of transcript fit in a local model's context, next to the rest of the prompt and the reply. */
export function transcriptBudget(episode, sun, { numCtx = OLLAMA_NUM_CTX, think = false } = {}) {
	return numCtx - (think ? OLLAMA_THINKING_TOKENS : OLLAMA_REPLY_TOKENS) - promptTokens(summaryMessages(episode, '', sun));
}

/**
 * The transcript as text for a prompt of at most `maxTokens` of it (estimated): all
 * of it when it fits; otherwise without its shortest lines ("Yeah.", "Mm-hmm."), the
 * rest in order. The Worker never trims (GPT-4o-mini takes 128,000 tokens), but a
 * local model's context is smaller, and Ollama would silently cut the start of the
 * prompt instead, where the weather is.
 * @returns {{text: string, leftOut: number}} leftOut: how many lines were left out
 */
export function fitTranscript(lines, maxTokens) {
	const texts = lines.map((l) => l.text);
	const maxChars = Math.floor(maxTokens * CHARS_PER_TOKEN);
	let chars = texts.reduce((n, t) => n + t.length + 1, 0) - 1; // joined by newlines
	if (chars <= maxChars) return { text: texts.join('\n'), leftOut: 0 };
	const shortestFirst = texts.map((_, i) => i).sort((a, b) => texts[a].length - texts[b].length || a - b);
	const drop = new Set();
	for (const i of shortestFirst) {
		if (chars <= maxChars) break;
		drop.add(i);
		chars -= texts[i].length + 1;
	}
	return { text: texts.filter((_, i) => !drop.has(i)).join('\n'), leftOut: drop.size };
}

// ── The reply ─────────────────────────────────────────────────────────

/**
 * The summary in a model's reply: a JSON object with a non-empty "summary". Reasoning a
 * thinking model left in its answer goes first: <think>…</think> blocks, and everything
 * up to a </think> whose <think> the prompt itself opened (qwen3's template does).
 * Throws on anything else, so a raw or half reply never becomes a summary.
 */
export function parseSummaryReply(content) {
	let text = String(content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '');
	const close = text.lastIndexOf('</think>');
	if (close !== -1) text = text.slice(close + '</think>'.length);
	text = text.trim();
	if (text.includes('<think>')) throw new Error('The summary reply stopped in the middle of the model\'s thinking');
	let parsed = null;
	// The whole reply, or the object in it (```json fences, a sentence before it)
	for (const candidate of [text, text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)]) {
		try {
			parsed = JSON.parse(candidate);
			break;
		} catch { /* the next one */ }
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The summary reply was not readable JSON');
	const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
	if (!summary) throw new Error('The summary reply had no summary');
	return summary;
}

// ── Asking ────────────────────────────────────────────────────────────

const duration = (ms) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`);

/** Run `fn(signal)`, stopping it after `ms` with a TimeoutError that says who didn't answer. */
async function timed(who, ms, fn) {
	const controller = new AbortController();
	const timer = setTimeout(() => {
		const err = new Error(`${who} gave no answer within ${duration(ms)}`);
		err.name = 'TimeoutError';
		controller.abort(err);
	}, ms);
	try {
		return await fn(controller.signal);
	} catch (err) {
		throw controller.signal.aborted ? controller.signal.reason : err;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * fetch's shape over node:http. fetch gives up after 300 s without the reply's
 * headers, and Ollama sends none until its whole answer is ready, which can take
 * longer on this Mac. `agent: false`: no socket kept for later.
 */
export function httpRequest(url, { method = 'GET', headers = {}, body, signal } = {}) {
	const client = url.startsWith('https:') ? https : http;
	return new Promise((resolve, reject) => {
		const req = client.request(url, {
			method,
			headers: body == null ? headers : { ...headers, 'Content-Length': Buffer.byteLength(body) },
			agent: false,
			signal,
		}, (res) => {
			const chunks = [];
			res.on('data', (c) => chunks.push(c));
			res.on('error', reject);
			res.on('end', () => {
				const text = Buffer.concat(chunks).toString('utf-8');
				resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: async () => text, json: async () => JSON.parse(text) });
			});
		});
		req.on('error', reject);
		req.end(body);
	});
}

/** Ollama not running (or not there): no episode can be done, so the run stops. */
function unreachable(err, url) {
	const code = err?.code ?? err?.cause?.code;
	if (!['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'EADDRNOTAVAIL'].includes(code)) return null;
	const out = new PermanentError(`Ollama isn't answering at ${url} (${code}): start the Ollama app, or run \`ollama serve\``);
	out.stopRun = true;
	return out;
}

/** This episode's prompt is longer than the context: asking again won't help, but the next episode may fit. */
function tooLong(numCtx, detail) {
	return new PermanentError(`the prompt is longer than the model's ${numCtx}-token context (Ollama: ${String(detail).slice(0, 200)}): use a larger --num-ctx`);
}

/** An HTTP error; one no episode would get past (a bad key, no such model, a bad request) stops the run. */
function httpError(service, status, body, stopStatuses) {
	const err = apiError(service, status, body);
	if (stopStatuses.includes(status)) err.stopRun = true;
	return err;
}

/**
 * Ask GPT-4o-mini for the summary, as the Worker asks it (summary.js).
 * @param {{usd: number}} [meter] - adds what each answer cost, a refused one included
 *   (a cut-off or unreadable reply is paid for too)
 * @returns {Promise<{summary: string, promptTokens: number, replyTokens: number, usd: number}>}
 */
export async function askOpenAI(messages, { apiKey, fetchImpl = fetch, timeoutMs = TIMEOUT_MS.summary, meter = null } = {}) {
	const data = await timed('OpenAI', timeoutMs, async (signal) => {
		const res = await fetchImpl('https://api.openai.com/v1/chat/completions', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
			body: JSON.stringify({
				model: OPENAI_MODEL,
				messages,
				temperature: 0.5,
				max_tokens: OPENAI_REPLY_TOKENS,
				response_format: { type: 'json_object' },
			}),
			signal,
		});
		if (!res.ok) throw httpError('OpenAI API', res.status, await res.text(), [401, 403, 404]);
		return res.json();
	});
	const promptTokens = data.usage?.prompt_tokens ?? 0;
	const replyTokens = data.usage?.completion_tokens ?? 0;
	const usd = promptTokens * OPENAI_USD_PER_TOKEN.in + replyTokens * OPENAI_USD_PER_TOKEN.out;
	if (meter) meter.usd += usd;
	const choice = data.choices?.[0];
	if (choice?.finish_reason === 'length') throw new Error('The summary reply was cut off');
	return { summary: parseSummaryReply(choice?.message?.content), promptTokens, replyTokens, usd };
}

/**
 * The /api/chat request: the whole answer at once, as JSON with a "summary" (Ollama
 * holds the model to the schema), the context size set (Ollama's default is far too
 * small for a 2-hour transcript), and thinking off unless `think`. With think on, a
 * thinking model's reasoning comes back apart from the answer (message.thinking).
 * truncate and shift off: a prompt too long for the context is refused rather than
 * cut, and a full context ends the reply rather than dropping the transcript's start
 * (Ollama 0.34 has both; an older one ignores them, and the check on the counts in
 * askOllama catches it).
 */
export function ollamaRequest(messages, { model = OLLAMA_MODEL, numCtx = OLLAMA_NUM_CTX, think = false } = {}) {
	return {
		model,
		messages,
		stream: false,
		think,
		format: SUMMARY_SCHEMA,
		truncate: false,
		shift: false,
		options: { num_ctx: numCtx, num_predict: think ? OLLAMA_THINKING_TOKENS : OLLAMA_REPLY_TOKENS, temperature: 0.5 },
	};
}

/**
 * Ask a local model through Ollama for the summary.
 * @returns {Promise<{summary: string, promptTokens: number|null, replyTokens: number|null, thinkingChars: number, seconds: number|null, usd: 0}>}
 */
export async function askOllama(messages, { url = OLLAMA_URL, model, numCtx, think, request = httpRequest, timeoutMs = OLLAMA_TIMEOUT_MS } = {}) {
	const body = ollamaRequest(messages, { model, numCtx, think });
	const data = await timed(`Ollama (${body.model})`, timeoutMs, async (signal) => {
		let res;
		try {
			res = await request(`${url}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
		} catch (err) {
			throw unreachable(err, url) ?? err;
		}
		if (!res.ok) {
			const text = await res.text();
			if (/exceeds the context length/i.test(text)) throw tooLong(body.options.num_ctx, text);
			throw httpError('Ollama', res.status, text, [400, 404]);
		}
		return res.json();
	});
	if (data.error) throw /exceeds the context length/i.test(data.error) ? tooLong(body.options.num_ctx, data.error) : new Error(`Ollama: ${data.error}`);
	// A prompt that didn't fit loses its start (and the reply its room): refuse the answer.
	// Only a fallback for an Ollama without truncate: prompt_eval_count leaves out tokens it
	// had cached, so this can miss one (the estimate the transcript was fitted to errs high).
	const used = (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0);
	if (used >= body.options.num_ctx) {
		throw new PermanentError(`the prompt and reply took all of the model's ${body.options.num_ctx}-token context (${used}), so Ollama may have left part of the transcript out: use a larger --num-ctx`);
	}
	if (data.done_reason === 'length') throw new Error(`The summary reply was cut off at ${data.eval_count} tokens`);
	return {
		summary: parseSummaryReply(data.message?.content),
		promptTokens: data.prompt_eval_count ?? null,
		replyTokens: data.eval_count ?? null,
		thinkingChars: data.message?.thinking?.length ?? 0,
		seconds: data.total_duration ? Math.round(data.total_duration / 1e8) / 10 : null,
		usd: 0,
	};
}

/** The models Ollama has, by name ("qwen3:30b"). Throws (stopRun) when it isn't running. */
export async function ollamaModels(url = OLLAMA_URL, { request = httpRequest, timeoutMs = 15_000 } = {}) {
	const data = await timed('Ollama', timeoutMs, async (signal) => {
		let res;
		try {
			res = await request(`${url}/api/tags`, { signal });
		} catch (err) {
			throw unreachable(err, url) ?? err;
		}
		if (!res.ok) throw apiError('Ollama', res.status, await res.text());
		return res.json();
	});
	return (data.models ?? []).map((m) => m.name ?? m.model).filter(Boolean);
}

/** Call `ask` until it answers, waiting `waitsMs[i]` before each new try; a permanent error isn't tried again. */
export async function withRetries(ask, waitsMs, log = console.warn) {
	for (let attempt = 0; ; attempt++) {
		try {
			return await ask();
		} catch (err) {
			if (err.permanent || attempt >= waitsMs.length) throw err;
			log(`    ${err.message.split('\n')[0]}; asking again in ${waitsMs[attempt] / 1000} s`);
			await new Promise((resolve) => setTimeout(resolve, waitsMs[attempt]));
		}
	}
}

// ── Sunrise and sunset ────────────────────────────────────────────────

function pacificTime(iso) {
	return new Date(iso).toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' });
}

/**
 * Sunrise and sunset at the Ferry Building on a YYYY-MM-DD date, Pacific time, as the
 * Worker gets them (null if the lookup fails). lib.js's fetchSunriseSunset without a time
 * limit could hold a run up, and it logs a failure to pipeline-errors.log.
 */
export async function sunTimes(dateStr, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS.sunrise } = {}) {
	if (!dateStr) return null;
	try {
		return await timed('The sunrise lookup', timeoutMs, async (signal) => {
			const res = await fetchImpl(`https://api.sunrise-sunset.org/json?lat=37.7955&lng=-122.3937&date=${dateStr}&formatted=0`, { signal });
			const data = await res.json();
			if (data.status !== 'OK') return null;
			return { sunrise: pacificTime(data.results.sunrise), sunset: pacificTime(data.results.sunset) };
		});
	} catch {
		return null;
	}
}

// ── What to check in a summary ────────────────────────────────────────

const WEATHER = [
	/\bfog(?:gy)?\b/i,
	/\b(?:sunny|sunshine)\b/i,
	/\b(?:rain|rainy|raining|drizzle|drizzly)\b/i,
	/\b(?:cloudy|overcast)\b/i,
	/\bwindy?\b/i,
	/\b(?:cold|chilly|freezing)\b/i,
	/\b(?:hot|heat)\b/i,
];
const TEMPERATURE = /\b(\d{2,3})\s*(?:°|degrees?\b)/gi;
const REASONING = /^(?:okay|ok|alright|all right|hmm|let me|let's|first,|i need|i'll|i will|i should|we need|the user|the transcript)\b/i;
const JOINED = /\b(?:joined by|joining (?:the show|them|us)|visit(?:ed)? (?:from|by)|appearance (?:by|from)|special guests?|guests? (?:included|were|was))\b/i;

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const HOSTS = HOST_NAMES.map(escapeRegExp).sort((a, b) => b.length - a.length).join('|');
const HOST_JOINED = new RegExp(`(?:${JOINED.source})[^.!?]{0,40}\\b(?:${HOSTS})\\b|\\b(?:${HOSTS})\\b[^.!?]{0,30}\\b(?:joined|stopped by|dropped by|visited|appearance)\\b`, 'i');

const sentences = (text) => text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);

/** Capitalized words that don't start a sentence (names, places), without a possessive 's. */
function capitalizedWords(text) {
	const out = new Set();
	for (const sentence of sentences(text)) {
		const words = sentence.split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').replace(/['’]s$/u, ''));
		for (const w of words.slice(1)) if (/^\p{Lu}/u.test(w)) out.add(w);
	}
	return [...out];
}

/**
 * What the owner should check in a summary, the way the Worker checks its guests
 * against the transcript: weather or a temperature the transcript never mentions,
 * capitalized words it doesn't have (a made-up name or place; near spellings count as
 * there), a host called a guest, and reasoning where the summary should be (a thinking
 * model). Notes don't stop a summary; they go with it for review.
 * @param {string} context - the prompt's own text (the date, the hosts, the guests given)
 */
export function summaryNotes(summary, transcriptText, context = '') {
	const notes = [];
	for (const re of WEATHER) {
		const word = summary.match(re)?.[0];
		if (word && !re.test(transcriptText)) notes.push(`weather the transcript doesn't mention: "${word}"`);
	}
	for (const [, n] of summary.matchAll(TEMPERATURE)) {
		if (!new RegExp(`\\b${n}\\b[^\\n]{0,20}\\bdegree`, 'i').test(transcriptText)) notes.push(`a temperature the transcript doesn't give: ${n} degrees`);
	}
	const words = capitalizedWords(summary);
	const found = new Set(guestsInTranscript(words, `${transcriptText}\n${context}`));
	const unknown = words.filter((w) => !found.has(w));
	if (unknown.length > 0) notes.push(`not in the transcript: ${unknown.join(', ')}`);
	for (const s of sentences(summary)) {
		if (HOST_JOINED.test(s)) notes.push(`a host may be called a guest: "${s}"`);
	}
	if (REASONING.test(summary)) notes.push('reads like the model\'s reasoning, not a summary');
	return notes;
}
