# Skip to Interview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Skip to interview with [Guest Name]" button to episode cards that jumps to the guest interview segment, powered by transcript-based detection of interview start times.

**Architecture:** A backfill script scans local transcript JSON files, detects the guest interview start point using song-break + guest-name heuristics, and writes `guest_start_ms` to the `episodes` table. The worker API includes this field (plus guest names) in episode responses. The frontend renders a "Skip to interview" button when data is available.

**Tech Stack:** Node.js scripts, Cloudflare D1 (SQLite), Wrangler CLI, vanilla JS frontend

---

### Task 1: Add `guest_start_ms` Column to Schema and D1

**Files:**
- Modify: `schema.sql:1-9` (episodes table definition)

This task updates the schema reference file and runs the ALTER TABLE on both local and remote D1.

- [ ] **Step 1: Update schema.sql**

Add the column to the episodes table definition:

```sql
CREATE TABLE episodes (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    audio_file TEXT,
    duration_ms INTEGER,
    published_at TEXT,
    summary TEXT,
    guests_reviewed INTEGER DEFAULT 0,
    guest_start_ms INTEGER
);
```

- [ ] **Step 2: Run ALTER TABLE on local D1**

```bash
cd roe-search && npx wrangler d1 execute roe-episodes --local --command="ALTER TABLE episodes ADD COLUMN guest_start_ms INTEGER"
```

Expected: Success, no output errors.

- [ ] **Step 3: Run ALTER TABLE on remote D1**

```bash
cd roe-search && npx wrangler d1 execute roe-episodes --remote --command="ALTER TABLE episodes ADD COLUMN guest_start_ms INTEGER"
```

Expected: Success, no output errors.

- [ ] **Step 4: Verify the column exists**

```bash
cd roe-search && npx wrangler d1 execute roe-episodes --remote --command="SELECT guest_start_ms FROM episodes LIMIT 1"
```

Expected: Returns one row with `guest_start_ms: null`.

- [ ] **Step 5: Commit**

```bash
git add schema.sql
git commit -m "schema: add guest_start_ms column to episodes table"
```

---

### Task 2: Create Backfill Script

**Files:**
- Create: `scripts/backfill-guest-start.js`

This script reads local transcript JSON files, looks up each episode's guests from D1, and computes where the guest interview starts. It follows the same patterns as `scripts/backfill-guests.js` for D1 access (wrangler CLI, `--local`/`--remote` flags).

- [ ] **Step 1: Create the backfill script**

```javascript
#!/usr/bin/env node

/**
 * Backfill guest_start_ms for episodes by analyzing transcripts.
 *
 * Detection algorithm:
 *   1. Only look at segments after 50 minutes (3,000,000ms)
 *   2. Find the last "song break" — a segment >=180s or a gap >=60s between segments
 *   3. After that break, find the first mention of any guest name
 *   4. Fallback A: first guest name mention after 50min (no song break found)
 *   5. Fallback B: first speech segment after the last song break
 *   6. Fallback C: 3,600,000ms (1 hour)
 *
 * Usage:
 *   node scripts/backfill-guest-start.js [--local] [--force] [--dry-run]
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// ── Load .env ─────────────────────────────────────────────────────────

const scriptDir = path.dirname(decodeURIComponent(new URL(import.meta.url).pathname));
const envPath = path.resolve(scriptDir, '..', '.env');
if (fs.existsSync(envPath)) {
	for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const eq = trimmed.indexOf('=');
		if (eq === -1) continue;
		const key = trimmed.slice(0, eq);
		const val = trimmed.slice(eq + 1);
		if (!process.env[key]) process.env[key] = val;
	}
}

const DB_NAME = 'roe-episodes';
const MIN_START_MS = 3_000_000; // 50 minutes
const SONG_DURATION_MS = 180_000; // 3 minutes — segments this long are songs
const GAP_THRESHOLD_MS = 60_000; // 1 minute gap between segments
const FALLBACK_MS = 3_600_000; // 1 hour

function workerCwd() {
	return path.resolve(scriptDir, '..', 'roe-search');
}

function escapeSQL(str) {
	return str.replace(/'/g, "''");
}

function wranglerEnv() {
	const env = { ...process.env };
	delete env.CLOUDFLARE_API_TOKEN;
	return env;
}

function runSQL(sql, isLocal) {
	const flag = isLocal ? '--local' : '--remote';
	const cmd = `npx wrangler d1 execute ${DB_NAME} ${flag} --command="${sql.replace(/"/g, '\\"')}"`;
	return execSync(cmd, {
		cwd: workerCwd(),
		encoding: 'utf-8',
		stdio: 'pipe',
		env: wranglerEnv(),
	});
}

