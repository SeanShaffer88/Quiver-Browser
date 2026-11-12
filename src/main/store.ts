import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SEARCH } from '../shared/constants';
import type { Bookmark, Settings, Space } from '../shared/types';
import { validBookmarkUndo, type BookmarkUndo } from './bookmark-import';
import { normalizeBookmarks } from './bookmarks';

export interface PersistedTab {
  url: string;
}

export interface PersistedState {
  version: 1;
  spaces: Space[];
  activeSpaceId: string;
  tabsBySpace: Record<string, PersistedTab[]>;
  activeIndexBySpace: Record<string, number>;
  settings: Settings;
  bookmarks: Bookmark[];
  bookmarkUndo?: BookmarkUndo;
  sessionOpen?: boolean;
  bounds?: { x?: number; y?: number; width: number; height: number; maximized: boolean };
}

export function defaultSettings(): Settings {
  return {
    envGroups: [],
    searchEngine: DEFAULT_SEARCH,
    devServerScan: true,
    sidebarCollapsed: false,
  };
}

export function defaultState(): PersistedState {
  const id = 'space-main';
  return {
    version: 1,
    spaces: [{ id, name: 'Main', color: '#5b8cff', isolated: false }],
    activeSpaceId: id,
    tabsBySpace: {},
    activeIndexBySpace: {},
    settings: defaultSettings(),
    bookmarks: [],
  };
}

/** Atomic write: temp file in the same directory, then rename over the target. */
export function writeFileAtomic(file: string, data: string | Buffer): void {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

export class Store {
  readonly file: string;
  state: PersistedState;
  private timer: NodeJS.Timeout | null = null;

  constructor() {
    this.file = path.join(app.getPath('userData'), 'quiver-state.json');
    this.state = this.load();
  }

  private load(): PersistedState {
    const base = defaultState();
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<PersistedState>;
      if (raw.version !== 1 || !Array.isArray(raw.spaces) || raw.spaces.length === 0) throw new Error('bad shape');
      const state: PersistedState = {
        ...base,
        ...raw,
        bookmarks: normalizeBookmarks(raw.bookmarks),
        settings: {
          envGroups: raw.settings?.envGroups ?? base.settings.envGroups,
          searchEngine: raw.settings?.searchEngine ?? base.settings.searchEngine,
          devServerScan: raw.settings?.devServerScan ?? base.settings.devServerScan,
          sidebarCollapsed: raw.settings?.sidebarCollapsed ?? base.settings.sidebarCollapsed,
        },
      } as PersistedState;
      state.bookmarkUndo = validBookmarkUndo(raw.bookmarkUndo, state.bookmarks);
      if (!state.spaces.some((s) => s.id === state.activeSpaceId)) state.activeSpaceId = state.spaces[0].id;
      return state;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') {
        // Quarantine unparseable data instead of silently discarding it.
        try {
          fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
        } catch {
          /* ignore */
        }
        console.warn('[quiver] state file unreadable, starting fresh:', e.message);
      }
      return base;
    }
  }

  save(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 250);
  }

  flush(): boolean {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileAtomic(this.file, JSON.stringify(this.state, null, 2));
      return true;
    } catch (err) {
      console.error('[quiver] could not save state:', (err as Error).message);
      return false;
    }
  }
}
