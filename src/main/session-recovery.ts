type SessionEntry = { url: string };
type LiveEntry = SessionEntry & { id: number };
export type ClosedTab = LiveEntry & { title: string; spaceId: string; index: number; placeholderId?: number };
export const CLOSED_TAB_LIMIT = 20;

const INTERNAL_PAGES = new Set(['/newtab.html', '/settings.html', '/boosts.html']);
const INTERNAL_HOSTS = new Set(['newtab', 'settings', 'boosts']);

export function restorableUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    if (/^https?:\/\//i.test(value)) return url.protocol === 'https:' || url.protocol === 'http:';
    if (!value.startsWith('quiver://') || url.username || url.password || url.port) return false;
    return url.host === 'app' ? INTERNAL_PAGES.has(url.pathname) : INTERNAL_HOSTS.has(url.host) && !url.pathname;
  } catch {
    return false;
  }
}

/** Keep selection relative to the original order when some URLs cannot be restored. */
export function restoreSelection<T extends SessionEntry>(entries: readonly T[], selected: number) {
  const available: T[] = [];
  let activeIndex = -1;
  const wanted = Number.isInteger(selected) && selected >= 0 ? selected : 0;
  entries.forEach((entry, index) => {
    if (!restorableUrl(entry?.url)) return;
    if (activeIndex < 0 && index >= wanted) activeIndex = available.length;
    available.push(entry);
  });
  if (activeIndex < 0) activeIndex = Math.max(0, available.length - 1);
  return { entries: available, activeIndex };
}

export function snapshotSpace(entries: readonly LiveEntry[], activeId: number | undefined) {
  const selected = entries.findIndex((entry) => entry.id === activeId);
  const { entries: available, activeIndex } = restoreSelection(entries, selected);
  return { tabs: available.map(({ url }) => ({ url })), activeIndex };
}

export function rememberClosed(closed: readonly ClosedTab[], entry: ClosedTab): ClosedTab[] {
  if (!restorableUrl(entry.url) || /^quiver:\/\/(?:app\/newtab\.html|newtab)(?:[?#]|$)/.test(entry.url)) return [...closed];
  return [entry, ...closed].slice(0, CLOSED_TAB_LIMIT);
}
