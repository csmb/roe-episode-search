/**
 * Parse an episode ID from an R2 object key (filename).
 * Returns canonical format: roll-over-easy_YYYY-MM-DD_HH-MM-SS
 * Returns null if the filename is unrecognized or not an MP3.
 */

// Lookup table for historic month-day-only filenames (2014 episodes)
const MONTH_DAY_2014 = {
  'jan 9': '2014-01-09', 'jan 13': '2014-01-13', 'jan 16': '2014-01-16',
  'jan 23': '2014-01-23', 'jan 30': '2014-01-30',
  'feb 6': '2014-02-06', 'feb 13': '2014-02-13', 'feb 18': '2014-02-18',
  'feb 26': '2014-02-26',
  'march 6': '2014-03-06', 'march 13': '2014-03-13', 'march 20': '2014-03-20',
  'march 27': '2014-03-27',
  'april 3': '2014-04-03', 'april 10': '2014-04-10', 'april 17': '2014-04-17',
  'april 24': '2014-04-24',
};

export function parseEpisodeId(key) {
  // Strip directory prefix if present
  const filename = key.includes('/') ? key.split('/').pop() : key;

  // Only process MP3 files
  if (!filename.toLowerCase().endsWith('.mp3')) return null;

  // Strip extension
  const stem = filename.replace(/\.mp3$/i, '');

  // Canonical: roll-over-easy_2026-02-16_07-30-00 (with optional " copy")
  const canonicalMatch = stem.match(/^(roll-over-easy_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})(\s+copy)?$/);
  if (canonicalMatch) return canonicalMatch[1];

  // App Recording: "App Recording 20260216 0730"
  const appMatch = stem.match(/App[_ ]Recording[_ ]+(\d{4})(\d{2})(\d{2})[_ ]+(\d{2})(\d{2})/i);
  if (appMatch) {
    const [, y, m, d, hh, mm] = appMatch;
    return `roll-over-easy_${y}-${m}-${d}_${hh}-${mm}-00`;
  }

  // Input Device Recording: "Input Device Recording 20220815 2051"
  const inputMatch = stem.match(/Input Device Recording\s+(\d{4})(\d{2})(\d{2})\s+(\d{2})(\d{2})/i);
  if (inputMatch) {
    const [, y, m, d, hh, mm] = inputMatch;
    return `roll-over-easy_${y}-${m}-${d}_${hh}-${mm}-00`;
  }

  // Podcast Roll Over Easy YYYYMMDD
  const podcastMatch = stem.match(/Podcast Roll Over Easy\s+(\d{4})(\d{2})(\d{2})/i);
  if (podcastMatch) {
    const [, y, m, d] = podcastMatch;
    return `roll-over-easy_${y}-${m}-${d}_07-30-00`;
  }

  // Roll Over Easy YYYYMMDD
  const roeYMDMatch = stem.match(/^Roll Over Easy\s+(\d{4})(\d{2})(\d{2})/i);
  if (roeYMDMatch) {
    const [, y, m, d] = roeYMDMatch;
    return `roll-over-easy_${y}-${m}-${d}_07-30-00`;
  }

  // Roll Over Easy - YYYY-MM-DD
  const roeDashMatch = stem.match(/^Roll Over Easy\s*-\s*(\d{4})-(\d{2})-(\d{2})/i);
  if (roeDashMatch) {
    const [, y, m, d] = roeDashMatch;
    return `roll-over-easy_${y}-${m}-${d}_07-30-00`;
  }

  // Roll Over Easy YYYY-MM-DD
  const roeSpaceDashMatch = stem.match(/^Roll Over Easy\s+(\d{4})-(\d{2})-(\d{2})(?:\s|$)/i);
  if (roeSpaceDashMatch) {
    const [, y, m, d] = roeSpaceDashMatch;
    return `roll-over-easy_${y}-${m}-${d}_07-30-00`;
  }

  // Roll_Over_Easy_-_YYYY-MM-DD
  const roeUnderscoreDashMatch = stem.match(/^Roll_Over_Easy_-_(\d{4})-(\d{2})-(\d{2})/i);
  if (roeUnderscoreDashMatch) {
    const [, y, m, d] = roeUnderscoreDashMatch;
    return `roll-over-easy_${y}-${m}-${d}_07-30-00`;
  }

  // roll_over_easy-YYYY-MM-DD
  const roeUnderscoreMatch = stem.match(/^roll_over_easy-(\d{4})-(\d{2})-(\d{2})/i);
  if (roeUnderscoreMatch) {
    const [, y, m, d] = roeUnderscoreMatch;
    return `roll-over-easy_${y}-${m}-${d}_07-30-00`;
  }

  // roll-over-easy YYYY-MM-DD
  const roeSpaceMatch = stem.match(/^roll-over-easy\s+(\d{4})-(\d{2})-(\d{2})/i);
  if (roeSpaceMatch) {
    const [, y, m, d] = roeSpaceMatch;
    return `roll-over-easy_${y}-${m}-${d}_07-30-00`;
  }

  // rec_(YYYY_MM_DD)_N
  const recYMDMatch = stem.match(/^rec_\((\d{4})_(\d{2})_(\d{2})\)_/);
  if (recYMDMatch) {
    const [, y, m, d] = recYMDMatch;
    return `roll-over-easy_${y}-${m}-${d}_07-30-00`;
  }

  // rec_(MM_DD_YYYY)_N
  const recMDYMatch = stem.match(/^rec_\((\d{2})_(\d{2})_(\d{4})\)_/);
  if (recMDYMatch) {
    const [, m, d, y] = recMDYMatch;
    return `roll-over-easy_${y}-${m}-${d}_07-30-00`;
  }

  // Month-day-only: "Feb 6 - Roll Over Easy"
  const monthDayPrefix = stem.match(/^(Jan|Feb|March|April)\s+(\d{1,2})\s*-\s*Roll Over Easy/i);
  if (monthDayPrefix) {
    const key = `${monthDayPrefix[1].toLowerCase()} ${monthDayPrefix[2]}`;
    if (MONTH_DAY_2014[key]) return `roll-over-easy_${MONTH_DAY_2014[key]}_07-30-00`;
  }

  // Month-day-only: "Roll Over Easy March 20"
  const monthDaySuffix = stem.match(/^Roll Over Easy\s+(Jan|Feb|March|April)\s+(\d{1,2})/i);
  if (monthDaySuffix) {
    const key = `${monthDaySuffix[1].toLowerCase()} ${monthDaySuffix[2]}`;
    if (MONTH_DAY_2014[key]) return `roll-over-easy_${MONTH_DAY_2014[key]}_07-30-00`;
  }

  return null;
}
