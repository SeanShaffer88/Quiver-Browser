import { badgeFor } from '../shared/env';
import type { EnvGroup, Suggestion, TabCommandTarget } from '../shared/types';
import { fuzzyScore } from './palette';
import { normalizeTabTitle } from './session-recovery';

const RESULT_LIMIT = 20;

function safeLabel(value: string): string {
  return value.slice(0, 200).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').trim();
}

export function tabSearchQuery(text: string): string | undefined {
  const match = /^tab(?:\s+(.*))?$/is.exec(text.trim());
  return match ? (match[1] ?? '').toLowerCase() : undefined;
}

export function tabCommandTarget(
  tab: { id: number; spaceId: string; title: string; titleIsExplicit: boolean; commandRevision: number; internalPage?: 'newtab' | 'settings' | 'boosts' | 'research' },
  url: string,
  spaceName: string,
  envGroups: EnvGroup[],
): TabCommandTarget {
  const parsed = URL.parse(url);
  const host = parsed?.protocol === 'http:' || parsed?.protocol === 'https:' ? parsed.host.slice(0, 260) : '';
  const fallback = tab.internalPage === 'settings' ? 'Settings' : tab.internalPage === 'boosts' ? 'Boosts' : tab.internalPage === 'research' ? 'Research'
    : tab.internalPage === 'newtab' ? 'New Tab' : parsed?.protocol === 'file:' ? 'Local file' : host || 'Untitled tab';
  const title = tab.titleIsExplicit ? normalizeTabTitle(tab.title, url) : '';
  return {
    id: tab.id, spaceId: tab.spaceId, spaceName: safeLabel(spaceName), revision: tab.commandRevision,
    url, title: title || fallback, host, environment: host ? badgeFor(url, envGroups) : null,
  };
}

export function tabSearchSuggestions(query: string, activeSpaceId: string, targets: Iterable<TabCommandTarget>): Suggestion[] {
  const current: { score: number; order: number; target: TabCommandTarget }[] = [];
  const other: typeof current = [];
  let order = 0;
  for (const target of targets) {
    const score = Math.max(fuzzyScore(query, target.title), fuzzyScore(query, target.host) - 5);
    if (score < 0) continue;
    (target.spaceId === activeSpaceId ? current : other).push({ score, order: order++, target });
  }
  const rank = (list: typeof current) => list.sort((a, b) => b.score - a.score || a.order - b.order);
  rank(current);
  rank(other);
  // A busy current Space should still leave room for a matching tab elsewhere.
  const currentLimit = other.length ? RESULT_LIMIT - 1 : RESULT_LIMIT;
  const results = current.slice(0, currentLimit).concat(other).slice(0, RESULT_LIMIT)
    .map(({ target }): Suggestion => ({ kind: 'tab', label: target.title, action: { type: 'activate-tab', target } }));
  return results.length ? results : [{ kind: 'tab', label: 'No matching open tabs', action: { type: 'noop' } }];
}

export function tabTargetMatches(before: TabCommandTarget, after: TabCommandTarget): boolean {
  return before.id === after.id && before.spaceId === after.spaceId && before.spaceName === after.spaceName &&
    before.revision === after.revision && before.url === after.url && before.title === after.title &&
    before.host === after.host && before.environment === after.environment;
}
