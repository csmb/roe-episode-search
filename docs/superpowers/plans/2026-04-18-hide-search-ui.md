# Hide Search UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove transcript search from the public site and move it behind the password-protected admin page.

**Architecture:** Remove search input, mode toggle, and per-episode search buttons from `frontend.html` and `episodes.html`. Add an `/admin` route to `index.js` with password protection via `ADMIN_PASSWORD` worker secret. Add a "Search" tab to `admin.html` with the full search UI.

**Tech Stack:** Cloudflare Workers, D1, inline HTML, Wrangler secrets

---

### Task 1: Remove search UI from `frontend.html`

**Files:**
- Modify: `roe-search/src/frontend.html:683-701` (search bar + mode toggle)
- Modify: `roe-search/src/frontend.html:816-828` (URL auto-search)
- Modify: `roe-search/src/frontend.html:675` (nav link)
- Modify: `roe-search/src/frontend.html:877` (clip card search button)
- Modify: `roe-search/src/frontend.html:935` (On This Day search button)
- Modify: `roe-search/src/frontend.html:1097-1101` (renderEpisode search button)

- [ ] **Step 1: Remove the search bar and mode toggle from the DOM**

In `frontend.html`, replace the search box and mode toggle (lines 683-695):

```html
			<div class="search-box">
				<label for="search-input" class="sr-only">Search episodes</label>
				<input type="text" id="search-input" placeholder="Search through the fog...">
				<button id="search-btn">Search</button>
			</div>
			<div class="search-mode">
				<span class="search-mode-label">Search mode:</span>
				<div class="mode-toggle">
					<button id="mode-keyword" class="active" onclick="setSearchMode('keyword')">Keyword</button>
					<button id="mode-semantic" onclick="setSearchMode('semantic')">Semantic</button>
				</div>
			</div>
```

with nothing (delete those lines entirely).

- [ ] **Step 2: Remove the URL-based auto-search**

Replace the URL parameter handling block (lines 816-828):

```javascript
const params = new URLSearchParams(window.location.search);
if (params.get('mode') === 'semantic') {
	setSearchMode('semantic');
}
if (params.get('episode')) {
	loadClip(params.get('episode'), parseInt(params.get('t') || '0', 10));
} else if (params.get('bummer-and-lazarus-fetch-me')) {
	searchInput.value = deslugify(params.get('bummer-and-lazarus-fetch-me'));
	doSearch();
} else {
	loadOnThisDay();
}
```

with:

```javascript
const params = new URLSearchParams(window.location.search);
if (params.get('episode')) {
	loadClip(params.get('episode'), parseInt(params.get('t') || '0', 10));
} else {
	loadOnThisDay();
}
```

- [ ] **Step 3: Remove the per-episode "Search" button from `loadClip()`**

Delete this line from the `loadClip()` function (line 877):

```javascript
			html += '<a class="ep-btn" href="/?q=&episode=' + encodeURIComponent(ep.id) + '">&#128269; Search</a>';
```

- [ ] **Step 4: Remove the per-episode "Search" button from `loadOnThisDay()`**

Delete this line from the `loadOnThisDay()` function (line 935):

```javascript
			html += '<a class="ep-btn" href="/?q=&episode=' + encodeURIComponent(ep.id) + '">&#128269; Search</a>';
```

- [ ] **Step 5: Remove the per-episode "Search" button from `renderEpisode()`**

Delete these lines from the `renderEpisode()` function (lines 1097-1101):

```javascript
	const searchBtn = document.createElement('a');
	searchBtn.className = 'ep-btn';
	searchBtn.innerHTML = '&#128269; Search';
	searchBtn.href = '/?q=&episode=' + encodeURIComponent(episode.episode_id);
	actions.appendChild(searchBtn);
```

- [ ] **Step 6: Update nav — drop "Search" link**

Replace (line 675):

```html
		<nav aria-label="Main navigation"><a href="/episodes">Episodes</a> · <a href="/map">Map</a> · <a href="/" aria-current="page">Search</a></nav>
```

with:

