/**
 * Guest-interview start detection for the Cloudflare ingest pipeline.
 *
 * The local scripts use this detectGuestStart() too (scripts/guest-start.js
 * re-exports it), so both pipelines pick the same interview time.
 *
 * Only lines from 50 minutes on count. A line names the guest when it has
 * their full name, as whole words in any case, or their first name (the first
 * word of 3+ letters that isn't a title like "Dr." or an everyday word like
 * the "That" of "That MC") written with a capital, unless the line has no
 * capitals at all: "Burrito Justice", not "a good burrito". A line naming the
 * guest is a teaser when it is about later ("in a few minutes", "we'll",
 * "going to", "coming up"). Music is a line 90 s or longer, or a gap of 60 s
 * or more between lines (whisper.cpp leaves lyrics out); music less than 2
 * minutes apart is one song break. The interview starts at, in order:
 *   1. The earlier of: the first line after the first song break with a
 *      teaser in the 3 minutes before it or between its songs ("after this
 *      song, Jane Doe") or a line naming the guest in the 3 minutes after it
 *      ("we're back with Jane"); and the first line naming the guest with a
 *      welcome in it or the line right after ("joined by", "here with", "in
 *      the studio", "welcome").
 *   2. The first line naming the guest with a greeting ("good morning",
 *      "hello", "how are you", "what's up"): for transcripts that keep the
 *      lyrics, so have no gaps, and shows out and about.
 *   3. The first line naming the guest.
 *   4. 3,600,000 ms (1 hour).
 * Teasers only count before a song break: rules 1-3 skip them.
 * On a transcript that reaches 100 minutes, its last 10 minutes don't count:
 * that is where the show thanks the guest and signs off. (Until 2026-09-28 it
 * took the first mention after the show's last song break, which on a
 * complete transcript is the closing song, so it often picked the sign-off.)
 */

export const MIN_START_MS = 3_000_000; // 50 minutes
export const SONG_DURATION_MS = 90_000; // a line this long is music
export const GAP_THRESHOLD_MS = 60_000; // a gap this long between lines is music
export const FALLBACK_MS = 3_600_000; // 1 hour
export const ONE_BREAK_MS = 120_000; // music closer than this is one song break
export const NEAR_BREAK_MS = 180_000; // the guest named this close to a song break
export const FULL_SHOW_MS = 6_000_000; // a transcript that reaches 100 minutes has the sign-off...
export const SIGN_OFF_MS = 600_000; // ...in its last 10 minutes
export const NEXT_LINE_MS = 10_000; // a phrase split over two lines: the next one follows within 10 s

// Titles, and everyday words that start some guests' names ("That MC", "Just Shannon", "Will"):
// never a way of naming a guest on their own
const NOT_A_NAME = new Set([
  'dr', 'doctor', 'captain', 'officer', 'mayor', 'supervisor', 'chef', 'mr', 'mrs', 'ms', 'the', 'dj', 'judge', 'senator', 'reverend', 'rev',
  'that', 'just', 'will', 'little', 'san', 'francisco',
]);
// Whole words, as words() writes them (" we ll " for "we'll")
const LATER = / (going to|gonna|will|ll|shall|about to|in a few|in just a|in a minute|in a moment|in a bit|in a second|coming up|later|soon|shortly|when we get back|when we come back|after this|after the break|wait for|waiting for|gets here|get here|on the way|on his way|on her way|on their way) /;
const WELCOME = / (joined by|here with|with us now|in the studio|welcome) /;
const GREETING = / (good morning|hello|how are you|what s up) /;

