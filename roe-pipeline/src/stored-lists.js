/**
 * Durable Object storage caps each value at 128 KiB, so long lists (transcript
 * segments) are kept as pages under `<prefix>:0`, `<prefix>:1`, …
 *
 * Pages are cut by size rather than by count, so a show with unusually long
 * lines can't push one over the cap. V8 stores a string in one or two bytes per
 * character, so 60,000 characters of JSON always fit.
 */

export const MAX_PAGE_CHARS = 60_000;

/** Storage entries for `list` as pages, ready for one `storage.put(entries)`. */
export function pageEntries(prefix, list, maxChars = MAX_PAGE_CHARS) {
  const entries = {};
  let page = [], size = 2, pages = 0;
  for (const item of list) {
    const len = JSON.stringify(item).length + 1;
    if (page.length > 0 && size + len > maxChars) {
      entries[`${prefix}:${pages++}`] = page;
      page = [];
      size = 2;
    }
    page.push(item);
    size += len;
  }
  if (page.length > 0) entries[`${prefix}:${pages++}`] = page;
  return { entries, pages };
}

/** Reads back a list stored with pageEntries. */
export async function readPages(storage, prefix, pages) {
  if (!pages) return [];
  const keys = Array.from({ length: pages }, (_, i) => `${prefix}:${i}`);
  const stored = await storage.get(keys);
  return keys.flatMap(k => stored.get(k) || []);
}