```html
		<nav aria-label="Main navigation"><a href="/episodes">Episodes</a> · <a href="/map">Map</a></nav>
```

- [ ] **Step 7: Commit**

```bash
git add roe-search/src/frontend.html
git commit -m "feat: remove search UI from public homepage"
```

---

### Task 2: Remove search button from `episodes.html` and update all nav links

**Files:**
- Modify: `roe-search/src/episodes.html:280` (nav)
- Modify: `roe-search/src/episodes.html:391` (search button)
- Modify: `roe-search/src/guests.html:151` (nav)
- Modify: `roe-search/src/map.html:136` (nav)
- Modify: `roe-search/src/admin.html:275` (nav)

- [ ] **Step 1: Remove per-episode search button from `episodes.html`**

Delete this line (line 391):

```javascript
			html += '<a class="ep-btn" href="/?q=&episode=' + encodeURIComponent(ep.id) + '">&#128269; Search</a>';
```

- [ ] **Step 2: Update nav in `episodes.html`**

Replace (line 280):

```html
		<nav aria-label="Main navigation"><a href="/episodes" aria-current="page">Episodes</a> · <a href="/map">Map</a> · <a href="/">Search</a></nav>
```

with:

```html
		<nav aria-label="Main navigation"><a href="/episodes" aria-current="page">Episodes</a> · <a href="/map">Map</a></nav>
```

- [ ] **Step 3: Update nav in `guests.html`**

Replace (line 151):

```html
		<nav aria-label="Main navigation"><a href="/episodes">Episodes</a> · <a href="/map">Map</a> · <a href="/">Search</a></nav>
```

with:

```html
		<nav aria-label="Main navigation"><a href="/episodes">Episodes</a> · <a href="/map">Map</a></nav>
```

- [ ] **Step 4: Update nav in `map.html`**

Replace (line 136):

```html
		<nav aria-label="Main navigation"><a href="/episodes">Episodes</a> · <a href="/map" aria-current="page">Map</a> · <a href="/">Search</a></nav>
```

with:

```html
		<nav aria-label="Main navigation"><a href="/episodes">Episodes</a> · <a href="/map" aria-current="page">Map</a></nav>
```

- [ ] **Step 5: Update nav in `admin.html`**

Replace (line 275):

```html
		<nav aria-label="Main navigation"><a href="/episodes">Episodes</a> · <a href="/map">Map</a> · <a href="/">Search</a></nav>
```

with:

```html
		<nav aria-label="Main navigation"><a href="/episodes">Episodes</a> · <a href="/map">Map</a></nav>
```

- [ ] **Step 6: Commit**

```bash
git add roe-search/src/episodes.html roe-search/src/guests.html roe-search/src/map.html roe-search/src/admin.html
git commit -m "feat: remove search buttons and nav links from public pages"
```

---

### Task 3: Add `/admin` route with password protection in `index.js`

**Files:**
- Modify: `roe-search/src/index.js:1-3` (add admin.html import)
- Modify: `roe-search/src/index.js:63-111` (add admin route + password check)

- [ ] **Step 1: Add admin.html import**

Add after line 3 (`import GUESTS_HTML from './guests.html';`):

```javascript
import ADMIN_HTML from './admin.html';
```

- [ ] **Step 2: Add password checking helper function**

Add after the `getCorsOrigin` function (after line 59):

```javascript
function checkAdminPassword(request, env) {
	const password = request.headers.get('X-Admin-Password');
	return password && password === env.ADMIN_PASSWORD;
}
```

- [ ] **Step 3: Add `/admin` route and protect `/api/admin/*` routes**

In the router, add the `/admin` route and `/api/admin/*` password check. Add before the `/api/search` route (before line 68):

```javascript
		// Admin routes — password protected
		if (url.pathname === '/admin') {
			return new Response(ADMIN_HTML, { headers: HTML_HEADERS });
		}
		if (url.pathname.startsWith('/api/admin/')) {
			if (!checkAdminPassword(request, env)) {
				return json({ error: 'Unauthorized' }, 401, request);
			}
			return handleAdminApi(url, env, request);
		}
```