function queryJSON(sql, isLocal) {
	const flag = isLocal ? '--local' : '--remote';
	const cmd = `npx wrangler d1 execute ${DB_NAME} ${flag} --json --command="${sql.replace(/"/g, '\\"')}"`;
	const result = execSync(cmd, {
		cwd: workerCwd(),
		encoding: 'utf-8',
		stdio: 'pipe',
		env: wranglerEnv(),
	});
	const parsed = JSON.parse(result);
	return parsed[0]?.results ?? [];
}

/**
 * Detect the guest interview start timestamp from transcript segments.
 * Returns start_ms or null if detection fails.
 */
function detectGuestStart(segments, guestNames) {
	if (guestNames.length === 0) return null;

	// Only consider segments after 50 minutes
	const late = segments.filter(s => s.start_ms >= MIN_START_MS);
	if (late.length === 0) return null;

	// Find song breaks: segments with duration >= 180s, or gaps >= 60s
	const breaks = [];
	for (let i = 0; i < late.length; i++) {
		const seg = late[i];
		const duration = seg.end_ms - seg.start_ms;
		if (duration >= SONG_DURATION_MS) {
			breaks.push({ type: 'song', index: i, end_ms: seg.end_ms });
		}
		if (i > 0) {
			const gap = seg.start_ms - late[i - 1].end_ms;
			if (gap >= GAP_THRESHOLD_MS) {
				breaks.push({ type: 'gap', index: i, end_ms: late[i - 1].end_ms });
			}
		}
	}

	// Build lowercase guest name list for matching
	const lowerNames = guestNames.map(n => n.toLowerCase());

	function segmentMentionsGuest(seg) {
		const text = seg.text.toLowerCase();
		return lowerNames.some(name => text.includes(name));
	}

	// Strategy 1: After the last song break, find first guest name mention
	if (breaks.length > 0) {
		// Sort breaks by position, take the last one
		breaks.sort((a, b) => a.end_ms - b.end_ms);
		const lastBreak = breaks[breaks.length - 1];
		const afterBreak = late.filter(s => s.start_ms >= lastBreak.end_ms);

		for (const seg of afterBreak) {
			if (segmentMentionsGuest(seg)) {
				return seg.start_ms;
			}
		}

		// Fallback B: first speech segment after the last song break
		if (afterBreak.length > 0) {
			return afterBreak[0].start_ms;
		}
	}

	// Fallback A: first guest name mention after 50 minutes (no song break)
	for (const seg of late) {
		if (segmentMentionsGuest(seg)) {
			return seg.start_ms;
		}
	}

	// Fallback C: 1 hour
	return FALLBACK_MS;
}

