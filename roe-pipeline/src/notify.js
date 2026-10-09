/**
 * Tell the owner how a show's run ended, wherever NOTIFY_URL (a Worker secret)
 * points: an ntfy.sh topic URL gets the message as plain text with a title, so
 * it pops up on a phone with the ntfy app; a Slack incoming-webhook URL gets
 * {text}. Without the secret nothing is sent. Never throws: a notice that fails
 * is only logged, and the run's outcome is in the ingest log either way.
 */

import { TIMEOUT_MS } from './limits.js';

/**
 * @param {{NOTIFY_URL?: string}} env
 * @param {{title: string, message: string, problem?: boolean}} notice - title in plain ASCII (a header)
 */
export async function notify(env, { title, message, problem = false }) {
  const url = env.NOTIFY_URL;
  if (!url) return;
  const slack = url.startsWith('https://hooks.slack.com/');
  try {
    const res = await fetch(url, slack
      ? {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Slack reads <…> as a mention or link and & as an entity: GPT-written text stays text
        body: JSON.stringify({ text: `*${title}*\n${String(message).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}` }),
        signal: AbortSignal.timeout(TIMEOUT_MS.notify),
      }
      : {
        method: 'POST',
        headers: { Title: title, Tags: problem ? 'warning' : 'radio', Priority: problem ? 'high' : 'default' },
        body: message,
        signal: AbortSignal.timeout(TIMEOUT_MS.notify),
      });
    if (!res.ok) console.error(`Notice not sent (${res.status}): ${title}`);
  } catch (err) {
    console.error(`Notice not sent (${err.message}): ${title}`);
  }
}