- [ ] **Step 4: Add the admin API handler**

Add the `handleAdminApi` function after the `handleGuests` function (after line 471):

```javascript
async function handleAdminApi(url, env, request) {
	const path = url.pathname.slice('/api/admin/'.length);

	if (path === 'unreviewed') {
		try {
			const { results } = await env.DB.prepare(`
				SELECT e.id, e.title, e.published_at
				FROM episodes e
				WHERE e.guests_reviewed = 0
				ORDER BY e.id DESC
			`).all();

			const episodes = [];
			for (const ep of results) {
				const { results: guests } = await env.DB.prepare(
					'SELECT guest_name FROM episode_guests WHERE episode_id = ?1'
				).bind(ep.id).all();
				episodes.push({
					id: ep.id,
					title: ep.title,
					published_at: ep.published_at,
					guests: guests.map(g => g.guest_name),
				});
			}
			return json({ episodes }, 200, request);
		} catch (err) {
			return json({ error: 'Failed to fetch unreviewed episodes' }, 500, request);
		}
	}

	if (path === 'guest/rename' && request.method === 'POST') {
		try {
			const body = await request.json();
			const { old_name, new_name } = body;
			if (!old_name || !new_name) return json({ error: 'Missing old_name or new_name' }, 400, request);
			await env.DB.prepare('UPDATE episode_guests SET guest_name = ?1 WHERE guest_name = ?2')
				.bind(new_name, old_name).run();
			return json({ ok: true }, 200, request);
		} catch (err) {
			return json({ error: 'Rename failed' }, 500, request);
		}
	}

	if (path === 'guest/delete' && request.method === 'POST') {
		try {
			const body = await request.json();
			const { guest_name } = body;
			if (!guest_name) return json({ error: 'Missing guest_name' }, 400, request);
			await env.DB.prepare('DELETE FROM episode_guests WHERE guest_name = ?1')
				.bind(guest_name).run();
			return json({ ok: true }, 200, request);
		} catch (err) {
			return json({ error: 'Delete failed' }, 500, request);
		}
	}

	if (path === 'episode/reviewed' && request.method === 'POST') {
		try {
			const body = await request.json();
			const { episode_id } = body;
			if (!episode_id) return json({ error: 'Missing episode_id' }, 400, request);
			await env.DB.prepare('UPDATE episodes SET guests_reviewed = 1 WHERE id = ?1')
				.bind(episode_id).run();
			return json({ ok: true }, 200, request);
		} catch (err) {
			return json({ error: 'Update failed' }, 500, request);
		}
	}

	if (path === 'episode/duration' && request.method === 'POST') {
		try {
			const body = await request.json();
			const { episode_id, duration_ms } = body;
			if (!episode_id || !duration_ms) return json({ error: 'Missing episode_id or duration_ms' }, 400, request);
			await env.DB.prepare('UPDATE episodes SET duration_ms = ?1 WHERE id = ?2')
				.bind(duration_ms, episode_id).run();
			return json({ ok: true }, 200, request);
		} catch (err) {
			return json({ error: 'Update failed' }, 500, request);
		}
	}

	return json({ error: 'Not found' }, 404, request);
}
```

- [ ] **Step 5: Commit**

```bash
git add roe-search/src/index.js
git commit -m "feat: add /admin route with password protection and admin API handlers"
```

---

### Task 4: Add password prompt and Search tab to `admin.html`

**Files:**
- Modify: `roe-search/src/admin.html`

- [ ] **Step 1: Add password prompt overlay CSS**

Add these styles inside the `<style>` block, before the closing `</style>` tag (before line 266):