async function main() {
	if (process.argv.includes('--help') || process.argv.includes('-h')) {
		console.log('Usage: node scripts/backfill-guest-start.js [--local] [--force] [--dry-run]');
		console.log('');
		console.log('Detects guest interview start times from transcripts and updates episodes.guest_start_ms.');
		console.log('  --local    Target local D1 database');
		console.log('  --force    Re-detect for all episodes, even if guest_start_ms is already set');
		console.log('  --dry-run  Print detected timestamps without writing to D1');
		process.exit(0);
	}

	const isLocal = process.argv.includes('--local');
	const force = process.argv.includes('--force');
	const dryRun = process.argv.includes('--dry-run');

	const transcriptsDir = path.resolve(scriptDir, '..', 'transcripts');
	if (!fs.existsSync(transcriptsDir)) {
		console.error('No transcripts/ directory found.');
		process.exit(1);
	}

	// Get all episode IDs and their current guest_start_ms
	const episodes = queryJSON('SELECT id, duration_ms, guest_start_ms FROM episodes', isLocal);
	const episodeMap = new Map(episodes.map(e => [e.id, e]));

	// Get all guest names per episode
	const guestRows = queryJSON('SELECT episode_id, guest_name FROM episode_guests', isLocal);
	const guestsByEpisode = new Map();
	for (const row of guestRows) {
		if (!guestsByEpisode.has(row.episode_id)) {
			guestsByEpisode.set(row.episode_id, []);
		}
		guestsByEpisode.get(row.episode_id).push(row.guest_name);
	}

	const files = fs.readdirSync(transcriptsDir).filter(f => f.endsWith('.json')).sort();

	console.log(`Found ${episodeMap.size} episodes in DB, ${guestsByEpisode.size} with guests`);
	console.log(`Target: ${isLocal ? 'local' : 'remote'} D1 database${dryRun ? ' (DRY RUN)' : ''}`);
	console.log();

	let processed = 0;
	let skipped = 0;
	let updated = 0;
	const fallbackStats = { song_then_name: 0, song_then_first: 0, name_only: 0, fallback_1h: 0 };

	for (const file of files) {
		const transcript = JSON.parse(fs.readFileSync(path.join(transcriptsDir, file), 'utf-8'));
		const { episode_id, segments } = transcript;

		const ep = episodeMap.get(episode_id);
		if (!ep) continue;

		// Skip episodes with no guests
		const guests = guestsByEpisode.get(episode_id);
		if (!guests || guests.length === 0) {
			skipped++;
			continue;
		}

		// Skip episodes shorter than 50 minutes
		if (ep.duration_ms && ep.duration_ms < MIN_START_MS) {
			skipped++;
			continue;
		}

		// Skip if already set (unless --force)
		if (!force && ep.guest_start_ms != null) {
			skipped++;
			continue;
		}

		const startMs = detectGuestStart(segments, guests);
		if (startMs == null) {
			skipped++;
			continue;
		}

		const minutes = Math.floor(startMs / 60000);
		const seconds = Math.floor((startMs % 60000) / 1000);
		const timestamp = `${minutes}:${String(seconds).padStart(2, '0')}`;

		console.log(`  ${episode_id}: guest_start_ms=${startMs} (${timestamp}) — guests: ${guests.join(', ')}`);

		if (!dryRun) {
			runSQL(`UPDATE episodes SET guest_start_ms = ${startMs} WHERE id = '${escapeSQL(episode_id)}'`, isLocal);
		}

		updated++;
		processed++;
	}

	console.log();
	console.log('=== Backfill Complete ===');
	console.log(`Processed: ${processed}, Updated: ${updated}, Skipped: ${skipped}`);
}

