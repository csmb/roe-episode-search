/**
 * The show's hosts, under every name the transcripts, AI summaries and guest lists use for
 * them. None of these is ever a guest. The site Worker imports this list too.
 */
export const HOST_NAMES = ['Sequoia', 'Papa Sequoia', 'The Early Bird', 'Early Bird', 'Christopher', 'Christopher Bunting'];

const HOSTS = new Set(HOST_NAMES.map(name => name.toLowerCase()));

/** True when a guest name is really one of the hosts (ignores case and extra spaces). */
export function isHost(name) {
  return HOSTS.has(String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase());
}