```css
	/* Auth overlay */
	.auth-overlay {
		position: fixed;
		inset: 0;
		background: #f5f5f5;
		z-index: 2000;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.auth-box {
		text-align: center;
		max-width: 320px;
		padding: 2rem;
	}
	.auth-box h2 {
		font-size: 1.3rem;
		color: #2c2c2c;
		margin-bottom: 1rem;
	}
	.auth-box input {
		width: 100%;
		padding: 10px 14px;
		font-size: 1rem;
		border: 1px solid #d0d0d0;
		border-radius: 8px;
		outline: none;
		margin-bottom: 12px;
		font-family: inherit;
	}
	.auth-box input:focus {
		border-color: #505050;
		box-shadow: 0 0 0 3px rgba(80,80,80,0.25);
	}
	.auth-box button {
		width: 100%;
		padding: 10px;
		font-size: 1rem;
		font-weight: 600;
		background: #505050;
		color: #fff;
		border: none;
		border-radius: 8px;
		cursor: pointer;
		font-family: inherit;
	}
	.auth-box button:hover { background: #303030; }
	.auth-error {
		color: #c0392b;
		font-size: 0.85rem;
		margin-top: 8px;
		display: none;
	}
```

- [ ] **Step 2: Add search tab CSS**

Add these styles in the same `<style>` block, right after the auth overlay CSS:

```css
	/* Search tab */
	.search-box {
		display: flex;
		gap: 10px;
		margin-bottom: 16px;
	}
	.search-box input {
		flex: 1;
		padding: 12px 18px;
		font-size: 1rem;
		border: 1px solid #d0d0d0;
		border-radius: 50px;
		outline: none;
		background: #fff;
		font-family: inherit;
	}
	.search-box input:focus {
		border-color: #505050;
		box-shadow: 0 0 0 3px rgba(80,80,80,0.25);
	}
	.search-box button {
		padding: 12px 24px;
		font-size: 1rem;
		font-weight: 600;
		background: #505050;
		color: #fff;
		border: none;
		border-radius: 50px;
		cursor: pointer;
		font-family: inherit;
	}
	.search-box button:hover { background: #303030; }
	.search-mode {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 16px;
		font-size: 0.9rem;
		color: #666;
	}
	.mode-toggle {
		display: inline-flex;
		background: #e8e8e8;
		border-radius: 50px;
		padding: 2px;
	}
	.mode-toggle button {
		padding: 6px 16px;
		font-size: 0.85rem;
		font-weight: 600;
		border: none;
		border-radius: 50px;
		cursor: pointer;
		background: transparent;
		color: #636363;
		font-family: inherit;
	}
	.mode-toggle button.active {
		background: #505050;
		color: #fff;
	}
	.search-result {
		background: #fff;
		border-radius: 10px;
		box-shadow: 0 2px 8px rgba(0,0,0,0.06);
		margin-bottom: 12px;
		padding: 16px;
	}
	.search-result-title {
		font-weight: 600;
		font-size: 1rem;
		color: #2c2c2c;
		margin-bottom: 6px;
	}
	.search-result-meta {
		color: #767676;
		font-size: 0.85rem;
		margin-bottom: 8px;
	}
	.search-match {
		padding: 6px 0;
		border-top: 1px solid #eee;
		font-size: 0.9rem;
		line-height: 1.5;
	}
	.search-match:first-child { border-top: none; }
	.search-match .timestamp {
		font-family: monospace;
		font-size: 0.8rem;
		color: #505050;
		margin-right: 8px;
	}
	.search-match mark {
		background: #e0e0e0;
		padding: 1px 3px;
		border-radius: 2px;
	}
	.search-load-more {
		display: block;
		width: 100%;
		padding: 12px;
		font-size: 0.95rem;
		font-weight: 600;
		background: #fff;
		color: #505050;
		border: 1px solid #d0d0d0;
		border-radius: 50px;
		cursor: pointer;
		margin-top: 8px;
		font-family: inherit;
	}
	.search-load-more:hover { border-color: #999; }
	@media (max-width: 768px) {
		.search-box { flex-direction: column; }
		.search-box button { width: 100%; }
	}
```

- [ ] **Step 3: Add the auth overlay HTML**

Add right after the opening `<body>` tag (after line 268):

```html
<div id="auth-overlay" class="auth-overlay">
	<div class="auth-box">
		<h2>Admin Access</h2>
		<input type="password" id="auth-password" placeholder="Password" autocomplete="current-password">
		<button id="auth-submit">Enter</button>
		<div id="auth-error" class="auth-error">Wrong password</div>
	</div>
</div>
```