main().catch(err => {
	console.error('Error:', err.message);
	process.exit(1);
});
```

- [ ] **Step 2: Test with --dry-run on a few episodes**

```bash
node scripts/backfill-guest-start.js --local --dry-run
```

Expected: Prints detected timestamps for episodes that have guests. Review a few to sanity-check the times are in the 55-75 minute range.

- [ ] **Step 3: Run backfill on local D1**

```bash
node scripts/backfill-guest-start.js --local
```

Expected: Updates `guest_start_ms` for episodes with guests.

- [ ] **Step 4: Verify a few results locally**

```bash
cd roe-search && npx wrangler d1 execute roe-episodes --local --command="SELECT id, guest_start_ms FROM episodes WHERE guest_start_ms IS NOT NULL ORDER BY id DESC LIMIT 10"
```

Expected: Returns episodes with reasonable `guest_start_ms` values (typically 3,000,000 - 4,500,000).

- [ ] **Step 5: Run backfill on remote D1**

```bash
node scripts/backfill-guest-start.js --remote
```

Expected: Same as local run, updates remote D1.

- [ ] **Step 6: Commit**

```bash
git add scripts/backfill-guest-start.js
git commit -m "feat: add backfill script for guest interview start timestamps"
```

---

### Task 3: Update API to Include `guest_start_ms` and Guest Names

**Files:**
- Modify: `roe-search/src/index.js:351-362` (`handleEpisodes` function)
- Modify: `roe-search/src/index.js:126-213` (`handleSearch` function)
- Modify: `roe-search/src/index.js:216-291` (`handleSemanticSearch` function)
- Modify: `roe-search/src/index.js:454-485` (`handleOnThisDay` function)
- Modify: `roe-search/src/index.js:409-434` (`handleEpisodeById` function)

The episodes list endpoint needs to return `guest_start_ms` and guest names. Search results also need this data so the button can appear there too.

- [ ] **Step 1: Update `handleEpisodes` to include `guest_start_ms` and guest names**

Replace the `handleEpisodes` function:

```javascript
async function handleEpisodes(env) {
	const [episodeResult, guestResult] = await Promise.all([
		env.DB.prepare(`
			SELECT e.id, e.title, e.duration_ms, e.published_at, e.summary, e.guest_start_ms,
			       COALESCE(pc.cnt, 0) as place_count
			FROM episodes e
			LEFT JOIN (SELECT episode_id, COUNT(*) as cnt FROM place_mentions GROUP BY episode_id) pc
			  ON pc.episode_id = e.id
			ORDER BY e.id
		`).all(),
		env.DB.prepare('SELECT episode_id, guest_name FROM episode_guests ORDER BY episode_id, guest_name').all(),
	]);

	const guestsByEpisode = new Map();
	for (const row of guestResult.results) {
		if (!guestsByEpisode.has(row.episode_id)) {
			guestsByEpisode.set(row.episode_id, []);
		}
		guestsByEpisode.get(row.episode_id).push(row.guest_name);
	}

	const episodes = episodeResult.results.map(e => ({
		...e,
		guests: guestsByEpisode.get(e.id) || [],
	}));

	return json({ episodes });
}
```

- [ ] **Step 2: Update `handleSearch` to include `guest_start_ms` and guest names**

In the `handleSearch` function, after the search query runs and builds `episodeMap`, add a lookup for guest data. Replace the section that builds the response (around lines 200-210):

```javascript
	// Fetch guest_start_ms and guest names for matched episodes
	const epIds = Array.from(episodeMap.keys());
	if (epIds.length > 0) {
		const placeholders = epIds.map(() => '?').join(', ');
		const [startResult, guestResult] = await Promise.all([
			env.DB.prepare(`SELECT id, guest_start_ms FROM episodes WHERE id IN (${placeholders})`)
				.bind(...epIds).all(),
			env.DB.prepare(`SELECT episode_id, guest_name FROM episode_guests WHERE episode_id IN (${placeholders})`)
				.bind(...epIds).all(),
		]);
		for (const row of startResult.results) {
			const ep = episodeMap.get(row.id);
			if (ep) ep.guest_start_ms = row.guest_start_ms;
		}
		for (const row of guestResult.results) {
			const ep = episodeMap.get(row.episode_id);
			if (ep) {
				if (!ep.guests) ep.guests = [];
				ep.guests.push(row.guest_name);
			}
		}
	}

	// Sort matches chronologically within each episode
	for (const ep of episodeMap.values()) {
		ep.matches.sort((a, b) => a.start_ms - b.start_ms);
	}

	return json({
		query,
		page,
		results: Array.from(episodeMap.values()),
		has_more: episodeMap.size === pageSize,
	});
