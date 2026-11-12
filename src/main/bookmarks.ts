import type { Bookmark } from '../shared/types';

export const BOOKMARK_LIMIT = 5000;
const BOOKMARK_URL_LIMIT = 4096;
const BOOKMARK_TITLE_LIMIT = 200;

export function normalizeBookmarks(input: unknown): Bookmark[] {
  if (!Array.isArray(input)) return [];
  const byUrl = new Map<string, Bookmark>();
  for (const entry of input.slice(0, BOOKMARK_LIMIT)) {
    if (!entry || typeof entry !== 'object') continue;
    const { url, title } = entry as Partial<Bookmark>;
    if (typeof url !== 'string' || url.length > BOOKMARK_URL_LIMIT) continue;
    const raw = url.trim();
    if (!/^https?:\/\//i.test(raw) || /[\u0000-\u001f\u007f]/.test(raw)) continue;

    try {
      const target = new URL(raw);
      if (target.username || target.password || target.href.length > BOOKMARK_URL_LIMIT || byUrl.has(target.href)) continue;
      const name = typeof title === 'string'
        ? title.slice(0, BOOKMARK_TITLE_LIMIT).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
        : '';
      byUrl.set(target.href, { url: target.href, title: name || target.hostname });
    } catch {
      // Ignore malformed links in the export.
    }
  }
  return [...byUrl.values()];
}

export function mergeBookmarks(existing: Bookmark[], input: unknown): { bookmarks: Bookmark[]; added: number; full: boolean } {
  const incoming = normalizeBookmarks(input);
  const present = new Set(existing.map(({ url }) => url));
  const unique = incoming.filter(({ url }) => !present.has(url));
  const available = BOOKMARK_LIMIT - existing.length;
  const additions = unique.slice(0, available);
  return { bookmarks: [...existing, ...additions], added: additions.length, full: unique.length > available };
}
