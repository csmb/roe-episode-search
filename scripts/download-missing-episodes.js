#!/usr/bin/env node
/**
 * download-missing-episodes.js
 *
 * Scrapes bff.fm/shows/roll-over-easy for all broadcasts, compares with
 * locally-held episode dates, and downloads any missing episodes to:
 *   All episodes/bff-fm-downloads/
 */

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ALL_EPISODES_DIR = path.join(__dirname, '..', 'All episodes');
const DOWNLOAD_DIR = path.join(ALL_EPISODES_DIR, 'bff-fm-downloads');
const SHOW_URL = 'https://bff.fm/shows/roll-over-easy';

// Delay between requests to be polite
const REQUEST_DELAY_MS = 500;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function get(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return get(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        res.resume();
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
  });
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        fs.unlink(destPath, () => {});
        return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(destPath, () => {});
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let downloaded = 0;
      res.on('data', chunk => {
        downloaded += chunk.length;
        if (total) {
          const pct = Math.round(downloaded / total * 100);
          process.stdout.write(`\r  ${pct}% (${(downloaded/1e6).toFixed(1)} MB)`);
        }
      });
      res.pipe(file);
      file.on('finish', () => { file.close(); process.stdout.write('\n'); resolve(); });
    });
    req.on('error', err => { file.close(); fs.unlink(destPath, () => {}); reject(err); });
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('Download timeout')); });
  });
}

// Extract date from bff.fm broadcast page HTML: look for datePublished or visible date
function extractDateFromBroadcastPage(html) {
  // Try meta datePublished
  const metaMatch = html.match(/datePublished["\s:]+(\d{4}-\d{2}-\d{2})/);
  if (metaMatch) return metaMatch[1];

  // Try og:updated_time or similar
  const ogMatch = html.match(/content="(\d{4}-\d{2}-\d{2})T/);
  if (ogMatch) return ogMatch[1];

  // Try time element
  const timeMatch = html.match(/<time[^>]+datetime="(\d{4}-\d{2}-\d{2})"/);
  if (timeMatch) return timeMatch[1];

  return null;
}

// Extract base64-encoded audio src from broadcast page
function extractAudioSrc(html) {
  const match = html.match(/data-audio-src="([^"]+)"/);
  if (!match) return null;
  try {
    return Buffer.from(match[1], 'base64').toString('utf8');
  } catch {
    return null;
  }
}

// Get the local dates we already have
function getLocalDates() {
  const files = fs.readdirSync(ALL_EPISODES_DIR);
  const dates = new Set();
  for (const f of files) {
    if (!fs.statSync(path.join(ALL_EPISODES_DIR, f)).isFile()) continue;
    const match = f.match(/(\d{4}-\d{2}-\d{2})/);
    if (match) dates.add(match[1]);
  }
  // Also check bff-fm-downloads subdir
  if (fs.existsSync(DOWNLOAD_DIR)) {
    for (const f of fs.readdirSync(DOWNLOAD_DIR)) {
      const match = f.match(/(\d{4}-\d{2}-\d{2})/);
      if (match) dates.add(match[1]);
    }
  }
  return dates;
}

async function main() {
  // Create download dir
  if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    console.log(`Created: ${DOWNLOAD_DIR}`);
  }

  const localDates = getLocalDates();
  console.log(`Local episodes: ${localDates.size} unique dates\n`);

  console.log('Scraping bff.fm show pages for broadcast IDs and dates...');
  const broadcastMap = {}; // id -> { id, date }
  let page = 1;
  while (true) {
    const url = page === 1 ? SHOW_URL : `${SHOW_URL}/page:${page}`;
    let html;
    try {
      html = await get(url);
    } catch (err) {
      if (err.message.includes('404')) break;
      console.error(`Error page ${page}: ${err.message}`);
      page++;
      await sleep(1000);
      continue;
    }

    // Each episode block looks like:
    //   <a href="/broadcasts/ID">Title</a>
    //   ...
    //   <time ... datetime="YYYY-MM-DDT...">
    // datetime has full ISO format: 2026-03-12T07:30:00-07:00
    const blockRegex = /href="\/broadcasts\/(\d+)"[\s\S]{0,2000}?datetime="(\d{4}-\d{2}-\d{2})T/g;
    let m;
    let foundAny = false;
    while ((m = blockRegex.exec(html)) !== null) {
      const id = m[1];
      const date = m[2];
      if (!broadcastMap[id]) {
        broadcastMap[id] = { id, date };
        foundAny = true;
      }
    }

    if (!foundAny) {
      // Try alternate: time comes before the broadcast link
      const altRegex = /datetime="(\d{4}-\d{2}-\d{2})T[\s\S]{0,2000}?href="\/broadcasts\/(\d+)"/g;
      while ((m = altRegex.exec(html)) !== null) {
        const date = m[1];
        const id = m[2];
        if (!broadcastMap[id]) {
          broadcastMap[id] = { id, date };
          foundAny = true;
        }
      }
    }

    if (!foundAny && Object.keys(broadcastMap).length > 0) {
      // No more entries found, likely past last page
      break;
    }

    process.stdout.write(`\r  Page ${page}: ${Object.keys(broadcastMap).length} broadcasts with dates`);
    page++;
    await sleep(REQUEST_DELAY_MS);
  }
  console.log(`\n  Total with dates: ${Object.keys(broadcastMap).length}`);

  // Find which broadcasts have dates not in our local collection
  const missing = Object.values(broadcastMap)
    .filter(({ date }) => !localDates.has(date));

  // Sort by date
  missing.sort((a, b) => a.date.localeCompare(b.date));

  console.log(`\nBroadcasts missing locally: ${missing.length}`);
  if (missing.length === 0) {
    console.log('Nothing to download!');
    return;
  }

  for (const { id, date } of missing) {
    console.log(`  ${date} (broadcast ${id})`);
  }

  console.log('\nFetching audio URLs and downloading...\n');
  let downloaded = 0;
  let failed = 0;

  for (const { id, date } of missing) {
    const broadcastUrl = `https://bff.fm/broadcasts/${id}`;
    process.stdout.write(`[${date}] broadcast/${id} - fetching page... `);

    let html;
    try {
      html = await get(broadcastUrl);
    } catch (err) {
      console.log(`SKIP (page fetch failed: ${err.message})`);
      failed++;
      await sleep(REQUEST_DELAY_MS);
      continue;
    }

    const audioUrl = extractAudioSrc(html);
    if (!audioUrl) {
      console.log('SKIP (no audio URL found)');
      failed++;
      await sleep(REQUEST_DELAY_MS);
      continue;
    }

    // Derive filename from URL
    const urlFilename = path.basename(new URL(audioUrl).pathname);
    const destPath = path.join(DOWNLOAD_DIR, urlFilename);

    if (fs.existsSync(destPath)) {
      console.log(`already downloaded`);
      downloaded++;
      continue;
    }

    console.log(`downloading ${urlFilename}`);
    try {
      await downloadFile(audioUrl, destPath);
      console.log(`  -> saved to bff-fm-downloads/${urlFilename}`);
      downloaded++;
    } catch (err) {
      console.log(`  FAILED: ${err.message}`);
      if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
      failed++;
    }

    await sleep(REQUEST_DELAY_MS);
  }

  console.log(`\nDone. Downloaded: ${downloaded}, Failed: ${failed}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