```

- [ ] **Step 3: Update `handleSemanticSearch` to include `guest_start_ms` and guest names**

In `handleSemanticSearch`, update the D1 enrichment query (around line 265) to include `guest_start_ms`, and add a guest lookup:

```javascript
	// Enrich only the current page's episodes with D1 metadata
	let episodeMeta = {};
	let guestsByEpisode = {};
	if (pageEpisodeIds.length > 0) {
		const placeholders = pageEpisodeIds.map(() => '?').join(', ');
		const [metaResult, guestResult] = await Promise.all([
			env.DB.prepare(
				`SELECT id, title, duration_ms, summary, guest_start_ms FROM episodes WHERE id IN (${placeholders})`
			).bind(...pageEpisodeIds).all(),
			env.DB.prepare(
				`SELECT episode_id, guest_name FROM episode_guests WHERE episode_id IN (${placeholders})`
			).bind(...pageEpisodeIds).all(),
		]);
		for (const row of metaResult.results) {
			episodeMeta[row.id] = row;
		}
		for (const row of guestResult.results) {
			if (!guestsByEpisode[row.episode_id]) guestsByEpisode[row.episode_id] = [];
			guestsByEpisode[row.episode_id].push(row.guest_name);
		}
	}

	// Build result objects for this page
	const results = pageEpisodeIds.map((epId) => {
		const { matches } = episodeMatchMap.get(epId);
		const dbMeta = episodeMeta[epId] || {};
		matches.sort((a, b) => a.start_ms - b.start_ms);
		return {
			episode_id: epId,
			title: dbMeta.title || null,
			duration_ms: dbMeta.duration_ms || null,
			summary: dbMeta.summary || null,
			guest_start_ms: dbMeta.guest_start_ms || null,
			guests: guestsByEpisode[epId] || [],
			audio_file: `/audio/${epId}.m4a`,
			matches,
		};
	});
```

- [ ] **Step 4: Update `handleOnThisDay` to include `guest_start_ms` and guest names**

Replace the `handleOnThisDay` function's query and response building:

```javascript
async function handleOnThisDay(url, env) {
	const now = new Date();
	const pacificDate = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
	const month = String(pacificDate.getMonth() + 1).padStart(2, '0');
	const day = String(pacificDate.getDate()).padStart(2, '0');
	const todayMmDd = url.searchParams.get('date') || `${month}-${day}`;

	try {
		const { results } = await env.DB.prepare(`
			SELECT id, title, duration_ms, summary, guest_start_ms
			FROM episodes
			WHERE SUBSTR(id, 21, 5) = ?1
			ORDER BY id DESC
		`)
			.bind(todayMmDd)
			.all();

		// Fetch guest names for these episodes
		const epIds = results.map(r => r.id);
		let guestsByEpisode = {};
		if (epIds.length > 0) {
			const placeholders = epIds.map(() => '?').join(', ');
			const guestResult = await env.DB.prepare(
				`SELECT episode_id, guest_name FROM episode_guests WHERE episode_id IN (${placeholders})`
			).bind(...epIds).all();
			for (const row of guestResult.results) {
				if (!guestsByEpisode[row.episode_id]) guestsByEpisode[row.episode_id] = [];
				guestsByEpisode[row.episode_id].push(row.guest_name);
			}
		}

		return json({
			date: todayMmDd,
			episodes: results.map(ep => ({
				id: ep.id,
				title: ep.title,
				duration_ms: ep.duration_ms,
				summary: ep.summary,
				guest_start_ms: ep.guest_start_ms,
				guests: guestsByEpisode[ep.id] || [],
				audio_file: `/audio/${ep.id}.m4a`,
			})),
		});
	} catch (err) {
		return json({ error: 'Failed to fetch episodes' }, 500);
	}
}
```

- [ ] **Step 5: Update `handleEpisodeById` to include `guest_start_ms` and guest names**

```javascript
async function handleEpisodeById(episodeId, env) {
	try {
		const [epResult, guestResult] = await Promise.all([
			env.DB.prepare(
				'SELECT id, title, duration_ms, summary, guest_start_ms FROM episodes WHERE id = ?1'
			).bind(episodeId).all(),
			env.DB.prepare(
				'SELECT guest_name FROM episode_guests WHERE episode_id = ?1'
			).bind(episodeId).all(),
		]);

		if (epResult.results.length === 0) {
			return json({ error: 'Episode not found' }, 404);
		}

		const ep = epResult.results[0];
		return json({
			episode: {
				id: ep.id,
				title: ep.title,
				duration_ms: ep.duration_ms,
				summary: ep.summary,
				guest_start_ms: ep.guest_start_ms,
				guests: guestResult.results.map(r => r.guest_name),
				audio_file: `/audio/${ep.id}.m4a`,
			},
		});
	} catch (err) {
		return json({ error: 'Failed to fetch episode' }, 500);
	}
}
```

- [ ] **Step 6: Test locally**

```bash
cd roe-search && npx wrangler dev
```

Then in another terminal:

```bash
curl -s http://localhost:8787/api/episodes | jq '.episodes[0] | {id, guest_start_ms, guests}'
```

Expected: Episode objects include `guest_start_ms` (number or null) and `guests` (array of strings).

- [ ] **Step 7: Commit**

```bash
git add roe-search/src/index.js
git commit -m "feat: include guest_start_ms and guest names in API responses"
```

---

### Task 4: Add "Skip to Interview" Button to Episodes Page

**Files:**
- Modify: `roe-search/src/episodes.html:345-367` (episode card rendering in `loadEpisodes`)

- [ ] **Step 1: Add a helper function for formatting guest names**

Add this function right after the `formatDate` function (around line 324):

```javascript
function formatGuestLabel(guests) {
	if (!guests || guests.length === 0) return '';
	if (guests.length === 1) return guests[0];
	if (guests.length === 2) return guests[0] + ' & ' + guests[1];
	if (guests.length === 3) return guests[0] + ', ' + guests[1] + ' & ' + guests[2];
	return guests[0] + ', ' + guests[1] + ' & ' + (guests.length - 2) + ' others';
}
```

- [ ] **Step 2: Add the "Skip to interview" button to episode cards**

In the `loadEpisodes` function, after the "Skip intro" button and before the "Search" link (around line 365-366), add:

```javascript
if (ep.guest_start_ms && ep.guests && ep.guests.length > 0) {
	html += '<button class="ep-btn ep-skip-btn" data-audio="/audio/' + encodeURIComponent(ep.id) + '.m4a" data-title="' + escapeAttr(ep.title) + '" data-start="' + Math.floor(ep.guest_start_ms / 1000) + '">&#127908; Skip to interview with ' + escapeHtml(formatGuestLabel(ep.guests)) + '</button>';
}
```

Note: `data-start` is in seconds (matching existing convention — the "Skip intro" button uses `data-start="250"` which is 250 seconds). The `&#127908;` is a microphone emoji.

