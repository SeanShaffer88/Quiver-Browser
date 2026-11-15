import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './store';

export interface HistoryEntry {
  url: string;
  title: string;
  visits: number;
  lastVisit: number;
}

export const HISTORY_LIMIT = 5000;
const URL_LIMIT = 4096;
const SAVE_DELAY_MS = 2000;

/** The URL to remember for a visit, or null for pages that are not kept (non-web, too long). */
export function historyUrl(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length > URL_LIMIT) return null;
  const url = URL.parse(raw);
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) return null;
  url.username = '';
  url.password = '';
  url.hash = '';
  return url.href;
}

function cleanTitle(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) : '';
}

/** Record a visit in a newest-first list, keeping one entry per URL. Returns false when the page is not kept. */
export function recordVisit(list: HistoryEntry[], rawUrl: string, title: string, at: number): boolean {
  const url = historyUrl(rawUrl);
  if (!url) return false;
  const index = list.findIndex((e) => e.url === url);
  const label = cleanTitle(title);
  if (index >= 0) {
    const [entry] = list.splice(index, 1);
    entry.lastVisit = at;
    entry.visits += 1;
    if (label) entry.title = label;
    list.unshift(entry);
  } else {
    list.unshift({ url, title: label, visits: 1, lastVisit: at });
    if (list.length > HISTORY_LIMIT) list.length = HISTORY_LIMIT;
  }
  return true;
}

/** Update the title of a page already visited (titles often arrive after the navigation). */
export function updateTitle(list: HistoryEntry[], rawUrl: string, title: string): boolean {
  const url = historyUrl(rawUrl);
  const label = cleanTitle(title);
  const entry = url && label ? list.find((e) => e.url === url) : undefined;
  if (!entry || entry.title === label) return false;
  entry.title = label;
  return true;
}

export function normalizeHistory(raw: unknown): HistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: HistoryEntry[] = [];
  for (const item of raw) {
    if (out.length >= HISTORY_LIMIT) break;
    if (!item || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    const url = typeof e.url === 'string' ? historyUrl(e.url) : null;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const visits = typeof e.visits === 'number' && Number.isFinite(e.visits) && e.visits >= 1 ? Math.floor(e.visits) : 1;
    const lastVisit = typeof e.lastVisit === 'number' && Number.isFinite(e.lastVisit) ? e.lastVisit : 0;
    out.push({ url, title: cleanTitle(e.title), visits, lastVisit });
  }
  return out;
}

/** Browsing history in its own file, so the session state file stays small. Writes are debounced and atomic. */
export class History {
  private entries: HistoryEntry[];
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly file: string, private readonly enabled: () => boolean, private readonly now = () => Date.now()) {
    this.entries = this.load();
  }

  private load(): HistoryEntry[] {
    try {
      return normalizeHistory(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        try {
          fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
        } catch {
          /* keep going with empty history */
        }
      }
      return [];
    }
  }

  list(): readonly HistoryEntry[] {
    return this.entries;
  }

  visit(url: string, title: string): void {
    if (!this.enabled()) return;
    if (recordVisit(this.entries, url, title, this.now())) this.schedule();
  }

  title(url: string, title: string): void {
    if (this.enabled() && updateTitle(this.entries, url, title)) this.schedule();
  }

  clear(): void {
    this.entries = [];
    this.flush();
  }

  /** Stop without writing (the file is about to be deleted). */
  discard(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.entries = [];
  }

  /** A change is waiting to be written. */
  get pending(): boolean {
    return this.timer !== null;
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
    this.timer.unref?.();
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileAtomic(this.file, JSON.stringify(this.entries));
    } catch (error) {
      console.error('[quiver] could not save history:', error instanceof Error ? error.message : String(error));
    }
  }
}

/**
 * One history per profile (see profiles.ts). The shared profile keeps the original history.json, so history from
 * before profiles existed stays where it was; each separate profile has its own file under history-profiles/.
 */
export class ProfileHistories {
  private readonly open = new Map<string, History>();

  constructor(private readonly dir: string, private readonly enabled: () => boolean, private readonly now = () => Date.now()) {}

  fileFor(profile: string): string | null {
    if (profile === 'shared') return path.join(this.dir, 'history.json');
    return /^[\w-]{1,80}$/.test(profile) ? path.join(this.dir, 'history-profiles', `${profile}.json`) : null;
  }

  get(profile: string): History | null {
    let history = this.open.get(profile);
    if (history) return history;
    const file = this.fileFor(profile);
    if (!file) return null;
    history = new History(file, this.enabled, this.now);
    this.open.set(profile, history);
    return history;
  }

  list(profile: string): readonly HistoryEntry[] {
    return this.get(profile)?.list() ?? [];
  }

  visit(profile: string, url: string, title: string): void {
    this.get(profile)?.visit(url, title);
  }

  title(profile: string, url: string, title: string): void {
    this.get(profile)?.title(url, title);
  }

  clear(profile: string): void {
    this.get(profile)?.clear();
  }

  /** Clear the shared history and every given separate profile's. */
  clearAll(profiles: Iterable<string>): void {
    for (const profile of new Set(['shared', ...profiles])) this.clear(profile);
  }

  /** A profile is gone (its last Space was deleted): its history goes with its cookies. */
  remove(profile: string): void {
    if (profile === 'shared') return;
    const file = this.fileFor(profile);
    this.open.get(profile)?.discard();
    this.open.delete(profile);
    if (file) {
      try {
        fs.rmSync(file, { force: true });
      } catch (error) {
        console.error('[quiver] could not delete profile history:', error instanceof Error ? error.message : String(error));
      }
    }
  }

  flush(): void {
    // Only profiles with unsaved visits are written, so looking at a profile never creates its file.
    for (const history of this.open.values()) if (history.pending) history.flush();
  }
}
