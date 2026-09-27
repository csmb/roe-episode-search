#!/usr/bin/env node
/**
 * backfill-place-sentiment.js
 *
 * Pass 1: for every place_mention with analyzed_at NULL, find the passages in
 *         that episode's transcript (the local file, or D1 when there's none),
 *         score with GPT-4o-mini, write sentiment columns. An episode counts as
 *         done only when every one of its places was scored.
 * Pass 2: for every place meeting the narrative threshold that has no
 *         narrative yet, synthesize the "then vs now" narrative and upsert
 *         place_narratives.
 *
 * Usage:
 *   OPENAI_API_KEY=... node scripts/backfill-place-sentiment.js [--replace] [--episode <id>]
 *
 *   --replace         Re-score mentions even if analyzed_at is already set, and
 *                     rewrite every qualifying narrative.
 *   --episode <id>    Only this episode in pass 1.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findPlacePassages,
  scoreMention,
  regenerateNarrativeFromRows,
} from '../roe-pipeline/src/sentiment.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRANSCRIPTS_DIR = path.join(__dirname, '..', 'transcripts');
const PROGRESS_PATH = path.join(__dirname, 'backfill-sentiment-progress.json');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) { console.error('OPENAI_API_KEY required'); process.exit(1); }
const REPLACE = process.argv.includes('--replace');
const episodeArg = process.argv.indexOf('--episode');
const ONLY_EPISODE = episodeArg > -1 ? process.argv[episodeArg + 1] : null;
if (episodeArg > -1 && !ONLY_EPISODE) { console.error('--episode needs an episode id'); process.exit(1); }

const wranglerEnv = { ...process.env }; // CLOUDFLARE_API_TOKEN has D1 perms; used non-interactively

function d1(sql) {
  // Collapse newlines/indentation: a literal newline survives JSON.stringify as
  // an escaped backslash in the shell arg, which D1's SQLite rejects. SQL is
  // whitespace-insensitive and statements are ';'-separated, so flattening is safe.
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  const out = execSync(
    `npx wrangler d1 execute roe-episodes --remote --json --command=${JSON.stringify(flat)}`,
    { cwd: path.join(__dirname, '..', 'roe-search'), env: wranglerEnv, maxBuffer: 64 * 1024 * 1024 }
  );
  return JSON.parse(out.toString());
}

function sqlStr(s) { return `'${String(s).replace(/'/g, "''")}'`; }

function loadProgress() {
  if (fs.existsSync(PROGRESS_PATH)) {
    const p = JSON.parse(fs.readFileSync(PROGRESS_PATH));
    if (!p.doneEpisodes) p.doneEpisodes = [];
    if (!p.doneNarrativePlaces) p.doneNarrativePlaces = [];
    return p;
  }
  return { doneEpisodes: [], doneNarrativePlaces: [] };
}
function saveProgress(p) { fs.writeFileSync(PROGRESS_PATH, JSON.stringify(p, null, 2)); }

async function main() {
  const conditions = [];
  if (!REPLACE) conditions.push('pm.analyzed_at IS NULL');
  if (ONLY_EPISODE) conditions.push(`pm.episode_id = ${sqlStr(ONLY_EPISODE)}`);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const mentions = d1(
    `SELECT pm.place_id, pm.episode_id, p.name
     FROM place_mentions pm JOIN places p ON p.id = pm.place_id ${where}`
  )[0].results;

  // Group by episode so each transcript is read once.
  const byEpisode = new Map();
  for (const m of mentions) {
    if (!byEpisode.has(m.episode_id)) byEpisode.set(m.episode_id, []);
    byEpisode.get(m.episode_id).push(m);
  }

  const progress = REPLACE ? { doneEpisodes: [], doneNarrativePlaces: [] } : loadProgress();
  const doneSet = new Set(progress.doneEpisodes);
  const episodes = [...byEpisode.keys()].filter(e => ONLY_EPISODE || !doneSet.has(e));
  console.log(`Pass 1: ${episodes.length} episodes, ${mentions.length} mentions to score`);

  const now = () => new Date().toISOString();
  let epDone = 0;

  for (const episodeId of episodes) {
    // Drag-and-drop episodes have no local transcript file; D1 has the lines.
    const tfile = path.join(TRANSCRIPTS_DIR, `${episodeId}.json`);
    const segments = fs.existsSync(tfile)
      ? JSON.parse(fs.readFileSync(tfile)).segments || []
      : d1(`SELECT start_ms, text FROM transcript_segments WHERE episode_id = ${sqlStr(episodeId)} ORDER BY start_ms`)[0].results;

    const updates = [];
    let failed = 0;
    for (const m of byEpisode.get(episodeId)) {
      const passages = findPlacePassages(segments, m.name);
      let score = 'NULL', label = "'unknown'", snippet = 'NULL', startMs = 'NULL';
      if (passages.length > 0) {
        try {
          const r = await scoreMention(m.name, passages, OPENAI_API_KEY);
          const hit = passages.find(p => r.quote && p.text.includes(r.quote)) || passages[0];
          score = String(r.score);
          label = sqlStr(r.label);
          snippet = sqlStr(r.quote);
          startMs = String(hit.start_ms);
        } catch (err) {
          console.error(`\n  score failed ${episodeId} / ${m.name}: ${err.message}`);
          failed++;
          continue; // leave analyzed_at NULL for a later run
        }
      }
      updates.push(
        `UPDATE place_mentions SET sentiment=${score}, sentiment_label=${label}, ` +
        `snippet=${snippet}, snippet_start_ms=${startMs}, analyzed_at=${sqlStr(now())} ` +
        `WHERE place_id=${m.place_id} AND episode_id=${sqlStr(m.episode_id)};`
      );
    }
    if (updates.length > 0) d1(updates.join('\n'));

    // Only a fully scored episode is done; a later run retries the rest.
    if (failed === 0 && !progress.doneEpisodes.includes(episodeId)) {
      progress.doneEpisodes.push(episodeId);
      saveProgress(progress);
    }
    epDone++;
    process.stdout.write(`\r  Pass 1: ${epDone}/${episodes.length} episodes`);
  }
  console.log('\n  Pass 1 done.');

  // Pass 2: narratives, for places that meet the threshold (3+ scored episodes
  // across 2+ years, as in sentiment.js) and have none yet. Asking D1 for just
  // those avoids a query per place.
  const places = d1(
    `SELECT p.id, p.name FROM places p
     JOIN place_mentions pm ON pm.place_id = p.id
     WHERE pm.sentiment IS NOT NULL
       ${REPLACE ? '' : 'AND NOT EXISTS (SELECT 1 FROM place_narratives n WHERE n.place_id = p.id)'}
     GROUP BY p.id
     HAVING COUNT(*) >= 3 AND COUNT(DISTINCT substr(pm.episode_id, 16, 4)) >= 2`
  )[0].results;
  console.log(`Pass 2: ${places.length} places need a narrative`);

  let nDone = 0, nWritten = 0;
  for (const place of places) {
    try {
      const rows = d1(
        `SELECT episode_id, sentiment, sentiment_label, snippet
         FROM place_mentions WHERE place_id=${place.id} AND sentiment IS NOT NULL`
      )[0].results;

      const result = await regenerateNarrativeFromRows(place.name, rows, OPENAI_API_KEY);
      if (result) {
        d1(
          `INSERT INTO place_narratives
             (place_id, early_text, recent_text, arc_text, episode_count, year_min, year_max, generated_at)
           VALUES (${place.id}, ${sqlStr(result.early)}, ${sqlStr(result.recent)}, ${sqlStr(result.arc)},
             ${result.episode_count}, ${result.year_min}, ${result.year_max}, ${sqlStr(now())})
           ON CONFLICT(place_id) DO UPDATE SET
             early_text=excluded.early_text, recent_text=excluded.recent_text,
             arc_text=excluded.arc_text, episode_count=excluded.episode_count,
             year_min=excluded.year_min, year_max=excluded.year_max,
             generated_at=excluded.generated_at`
        );
        nWritten++;
      }
      progress.doneNarrativePlaces.push(place.id);
      saveProgress(progress);
    } catch (err) {
      console.error(`\n  narrative failed for ${place.name}: ${err.message}`);
    }
    nDone++;
    process.stdout.write(`\r  Pass 2: ${nDone}/${places.length} (${nWritten} narratives)`);
  }
  console.log(`\n  Pass 2 done. ${nWritten} narratives written.`);
}

main().catch(err => { console.error('\nFatal:', err); process.exit(1); });
