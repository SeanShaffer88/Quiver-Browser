import type { Bookmark, BrowserCommand, Suggestion, TabCommandTarget } from '../shared/types';
import type { HistoryEntry } from './history';

/** Browser actions the command palette can run. Each maps to an existing shortcut handler. */
export const BROWSER_COMMANDS: readonly { command: BrowserCommand; label: string; keys: string; keywords?: string }[] = [
  { command: 'command-new', label: 'New tab', keys: 'Ctrl+T', keywords: 'open' },
  { command: 'close-tab', label: 'Close tab', keys: 'Ctrl+W' },
  { command: 'reopen-tab', label: 'Reopen closed tab', keys: 'Ctrl+Shift+T', keywords: 'restore undo' },
  { command: 'reload', label: 'Reload page', keys: 'Ctrl+R', keywords: 'refresh' },
  { command: 'back', label: 'Go back', keys: 'Alt+←', keywords: 'history previous' },
  { command: 'forward', label: 'Go forward', keys: 'Alt+→', keywords: 'history next' },
  { command: 'recent-tab', label: 'Switch to the last tab you used', keys: 'Ctrl+Tab', keywords: 'recent previous back' },
  { command: 'next-tab', label: 'Next tab in the sidebar', keys: 'Ctrl+PageDown' },
  { command: 'prev-tab', label: 'Previous tab in the sidebar', keys: 'Ctrl+PageUp' },
  { command: 'copy-link', label: 'Copy link', keys: '', keywords: 'url address clipboard share' },
  { command: 'copy-markdown-link', label: 'Copy Markdown link', keys: '', keywords: 'url title clipboard md share' },
  { command: 'console', label: 'Open the console', keys: '', keywords: 'devtools errors log' },
  { command: 'next-space', label: 'Next Space', keys: '', keywords: 'switch' },
  { command: 'prev-space', label: 'Previous Space', keys: '', keywords: 'switch' },
  { command: 'move-tab-up', label: 'Move tab up', keys: 'Ctrl+Shift+PageUp', keywords: 'reorder' },
  { command: 'move-tab-down', label: 'Move tab down', keys: 'Ctrl+Shift+PageDown', keywords: 'reorder' },
  { command: 'toggle-sidebar', label: 'Toggle sidebar', keys: 'Ctrl+B', keywords: 'collapse expand' },
  { command: 'preview', label: 'Toggle phone preview', keys: 'Ctrl+Shift+P', keywords: 'mobile responsive device' },
  { command: 'env', label: 'Switch environment', keys: 'Ctrl+Alt+E', keywords: 'local staging prod' },
  { command: 'devtools', label: 'Toggle DevTools', keys: 'F12', keywords: 'inspect developer console' },
  { command: 'boosts', label: 'Open Boosts', keys: 'Ctrl+Shift+B', keywords: 'css script' },
  { command: 'settings', label: 'Open Settings', keys: '', keywords: 'preferences options' },
  { command: 'downloads', label: 'Open downloads', keys: 'Ctrl+J', keywords: 'files saved' },
  { command: 'find', label: 'Find in page', keys: 'Ctrl+F', keywords: 'search text' },
  { command: 'zoom-in', label: 'Zoom in', keys: 'Ctrl+=', keywords: 'bigger larger text size' },
  { command: 'zoom-out', label: 'Zoom out', keys: 'Ctrl+-', keywords: 'smaller text size' },
  { command: 'zoom-reset', label: 'Reset zoom', keys: 'Ctrl+0', keywords: '100 percent default size' },
];

const PER_KIND = 8;
const TOTAL = 20;

function isBoundary(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1];
  const cur = text[i];
  return /[\s\-_./:,()[\]#@?&=+]/.test(prev) || (/[a-z0-9]/.test(prev) && /[A-Z]/.test(cur)) || (/[^0-9]/.test(prev) && /[0-9]/.test(cur));
}

/**
 * Score one query token against text. A match is either a substring or a subsequence whose letters each start a word
 * (or camel hump) or directly follow the previous matched letter, so scattered letters never match. -1 = no match.
 */
function tokenScore(token: string, text: string): number {
  const t = text.toLowerCase();
  const n = text.length;
  const m = token.length;
  if (!m) return 0;
  if (m > n) return -1;
  const sub = t.indexOf(token);
  let best = -1;
  if (sub >= 0) best = 10 * m + (sub === 0 ? 30 : isBoundary(text, sub) ? 15 : 0);
  // dp[j]: best score with token[i] matched at text[j]
  const NEG = -Infinity;
  let prev = new Array<number>(n).fill(NEG);
  for (let i = 0; i < m; i++) {
    const cur = new Array<number>(n).fill(NEG);
    let runningMax = NEG; // best prev[k] for k < j - 1
    for (let j = 0; j < n; j++) {
      if (j >= 2) runningMax = Math.max(runningMax, prev[j - 2]);
      if (t[j] !== token[i]) continue;
      const boundary = isBoundary(text, j);
      const bonus = boundary ? (j === 0 ? 12 : 8) : 0;
      if (i === 0) {
        if (boundary) cur[j] = bonus + 4;
        continue;
      }
      const consecutive = j > 0 && prev[j - 1] > NEG ? prev[j - 1] + 10 : NEG;
      const jump = boundary && runningMax > NEG ? runningMax + bonus + 2 : NEG;
      cur[j] = Math.max(consecutive, jump);
    }
    prev = cur;
  }
  return Math.max(best, Math.max(...prev, -1));
}