/** Letters without their accents: "Sinéad" is "Sinead". */
const plain = (text) => String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
/** Lowercase words with one space between them and a space at each end, so " jane " finds a whole word. */
const words = (text) => ` ${plain(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;

/**
 * How a transcript names the guests: each guest's full name (" jane doe ") and first name
 * (" jane "). A first name alone only counts written with a capital, unless the line has no
 * capitals at all (some transcripts are all lowercase): "Burrito Justice", not "a good burrito".
 */
export function guestNameKeys(guestNames) {
  const full = new Set();
  const first = new Set();
  for (const name of guestNames) {
    const whole = words(name).trim();
    if (!whole) continue;
    const parts = whole.split(' ');
    if (parts.length > 1 || !NOT_A_NAME.has(whole)) full.add(` ${whole} `);
    const given = parts.find(w => w.length >= 3 && !NOT_A_NAME.has(w));
    if (given && given !== whole) first.add(` ${given} `);
  }
  // "Jane" or "JANE" as a word, not "jane"
  const capital = key => new RegExp(`(?:^|[^A-Za-z0-9])${[...key.trim()].map((c, i) => (i === 0 ? c.toUpperCase() : /[a-z]/.test(c) ? `[${c}${c.toUpperCase()}]` : c)).join('')}(?![A-Za-z0-9])`);
  return { full: [...full], first: [...first].map(key => ({ key, capital: capital(key) })) };
}

/** Whether a line names a guest (guestNameKeys), from its words and its text as written. */
function namesGuest(keys, lineWords, lineText) {
  if (keys.full.some(k => lineWords.includes(k))) return true;
  const hasCapitals = /[A-Z]/.test(lineText);
  return keys.first.some(({ key, capital }) => lineWords.includes(key) && (!hasCapitals || capital.test(plain(lineText))));
}

/** Song breaks: lines SONG_DURATION_MS+ long and GAP_THRESHOLD_MS+ gaps, those under ONE_BREAK_MS apart joined. */
export function songBreaks(lines) {
  const songs = [];
  lines.forEach((s, i) => {
    if (s.end_ms - s.start_ms >= SONG_DURATION_MS) songs.push({ start_ms: s.start_ms, end_ms: s.end_ms });
    const prev = lines[i - 1];
    if (prev && s.start_ms - prev.end_ms >= GAP_THRESHOLD_MS) songs.push({ start_ms: prev.end_ms, end_ms: s.start_ms });
  });
  songs.sort((a, b) => a.start_ms - b.start_ms);
  const breaks = [];
  for (const song of songs) {
    const last = breaks[breaks.length - 1];
    if (last && song.start_ms - last.end_ms < ONE_BREAK_MS) last.end_ms = Math.max(last.end_ms, song.end_ms);
    else breaks.push({ ...song });
  }
  return breaks;
}

/**
 * Detect the guest interview start timestamp from transcript segments.
 * @param {Array<{start_ms:number,end_ms:number,text:string}>} segments
 * @param {string[]} guestNames
 * @returns {number|null} start_ms, or null if detection fails
 */
export function detectGuestStart(segments, guestNames) {
  if (guestNames.length === 0) return null;

  const lines = [...segments].sort((a, b) => a.start_ms - b.start_ms);
  const late = lines.filter(s => s.start_ms >= MIN_START_MS);
  if (late.length === 0) return null;

  // A full show's last 10 minutes are its thanks and goodbyes
  const endMs = lines.reduce((ms, s) => Math.max(ms, s.end_ms), 0);
  const until = endMs >= FULL_SHOW_MS ? endMs - SIGN_OFF_MS : Infinity;
  const keys = guestNameKeys(guestNames);
  const text = late.map(s => words(s.text));
  const named = late.map((s, i) => s.start_ms <= until && namesGuest(keys, text[i], s.text ?? ''));
  // About later, not counting the name itself ("Will Durst" is no "will")
  const nameKeys = [...keys.full, ...keys.first.map(f => f.key)];
  const isLater = text.map(t => LATER.test(nameKeys.reduce((rest, k) => rest.split(k).join(' '), t)));
  const mentions = late.flatMap((s, i) => (named[i] ? [{ ms: s.start_ms, later: isLater[i] }] : []));
  // The first line naming the guest, not about later, with one of these words in it or in the
  // line right after it (a phrase split over two lines, not a line after a song)
  const firstNamedWith = (re) => {
    const i = late.findIndex((s, i) => {
      if (!named[i] || isLater[i]) return false;
      const next = late[i + 1];
      return !re || re.test(next && next.start_ms - s.end_ms <= NEXT_LINE_MS ? words(`${s.text} ${next.text}`) : text[i]);
    });
    return i === -1 ? null : late[i].start_ms;
  };

  // 1. After a song break with a teaser just before it (or in the talk between its songs) or
  //    the guest named just after it; or where the guest is welcomed, if that comes first
  const welcomed = firstNamedWith(WELCOME);
  for (const b of songBreaks(lines)) {
    if (welcomed != null && welcomed < b.end_ms) return welcomed;
    if (b.end_ms < MIN_START_MS || b.end_ms > until) continue;
    const near = mentions.some(m => (m.later
      ? m.ms < b.end_ms && m.ms >= b.start_ms - NEAR_BREAK_MS
      : m.ms >= b.end_ms && m.ms <= b.end_ms + NEAR_BREAK_MS));
    const next = near && lines.find(s => s.start_ms >= b.end_ms);
    if (next) return next.start_ms;
  }
  if (welcomed != null) return welcomed;

  // 2. Where the guest is greeted, then 3. first named
  return firstNamedWith(GREETING) ?? firstNamedWith(null) ?? FALLBACK_MS;
}

/**
 * Pipeline step: detect and persist guest_start_ms for an episode.
 * Reads the guest list from D1 (populated by the summary step) and writes
 * episodes.guest_start_ms — the field that gates the "Skip to interview" button.
 *
 * @param {D1Database} db
 * @param {string} episodeId
 * @param {Array<{start_ms:number,end_ms:number,text:string}>} segments
 * @param {number} durationMs
 * @returns {Promise<number|null>} the start_ms written, or null if skipped
 */
export async function seedGuestStart(db, episodeId, segments, durationMs) {
  const { results } = await db.prepare(
    'SELECT guest_name FROM episode_guests WHERE episode_id = ?'
  ).bind(episodeId).all();
  const guests = (results || []).map(r => r.guest_name);

  if (guests.length === 0) {
    console.log(`  [${episodeId}] no guests — skipping guest_start_ms`);
    return null;
  }
  if (durationMs && durationMs < MIN_START_MS) {
    console.log(`  [${episodeId}] shorter than 50min — skipping guest_start_ms`);
    return null;
  }

  const startMs = detectGuestStart(segments, guests);
  if (startMs == null) {
    console.log(`  [${episodeId}] no guest start detected — skipping`);
    return null;
  }
  if (durationMs && startMs > durationMs) {
    console.log(`  [${episodeId}] detected ${startMs}ms exceeds duration ${durationMs}ms — skipping`);
    return null;
  }

  // Only an empty time is filled, and never on a reviewed episode: a time set
  // (or cleared) by hand in admin stays as it is.
  const { meta } = await db.prepare(
    'UPDATE episodes SET guest_start_ms = ? WHERE id = ? AND guest_start_ms IS NULL AND COALESCE(guests_reviewed, 0) = 0'
  ).bind(startMs, episodeId).run();
  if (meta?.changes === 0) {
    console.log(`  [${episodeId}] interview time already set or reviewed — leaving it`);
    return null;
  }

  const minutes = Math.floor(startMs / 60000);
  const seconds = Math.floor((startMs % 60000) / 1000);
  console.log(`  [${episodeId}] guest_start_ms=${startMs} (${minutes}:${String(seconds).padStart(2, '0')})`);
  return startMs;
}