- [ ] **Step 4: Add the Search tab button**

Add a fourth tab button after the Tools tab (line 283). Change:

```html
		<button id="tab-tools" class="tab">Tools</button>
```

to:

```html
		<button id="tab-tools" class="tab">Tools</button>
		<button id="tab-search" class="tab">Search</button>
```

- [ ] **Step 5: Add the Search panel HTML**

Add after the Tools panel closing `</div>` (after line 304):

```html
	<!-- Panel: Search -->
	<div id="panel-search" style="display:none;">
		<div class="search-box">
			<input type="text" id="search-input" placeholder="Search transcripts...">
			<button id="search-btn">Search</button>
		</div>
		<div class="search-mode">
			<span>Mode:</span>
			<div class="mode-toggle">
				<button id="mode-keyword" class="active">Keyword</button>
				<button id="mode-semantic">Semantic</button>
			</div>
		</div>
		<div id="search-status" class="status"></div>
		<div id="search-results"></div>
		<button id="search-load-more" class="search-load-more" style="display:none;">Load more results</button>
	</div>
```

- [ ] **Step 6: Add the Search tab to the tab switching logic**

Replace the existing tab switching code (lines 312-326):

```javascript
document.getElementById('tab-guests').onclick = () => showTab('guests');
document.getElementById('tab-queue').onclick  = () => showTab('queue');
document.getElementById('tab-tools').onclick  = () => showTab('tools');

function showTab(tab) {
	activeTab = tab;
	document.getElementById('panel-guests').style.display = tab === 'guests' ? '' : 'none';
	document.getElementById('panel-queue').style.display  = tab === 'queue'  ? '' : 'none';
	document.getElementById('panel-tools').style.display  = tab === 'tools'  ? '' : 'none';
	document.getElementById('tab-guests').classList.toggle('active', tab === 'guests');
	document.getElementById('tab-queue').classList.toggle('active', tab === 'queue');
	document.getElementById('tab-tools').classList.toggle('active', tab === 'tools');
}
```

with:

```javascript
document.getElementById('tab-guests').onclick = () => showTab('guests');
document.getElementById('tab-queue').onclick  = () => showTab('queue');
document.getElementById('tab-tools').onclick  = () => showTab('tools');
document.getElementById('tab-search').onclick = () => showTab('search');

function showTab(tab) {
	activeTab = tab;
	document.getElementById('panel-guests').style.display = tab === 'guests' ? '' : 'none';
	document.getElementById('panel-queue').style.display  = tab === 'queue'  ? '' : 'none';
	document.getElementById('panel-tools').style.display  = tab === 'tools'  ? '' : 'none';
	document.getElementById('panel-search').style.display = tab === 'search' ? '' : 'none';
	document.getElementById('tab-guests').classList.toggle('active', tab === 'guests');
	document.getElementById('tab-queue').classList.toggle('active', tab === 'queue');
	document.getElementById('tab-tools').classList.toggle('active', tab === 'tools');
	document.getElementById('tab-search').classList.toggle('active', tab === 'search');
}
```

- [ ] **Step 7: Add password auth and admin API header logic**

Replace the existing `apiPost` helper and add the auth logic. Replace lines 328-341:

```javascript
// ── API helpers ────────────────────────────────────────────────────────

async function apiPost(path, body) {
	const res = await fetch(path, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({ error: 'Request failed' }));
		throw new Error(err.error || 'Request failed');
	}
	return res.json();
}
```

with:

