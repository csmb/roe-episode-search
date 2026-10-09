/**
 * Time limits for outside calls, and how the pipeline tells a failure worth
 * retrying (a timeout, a 500, a rate limit) from one that never will succeed.
 *
 * Every alarm has 15 minutes of wall time. Without these limits one hung
 * request could use all of it, and Cloudflare would start the step over.
 */

export const TIMEOUT_MS = {
  whisper: 5 * 60_000,     // one six-minute chunk; normally answered in well under a minute
  whisperRetry: 90_000,    // a retry clip of at most 3 minutes
  summary: 90_000,
  places: 180_000,         // a reply of up to 4,000 tokens
  sentiment: 60_000,
  sunrise: 10_000,
  geocode: 15_000,
  ai: 60_000,              // Workers AI embeddings and Vectorize upserts
  notify: 10_000,          // the owner's notice (notify.js)
};

/** An error a retry can't fix, so the pipeline gives up on the step at once. */
export class PermanentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PermanentError';
    this.permanent = true;
  }
}

export function isPermanent(err) {
  return err?.permanent === true;
}

// The request itself is wrong (bad audio, bad key, too large), so sending it again won't help.
const PERMANENT_STATUSES = new Set([400, 401, 403, 404, 413, 422]);

/** Error for a failed HTTP response, e.g. "Whisper API error 500: …". */
export function apiError(service, status, body) {
  // OpenAI echoes part of a rejected key ("sk-proj-AbC1***…wxyz"); the message reaches the upload log and notices
  const message = `${service} error ${status}: ${String(body).replace(/sk-[\w*.-]+/g, 'sk-…').slice(0, 500)}`;
  const err = PERMANENT_STATUSES.has(status) ? new PermanentError(message) : new Error(message);
  err.status = status;
  return err;
}

/** Rejects when `promise` takes longer than `ms`, for bindings that take no AbortSignal. */
export function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
