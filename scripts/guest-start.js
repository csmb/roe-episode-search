/**
 * Guest-interview start detection ("Skip to interview"). The code is the
 * Worker's (roe-pipeline/src/guest-start.js), so both pipelines find the same
 * time; this file keeps the scripts' import path.
 */

export { detectGuestStart, MIN_START_MS, SONG_DURATION_MS, GAP_THRESHOLD_MS, FALLBACK_MS } from '../roe-pipeline/src/guest-start.js';