- [ ] **Step 3: Test locally**

```bash
cd roe-search && npx wrangler dev
```

Open http://localhost:8787/episodes in a browser. Verify:
- Episodes with guests show the "Skip to interview with [Name]" button
- Episodes without guests don't show it
- Clicking the button starts audio at the correct timestamp
- Button wraps cleanly on mobile widths (~375px)

- [ ] **Step 4: Commit**

```bash
git add roe-search/src/episodes.html
git commit -m "feat: add skip-to-interview button on episodes page"
```

---

### Task 5: Add "Skip to Interview" Button to Search Results (frontend.html)

**Files:**
- Modify: `roe-search/src/frontend.html`

The search page has three places where episode cards with action buttons are rendered:
1. `renderEpisode()` function (~line 1037) — keyword/semantic search results
2. `loadClip()` function (~line 846) — shared clip view
3. `loadOnThisDay()` function (~line 894) — "on this day" cards

- [ ] **Step 1: Add `formatGuestLabel` helper**

Add this function near the other helper functions (after `formatDate`, around line 720):

```javascript
function formatGuestLabel(guests) {
	if (!guests || guests.length === 0) return '';
	if (guests.length === 1) return guests[0];
	if (guests.length === 2) return guests[0] + ' & ' + guests[1];
	if (guests.length === 3) return guests[0] + ', ' + guests[1] + ' & ' + guests[2];
	return guests[0] + ', ' + guests[1] + ' & ' + (guests.length - 2) + ' others';
}
```

- [ ] **Step 2: Add button to `renderEpisode()` (search results)**

In the `renderEpisode` function, after the "Skip intro" button is appended to `actions` (after line 1082), add:

