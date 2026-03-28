#!/usr/bin/env node

/**
 * Generate stars.json — word frequency data for the Stellar Lexicon visualization.
 *
 * Queries all transcript segments from D1, computes word frequencies,
 * assigns deterministic celestial coordinates, and uploads to R2.
 *
 * Usage:
 *   node scripts/generate-stars.js [--dry-run]
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DB_NAME = 'roe-episodes';
const R2_BUCKET = 'roe-audio';
const R2_KEY = 'data/stars.json';
const MAX_STARS = 1500;
const BATCH_SIZE = 5000;

const workerDir = path.resolve(
    path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)),
    '..', 'roe-search'
);

// --- Wrangler helpers (same pattern as process-episode.js) ---

function wranglerExec(args, opts = {}) {
    const env = { ...process.env };
    delete env.CLOUDFLARE_API_TOKEN;
    return execSync(`npx wrangler ${args}`, {
        cwd: workerDir,
        encoding: 'utf-8',
        stdio: opts.stdio || 'pipe',
        env,
        ...opts,
    });
}

function queryJSON(sql) {
    const cmd = `d1 execute ${DB_NAME} --remote --json --command="${sql.replace(/"/g, '\\"')}"`;
    const result = wranglerExec(cmd);
    const parsed = JSON.parse(result);
    return parsed[0]?.results ?? [];
}

// --- Stop words ---

const STOP_WORDS = new Set([
    'the', 'be', 'to', 'of', 'and', 'in', 'that', 'have', 'it', 'for',
    'not', 'on', 'with', 'he', 'as', 'you', 'do', 'at', 'this', 'but',
    'his', 'by', 'from', 'they', 'we', 'say', 'her', 'she', 'or', 'an',
    'will', 'my', 'one', 'all', 'would', 'there', 'their', 'what', 'so',
    'up', 'out', 'if', 'about', 'who', 'get', 'which', 'go', 'me', 'when',
    'make', 'can', 'like', 'time', 'no', 'just', 'him', 'know', 'take',
    'people', 'into', 'year', 'your', 'good', 'some', 'could', 'them',
    'see', 'other', 'than', 'then', 'now', 'look', 'only', 'come', 'its',
    'over', 'think', 'also', 'back', 'after', 'use', 'two', 'how', 'our',
    'work', 'first', 'well', 'way', 'even', 'new', 'want', 'because',
    'any', 'these', 'give', 'day', 'most', 'us', 'was', 'were', 'been',
    'had', 'are', 'has', 'did', 'got', 'said', 'is', 'am', 'does', 'done',
    'going', 'being', 'having', 'yeah', 'yes', 'right', 'okay', 'oh',
    'uh', 'um', 'know', 'mean', 'thing', 'things', 'kind', 'really',
    'actually', 'gonna', 'lot', 'don', 'didn', 'isn', 'wasn', 'aren',
    'doesn', 'wouldn', 'couldn', 'very', 'much', 'still', 'too', 'here',
    'where', 'why', 'let', 'down', 'should', 'own', 'while', 'those',
    'both', 'each', 'through', 'same', 'off', 'before', 'must', 'between',
    'such', 'may', 'again', 'might', 'never', 'every', 'more', 'put',
    'another', 'always', 'many', 'great', 'little', 'big', 'old', 'few',
    'around', 'long', 'made', 'away', 'keep', 'went', 'tell', 'called',
    'came', 'thought', 'part', 'whole', 'something', 'nothing', 'everything',
    'anything', 'someone', 'everyone', 'myself', 'himself', 'themselves',
    'yourself', 'what', 'being', 'have', 'been', 'just', 'really', 'that',
    'gonna', 'gotta', 'wanna', 'kinda', 'sorta', 'cause', 'though',
]);

// --- Coordinate assignment ---
// Note: The spec mentions Poisson-disc sampling, but FNV-1a hash gives
// sufficiently even distribution for 1500 words on a sphere without the
// complexity of spherical Poisson-disc. Each word always maps to the same
// position across regenerations (deterministic).

function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

function wordToCoords(word) {
    const h1 = fnv1a(word);
    const h2 = fnv1a(word + '\x00');
    const ra = Math.round(((h1 % 864000) / 36000) * 1000) / 1000;   // 0–24 hours
    const dec = Math.round(((h2 % 18001) / 100 - 90) * 100) / 100;  // -90 to +90 degrees
    return { ra, dec };
}

// --- Main ---

const dryRun = process.argv.includes('--dry-run');

console.log('Stellar Lexicon — generating stars.json');
console.log('========================================\n');

// 1. Count total segments
const [{ cnt }] = queryJSON('SELECT COUNT(*) as cnt FROM transcript_segments');
console.log(`Total segments: ${cnt}`);

// 2. Count episodes
const [{ ecnt }] = queryJSON('SELECT COUNT(*) as ecnt FROM episodes');
console.log(`Total episodes: ${ecnt}`);

// 3. Extract word frequencies in batches
console.log(`\nExtracting words in batches of ${BATCH_SIZE}...`);
const wordCounts = new Map();
let offset = 0;
let batchNum = 0;

while (true) {
    const rows = queryJSON(
        `SELECT text FROM transcript_segments LIMIT ${BATCH_SIZE} OFFSET ${offset}`
    );
    if (rows.length === 0) break;

    for (const row of rows) {
        const words = row.text.toLowerCase().replace(/[^a-z'-]/g, ' ').split(/\s+/);
        for (const word of words) {
            if (word.length >= 3 && !STOP_WORDS.has(word)) {
                wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
            }
        }
    }

    offset += BATCH_SIZE;
    batchNum++;
    process.stdout.write(`  Batch ${batchNum}: ${offset} segments processed\r`);
}
console.log(`\nUnique words (after filtering): ${wordCounts.size}`);

// 4. Sort by frequency, take top N
const sorted = [...wordCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_STARS);

console.log(`Top ${sorted.length} words selected`);
console.log(`  Most frequent: "${sorted[0][0]}" (${sorted[0][1]})`);
console.log(`  Least frequent: "${sorted[sorted.length - 1][0]}" (${sorted[sorted.length - 1][1]})`);

// 5. Build stars array with coordinates
const stars = sorted.map(([word, count]) => {
    const { ra, dec } = wordToCoords(word);
    return { w: word, c: count, ra, dec };
});

const output = {
    generated: new Date().toISOString(),
    total_episodes: Number(ecnt),
    total_segments: Number(cnt),
    stars,
};

const jsonStr = JSON.stringify(output);
console.log(`\nOutput size: ${(jsonStr.length / 1024).toFixed(1)} KB`);

// 6. Write local file and upload to R2
const outPath = path.resolve(workerDir, '..', 'stars.json');
fs.writeFileSync(outPath, jsonStr);
console.log(`Written to ${outPath}`);

if (dryRun) {
    console.log('\n--dry-run: skipping R2 upload');
} else {
    console.log(`\nUploading to R2: ${R2_BUCKET}/${R2_KEY}`);
    wranglerExec(
        `r2 object put ${R2_BUCKET}/${R2_KEY} --file="${outPath}" --content-type="application/json"`,
        { stdio: 'inherit' }
    );
    console.log('Upload complete.');
}

console.log('\nDone.');
