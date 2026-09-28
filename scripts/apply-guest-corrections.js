#!/usr/bin/env node

/**
 * Apply guest corrections from guest-corrections.json to D1.
 * Dry-run by default; use --apply to execute changes.
 *
 * Usage:
 *   node scripts/apply-guest-corrections.js              # dry-run (remote)
 *   node scripts/apply-guest-corrections.js --apply      # apply to remote
 *   node scripts/apply-guest-corrections.js --local --apply
 */

import { loadEnv, parseFlags, queryJSON as libQueryJSON, runSQL as libRunSQL } from './lib.js';
import fs from 'node:fs';
import path from 'node:path';

loadEnv();

function escapeSQL(str) {
	return str.replace(/'/g, "''");
}

// lib.js runs wrangler without a shell, so a name with "$" or backticks stays as typed.
function runSQL(sql, isLocal) {
	return libRunSQL(sql, { isLocal });
}

function queryJSON(sql, isLocal) {
	return libQueryJSON(sql, { isLocal });
}

function countRows(name, isLocal) {
	const rows = queryJSON(
		`SELECT COUNT(*) AS n FROM episode_guests WHERE guest_name = '${escapeSQL(name)}'`,
		isLocal
	);
	return rows[0]?.n ?? 0;
}

// ── Main ──────────────────────────────────────────────────────────────

function main() {
	const usage = 'Usage: node scripts/apply-guest-corrections.js [--local] [--apply]';
	const { flags, rest } = parseFlags(process.argv.slice(2), { '--local': 'flag', '--apply': 'flag', '--help': 'flag', '-h': 'flag' }, usage);
	if (flags.help || flags.h) {
		console.log(usage);
		console.log('');
		console.log('Applies guest-corrections.json renames and deletes to D1.');
		console.log('  --local   Target local D1 database');
		console.log('  --apply   Execute changes (default: dry-run preview only)');
		process.exit(0);
	}
	if (rest.length > 0) {
		console.error(`Unexpected argument: ${rest.join(' ')}\n\n${usage}`);
		process.exit(1);
	}

	const isLocal = !!flags.local;
	const apply = !!flags.apply;

	const correctionsPath = path.resolve(
		path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)),
		'guest-corrections.json'
	);

	if (!fs.existsSync(correctionsPath)) {
		console.error('Error: guest-corrections.json not found');
		process.exit(1);
	}

	const corrections = JSON.parse(fs.readFileSync(correctionsPath, 'utf-8'));
	const renames = corrections.renames || {};
	const deletes = corrections.deletes || [];

	if (Object.keys(renames).length === 0 && deletes.length === 0) {
		console.log('No corrections in guest-corrections.json. Nothing to do.');
		process.exit(0);
	}

	console.log(`Target: ${isLocal ? 'local' : 'remote'} D1 database`);
	console.log(`Mode:   ${apply ? 'APPLY' : 'dry-run'}`);
	console.log();

	let totalChanges = 0;

	// Process renames
	for (const [oldName, newName] of Object.entries(renames)) {
		const count = countRows(oldName, isLocal);

		const insertSQL = `INSERT OR IGNORE INTO episode_guests SELECT episode_id, '${escapeSQL(newName)}' FROM episode_guests WHERE guest_name = '${escapeSQL(oldName)}'`;
		const deleteSQL = `DELETE FROM episode_guests WHERE guest_name = '${escapeSQL(oldName)}'`;

		if (apply) {
			console.log(`Renaming "${oldName}" → "${newName}" (${count} rows)...`);
			runSQL(insertSQL, isLocal);
			runSQL(deleteSQL, isLocal);
			console.log(`  Done.`);
		} else {
			console.log(`[dry-run] Rename "${oldName}" → "${newName}" (${count} rows)`);
			console.log(`  ${insertSQL}`);
			console.log(`  ${deleteSQL}`);
		}

		totalChanges += count;
	}

	if (Object.keys(renames).length > 0) console.log();

	// Process deletes
	for (const name of deletes) {
		const count = countRows(name, isLocal);
		const deleteSQL = `DELETE FROM episode_guests WHERE guest_name = '${escapeSQL(name)}'`;

		if (apply) {
			console.log(`Deleting "${name}" (${count} rows)...`);
			runSQL(deleteSQL, isLocal);
			console.log(`  Done.`);
		} else {
			console.log(`[dry-run] Delete "${name}" (${count} rows)`);
			console.log(`  ${deleteSQL}`);
		}

		totalChanges += count;
	}

	if (deletes.length > 0) console.log();

	console.log(`=== ${apply ? 'Applied' : 'Preview'}: ${Object.keys(renames).length} rename(s), ${deletes.length} delete(s), ~${totalChanges} total row(s) affected ===`);

	if (!apply) {
		console.log();
		console.log('Run with --apply to execute these changes.');
	}
}

main();