```javascript
if (episode.guest_start_ms && episode.guests && episode.guests.length > 0) {
	const guestBtn = document.createElement('button');
	guestBtn.className = 'ep-btn';
	guestBtn.innerHTML = '&#127908; Skip to interview with ' + escapeHtml(formatGuestLabel(episode.guests));
	guestBtn.onclick = () => playAt(episode.audio_file, episode.guest_start_ms, episode.title);
	actions.appendChild(guestBtn);
}
```

Note: In frontend.html, `playAt` takes milliseconds (the "Skip intro" button uses `250000`), so we pass `episode.guest_start_ms` directly.

- [ ] **Step 3: Add button to `loadClip()` (shared clip view)**

In the `loadClip` function, after the "Skip intro" button HTML (after line 872), add:

```javascript
// Fetch guest data for the clip episode
const guestRes = await fetch('/api/episode/' + encodeURIComponent(episodeId));
```

Actually, the clip view already fetches from `/api/episode/:id` which now returns `guest_start_ms` and `guests`. So simply add after the "Skip intro" line (872):

```javascript
if (ep.guest_start_ms && ep.guests && ep.guests.length > 0) {
	html += '<button class="ep-btn ep-guest-btn" data-audio="' + escapeHtml(ep.audio_file) + '" data-title="' + escapeHtml(ep.title) + '" data-start="' + ep.guest_start_ms + '">&#127908; Skip to interview with ' + escapeHtml(formatGuestLabel(ep.guests)) + '</button>';
}
```

- [ ] **Step 4: Add button to `loadOnThisDay()` (on-this-day cards)**

In the `loadOnThisDay` function, after the "Skip intro" button HTML (after line 927), add:

```javascript
if (ep.guest_start_ms && ep.guests && ep.guests.length > 0) {
	html += '<button class="ep-btn ep-guest-btn" data-audio="' + escapeHtml(ep.audio_file) + '" data-title="' + escapeHtml(ep.title) + '" data-start="' + ep.guest_start_ms + '">&#127908; Skip to interview with ' + escapeHtml(formatGuestLabel(ep.guests)) + '</button>';
}
```

- [ ] **Step 5: Update the delegated click handler to catch guest buttons**

In frontend.html, line 782, there's a delegated click handler that matches `.ep-play-btn, .ep-skip-btn`. Add `.ep-guest-btn` to the selector so the HTML-string buttons in clip/OTD cards are handled:

```javascript
document.addEventListener('click', (e) => {
	const btn = e.target.closest('.ep-play-btn, .ep-skip-btn, .ep-guest-btn');
	if (!btn || !btn.dataset.audio) return;
	playAt(btn.dataset.audio, parseInt(btn.dataset.start, 10), btn.dataset.title);
});
```

This handler calls `playAt(audio, startMs, title)` where `startMs` is in milliseconds (matching the `data-start` values set in Steps 3-4).

- [ ] **Step 6: Test locally**

```bash
cd roe-search && npx wrangler dev
```

Test in browser at http://localhost:8787:
1. Search for something that matches episodes with guests — verify "Skip to interview" button appears
2. Check the "On This Day" section — verify button appears for episodes with guests
3. Click a "Skip to interview" button — verify audio plays from the correct timestamp
4. Test at mobile width (~375px) — verify buttons wrap cleanly

- [ ] **Step 7: Commit**

```bash
git add roe-search/src/frontend.html
git commit -m "feat: add skip-to-interview button to search results and on-this-day cards"
```

---

### Task 6: Integrate Guest Start Detection into Pipeline

**Files:**
- Modify: `scripts/process-episode.js` (after the guest insertion block, around line 865)

- [ ] **Step 1: Add the `detectGuestStart` function to process-episode.js**

Add this function before the `main()` function or in the utility section of the file. It's the same logic as in the backfill script:

