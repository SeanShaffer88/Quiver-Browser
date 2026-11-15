import type { Bookmark } from '../shared/types';

export const BOOKMARK_LIMIT = 5000;
const BOOKMARK_URL_LIMIT = 4096;
const BOOKMARK_TITLE_LIMIT = 200;

export function normalizeBookmark(entry: unknown): Bookmark | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const { url, title, profile } = entry as Partial<Bookmark>;
  if (typeof url !== 'string' || url.length > BOOKMARK_URL_LIMIT) return undefined;
  const raw = url.trim();
  if (!/^https?:\/\//i.test(raw) || /[\u0000-\u001f\u007f]/.test(raw)) return undefined;
  try {
    const target = new URL(raw);
    if (target.username || target.password || target.href.length > BOOKMARK_URL_LIMIT) return undefined;
    const name = typeof title === 'string'
      ? title.slice(0, BOOKMARK_TITLE_LIMIT).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
      : '';
    const owner = typeof profile === 'string' && profile !== 'shared' && /^[\w-]{1,80}$/.test(profile) ? profile : undefined;
    return { url: target.href, title: name || target.hostname, ...(owner ? { profile: owner } : {}) };
  } catch {
    return undefined;
  }
}

/** Bookmarks are unique per URL within a profile; the same page can be bookmarked in two profiles. */
export function bookmarkKey(bookmark: Pick<Bookmark, 'url' | 'profile'>): string {
  return `${bookmark.profile ?? ''} ${bookmark.url}`;
}

export function normalizeBookmarks(input: unknown): Bookmark[] {
  if (!Array.isArray(input)) return [];
  const byKey = new Map<string, Bookmark>();
  for (const entry of input.slice(0, BOOKMARK_LIMIT)) {
    const bookmark = normalizeBookmark(entry);
    if (bookmark && !byKey.has(bookmarkKey(bookmark))) byKey.set(bookmarkKey(bookmark), bookmark);
  }
  return [...byKey.values()];
}

export function mergeBookmarks(existing: Bookmark[], input: unknown): { bookmarks: Bookmark[]; added: number; full: boolean } {
  const incoming = normalizeBookmarks(input);
  const present = new Set(existing.map(bookmarkKey));
  const unique = incoming.filter((b) => !present.has(bookmarkKey(b)));
  const available = BOOKMARK_LIMIT - existing.length;
  const additions = unique.slice(0, available);
  return { bookmarks: [...existing, ...additions], added: additions.length, full: unique.length > available };
}
