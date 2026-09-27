/**
 * Spelling hints sent to Whisper with every request.
 *
 * Whisper only reads the last ~224 tokens of a prompt, so this list is kept to
 * about 180 (177 when measured with Whisper's own tokenizer on 2026-09-27;
 * test/whisper-prompt.test.js caps its length). The names that matter most go
 * last, so they survive if the list ever grows. During music Whisper sometimes
 * "hears" the prompt itself; isPromptEcho() in clean-segments.js drops those
 * lines using PROMPT_TERMS.
 */

export const SF_VOCAB_PROMPT = [
  'Muni, BART, Caltrain, the N-Judah,',
  'SoMa, the Tenderloin, Dogpatch, Bernal Heights, Japantown, Visitacion Valley,',
  'Haight-Ashbury, Noe Valley, Potrero Hill, Bayview,',
  'Golden Gate Park, Sutro Baths, Lands End, McLaren Park,',
  'Muni Diaries, Noise Pop, Litquake, KQED, KALW, Hoodline, Mission Local, Tablehopper,',
  'SFMOMA, the Exploratorium,',
  'Hamburger Haven, Bi-Rite, Tartine, Humphry Slocombe,',
  'Emperor Norton, Herb Caen, Karl the Fog,',
  'the Ferry Building,',
  'Sequoia, The Early Bird, Suldrew, BFF.fm, Roll Over Easy.',
].join(' ');

/** Lower-case a list item and drop a leading "the" and trailing punctuation. */
export function normalizeTerm(s) {
  return s.trim().toLowerCase().replace(/^the\s+/, '').replace(/[.!?;:]+$/, '').trim();
}

export const PROMPT_TERMS = new Set(SF_VOCAB_PROMPT.split(',').map(normalizeTerm).filter(Boolean));