/** Score a query (whitespace-separated tokens, all required, any order) against text; -1 when any token is missing. */
export function fuzzyScore(query: string, text: string): number {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return 0;
  let total = 0;
  for (const token of tokens) {
    const s = tokenScore(token, text);
    if (s < 0) return -1;
    total += s;
  }
  if (text.toLowerCase().startsWith(query.trim().toLowerCase())) total += 20;
  return total - Math.min(text.length, 200) / 20;
}

export type PaletteScope = 'all' | 'actions' | 'bookmarks' | 'history';

export function paletteQuery(text: string): { scope: PaletteScope; query: string } | undefined {
  const trimmed = text.trim();
  if (trimmed.startsWith('>') || trimmed.startsWith('?')) return { scope: 'actions', query: trimmed.slice(1).trim() };
  const bm = /^(?:bm|bookmarks?)(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (bm) return { scope: 'bookmarks', query: (bm[1] ?? '').trim() };
  const history = /^(?:h|history)(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (history) return { scope: 'history', query: (history[1] ?? '').trim() };
  if (/^\S+$/.test(trimmed) && /^(?:bm|bookmarks?)\S/i.test(trimmed)) return undefined;
  return trimmed ? { scope: 'all', query: trimmed } : undefined;
}

function safeLabel(value: string): string {
  return value.slice(0, 200).replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, ' ').trim();
}

function openableBookmark(url: string): boolean {
  return /^(?:https?|file):\/\//i.test(url) && URL.canParse(url);
}

export interface PaletteSources {
  activeSpaceId: string;
  tabs: Iterable<TabCommandTarget>;
  bookmarks: readonly Bookmark[];
  history?: readonly HistoryEntry[];
}

type Scored = { score: number; order: number; suggestion: Suggestion };

function best(items: Scored[], limit: number): Scored[] {
  return items.sort((a, b) => b.score - a.score || a.order - b.order).slice(0, limit);
}

export function paletteSuggestions(scope: PaletteScope, query: string, sources: PaletteSources): Suggestion[] {
  const score = (...texts: string[]) => Math.max(-1, ...texts.map((t, i) => (t ? fuzzyScore(query, t) - i * 5 : -1)));
  const actions: Scored[] = [];
  const tabs: Scored[] = [];
  const bookmarks: Scored[] = [];
  if (scope !== 'bookmarks') {
    BROWSER_COMMANDS.forEach((c, order) => {
      const s = score(c.label, c.keywords ? `${c.label} ${c.keywords}` : '');
      if (s >= 0 && (query || scope === 'actions')) {
        actions.push({ score: s, order, suggestion: { kind: 'action', label: c.label, detail: c.keys || undefined, action: { type: 'browser', command: c.command } } });
      }
    });
  }
  if (scope === 'all' && query) {
    let order = 0;
    for (const target of sources.tabs) {
      const s = score(target.title, target.host);
      // Tabs in the current Space rank a little higher.
      if (s >= 0) tabs.push({ score: s + (target.spaceId === sources.activeSpaceId ? 3 : 0), order: order++, suggestion: { kind: 'tab', label: target.title, action: { type: 'activate-tab', target } } });
    }
  }
  if (scope !== 'actions') {
    sources.bookmarks.forEach((b, order) => {
      if (!openableBookmark(b.url)) return;
      const title = safeLabel(b.title) || b.url;
      const host = URL.parse(b.url)?.host ?? '';
      const s = score(title, host);
      if (s >= 0) bookmarks.push({ score: s, order, suggestion: { kind: 'bookmark', label: title, action: { type: 'navigate', url: b.url } } });
    });
  }
  const history: Scored[] = [];
  if ((scope === 'history' || (scope === 'all' && query.length >= 2)) && sources.history) {
    // URLs already offered as an open tab or a bookmark are not repeated.
    const offered = new Set([...tabs.map((t) => (t.suggestion.action as { target: TabCommandTarget }).target.url), ...bookmarks.map((b) => (b.suggestion.action as { url: string }).url)]);
    const now = Date.now();
    sources.history.forEach((entry, order) => {
      if (scope === 'all' && offered.has(entry.url)) return;
      const url = URL.parse(entry.url);
      const where = url ? url.host + url.pathname : entry.url;
      const s = query ? score(entry.title, where) : 0;
      if (s < 0) return;
      const age = now - entry.lastVisit;
      // Pages visited often and recently outrank a closer text match on a page seen once long ago.
      const frecency = Math.min(30, Math.log2(entry.visits + 1) * 8) + (age < 86_400_000 ? 15 : age < 7 * 86_400_000 ? 8 : age < 30 * 86_400_000 ? 3 : 0);
      history.push({ score: s * 0.5 + frecency, order, suggestion: { kind: 'history', label: safeLabel(entry.title) || where, detail: where, action: { type: 'navigate', url: entry.url } } });
    });
  }
  if (scope === 'history') {
    const list = best(history, TOTAL).map((x) => x.suggestion);
    return list.length ? list : [{ kind: 'history', label: query ? 'No matching history' : 'No history yet', action: { type: 'noop' } }];
  }
  if (scope === 'actions') return best(actions, TOTAL).map((x) => x.suggestion);
  if (scope === 'bookmarks') {
    const list = best(bookmarks, TOTAL).map((x) => x.suggestion);
    return list.length ? list : [{ kind: 'bookmark', label: 'No matching bookmarks', action: { type: 'noop' } }];
  }
  const priority = { action: 0, tab: 1, bookmark: 2, history: 3 } as Record<string, number>;
  return [...best(actions, PER_KIND), ...best(tabs, PER_KIND), ...best(bookmarks, PER_KIND), ...best(history, 5)]
    .sort((a, b) => b.score - a.score || priority[a.suggestion.kind] - priority[b.suggestion.kind])
    .slice(0, TOTAL).map((x) => x.suggestion);
}
