import { badgeFor } from '../shared/env';
import type { EnvGroup, Suggestion, TabCommandTarget } from '../shared/types';

const RESULT_LIMIT = 20;

function safeLabel(value: string): string {
  return value.slice(0, 200).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').trim();
}

export function tabSearchQuery(text: string): string | undefined {
  const match = /^tab(?:\s+(.*))?$/is.exec(text.trim());
  return match ? (match[1] ?? '').toLowerCase() : undefined;
}

export function tabCommandTarget(
  tab: { id: number; spaceId: string; title: string; commandRevision: number; internalPage?: 'newtab' | 'settings' | 'boosts' },
  url: string,
  spaceName: string,
  envGroups: EnvGroup[],
): TabCommandTarget {
  const parsed = URL.parse(url);
  const host = parsed?.protocol === 'http:' || parsed?.protocol === 'https:' ? parsed.host.slice(0, 260) : '';
  const fallback = tab.internalPage === 'settings' ? 'Settings' : tab.internalPage === 'boosts' ? 'Boosts'
    : tab.internalPage === 'newtab' ? 'New Tab' : parsed?.protocol === 'file:' ? 'Local file' : host || 'Untitled tab';
  // Chromium can use the address as a title when a document supplies none.
  const title = tab.title === url || /^(?:https?|file|data|about|quiver):/i.test(tab.title.trim()) ? '' : safeLabel(tab.title);
  return {
    id: tab.id, spaceId: tab.spaceId, spaceName: safeLabel(spaceName), revision: tab.commandRevision,
    url, title: title || fallback, host, environment: host ? badgeFor(url, envGroups) : null,
  };
}

export function tabSearchSuggestions(query: string, activeSpaceId: string, targets: Iterable<TabCommandTarget>): Suggestion[] {
  const current: Suggestion[] = [];
  const other: Suggestion[] = [];
  for (const target of targets) {
    const matches = target.title.toLowerCase().includes(query) || target.host.toLowerCase().includes(query);
    if (!matches) continue;
    const group = target.spaceId === activeSpaceId ? current : other;
    if (group.length < RESULT_LIMIT) group.push({ kind: 'tab', label: target.title, action: { type: 'activate-tab', target } });
    if (current.length === RESULT_LIMIT) break;
  }
  const results = current.concat(other).slice(0, RESULT_LIMIT);
  return results.length ? results : [{ kind: 'tab', label: 'No matching open tabs', action: { type: 'noop' } }];
}

export function tabTargetMatches(before: TabCommandTarget, after: TabCommandTarget): boolean {
  return before.id === after.id && before.spaceId === after.spaceId && before.spaceName === after.spaceName &&
    before.revision === after.revision && before.url === after.url && before.title === after.title &&
    before.host === after.host && before.environment === after.environment;
}