```javascript
// ── Auth ──────────────────────────────────────────────────────────────

function getPassword() { return sessionStorage.getItem('admin_pw') || ''; }

async function verifyPassword(pw) {
	const res = await fetch('/api/admin/unreviewed', {
		headers: { 'X-Admin-Password': pw },
	});
	return res.ok;
}

(async function initAuth() {
	const overlay = document.getElementById('auth-overlay');
	const input = document.getElementById('auth-password');
	const btn = document.getElementById('auth-submit');
	const err = document.getElementById('auth-error');

	// Check if already authenticated this session
	const saved = getPassword();
	if (saved && await verifyPassword(saved)) {
		overlay.remove();
		loadAndRender();
		return;
	}

	async function tryLogin() {
		const pw = input.value;
		if (!pw) return;
		btn.disabled = true;
		err.style.display = 'none';
		if (await verifyPassword(pw)) {
			sessionStorage.setItem('admin_pw', pw);
			overlay.remove();
			loadAndRender();
		} else {
			err.style.display = '';
			btn.disabled = false;
			input.select();
		}
	}

	btn.onclick = tryLogin;
	input.onkeydown = (e) => { if (e.key === 'Enter') tryLogin(); };
	input.focus();
})();

// ── API helpers ────────────────────────────────────────────────────────

async function apiPost(path, body) {
	const res = await fetch(path, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'X-Admin-Password': getPassword(),
		},
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({ error: 'Request failed' }));
		throw new Error(err.error || 'Request failed');
	}
	return res.json();
}
```

- [ ] **Step 8: Add the search functionality JS**

Add this search code right before the `// ── Init` section at the bottom (before line 662, which is `// ── Init`):

```javascript
// ── Search tab ────────────────────────────────────────────────────────

let searchQuery = '';
let searchPage = 1;
let searchHasMore = false;
let searchModeVal = 'keyword';

document.getElementById('mode-keyword').onclick = () => {
	searchModeVal = 'keyword';
	document.getElementById('mode-keyword').classList.add('active');
	document.getElementById('mode-semantic').classList.remove('active');
	if (searchQuery) runSearch();
};
document.getElementById('mode-semantic').onclick = () => {
	searchModeVal = 'semantic';
	document.getElementById('mode-semantic').classList.add('active');
	document.getElementById('mode-keyword').classList.remove('active');
	if (searchQuery) runSearch();
};

document.getElementById('search-btn').onclick = () => runSearch();
document.getElementById('search-input').onkeydown = (e) => {
	if (e.key === 'Enter') runSearch();
};
document.getElementById('search-load-more').onclick = () => {
	searchPage++;
	fetchSearchResults(false);
};

async function runSearch() {
	const q = document.getElementById('search-input').value.trim();
	if (!q) return;
	searchQuery = q;
	searchPage = 1;
	document.getElementById('search-results').innerHTML = '';
	document.getElementById('search-status').textContent = 'Searching...';
	document.getElementById('search-load-more').style.display = 'none';
	await fetchSearchResults(true);
}

async function fetchSearchResults(isNew) {
	try {
		const endpoint = searchModeVal === 'semantic' ? '/api/semantic-search' : '/api/search';
		const res = await fetch(endpoint + '?q=' + encodeURIComponent(searchQuery) + '&page=' + searchPage);
		const data = await res.json();

		if (data.error) {
			document.getElementById('search-status').textContent = 'Error: ' + data.error;
			return;
		}

		searchHasMore = data.has_more;
		document.getElementById('search-load-more').style.display = searchHasMore ? '' : 'none';

		const totalMatches = data.results.reduce((sum, ep) => sum + ep.matches.length, 0);
		if (isNew && totalMatches === 0) {
			document.getElementById('search-status').textContent = 'No results for \u201c' + searchQuery + '\u201d';
			return;
		}
		if (isNew) {
			document.getElementById('search-status').textContent = 'Results for \u201c' + searchQuery + '\u201d';
		}

		const container = document.getElementById('search-results');
		for (const episode of data.results) {
			container.appendChild(renderSearchResult(episode));
		}
	} catch (err) {
		document.getElementById('search-status').textContent = 'Error: ' + err.message;
	}
}

function renderSearchResult(episode) {
	const div = document.createElement('div');
	div.className = 'search-result';

	const title = document.createElement('div');
	title.className = 'search-result-title';
	title.textContent = episode.title + ' (' + episode.matches.length + ' match' + (episode.matches.length !== 1 ? 'es' : '') + ')';
	div.appendChild(title);

	const dateStr = parseSearchDate(episode.episode_id);
	if (dateStr) {
		const meta = document.createElement('div');
		meta.className = 'search-result-meta';
		meta.textContent = dateStr;
		div.appendChild(meta);
	}

	for (const match of episode.matches) {
		const m = document.createElement('div');
		m.className = 'search-match';
		const ts = document.createElement('span');
		ts.className = 'timestamp';
		ts.textContent = formatSearchTime(match.start_ms);
		m.appendChild(ts);
		const text = document.createElement('span');
		text.innerHTML = searchModeVal === 'keyword' ? highlightSearchQuery(match.text, searchQuery) : escapeSearchHtml(match.text);
		m.appendChild(text);
		div.appendChild(m);
	}

	return div;
}

function parseSearchDate(id) {
	const match = id.match(/(\d{4}-\d{2}-\d{2})/);
	if (!match) return null;
	const [y, m, d] = match[1].split('-');
	return new Date(+y, +m - 1, +d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function formatSearchTime(ms) {
	const totalSeconds = Math.floor(ms / 1000);
	const h = Math.floor(totalSeconds / 3600);
	const m = Math.floor((totalSeconds % 3600) / 60);
	const s = totalSeconds % 60;
	if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
	return m + ':' + String(s).padStart(2, '0');
}

function highlightSearchQuery(text, query) {
	const safe = escapeSearchHtml(text);
	const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return safe.replace(new RegExp('(' + escaped + ')', 'gi'), '<mark>$1</mark>');
}

function escapeSearchHtml(str) {
	return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
```

