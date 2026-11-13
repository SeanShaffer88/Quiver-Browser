import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SEARCH } from '../shared/constants';
import type { Bookmark, Settings, Space } from '../shared/types';
import { validBookmarkUndo, type BookmarkUndo } from './bookmark-import';
import { normalizeBookmarks } from './bookmarks';
import { normalizeSyncState, type SyncState } from './sync-service';
import { normalizePrivacy } from './privacy';
import { normalizeFolders } from './tab-tree';
import { normalizeTopics, type Topic } from './research';
import { hasSavedNewTabPlaceholder, normalizeRecentlyClosed, type PersistedClosedTab } from './session-recovery';

export interface PersistedTab {
  url: string;
  title?: string;
  pinned?: true;
  folderId?: string;
  automaticPlaceholder?: true;
}

export interface PersistedState {
  version: 1;
  spaces: Space[];
  activeSpaceId: string;
  tabsBySpace: Record<string, PersistedTab[]>;
  activeIndexBySpace: Record<string, number>;
  recentlyClosed: PersistedClosedTab[];
  settings: Settings;
  bookmarks: Bookmark[];
  bookmarkUndo?: BookmarkUndo;
  sessionOpen?: boolean;
  topics?: Topic[];
  sync?: SyncState;
  activeTopicBySpace?: Record<string, string>;
  bounds?: { x?: number; y?: number; width: number; height: number; maximized: boolean };
}

export function defaultSettings(): Settings {
  return {
    envGroups: [],
    searchEngine: DEFAULT_SEARCH,
    devServerScan: true,
    sidebarCollapsed: false,
    privacy: normalizePrivacy(undefined, process.platform),
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
    recentlyClosed: [],
    settings: defaultSettings(),
    bookmarks: [],
  };
}

/** Atomic write: temp file in the same directory, then rename over the target. */
export function writeFileAtomic(file: string, data: string | Buffer): void {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  let created = false;
  try {
    fd = fs.openSync(tmp, 'wx');
    created = true;
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* retain the original error */ }
    }
    if (created) {
      try { fs.unlinkSync(tmp); } catch { /* retain the original error */ }
    }
    throw error;
  }
}

const SAVE_DEBOUNCE_MS = 250;
const WINDOWS_RENAME_BACKOFFS_MS = [75, 150, 300] as const;

export class Store {
  readonly file: string;
  state: PersistedState;
  private timer: NodeJS.Timeout | null = null;

  constructor(file = path.join(app.getPath('userData'), 'quiver-state.json')) {
    this.file = file;
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
          privacy: normalizePrivacy(raw.settings?.privacy, process.platform),
        },
      } as PersistedState;
      state.spaces = state.spaces.map((space) => ({ ...space, folders: normalizeFolders(space.folders) }));
      const knownSpaces = new Set(state.spaces.map(({ id }) => id));
      state.topics = normalizeTopics(raw.topics, knownSpaces);
      state.activeTopicBySpace = Object.fromEntries(Object.entries(raw.activeTopicBySpace ?? {})
        .filter(([space, topic]) => knownSpaces.has(space) && state.topics!.some((t) => t.id === topic && t.spaceId === space)));
      state.sync = normalizeSyncState(raw.sync, os.hostname());
      state.bookmarkUndo = validBookmarkUndo(raw.bookmarkUndo, state.bookmarks);
      const spaceIds = new Set(state.spaces.map(({ id }) => id));
      const soleNewTabSpaces = new Set([...spaceIds].filter((id) => hasSavedNewTabPlaceholder(state.tabsBySpace?.[id])));
      state.recentlyClosed = normalizeRecentlyClosed(raw.recentlyClosed, spaceIds, soleNewTabSpaces);
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
    this.cancelPendingSave();
    this.scheduleSave(SAVE_DEBOUNCE_MS, 0);
  }

  flush(): boolean {
    this.cancelPendingSave();
    try {
      this.writeState();
      return true;
    } catch (error) {
      this.reportSaveError(error);
      return false;
    }
  }

  private cancelPendingSave(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private scheduleSave(delay: number, attempt: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        this.writeState();
      } catch (error) {
        const backoff = WINDOWS_RENAME_BACKOFFS_MS[attempt];
        const failure = error as NodeJS.ErrnoException;
        if (backoff !== undefined && process.platform === 'win32' && failure.syscall === 'rename' &&
            (failure.code === 'EPERM' || failure.code === 'EBUSY')) {
          this.scheduleSave(backoff, attempt + 1);
        } else {
          this.reportSaveError(error);
        }
      }
    }, delay);
  }

  private writeState(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, JSON.stringify(this.state, null, 2));
  }

  private reportSaveError(error: unknown): void {
    console.error('[quiver] could not save state:', error instanceof Error ? error.message : String(error));
  }
}
