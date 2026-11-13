import type { Suggestion } from '../shared/types';
import { fuzzyScore } from './palette';
import { restorableUrl } from './session-recovery';

/** Hours after which an unused tab is archived (0 = never). */
export const ARCHIVE_OPTIONS = [0, 12, 24, 168, 720] as const;
export const DEFAULT_ARCHIVE_HOURS = 12;
export const ARCHIVE_LIMIT = 300;

export interface ArchivedTab {
  url: string;
  title: string;
  spaceId: string;
  archivedAt: number;
}

export interface ArchiveCandidate {
  id: number;
  pinned: boolean;
  active: boolean;
  audible: boolean;
  lastActiveAt: number;
}

export function normalizeArchiveHours(value: unknown): number {
  return ARCHIVE_OPTIONS.includes(value as (typeof ARCHIVE_OPTIONS)[number]) ? (value as number) : DEFAULT_ARCHIVE_HOURS;
}

/** Arc's rule: temporary tabs you haven't looked at for a while go to the archive; pinned, active and playing tabs stay. */
export function tabsToArchive(tabs: readonly ArchiveCandidate[], now: number, hours: number): number[] {
  if (!hours) return [];
  const cutoff = now - hours * 3_600_000;
  return tabs.filter((t) => !t.pinned && !t.active && !t.audible && t.lastActiveAt <= cutoff).map((t) => t.id);
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, ' ').trim().slice(0, 200) : '';
}

export function addArchived(list: readonly ArchivedTab[], entry: ArchivedTab): ArchivedTab[] {
  return [entry, ...list.filter((e) => e.url !== entry.url || e.spaceId !== entry.spaceId)].slice(0, ARCHIVE_LIMIT);
}

export function normalizeArchive(raw: unknown, spaceIds: ReadonlySet<string>): ArchivedTab[] {
  if (!Array.isArray(raw)) return [];
  const out: ArchivedTab[] = [];
  for (const item of raw) {
    if (out.length >= ARCHIVE_LIMIT) break;
    if (!item || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    if (typeof e.url !== 'string' || !restorableUrl(e.url) || typeof e.spaceId !== 'string' || !spaceIds.has(e.spaceId)) continue;
    out.push({ url: e.url, title: clean(e.title), spaceId: e.spaceId, archivedAt: typeof e.archivedAt === 'number' && Number.isFinite(e.archivedAt) ? e.archivedAt : 0 });
  }
  return out;
}

/** Command-bar results for `archive …`: newest first when empty, best match otherwise. */
export function archiveSuggestions(query: string, list: readonly ArchivedTab[]): Suggestion[] {
  const scored = list
    .map((e, order) => {
      const host = URL.parse(e.url)?.host ?? '';
      const score = query ? Math.max(fuzzyScore(query, e.title), fuzzyScore(query, host) - 5) : 0;
      return { e, order, score };
    })
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, 20);
  if (!scored.length) return [{ kind: 'archive', label: list.length ? 'No matching archived tabs' : 'No archived tabs yet', action: { type: 'noop' } }];
  return scored.map(({ e }) => ({
    kind: 'archive', label: e.title || URL.parse(e.url)?.host || e.url,
    detail: `${URL.parse(e.url)?.host ?? ''} · archived ${new Date(e.archivedAt).toLocaleDateString()}`,
    action: { type: 'unarchive', url: e.url, archivedAt: e.archivedAt },
  }));
}
