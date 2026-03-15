#!/usr/bin/env node

/**
 * Local ingest server — drag-and-drop UI for processing new episodes via OpenAI Whisper.
 *
 * Usage:
 *   node scripts/ingest-server.js        # port 3001
 *   node scripts/ingest-server.js 3002   # custom port
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { execSync } from 'node:child_process';

const PORT = parseInt(process.argv[2] || '3001', 10);
const projectRoot = path.resolve(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)), '..');

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, X-Filename',
};

// ── Job queue ──────────────────────────────────────────────────────────

/**
 * @type {{ jobId: string, filename: string, tmpPath: string, lines: {line: string, type: string}[], clients: Set<import('node:http').ServerResponse>, done: boolean, exitCode: number|null }[]}
 */
const jobs = new Map();
const queue = [];
let running = false;

function enqueue(job) {
	queue.push(job);
	if (!running) drain();
}

async function drain() {
	running = true;
	while (queue.length) await queue.shift()();
	running = false;
}

function createJob(jobId, filename, tmpPath) {
	const job = { jobId, filename, tmpPath, lines: [], clients: new Set(), done: false, exitCode: null };
	jobs.set(jobId, job);
	return job;
}

function broadcast(job, event, data) {
	const payload = event === 'message'
		? `data: ${JSON.stringify(data)}\n\n`
		: `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
	for (const client of job.clients) {
		try { client.write(payload); } catch { /* client disconnected */ }
	}
}

function runJob(job) {
	return new Promise((resolve) => {
		const scriptPath = path.join(projectRoot, 'scripts', 'process-episode.js');
		const child = spawn('node', [scriptPath, job.tmpPath, '--openai-whisper'], {
			cwd: projectRoot,
			env: process.env,
		});

		function handleLine(line, type) {
			job.lines.push({ line, type });
			broadcast(job, 'message', { line, type });
		}

		let stdoutBuf = '';
		child.stdout.on('data', (chunk) => {
			stdoutBuf += chunk.toString();
			const parts = stdoutBuf.split('\n');
			stdoutBuf = parts.pop();
			for (const line of parts) handleLine(line, 'out');
		});

		let stderrBuf = '';
		child.stderr.on('data', (chunk) => {
			stderrBuf += chunk.toString();
			const parts = stderrBuf.split('\n');
			stderrBuf = parts.pop();
			for (const line of parts) handleLine(line, 'err');
		});

		child.on('close', (code) => {
			// Flush remaining buffered output
			if (stdoutBuf) handleLine(stdoutBuf, 'out');
			if (stderrBuf) handleLine(stderrBuf, 'err');

			job.done = true;
			job.exitCode = code;

			const event = code === 0 ? 'done' : 'error';
			broadcast(job, event, { exitCode: code });

			// Close SSE connections
			for (const client of job.clients) {
				try { client.end(); } catch { /* already closed */ }
			}
			job.clients.clear();

			// Clean up temp file after a delay (in case of retry)
			setTimeout(() => {
				try { fs.rmSync(job.tmpPath, { force: true }); } catch { /* ignore */ }
				// Also clean up the tmp dir if empty
				try { fs.rmdirSync(path.dirname(job.tmpPath)); } catch { /* ignore */ }
			}, 60_000);

			resolve();
		});
	});
}

// ── HTML UI ────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Roll Over Easy — Episode Ingest</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #0f1117;
    color: #e2e8f0;
    min-height: 100vh;
    padding: 2rem;
  }
  header {
    display: flex;
    align-items: baseline;
    gap: 1rem;
    margin-bottom: 2rem;
    border-bottom: 1px solid #2d3748;
    padding-bottom: 1rem;
  }
  header h1 { font-size: 1.4rem; font-weight: 700; color: #f7fafc; }
  header span { color: #718096; font-size: 0.9rem; }

  #drop-zone {
    border: 2px dashed #4a5568;
    border-radius: 12px;
    padding: 3rem 2rem;
    text-align: center;
    cursor: pointer;
    transition: border-color 0.2s, background 0.2s;
    margin-bottom: 2rem;
    background: #1a202c;
  }
  #drop-zone.drag-over {
    border-color: #63b3ed;
    background: #1a2332;
  }
  #drop-zone p { color: #718096; font-size: 1rem; }
  #drop-zone p strong { color: #a0aec0; }
  #file-input { display: none; }

  #cards { display: flex; flex-direction: column; gap: 1rem; }

  .card {
    border: 1px solid #2d3748;
    border-radius: 8px;
    overflow: hidden;
    background: #1a202c;
  }
  .card.success { border-color: #48bb78; }
  .card.failed  { border-color: #fc8181; }

  .card-header {
    padding: 0.6rem 1rem;
    background: #2d3748;
    font-size: 0.85rem;
    font-weight: 600;
    color: #e2e8f0;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .card.success .card-header { background: #1c4532; color: #9ae6b4; }
  .card.failed  .card-header { background: #3b1b1b; color: #fc8181; }

  .status-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: #718096;
    flex-shrink: 0;
  }
  .card.success .status-dot { background: #48bb78; }
  .card.failed  .status-dot { background: #fc8181; }
  .card:not(.success):not(.failed) .status-dot {
    background: #63b3ed;
    animation: pulse 1.5s infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }

  .card-log {
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 0.75rem;
    line-height: 1.5;
    padding: 0.75rem 1rem;
    max-height: 280px;
    overflow-y: auto;
    background: #111318;
  }
  .log-line { white-space: pre-wrap; word-break: break-all; }
  .log-line.out { color: #cbd5e0; }
  .log-line.err { color: #f6ad55; }
</style>
</head>
<body>
<header>
  <h1>Roll Over Easy</h1>
  <span>Episode Ingest</span>
</header>

<div id="drop-zone">
  <p><strong>Drop MP3 files here</strong></p>
  <p>or click to select files</p>
  <input type="file" id="file-input" accept="audio/mpeg,.mp3" multiple>
</div>

<div id="cards"></div>

<script>
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const cardsEl  = document.getElementById('cards');

dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => handleFiles(fileInput.files));

dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  handleFiles(e.dataTransfer.files);
});

function createCard(filename) {
  const card = document.createElement('div');
  card.className = 'card';

  const header = document.createElement('div');
  header.className = 'card-header';

  const dot = document.createElement('span');
  dot.className = 'status-dot';

  const name = document.createElement('span');
  name.textContent = filename;

  header.appendChild(dot);
  header.appendChild(name);

  const log = document.createElement('div');
  log.className = 'card-log';

  card.appendChild(header);
  card.appendChild(log);
  cardsEl.prepend(card);
  return { card, log };
}

function appendLog({ card, log }, { line, type }) {
  const el = document.createElement('div');
  el.className = 'log-line ' + type;
  el.textContent = line;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

async function processFile(file) {
  const { card, log } = createCard(file.name);

  let res;
  try {
    res = await fetch('/upload', {
      method: 'POST',
      headers: { 'X-Filename': encodeURIComponent(file.name) },
      body: file,
    });
  } catch (err) {
    card.classList.add('failed');
    appendLog({ card, log }, { line: 'Upload failed: ' + err.message, type: 'err' });
    return;
  }

  if (!res.ok) {
    card.classList.add('failed');
    appendLog({ card, log }, { line: 'Server error: ' + res.status, type: 'err' });
    return;
  }

  const { jobId } = await res.json();

  const es = new EventSource('/stream/' + jobId);
  es.onmessage = (e) => appendLog({ card, log }, JSON.parse(e.data));
  es.addEventListener('done',  () => { card.classList.add('success'); es.close(); });
  es.addEventListener('error', (e) => {
    // native EventSource fires 'error' on connection errors too
    if (e.type === 'error' && !e.data) return; // connection issue, not pipeline error
    card.classList.add('failed');
    es.close();
  });
}

async function handleFiles(files) {
  for (const file of files) {
    await processFile(file);
  }
}
</script>
</body>
</html>`;

// ── HTTP server ────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
	const url = new URL(req.url, `http://localhost:${PORT}`);

	// OPTIONS preflight (for cross-origin requests from the admin page)
	if (req.method === 'OPTIONS') {
		res.writeHead(204, CORS_HEADERS);
		res.end();
		return;
	}

	// GET / — serve UI
	if (req.method === 'GET' && url.pathname === '/') {
		res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
		res.end(HTML);
		return;
	}

	// GET /ping — connectivity check for admin page
	if (req.method === 'GET' && url.pathname === '/ping') {
		res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
		res.end(JSON.stringify({ ok: true, port: PORT }));
		return;
	}

	// POST /upload — receive file, queue job
	if (req.method === 'POST' && url.pathname === '/upload') {
		const rawFilename = req.headers['x-filename'];
		if (!rawFilename) {
			res.writeHead(400, { 'Content-Type': 'application/json', ...CORS_HEADERS });
			res.end(JSON.stringify({ error: 'Missing X-Filename header' }));
			return;
		}

		const filename = decodeURIComponent(rawFilename);
		const safeFilename = path.basename(filename); // strip any path components

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `roe-ingest-${Date.now()}-`));
		const tmpPath = path.join(tmpDir, safeFilename);

		const writeStream = fs.createWriteStream(tmpPath);
		req.pipe(writeStream);

		writeStream.on('finish', () => {
			const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			const job = createJob(jobId, safeFilename, tmpPath);

			res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
			res.end(JSON.stringify({ jobId }));

			enqueue(() => runJob(job));
		});

		writeStream.on('error', (err) => {
			res.writeHead(500, { 'Content-Type': 'application/json', ...CORS_HEADERS });
			res.end(JSON.stringify({ error: err.message }));
		});

		return;
	}

	// GET /stream/:jobId — SSE stream
	const streamMatch = url.pathname.match(/^\/stream\/([^/]+)$/);
	if (req.method === 'GET' && streamMatch) {
		const jobId = streamMatch[1];
		const job = jobs.get(jobId);

		if (!job) {
			res.writeHead(404, { 'Content-Type': 'application/json', ...CORS_HEADERS });
			res.end(JSON.stringify({ error: 'Job not found' }));
			return;
		}

		res.writeHead(200, {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			'Connection': 'keep-alive',
			...CORS_HEADERS,
		});

		// Replay buffered lines
		for (const entry of job.lines) {
			res.write(`data: ${JSON.stringify(entry)}\n\n`);
		}

		if (job.done) {
			// Job already finished — send terminal event and close
			const event = job.exitCode === 0 ? 'done' : 'error';
			res.write(`event: ${event}\ndata: ${JSON.stringify({ exitCode: job.exitCode })}\n\n`);
			res.end();
		} else {
			job.clients.add(res);
			req.on('close', () => job.clients.delete(res));
		}

		return;
	}

	res.writeHead(404, { 'Content-Type': 'text/plain' });
	res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
	const url = `http://localhost:${PORT}`;
	console.log(`Roll Over Easy — Ingest Server`);
	console.log(`Listening on ${url}`);
	console.log('');
	console.log('Drag MP3 files onto the drop zone to process them.');
	console.log('Press Ctrl+C to stop.');

	// Open browser
	try {
		execSync(`open "${url}"`, { stdio: 'ignore' });
	} catch {
		// Non-macOS or open not available — silently skip
	}
});
