import type { Bookmark } from '../shared/types';

export const BOOKMARK_LIMIT = 5000;
const BOOKMARK_URL_LIMIT = 4096;
const BOOKMARK_TITLE_LIMIT = 200;

export function normalizeBookmark(entry: unknown): Bookmark | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const { url, title } = entry as Partial<Bookmark>;
  if (typeof url !== 'string' || url.length > BOOKMARK_URL_LIMIT) return undefined;
  const raw = url.trim();
  if (!/^https?:\/\//i.test(raw) || /[\u0000-\u001f\u007f]/.test(raw)) return undefined;
  try {
    const target = new URL(raw);
    if (target.username || target.password || target.href.length > BOOKMARK_URL_LIMIT) return undefined;
    const name = typeof title === 'string'
      ? title.slice(0, BOOKMARK_TITLE_LIMIT).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
      : '';
    return { url: target.href, title: name || target.hostname };
  } catch {
    return undefined;
  }
}

export function normalizeBookmarks(input: unknown): Bookmark[] {
  if (!Array.isArray(input)) return [];
  const byUrl = new Map<string, Bookmark>();
  for (const entry of input.slice(0, BOOKMARK_LIMIT)) {
    const bookmark = normalizeBookmark(entry);
    if (bookmark && !byUrl.has(bookmark.url)) byUrl.set(bookmark.url, bookmark);
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
