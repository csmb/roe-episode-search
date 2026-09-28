import { describe, it, expect, vi, afterEach } from 'vitest';
import * as scriptsMod from '../../scripts/guest-start.js';
import * as workerMod from '../src/guest-start.js';
import { makeD1 } from './helpers/fakes.js';

// Two self-contained copies (local pipeline vs. Cloudflare Worker). Run the
// identical suite against each so they can't silently drift.
const IMPLS = [
  ['scripts/guest-start.js', scriptsMod],
  ['roe-pipeline/src/guest-start.js', workerMod],
];

const BASE = 3_000_000; // 50 minutes — earliest a guest interview is considered
const seg = (start_ms, end_ms, text) => ({ start_ms, end_ms, text });
const min = (m, s = 0) => (m * 60 + s) * 1000;
// Talk from one minute to another, a line every 5 s: "chatter" unless `said` has a line for
// that time (keys are min(m, s) with s a multiple of 5). A song whisper.cpp leaves out is
// the gap between two stretches of talk.
const talk = (from, to, said = {}) => {
  const out = [];
  for (let t = min(from); t < min(to); t += 5000) out.push(seg(t, t + 4000, said[t] ?? 'chatter chatter'));
  return out;
};

for (const [label, { detectGuestStart, FALLBACK_MS }] of IMPLS) {
  describe(`detectGuestStart — ${label}`, () => {
    it('returns null when there are no guests', () => {
      expect(detectGuestStart([seg(BASE, BASE + 5000, 'welcome back jane')], [])).toBe(null);
    });

    it('returns null when nothing happens after 50 minutes', () => {
      expect(detectGuestStart([seg(0, 1000, 'here is jane early on')], ['Jane'])).toBe(null);
    });

    it('after a song break with the guest named right after it: the first line after the break', () => {
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

    it('with no song break: the first line naming the guest after 50 minutes', () => {
      const segments = [
        seg(BASE, BASE + 5_000, 'chatter chatter'),
        seg(BASE + 5_000, BASE + 10_000, "here's Jane now"),
      ];
      expect(detectGuestStart(segments, ['Jane'])).toBe(BASE + 5_000);
    });

    it('a song break with the guest never named is no evidence: 1 hour, not the line after the last break', () => {
      // Until 2026-09-28 this gave the first line after the show's last song break, which on a
      // complete transcript is the closing song
      const segments = [
        seg(BASE, BASE + 10_000, 'welcome back'),
        seg(BASE + 10_000, BASE + 200_000, '[music]'),
        seg(BASE + 200_000, BASE + 210_000, 'some chatter'),
        seg(BASE + 210_000, BASE + 220_000, 'more chatter'),
      ];
      expect(detectGuestStart(segments, ['Zelda'])).toBe(FALLBACK_MS);
    });

    it('with no break and no mention, falls back to 1 hour (Fallback C)', () => {
      const segments = [
        seg(BASE, BASE + 5_000, 'a'),
        seg(BASE + 5_000, BASE + 10_000, 'b'),
      ];
      expect(detectGuestStart(segments, ['Nobody'])).toBe(FALLBACK_MS);
    });

    it('a complete show: the interview after its song, not the sign-off after the closing song', () => {
      // The whole two hours, songs left out (whisper.cpp): the old detector took the show's last
      // song break (the closing song, 114-117) and gave 117:00, just before the thank-you
      const segments = [
        ...talk(0, 58, { [min(20)]: 'later this morning we talk with Jane Doe' }),
        ...talk(61, 85, { [min(61)]: "We're back, and we're here with Jane Doe. Good morning, Jane." }),
        ...talk(89, 114, { [min(90)]: 'Jane, what are you seeing out there?' }),
        ...talk(117, 120, { [min(118)]: 'Thank you so much for coming in, Jane.' }),
      ];
      expect(detectGuestStart(segments, ['Jane Doe'])).toBe(min(61));
    });

    it('on a complete show the last 10 minutes are the goodbyes: a thank-you there is no interview', () => {
      const segments = [
        ...talk(0, 58),
        ...talk(61, 114),
        ...talk(117, 120, { [min(118)]: 'Thank you so much for coming in, Jane.' }),
      ];
      expect(detectGuestStart(segments, ['Jane Doe'])).toBe(FALLBACK_MS);
    });

    it('a transcript that stops early keeps its last minutes (it has no sign-off)', () => {
      const segments = talk(40, 70, { [min(66)]: 'so Jane, tell us about the stairs' });
      expect(detectGuestStart(segments, ['Jane Doe'])).toBe(min(66));
    });

    it('a teaser right before a song: the interview starts after the song, name or not', () => {
      const segments = [
        ...talk(50, 62, { [min(60)]: "after this song we'll be joined by Jane Doe" }),
        ...talk(65, 120, { [min(65, 5)]: 'good morning and welcome to the studio' }),
      ];
      expect(detectGuestStart(segments, ['Jane Doe'])).toBe(min(65));
    });

    it('the first song break next to the guest, not the song in the middle of the interview', () => {
      // 2019-05-16: in the studio at 58:55, a song at 83-89, "welcome back ... our guest" at 89:33
      const segments = [
        ...talk(50, 55),
        seg(min(55), min(58, 20), 'Beautiful day in San Francisco.'), // a song whisper.cpp wrote as one long line
        ...talk(58, 83, { [min(58, 55)]: 'in the studio with Mary Marr Keenan. Good morning.' }).filter(s => s.start_ms >= min(58, 20)),
        ...talk(89, 120, { [min(89, 30)]: 'Welcome back to the studio with our guest, Mary Marr Keenan.' }),
      ];
      expect(detectGuestStart(segments, ['Mary Marr Keenan'])).toBe(min(58, 20));
    });

    it('only a line about later is a teaser: the guest named in passing before a song is not', () => {
      // 2014-06-19: "Just like James up in Oregon." (a listener), then a song at 57-60
      const segments = [
        ...talk(50, 58, { [min(56, 30)]: 'Just like James up in Oregon.' }),
        ...talk(61, 120, { [min(75)]: "We're here with James Wong. Good morning." }),
      ];
      expect(detectGuestStart(segments, ['James Wong'])).toBe(min(75));
    });

    it('a line about later just after a song is no welcome: the start is after the next song', () => {
      const segments = [
        ...talk(50, 60),
        ...talk(63, 70, {
          [min(63)]: "we're going to chat with Jane in just a few minutes",
          [min(69)]: "Jane just walked in, we'll talk after this song",
        }),
        ...talk(73, 120),
      ];
      expect(detectGuestStart(segments, ['Jane Doe'])).toBe(min(73));
    });

    it('a welcome before the first song break wins over the song in the middle of the interview', () => {
      // 2019-10-24: the song before the welcome kept its lyrics, so has no gap
      const segments = [
        ...talk(50, 85, { [min(64, 30)]: 'Well, hey, we are joined here in the studio by our good friend Grant from SFGate.' }),
        ...talk(88, 120, { [min(88)]: "We're back with Grant. Grant, what are you seeing out there?" }),
      ];
      expect(detectGuestStart(segments, ['Grant Marek'])).toBe(min(64, 30));
    });

    it('lyrics kept, no gaps: the greeting, not the teaser before it', () => {
      // 2026-07-16: "We're gonna have to ask Jim and Lauren" at 61:03, the greeting at 71:57
      const segments = talk(50, 120, {
        [min(61, 5)]: "We're gonna have to ask Jim and Lauren their writing techniques.",
        [min(71, 55)]: "All right, well, we're joined here by our guests,",
        [min(72)]: 'Jim and Lauren from The Approach. Good morning.',
      });
      expect(detectGuestStart(segments, ['Jim', 'Lauren'])).toBe(min(72));
    });

    it('a greeting when nothing welcomes the guest (a show on the move)', () => {
      const segments = talk(50, 120, {
        [min(65, 55)]: 'As we are getting closer to Kirk and the warehouse.',
        [min(88, 30)]: 'oh yeah there he is, hello, you found Kirk',
      });
      expect(detectGuestStart(segments, ['Kirk Lombard'])).toBe(min(88, 30));
    });

    it('whole words only: "Kat" is not in "Skate" or "Kate", and a first name counts on its own', () => {
      // 2026-09-24: the old substring match found "Kat" in "Skate n' Place" and "Morning Kate" at 57:14
      const segments = talk(50, 120, {
        [min(57, 15)]: 'Morning, morning Kate, morning Harvey. Come to Skate n Place.',
        [min(77, 40)]: "We're here with Cyrus, how are ya?",
      });
      expect(detectGuestStart(segments, ['Cyrus', 'Kat'])).toBe(min(77, 40));
      expect(detectGuestStart(talk(50, 120, { [min(73, 40)]: 'Well, hello Marcy.' }), ['Marcy Coburn'])).toBe(min(73, 40));
    });

    it('everyday words are no name: "That MC", "Just Shannon" and "Will" are not found in "that", "just" and "will"', () => {
      const segments = [
        ...talk(50, 58, { [min(57, 30)]: 'That will just have to wait, that is just how it is.' }),
        ...talk(61, 120, { [min(70)]: "We're here with Just Shannon. Good morning!", [min(90)]: 'That MC says good morning.' }),
      ];
      expect(detectGuestStart(segments, ['Just Shannon', 'That MC', 'Will'])).toBe(min(70));
    });

    it('a welcome is in the line or the one right after, not in the first line after a song', () => {
      // The last line before a song names the guest; "Welcome back" after the song is for the listeners
      const segments = [
        ...talk(0, 58, { [min(57, 55)]: 'This one was picked by our guest Jane Doe.' }),
        ...talk(61, 114, { [min(61)]: "Welcome back, it's 8:31 on BFF.fm.", [min(62)]: 'Jane, thanks for coming in.' }),
        ...talk(117, 120),
      ];
      expect(detectGuestStart(segments, ['Jane Doe'])).toBe(min(61));
    });

    it('a teaser in the short talk between two songs counts for the break they make', () => {
      const segments = [
        ...talk(50, 55),
        ...talk(58, 59.5, { [min(58, 30)]: 'After this next one, Jane Doe joins us.' }),
        ...talk(62.5, 120, { [min(70)]: 'So Jane, the stairs.' }),
      ];
      expect(detectGuestStart(segments, ['Jane Doe'])).toBe(min(62, 30));
    });

    it('a first name that is an everyday word only counts with a capital', () => {
      const segments = [
        ...talk(50, 58),
        ...talk(61, 120, { [min(61)]: 'I had the best burrito this morning, honestly.', [min(83)]: "We're here with Burrito Justice. Good morning!" }),
      ];
      expect(detectGuestStart(segments, ['Burrito Justice'])).toBe(min(83));
      // An all-lowercase transcript (old whisper.cpp) has no capitals to go by
      expect(detectGuestStart(talk(50, 120, { [min(66)]: 'hey jane welcome to the studio' }), ['Jane Doe'])).toBe(min(66));
    });

    it('a name with a word about later in it ("Will Durst") is still a welcome', () => {
      const segments = [...talk(0, 58), ...talk(61, 120, { [min(61)]: "We're back, and we're here with Will Durst. Good morning." })];
      expect(detectGuestStart(segments, ['Will Durst'])).toBe(min(61));
    });

    it('accents: "Sinéad" is found as "Sinead", and is not the word "sin"', () => {
      const segments = talk(50, 120, { [min(55)]: 'Is it a sin to sleep in?', [min(66)]: "Good morning, Sinead, welcome!" });
      expect(detectGuestStart(segments, ["Sinéad O'Connor"])).toBe(min(66));
    });

    it('titles and punctuation: "Dr. Rick" is named as "dr rick" or "Rick"', () => {
      const segments = talk(50, 120, { [min(81, 35)]: 'hey hello dr rick all right hey guys i made it' });
      expect(detectGuestStart(segments, ['Dr. Rick'])).toBe(min(81, 35));
    });

    it('lines out of order give the same time', () => {
      const segments = [
        ...talk(61, 85, { [min(61)]: "We're back, and we're here with Jane Doe." }),
        ...talk(0, 58),
        ...talk(89, 120),
      ];
      expect(detectGuestStart(segments, ['Jane Doe'])).toBe(min(61));
    });
  });
}

describe('seedGuestStart', () => {
  const EP = 'roll-over-easy_2026-10-01_07-30-00';
  // A song break at 55 minutes, then the guest is introduced
  const segments = [
    seg(BASE, BASE + 10_000, 'welcome back'),
    seg(BASE + 10_000, BASE + 200_000, '[music]'),
    seg(BASE + 200_000, BASE + 210_000, 'please welcome Heather Knight'),
  ];
  const setup = (row = {}) => {
    const db = makeD1();
    db.sqlite.prepare('INSERT INTO episodes (id, title, guest_start_ms, guests_reviewed) VALUES (?, ?, ?, ?)')
      .run(EP, 'Stairway Streets!', row.guest_start_ms ?? null, row.guests_reviewed ?? 0);
    db.sqlite.prepare('INSERT INTO episode_guests (episode_id, guest_name) VALUES (?, ?)').run(EP, 'Heather Knight');
    return db;
  };
  const startMs = db => db.rows('SELECT guest_start_ms FROM episodes')[0].guest_start_ms;
  afterEach(() => vi.restoreAllMocks());

  it('fills an empty interview time', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const db = setup();
    expect(await workerMod.seedGuestStart(db, EP, segments, 7_200_000)).toBe(BASE + 200_000);
    expect(startMs(db)).toBe(BASE + 200_000);
  });

  it('keeps a time set by hand, and leaves a reviewed episode alone', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const handSet = setup({ guest_start_ms: 4_637_000 });
    expect(await workerMod.seedGuestStart(handSet, EP, segments, 7_200_000)).toBe(null);
    expect(startMs(handSet)).toBe(4_637_000);

    const reviewed = setup({ guests_reviewed: 1 });
    expect(await workerMod.seedGuestStart(reviewed, EP, segments, 7_200_000)).toBe(null);
    expect(startMs(reviewed)).toBe(null);
  });
});