```javascript
function detectGuestStart(segments, guestNames) {
	const MIN_START_MS = 3_000_000;
	const SONG_DURATION_MS = 180_000;
	const GAP_THRESHOLD_MS = 60_000;
	const FALLBACK_MS = 3_600_000;

	if (guestNames.length === 0) return null;

	const late = segments.filter(s => s.start_ms >= MIN_START_MS);
	if (late.length === 0) return null;

	const breaks = [];
	for (let i = 0; i < late.length; i++) {
		const seg = late[i];
		const duration = seg.end_ms - seg.start_ms;
		if (duration >= SONG_DURATION_MS) {
			breaks.push({ type: 'song', index: i, end_ms: seg.end_ms });
		}
		if (i > 0) {
			const gap = seg.start_ms - late[i - 1].end_ms;
			if (gap >= GAP_THRESHOLD_MS) {
				breaks.push({ type: 'gap', index: i, end_ms: late[i - 1].end_ms });
			}
		}
	}

	const lowerNames = guestNames.map(n => n.toLowerCase());
	function segmentMentionsGuest(seg) {
		const text = seg.text.toLowerCase();
		return lowerNames.some(name => text.includes(name));
	}

	if (breaks.length > 0) {
		breaks.sort((a, b) => a.end_ms - b.end_ms);
		const lastBreak = breaks[breaks.length - 1];
		const afterBreak = late.filter(s => s.start_ms >= lastBreak.end_ms);
		for (const seg of afterBreak) {
			if (segmentMentionsGuest(seg)) return seg.start_ms;
		}
		if (afterBreak.length > 0) return afterBreak[0].start_ms;
	}

	for (const seg of late) {
		if (segmentMentionsGuest(seg)) return seg.start_ms;
	}

	return FALLBACK_MS;
}
```

- [ ] **Step 2: Call `detectGuestStart` after guest insertion**

After the guest insertion block (line 865), add:

```javascript
	// Detect guest interview start time
	if (guests.length > 0) {
		const transcriptPath = path.join(transcriptsDir, `${episodeId}.json`);
		if (fs.existsSync(transcriptPath)) {
			const transcriptData = JSON.parse(fs.readFileSync(transcriptPath, 'utf-8'));
			const guestStartMs = detectGuestStart(transcriptData.segments, guests);
			if (guestStartMs != null) {
				runSQL(`UPDATE episodes SET guest_start_ms = ${guestStartMs} WHERE id = '${escapeSQL(episodeId)}'`);
				const mins = Math.floor(guestStartMs / 60000);
				const secs = Math.floor((guestStartMs % 60000) / 1000);
				console.log(`  Guest interview starts at ${mins}:${String(secs).padStart(2, '0')}`);
			}
		}
	}
```

Note: `transcriptsDir` is already defined in process-episode.js (it's `path.join(projectRoot, 'transcripts')`). Verify the exact variable name used and adjust if needed.

- [ ] **Step 3: Verify the transcripts directory variable**

Check that `transcriptsDir` or equivalent is accessible in the summary step's scope. The pipeline saves transcripts to `transcripts/` — find the exact path variable used.

- [ ] **Step 4: Commit**

```bash
git add scripts/process-episode.js
git commit -m "feat: detect guest interview start time in pipeline"
```

---

### Task 7: Deploy and Verify

- [ ] **Step 1: Deploy the worker**

```bash
cd roe-search && npx wrangler deploy
```

Expected: Deployment succeeds.

- [ ] **Step 2: Verify API responses on production**

```bash
curl -s https://rollovereasy.org/api/episodes | jq '[.episodes[] | select(.guest_start_ms != null)] | length'
```

Expected: A number representing how many episodes have `guest_start_ms` set.

```bash
curl -s https://rollovereasy.org/api/episodes | jq '[.episodes[] | select(.guest_start_ms != null)][0] | {id, guest_start_ms, guests}'
```

Expected: An episode with `guest_start_ms` (number) and `guests` (array of names).

- [ ] **Step 3: Test the frontend on production**

Open https://rollovereasy.org/episodes in a browser:
- Verify "Skip to interview with [Name]" buttons appear on episode cards
- Click one and verify audio starts playing at the right point
- Test on mobile

Open https://rollovereasy.org and:
- Check "On This Day" cards for the button
- Search for something and verify the button appears on search result cards

- [ ] **Step 4: Commit any final fixes if needed**