- [ ] **Step 9: Remove the auto-init `loadAndRender()` call**

The existing code calls `loadAndRender()` unconditionally at the bottom (line 664). Since the auth flow now calls `loadAndRender()` after successful login, delete this line:

```javascript
loadAndRender();
```

- [ ] **Step 10: Commit**

```bash
git add roe-search/src/admin.html
git commit -m "feat: add password auth and search tab to admin page"
```

---

### Task 5: Test locally and verify

**Files:** None (verification only)

- [ ] **Step 1: Start dev server**

```bash
cd roe-search && npx wrangler dev
```

- [ ] **Step 2: Set a test password for local dev**

In `roe-search/wrangler.jsonc`, temporarily add (or use `--var` flag):

```bash
cd roe-search && npx wrangler dev --var ADMIN_PASSWORD:testpass
```

- [ ] **Step 3: Verify public site**

Open `http://localhost:8787/` and confirm:
- No search bar visible
- No keyword/semantic toggle
- On This Day section still loads
- Nav shows "Episodes · Map" (no "Search")
- Clip sharing still works (test with `?episode=<id>&t=0`)

- [ ] **Step 4: Verify episodes page**

Open `http://localhost:8787/episodes` and confirm:
- No "Search" button on episode cards
- Play, Skip intro, and Link buttons still work
- Nav shows "Episodes · Map"

- [ ] **Step 5: Verify admin page**

Open `http://localhost:8787/admin` and confirm:
- Password overlay appears
- Wrong password shows error
- Correct password ("testpass") dismisses overlay
- All Guests, Review Queue, and Tools tabs work
- Search tab shows search input and mode toggle
- Searching returns results with highlighted matches
- Password persists across tab switches (sessionStorage)
- Refreshing the page doesn't require re-entering password (sessionStorage)

- [ ] **Step 6: Verify mobile layout**

Check `http://localhost:8787/admin` at 390px width:
- Password prompt is usable on mobile
- Search box stacks vertically
- Search results are readable

- [ ] **Step 7: Commit verification notes (if any fixes needed)**

---

### Task 6: Deploy

- [ ] **Step 1: Deploy the worker**

```bash
cd roe-search && npx wrangler deploy
```

- [ ] **Step 2: Set the admin password secret**

```bash
cd roe-search && npx wrangler secret put ADMIN_PASSWORD
```

Enter the desired password when prompted.

- [ ] **Step 3: Verify production**

Open `https://rollovereasy.org/` and confirm search is gone.
Open `https://rollovereasy.org/admin` and confirm password prompt works.
