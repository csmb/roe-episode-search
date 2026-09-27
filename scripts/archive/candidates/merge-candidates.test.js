#!/usr/bin/env node
/**
 * merge-candidates.test.js
 *
 * Tests for merge-candidates.js using node:test and node:assert/strict.
 *
 * Run with:
 *   node --test scripts/candidates/merge-candidates.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeName, shouldFilter, deduplicateCandidates } from './merge-candidates.js';

// ---------------------------------------------------------------------------
// normalizeName
// ---------------------------------------------------------------------------

describe('normalizeName', () => {
  it('lowercases and trims whitespace', () => {
    assert.equal(normalizeName('  Ritual Coffee  '), 'ritual coffee');
  });

  it('strips Inc suffix', () => {
    assert.equal(normalizeName('Acme Foods Inc'), 'acme foods');
  });

  it('strips Inc. suffix (with period)', () => {
    assert.equal(normalizeName('Acme Foods Inc.'), 'acme foods');
  });

  it('strips LLC suffix', () => {
    assert.equal(normalizeName('Acme LLC'), 'acme');
  });

  it('strips Corp. suffix (with period)', () => {
    assert.equal(normalizeName('Acme Corp.'), 'acme');
  });

  it('strips Corp suffix', () => {
    assert.equal(normalizeName('Acme Corp'), 'acme');
  });

  it('strips Co suffix', () => {
    assert.equal(normalizeName('Acme Co'), 'acme');
  });

  it('strips Ltd suffix', () => {
    assert.equal(normalizeName('Acme Ltd'), 'acme');
  });

  it('strips LP suffix', () => {
    assert.equal(normalizeName('Acme LP'), 'acme');
  });

  it('collapses multiple spaces to single', () => {
    assert.equal(normalizeName('Golden   Gate   Park'), 'golden gate park');
  });

  it('strips trailing SF', () => {
    assert.equal(normalizeName('Tartine Bakery SF'), 'tartine bakery');
  });

  it('strips trailing San Francisco', () => {
    assert.equal(normalizeName('Blue Bottle San Francisco'), 'blue bottle');
  });

  it('strips trailing San Francisco (case-insensitive)', () => {
    assert.equal(normalizeName('Blue Bottle san francisco'), 'blue bottle');
  });

  it('is case-insensitive for suffixes', () => {
    assert.equal(normalizeName('Acme inc'), 'acme');
    assert.equal(normalizeName('Acme LLC'), 'acme');
  });
});

// ---------------------------------------------------------------------------
// shouldFilter
// ---------------------------------------------------------------------------

describe('shouldFilter', () => {
  it('filters names of 2 characters or fewer', () => {
    assert.equal(shouldFilter({ name: 'AB' }), true);
    assert.equal(shouldFilter({ name: 'A' }), true);
  });

  it('does not filter names of 3+ characters (non-numeric, non-stoplist)', () => {
    assert.equal(shouldFilter({ name: 'ABC' }), false);
  });

  it('filters purely numeric names', () => {
    assert.equal(shouldFilter({ name: '12345' }), true);
    assert.equal(shouldFilter({ name: '0' }), true);
  });

  it('does not filter alphanumeric names', () => {
    assert.equal(shouldFilter({ name: 'Route 66' }), false);
  });

  it('filters stoplist word: The Page', () => {
    assert.equal(shouldFilter({ name: 'The Page' }), true);
  });

  it('filters stoplist word: Grace', () => {
    assert.equal(shouldFilter({ name: 'Grace' }), true);
  });

  it('filters stoplist word: Amber', () => {
    assert.equal(shouldFilter({ name: 'Amber' }), true);
  });

  it('filters stoplist words case-insensitively', () => {
    assert.equal(shouldFilter({ name: 'GRACE' }), true);
    assert.equal(shouldFilter({ name: 'amber' }), true);
    assert.equal(shouldFilter({ name: 'The Page' }), true);
  });

  it('does not filter valid business names', () => {
    assert.equal(shouldFilter({ name: 'Ritual Coffee Roasters' }), false);
    assert.equal(shouldFilter({ name: 'Dolores Park' }), false);
    assert.equal(shouldFilter({ name: 'Golden Gate Bridge' }), false);
  });
});

// ---------------------------------------------------------------------------
// deduplicateCandidates
// ---------------------------------------------------------------------------

describe('deduplicateCandidates', () => {
  it('merges two entries with the same normalized name', () => {
    const candidates = [
      {
        name: 'Ritual Coffee',
        normalizedName: 'ritual coffee',
        address: '1026 Valencia St, San Francisco, CA 94110',
        lat: 37.757,
        lng: -122.421,
        source: 'yelp',
        sources: ['yelp'],
        category: 'coffee',
        categories: ['coffee'],
        meta: { yelp_id: 'abc' },
      },
      {
        name: 'Ritual Coffee',
        normalizedName: 'ritual coffee',
        address: '1026 Valencia St, San Francisco, 94110',
        lat: null,
        lng: null,
        source: 'datasf',
        sources: ['datasf'],
        category: 'restaurant',
        categories: ['restaurant'],
        meta: { naics_code: '7225' },
      },
    ];

    const result = deduplicateCandidates(candidates);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].sources.sort(), ['datasf', 'yelp']);
  });

  it('preserves the original casing from the first source', () => {
    const candidates = [
      {
        name: 'Ritual Coffee',
        normalizedName: 'ritual coffee',
        address: '1026 Valencia St',
        lat: 37.757,
        lng: -122.421,
        source: 'yelp',
        sources: ['yelp'],
        category: 'coffee',
        categories: ['coffee'],
        meta: {},
      },
    ];
    const result = deduplicateCandidates(candidates);
    assert.equal(result[0].name, 'Ritual Coffee');
  });

  it('prefers yelp coords over datasf null coords', () => {
    const candidates = [
      {
        name: 'Ritual Coffee',
        normalizedName: 'ritual coffee',
        address: '1026 Valencia St',
        lat: null,
        lng: null,
        source: 'datasf',
        sources: ['datasf'],
        category: 'restaurant',
        categories: ['restaurant'],
        meta: {},
      },
      {
        name: 'Ritual Coffee',
        normalizedName: 'ritual coffee',
        address: '1026 Valencia St',
        lat: 37.757,
        lng: -122.421,
        source: 'yelp',
        sources: ['yelp'],
        category: 'coffee',
        categories: ['coffee'],
        meta: {},
      },
    ];

    const result = deduplicateCandidates(candidates);
    assert.equal(result.length, 1);
    assert.equal(result[0].lat, 37.757);
    assert.equal(result[0].lng, -122.421);
  });

  it('prefers osm coords over datasf null coords', () => {
    const candidates = [
      {
        name: 'Dolores Park',
        normalizedName: 'dolores park',
        address: null,
        lat: null,
        lng: null,
        source: 'datasf',
        sources: ['datasf'],
        category: 'entertainment',
        categories: ['entertainment'],
        meta: {},
      },
      {
        name: 'Dolores Park',
        normalizedName: 'dolores park',
        address: null,
        lat: 37.760,
        lng: -122.426,
        source: 'osm',
        sources: ['osm'],
        category: 'park',
        categories: ['park'],
        meta: { osm_id: 999 },
      },
    ];

    const result = deduplicateCandidates(candidates);
    assert.equal(result.length, 1);
    assert.equal(result[0].lat, 37.760);
    assert.equal(result[0].lng, -122.426);
  });

  it('merges categories from all sources', () => {
    const candidates = [
      {
        name: 'Ritual Coffee',
        normalizedName: 'ritual coffee',
        address: '1026 Valencia St',
        lat: 37.757,
        lng: -122.421,
        source: 'yelp',
        sources: ['yelp'],
        category: 'coffee',
        categories: ['coffee'],
        meta: {},
      },
      {
        name: 'Ritual Coffee',
        normalizedName: 'ritual coffee',
        address: '1026 Valencia St',
        lat: null,
        lng: null,
        source: 'datasf',
        sources: ['datasf'],
        category: 'restaurant',
        categories: ['restaurant'],
        meta: {},
      },
    ];

    const result = deduplicateCandidates(candidates);
    assert.equal(result.length, 1);
    assert.ok(result[0].categories.includes('coffee'));
    assert.ok(result[0].categories.includes('restaurant'));
  });

  it('keeps distinct places as separate entries', () => {
    const candidates = [
      {
        name: 'Ritual Coffee',
        normalizedName: 'ritual coffee',
        address: '1026 Valencia St',
        lat: 37.757,
        lng: -122.421,
        source: 'yelp',
        sources: ['yelp'],
        category: 'coffee',
        categories: ['coffee'],
        meta: {},
      },
      {
        name: 'Sightglass Coffee',
        normalizedName: 'sightglass coffee',
        address: '270 7th St',
        lat: 37.776,
        lng: -122.408,
        source: 'yelp',
        sources: ['yelp'],
        category: 'coffee',
        categories: ['coffee'],
        meta: {},
      },
    ];

    const result = deduplicateCandidates(candidates);
    assert.equal(result.length, 2);
  });

  it('includes all required fields on merged output', () => {
    const candidates = [
      {
        name: 'Ritual Coffee',
        normalizedName: 'ritual coffee',
        address: '1026 Valencia St',
        lat: 37.757,
        lng: -122.421,
        source: 'yelp',
        sources: ['yelp'],
        category: 'coffee',
        categories: ['coffee'],
        meta: { yelp_id: 'abc' },
      },
    ];

    const result = deduplicateCandidates(candidates);
    const r = result[0];
    assert.ok('name' in r, 'missing name');
    assert.ok('normalizedName' in r, 'missing normalizedName');
    assert.ok('address' in r, 'missing address');
    assert.ok('lat' in r, 'missing lat');
    assert.ok('lng' in r, 'missing lng');
    assert.ok('source' in r, 'missing source');
    assert.ok('sources' in r, 'missing sources');
    assert.ok('category' in r, 'missing category');
    assert.ok('categories' in r, 'missing categories');
    assert.ok('meta' in r, 'missing meta');
  });
});
