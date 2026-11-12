type SessionEntry = { url: string; title?: string };
type LiveEntry = SessionEntry & { id: number };
export type ClosedTab = LiveEntry & { title: string; spaceId: string; index: number; placeholderId?: number };
export type PersistedClosedTab = Omit<ClosedTab, 'id' | 'placeholderId'> & { replacePlaceholder?: true };
export const CLOSED_TAB_LIMIT = 20;
export const CANONICAL_NEW_TAB_URL = 'quiver://app/newtab.html';
const CLOSED_URL_LIMIT = 8192;
const CLOSED_TITLE_LIMIT = 200;

const INTERNAL_PAGES = new Set(['/newtab.html', '/settings.html', '/boosts.html']);
const INTERNAL_HOSTS = new Set(['newtab', 'settings', 'boosts']);

export function restorableUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    if (/^https?:\/\//i.test(value)) return url.protocol === 'https:' || url.protocol === 'http:';
    if (value === 'about:blank') return true;
    if (/^file:\/\//i.test(value)) return url.protocol === 'file:' && !url.host && url.pathname.startsWith('/');
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
  const tabs = available.map(({ url, title }) => {
    const label = normalizeTabTitle(title, url);
    return label ? { url, title: label } : { url };
  });
  return { tabs, activeIndex };
}

export function normalizeTabTitle(value: unknown, url: string): string {
  if (typeof value !== 'string') return '';
  const title = value.trim();
  if (title === url || /^(?:https?|file|data|about|quiver):/i.test(title)) return '';
  return title.slice(0, 200).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').trim();
}
function isNewTab(url: string): boolean {
  return /^quiver:\/\/(?:app\/newtab\.html|newtab)(?:[?#]|$)/.test(url);
}

export function hasSavedNewTabPlaceholder(tabs: unknown): boolean {
  return Array.isArray(tabs) && tabs.length === 1 &&
    tabs[0]?.url === CANONICAL_NEW_TAB_URL && tabs[0]?.automaticPlaceholder === true;
}

export function normalizeRecentlyClosed(
  input: unknown,
  spaceIds: ReadonlySet<string>,
  soleNewTabSpaces?: ReadonlySet<string>,
): PersistedClosedTab[] {
  if (!Array.isArray(input)) return [];
  const result: PersistedClosedTab[] = [];
  const marked = new Set<string>();
  for (const value of input.slice(0, CLOSED_TAB_LIMIT)) {
    if (!value || typeof value !== 'object') continue;
    const { url, title, spaceId, index, replacePlaceholder } = value as Partial<PersistedClosedTab>;
    if (typeof spaceId !== 'string' || !spaceIds.has(spaceId) || typeof title !== 'string' ||
        typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 ||
        typeof url !== 'string' || url.length > CLOSED_URL_LIMIT || !restorableUrl(url) || isNewTab(url)) continue;
    const { username, password } = new URL(url);
    if (username || password) continue;
    const label = title.slice(0, CLOSED_TITLE_LIMIT).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() || 'tab';
    const entry: PersistedClosedTab = { url, title: label, spaceId, index };
    if (replacePlaceholder === true && soleNewTabSpaces?.has(spaceId) && !marked.has(spaceId)) {
      entry.replacePlaceholder = true;
      marked.add(spaceId);
    }
    result.push(entry);
  }
  return result;
}

export function snapshotRecentlyClosed(
  entries: readonly ClosedTab[],
  spaceIds: ReadonlySet<string>,
  soleNewTabs: ReadonlyMap<string, number>,
): PersistedClosedTab[] {
  const candidate = entries.map(({ url, title, spaceId, index, placeholderId }) => ({
    url, title, spaceId, index,
    replacePlaceholder: placeholderId !== undefined && soleNewTabs.get(spaceId) === placeholderId,
  }));
  return normalizeRecentlyClosed(candidate, spaceIds, new Set(soleNewTabs.keys()));
}

export function restoreRecentlyClosed(
  entries: readonly PersistedClosedTab[],
  allocateId: () => number,
  soleNewTabs: ReadonlyMap<string, number>,
): ClosedTab[] {
  return entries.map(({ replacePlaceholder, ...entry }) => ({
    ...entry,
    id: allocateId(),
    placeholderId: replacePlaceholder ? soleNewTabs.get(entry.spaceId) : undefined,
  }));
}

export function rememberClosed(closed: readonly ClosedTab[], entry: ClosedTab): ClosedTab[] {
  if (!restorableUrl(entry.url) || isNewTab(entry.url)) return [...closed];
  return [entry, ...closed].slice(0, CLOSED_TAB_LIMIT);
}
