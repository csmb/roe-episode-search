import { describe, it, expect } from 'vitest';
import { detectGuestStart, FALLBACK_MS } from '../../scripts/guest-start.js';

// 50 minutes — the earliest a guest interview is considered.
const BASE = 3_000_000;

function seg(start_ms, end_ms, text) {
	return { start_ms, end_ms, text };
}

describe('detectGuestStart', () => {
	it('returns null when there are no guests', () => {
		const segments = [seg(BASE, BASE + 5000, 'welcome back jane')];
		expect(detectGuestStart(segments, [])).toBe(null);
	});

	it('returns null when nothing happens after 50 minutes', () => {
		const segments = [seg(0, 1000, 'here is jane early on')];
		expect(detectGuestStart(segments, ['Jane'])).toBe(null);
	});

	it('after a song break, returns the first guest mention (Strategy 1)', () => {
		const segments = [
			seg(BASE, BASE + 10_000, 'welcome back everyone'),
			seg(BASE + 10_000, BASE + 200_000, '[music]'), // 190s song → break
			seg(BASE + 200_000, BASE + 210_000, 'please welcome Jane to the show'),
		];
		expect(detectGuestStart(segments, ['Jane'])).toBe(BASE + 200_000);
	});

	it('matches guest names case-insensitively', () => {
		const segments = [
			seg(BASE, BASE + 10_000, 'welcome back'),
			seg(BASE + 10_000, BASE + 200_000, '[music]'),
			seg(BASE + 200_000, BASE + 210_000, 'say hi to JANE everybody'),
		];
		expect(detectGuestStart(segments, ['Jane'])).toBe(BASE + 200_000);
	});

	it('with no song break, falls back to first guest mention after 50min (Fallback A)', () => {
		const segments = [
			seg(BASE, BASE + 5_000, 'chatter chatter'),
			seg(BASE + 5_000, BASE + 10_000, "here's Jane now"),
		];
		expect(detectGuestStart(segments, ['Jane'])).toBe(BASE + 5_000);
	});

	it('after a song break with no guest mention, returns first post-break segment (Fallback B)', () => {
		const segments = [
			seg(BASE, BASE + 10_000, 'welcome back'),
			seg(BASE + 10_000, BASE + 200_000, '[music]'), // song → break
			seg(BASE + 200_000, BASE + 210_000, 'some chatter'),
			seg(BASE + 210_000, BASE + 220_000, 'more chatter'),
		];
		expect(detectGuestStart(segments, ['Zelda'])).toBe(BASE + 200_000);
	});

	it('with no break and no mention, falls back to 1 hour (Fallback C)', () => {
		const segments = [
			seg(BASE, BASE + 5_000, 'a'),
			seg(BASE + 5_000, BASE + 10_000, 'b'),
		];
		expect(detectGuestStart(segments, ['Nobody'])).toBe(FALLBACK_MS);
	});
});
