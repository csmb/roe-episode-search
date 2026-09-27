/**
 * A D1 binding for Node scripts, so a script can run the Worker's own code
 * (roe-pipeline/src/*.js) against the database instead of keeping a copy of
 * it. Each statement goes through `wrangler d1 execute` (lib.js), with its
 * bound parameters written into the SQL as literals.
 *
 * It's slow (a second or two per statement), and batch() isn't one
 * transaction: fine for repair tools that can simply be run again.
 */

import { queryJSON, runSQL } from './lib.js';

function literal(value) {
	if (value === null || value === undefined) return 'NULL';
	if (typeof value === 'boolean') return value ? '1' : '0';
	if (typeof value === 'number' || typeof value === 'bigint') {
		if (!Number.isFinite(Number(value))) throw new Error(`Can't bind ${value}`);
		return String(value);
	}
	return `'${String(value).replace(/'/g, "''")}'`;
}

/** Replace `?` and `?NNN` placeholders outside string literals with the bound values. */
export function inlineParams(sql, args) {
	let out = '';
	let next = 0;
	let inString = false;
	for (let i = 0; i < sql.length; i++) {
		const c = sql[i];
		if (c === "'") inString = !inString; // '' inside a string toggles twice, so it stays inside
		if (c !== '?' || inString) {
			out += c;
			continue;
		}
		const number = /^\d+/.exec(sql.slice(i + 1));
		const index = number ? Number(number[0]) - 1 : next++;
		if (index >= args.length) throw new Error(`No value bound for parameter ${index + 1} in: ${sql.slice(0, 80)}`);
		out += literal(args[index]);
		if (number) i += number[0].length;
	}
	return out;
}

/** @param {{local?: boolean}} [opts] - `local: true` targets the local D1 copy instead of production. */
export function remoteD1({ local = false } = {}) {
	const target = { isLocal: local };
	const statement = (sql, args = []) => ({
		sql,
		args,
		bind: (...values) => statement(sql, values),
		all: async () => ({ results: queryJSON(inlineParams(sql, args), target), success: true }),
		first: async column => {
			const row = queryJSON(inlineParams(sql, args), target)[0] ?? null;
			return row && column ? row[column] : row;
		},
		run: async () => {
			runSQL(inlineParams(sql, args), target);
			return { success: true };
		},
	});
	return {
		prepare: sql => statement(sql),
		async batch(statements) {
			if (statements.length > 0) runSQL(statements.map(s => inlineParams(s.sql, s.args)).join(';\n'), target);
			return statements.map(() => ({ success: true }));
		},
	};
}
