#!/usr/bin/env node

/**
 * Audit guest names in D1: list all guests, flag fuzzy duplicates, preview corrections.
 *
 * Usage:
 *   node scripts/audit-guests.js           # remote D1
 *   node scripts/audit-guests.js --local   # local D1
 */

import { loadEnv, parseFlags, queryJSON as libQueryJSON } from './lib.js';
import fs from 'node:fs';
import path from 'node:path';

loadEnv();

// lib.js runs wrangler without a shell, so a name with "$" or backticks stays as typed.
function queryJSON(sql, isLocal) {
	return libQueryJSON(sql, { isLocal });
}

// ── Levenshtein similarity ────────────────────────────────────────────

function levenshtein(a, b) {
	const m = a.length, n = b.length;
	let row = Array.from({ length: n + 1 }, (_, i) => i);
	for (let i = 1; i <= m; i++) {
		const next = [i];
		for (let j = 1; j <= n; j++) {
			next[j] = a[i - 1] === b[j - 1]
				? row[j - 1]
				: 1 + Math.min(row[j - 1], row[j], next[j - 1]);
		}
		row = next;
	}
	return row[n];
}

function nameSimilarity(a, b) {
	const na = a.toLowerCase().trim();
	const nb = b.toLowerCase().trim();
	const maxLen = Math.max(na.length, nb.length);
	if (maxLen === 0) return 1;
	return 1 - levenshtein(na, nb) / maxLen;
}

// ── Main ──────────────────────────────────────────────────────────────

function main() {
	const usage = 'Usage: node scripts/audit-guests.js [--local]';
	const { flags, rest } = parseFlags(process.argv.slice(2), { '--local': 'flag', '--help': 'flag', '-h': 'flag' }, usage);
	if (flags.help || flags.h) {
		console.log(usage);
		console.log('');
		console.log('Lists all guests, flags fuzzy duplicate pairs, previews pending corrections.');
		console.log('  --local   Target local D1 database');
		process.exit(0);
	}
	if (rest.length > 0) {
		console.error(`Unexpected argument: ${rest.join(' ')}\n\n${usage}`);
		process.exit(1);
	}

	const isLocal = !!flags.local;

	console.log(`Target: ${isLocal ? 'local' : 'remote'} D1 database`);
	console.log();

	// 1. Fetch all guests with counts. Group by the exact name, so spellings that
	// differ only in capitals show up as separate rows (and get flagged below).
	const guests = queryJSON(
		'SELECT guest_name, COUNT(*) as n FROM episode_guests GROUP BY guest_name ORDER BY guest_name COLLATE NOCASE',
		isLocal
	);

	console.log(`=== All Guests (${guests.length} total) ===`);
	console.log();
	for (const g of guests) {
		console.log(`  ${g.guest_name.padEnd(40)} ${g.n} episode${g.n !== 1 ? 's' : ''}`);
	}
	console.log();

	// 2. Flag fuzzy duplicate pairs (similarity ≥ 0.85)
	const THRESHOLD = 0.85;
	const flagged = [];
	for (let i = 0; i < guests.length; i++) {
		for (let j = i + 1; j < guests.length; j++) {
			const sim = nameSimilarity(guests[i].guest_name, guests[j].guest_name);
			if (sim >= THRESHOLD) {
				flagged.push({ a: guests[i], b: guests[j], sim });
			}
		}
	}

	if (flagged.length > 0) {
		console.log(`=== Potential Duplicates (similarity ≥ ${THRESHOLD}) ===`);
		console.log();
		for (const { a, b, sim } of flagged) {
			console.log(`  "${a.guest_name}" (${a.n} ep)  ↔  "${b.guest_name}" (${b.n} ep)  [${(sim * 100).toFixed(0)}%]`);
		}
		console.log();
	} else {
		console.log('=== No Potential Duplicates Found ===');
		console.log();
	}

	// 3. Preview pending corrections
	const correctionsPath = path.resolve(
		path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)),
		'guest-corrections.json'
	);

	if (!fs.existsSync(correctionsPath)) {
		console.log('No guest-corrections.json found.');
		return;
	}

	const corrections = JSON.parse(fs.readFileSync(correctionsPath, 'utf-8'));
	const renames = corrections.renames || {};
	const deletes = corrections.deletes || [];

	if (Object.keys(renames).length === 0 && deletes.length === 0) {
		console.log('=== No Pending Corrections ===');
		return;
	}

	console.log('=== Pending Corrections (guest-corrections.json) ===');
	console.log();

	if (Object.keys(renames).length > 0) {
		console.log('Renames:');
		for (const [oldName, newName] of Object.entries(renames)) {
			const rows = queryJSON(
				`SELECT COUNT(*) AS n FROM episode_guests WHERE guest_name = '${oldName.replace(/'/g, "''")}'`,
				isLocal
			);
			const count = rows[0]?.n ?? 0;
			console.log(`  "${oldName}" → "${newName}"  (${count} episode_guest row${count !== 1 ? 's' : ''})`);
		}
		console.log();
	}

	if (deletes.length > 0) {
		console.log('Deletes:');
		for (const name of deletes) {
			const rows = queryJSON(
				`SELECT COUNT(*) AS n FROM episode_guests WHERE guest_name = '${name.replace(/'/g, "''")}'`,
				isLocal
			);
			const count = rows[0]?.n ?? 0;
			console.log(`  "${name}"  (${count} episode_guest row${count !== 1 ? 's' : ''})`);
		}
		console.log();
	}
}

main();
