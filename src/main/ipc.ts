import { clipboard, dialog, ipcMain, Menu, type IpcMainInvokeEvent, type WebContentsView, type WebFrameMain } from 'electron';
import { commandChoice, commandContextMatches, type CommandContext } from '../shared/command-preview';
import { detectEnv } from '../shared/env';
import { parseCommand } from '../shared/parser';
import type { BookmarkLibraryView, BrowserCommand, CommandCommitResult, CommandMode, EnvGroup, Settings, Suggestion } from '../shared/types';
import { BookmarkImports } from './bookmark-import';
import { isValidBoostName, type Boosts } from './boosts';
import { BookmarkProfileReadError, bookmarkProfileLabel, discoverBookmarkProfiles, readChromiumBookmarkCandidates } from './chromium-bookmarks';
import type { DevServerWatcher } from './devservers';
import { internalRole, type InternalPage, type InternalRole } from './internal-access';
import type { Store } from './store';
import { paletteQuery, paletteSuggestions } from './palette';
import { normalizePrivacy } from './privacy';
import { topicMarkdown, type Research } from './research';
import { researchSuggestions } from './research-commands';
import type { SyncService } from './sync-service';
import { tabCommandTarget, tabSearchQuery, tabSearchSuggestions, tabTargetMatches } from './tab-search';
import { displayUrl, type TabManager } from './tabs';

export interface IpcDeps {
  tabs: TabManager;
  store: Store;
  boosts: Boosts;
  devWatcher: DevServerWatcher;
  overlay: WebContentsView;
  shell: WebContentsView;
  /** Runs a browser action chosen in the command palette. */
  runCommand: (command: BrowserCommand) => void;
  research: Research;
  sync: SyncService;
  /** Reapply privacy settings after they change. */
  onPrivacyChanged: () => void;
}

const MAX_COMMAND_LENGTH = 65536;
type AuthorizedInvokeEvent = IpcMainInvokeEvent & { senderFrame: WebFrameMain };

export function sanitizeEnvGroups(input: unknown): EnvGroup[] {
  if (!Array.isArray(input)) return [];
  const s = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 300) : '');
  return input
    .slice(0, 50)
    .map((g) => ({ name: s((g as EnvGroup)?.name) || 'App', local: s((g as EnvGroup)?.local), staging: s((g as EnvGroup)?.staging), prod: s((g as EnvGroup)?.prod) }))
    .filter((g) => g.local || g.staging || g.prod);
}

export function registerIpc(d: IpcDeps): { openCommandBar: (text?: string, mode?: CommandMode) => void; toggleSidebar: () => void; applySettings: (patch: Partial<Settings>) => void } {
  const { tabs, store, boosts, devWatcher, overlay, shell, research } = d;

  const handle = (role: InternalRole, channel: string, fn: (e: AuthorizedInvokeEvent, ...args: any[]) => unknown) => {
    ipcMain.handle(channel, (e, ...args) => {
      const frame = e.senderFrame;
      if (!frame) throw new Error('forbidden sender');
      let assignedPage: InternalPage | undefined;
      if (e.sender === shell.webContents) assignedPage = 'shell';
      else if (e.sender === overlay.webContents) assignedPage = 'commandbar';
      else {
        for (const tab of tabs.tabs.values()) {
          if (tab.internalPage && e.sender === tab.view.webContents) {
            assignedPage = tab.internalPage;
            break;
          }
        }
      }
      if (internalRole(frame.url, assignedPage, frame === e.sender.mainFrame) !== role) throw new Error('forbidden sender');
      return fn(e as AuthorizedInvokeEvent, ...args);
    });
  };

  let nextCommandId = 0;
  let command: {
    id: number;
    mode: CommandMode;
    request: number;
    context?: CommandContext;
    suggestions: Suggestion[];
  } | null = null;

  const closeOverlay = (restoreFocus: boolean) => {
    command = null;
    tabs.setOverlayOpen(false, restoreFocus);
  };

  const commandContext = (mode: CommandMode): CommandContext => {
    const tab = tabs.activeTab;
    const spaceId = tabs.activeSpaceId;
    const url = tab ? tabs.tabUrl(tab) : '';
    return {
      spaceId,
      spaceName: tabs.spaces.find((space) => space.id === spaceId)?.name ?? '',
      tabId: tab?.id ?? null,
      url,
      internal: tab?.internal ?? false,
      mode,
      environment: tab && !tab.internal ? detectEnv(url, store.state.settings.envGroups)?.env : undefined,
      navigation: tab?.commandRevision ?? 0,
      navigationPending: !!tab && (!!tab.requestedLoad || tab.view.webContents.isDestroyed() || tab.view.webContents.isLoadingMainFrame()),
    };
  };

  const parseContext = (context: CommandContext) => ({
    searchEngine: store.state.settings.searchEngine,
    envGroups: store.state.settings.envGroups,
    currentUrl: context.internal ? undefined : context.url,
  });

  const commandTabTarget = (tab: NonNullable<TabManager['activeTab']>, spaceName: string) =>
    tabCommandTarget(tab, tabs.tabUrl(tab), spaceName, store.state.settings.envGroups);

  function* openTabTargets() {
    const spaces = new Map(tabs.spaces.map(({ id, name }) => [id, name]));
    for (const tab of tabs.tabs.values()) {
      const name = spaces.get(tab.spaceId);
      if (name !== undefined && !tab.view.webContents.isDestroyed()) yield commandTabTarget(tab, name);
    }
  }

  /** Tab search (`tab …`), palette scopes (`> …`, `bm …`), else the parser with palette matches below its default result. */
  const suggestionsFor = (text: string, context: CommandContext): Suggestion[] => {
    const topics = researchSuggestions(text, research.inSpace(context.spaceId), research.active(context.spaceId), context.internal ? '' : context.url);
    if (topics) return topics;
    const tabQuery = tabSearchQuery(text);
    if (tabQuery !== undefined) return tabSearchSuggestions(tabQuery, context.spaceId, openTabTargets());
    const palette = paletteQuery(text);
    const sources = () => ({ activeSpaceId: context.spaceId, tabs: openTabTargets(), bookmarks: store.state.bookmarks });
    if (palette && palette.scope !== 'all') return paletteSuggestions(palette.scope, palette.query, sources());
    const parsed = parseCommand(text, parseContext(context));
    const fellThrough = parsed.length === 1 && (parsed[0].kind === 'url' || parsed[0].kind === 'search');
    if (!palette || !fellThrough || palette.query.length < 2) return parsed;
    return [...parsed, ...paletteSuggestions('all', palette.query, sources())];
  };

  handle('shell', 'state:get', () => tabs.snapshot());

  // tabs
  handle('shell', 'tab:close', (_e, id: number) => tabs.closeTab(Number(id)));
  handle('shell', 'tab:activate', (_e, id: number) => tabs.activateTab(Number(id)));
  handle('shell', 'tab:place', (_e, id: number, where: unknown) => {
    const w = (where && typeof where === 'object' ? where : {}) as Record<string, unknown>;
    tabs.placeTab(Number(id), {
      pinned: w.pinned === true,
      folderId: typeof w.folderId === 'string' ? w.folderId : null,
      targetId: typeof w.targetId === 'number' && Number.isInteger(w.targetId) ? w.targetId : null,
      after: w.after === true,
    });
  });
  handle('shell', 'tab:menu', (_e, id: number) => {
    const tab = tabs.tabs.get(Number(id));
    if (!tab) return;
    const folders = tabs.folders(tab.spaceId);
    const depth = (folderId: string | null): number => {
      let d = 0;
      for (let at = folderId; at; at = folders.find((f) => f.id === at)?.parentId ?? null) d++;
      return d;
    };
    const newFolder = (parentId: string | null) => {
      const folderId = tabs.createFolder(tab.spaceId, parentId);
      if (!folderId) return;
      tabs.setPinned(tab.id, true, folderId);
      shell.webContents.send('folder:rename-start', folderId);
    };
    Menu.buildFromTemplate([
      tab.pinned
        ? { label: 'Unpin tab', click: () => tabs.setPinned(tab.id, false) }
        : { label: 'Pin tab', click: () => tabs.setPinned(tab.id, true) },
      {
        label: 'Move to folder',
        submenu: [
          { label: 'Pinned, no folder', type: 'radio', checked: tab.pinned && tab.folderId === null, click: () => tabs.setPinned(tab.id, true) },
          ...folders.map((f) => ({
            label: '  '.repeat(Math.max(0, depth(f.id) - 1)) + f.name,
            type: 'radio' as const,
            checked: tab.folderId === f.id,
            click: () => tabs.setPinned(tab.id, true, f.id),
          })),
          { type: 'separator' },
          { label: 'New folder', click: () => newFolder(null) },
        ],
      },
      { type: 'separator' },
      { label: 'Close tab', click: () => tabs.closeTab(tab.id) },
    ]).popup();
  });

  // pinned-tab folders
  const folderId = (id: unknown) => (typeof id === 'string' ? id : '');
  handle('shell', 'folder:toggle', (_e, id: string, collapsed?: boolean) =>
    tabs.toggleFolder(folderId(id), typeof collapsed === 'boolean' ? collapsed : undefined));
  handle('shell', 'folder:rename', (_e, id: string, name: string) => tabs.renameFolder(folderId(id), String(name ?? '')));
  handle('shell', 'folder:move', (_e, id: string, parentId: string | null) =>
    tabs.moveFolder(folderId(id), typeof parentId === 'string' ? parentId : null));
  handle('shell', 'folder:menu', (_e, id: string) => {
    const spaceId = tabs.spaces.find((s) => s.folders?.some((f) => f.id === id))?.id;
    const folder = spaceId && tabs.folders(spaceId).find((f) => f.id === id);
    if (!spaceId || !folder) return;
    Menu.buildFromTemplate([
      { label: 'Rename folder', click: () => shell.webContents.send('folder:rename-start', folder.id) },
      {
        label: 'New subfolder',
        click: () => {
          const child = tabs.createFolder(spaceId, folder.id);
          if (child) shell.webContents.send('folder:rename-start', child);
        },
      },
      { label: folder.collapsed ? 'Expand' : 'Collapse', click: () => tabs.toggleFolder(folder.id) },
      { label: 'Move to top level', enabled: folder.parentId !== null, click: () => tabs.moveFolder(folder.id, null) },
      { type: 'separator' },
      { label: 'Delete folder (keep its tabs)', click: () => tabs.deleteFolder(folder.id) },
    ]).popup();
  });
  handle('shell', 'tab:back', () => tabs.goBack());
  handle('shell', 'tab:forward', () => tabs.goForward());
  handle('shell', 'tab:reload', () => tabs.reload());
  handle('shell', 'tab:reopen', (_e, id: number) => {
    if (!Number.isSafeInteger(id)) throw new Error('invalid reopen request');
    tabs.reopenClosedTab(id);
  });
  handle('shell', 'tab:retry-crash', (_e, id: number) => {
    if (!Number.isSafeInteger(id)) throw new Error('invalid retry request');
    tabs.retryCrashedTab(id);
  });
  handle('shell', 'recovery:dismiss', () => tabs.dismissRecovery());

  // spaces
  handle('shell', 'space:create', (_e, name: string, isolated: boolean) => {
    tabs.createSpace(String(name ?? ''), !!isolated);
  });
  handle('shell', 'space:rename', (_e, id: string, name: string) => tabs.renameSpace(String(id), String(name)));
  handle('shell', 'space:activate', (_e, id: string) => tabs.activateSpace(String(id)));
  handle('shell', 'space:menu', (_e, id: string) => {
    const menu = Menu.buildFromTemplate([
      { label: 'Rename Space', click: () => shell.webContents.send('space:rename-start', id) },
      { type: 'separator' },
      { label: 'Delete Space and its tabs', enabled: tabs.spaces.length > 1, click: () => void tabs.deleteSpace(String(id)).then(() => research.prune(new Set(tabs.spaces.map((sp) => sp.id)))) },
    ]);
    menu.popup();
  });

  // chrome
  handle('shell', 'sidebar:toggle', () => toggleSidebar());
  handle('shell', 'preview:toggle', () => tabs.setPreview(!tabs.preview));
  handle('shell', 'env:switch', (_e, target?: 'LOCAL' | 'STAGING' | 'PROD') => tabs.switchEnvironment(target));

  function toggleSidebar() {
    store.state.settings.sidebarCollapsed = !store.state.settings.sidebarCollapsed;
    store.save();
    tabs.syncPhone();
    tabs.emit();
  }

  // command bar
  handle('shell', 'cmd:open', (_e, text?: string, mode?: CommandMode, invoker?: unknown) => {
    openCommandBar(text, mode === 'new' ? 'new' : 'current', invoker === 'address' || invoker === 'new-tab' ? invoker : undefined);
  });
  handle('commandbar', 'cmd:close', (_e, id: number) => {
    if (command?.id === id) closeOverlay(true);
  });
  handle('commandbar', 'cmd:suggest', (_e, id: number, request: number, text: string) => {
    if (!command || command.id !== id || !Number.isSafeInteger(request) || request <= command.request) return [];
    command.request = request;
    command.suggestions = [];
    if (typeof text !== 'string' || text.length > MAX_COMMAND_LENGTH) return [];
    const context = commandContext(command.mode);
    command.context = context;
    command.suggestions = suggestionsFor(text, context);
    return command.suggestions.map((suggestion) => commandChoice(suggestion, context));
  });
  handle('commandbar', 'cmd:commit', (_e, id: number, request: number, index: number, alternate: boolean): CommandCommitResult => {
    if (!command?.context || command.id !== id || command.request !== request || !Number.isSafeInteger(index)) return 'stale';
    const suggestion = command.suggestions[index];
    if (!suggestion || suggestion.action.type === 'noop') return 'unavailable';
    const { action } = suggestion;
    const context = commandContext(command.mode);
    if (!commandContextMatches(command.context, context, action, parseContext(context))) return 'stale';
    const choice = commandChoice(suggestion, context);
    if (alternate === true && !choice.acceptsAltEnter) return 'unavailable';
    const preview = (alternate === true && choice.alternative) || choice.preview;
    switch (action.type) {
      case 'navigate':
        if (suggestion.kind === 'search') research.recordSearch(context.spaceId, suggestion.label.replace(/^Search: /, ''), action.url);
        tabs.navigate(action.url, { newTab: preview.tab === 'new' });
        break;
      case 'research': {
        const topicInSpace = (id: string) => research.get(id)?.spaceId === context.spaceId;
        if (action.op === 'start') {
          if (!research.start(context.spaceId, action.name)) return 'unavailable';
        } else if (action.op === 'resume') {
          if (!topicInSpace(action.topicId)) return 'stale';
          research.resume(action.topicId);
        } else if (action.op === 'stop') {
          research.stop(context.spaceId);
        } else if (action.op === 'open') {
          if (!topicInSpace(action.topicId)) return 'stale';
          tabs.navigate(`quiver://research?topic=${encodeURIComponent(action.topicId)}`);
          break;
        } else if (action.op === 'note') {
          const tab = tabs.activeTab;
          if (!tab || tab.internal || !research.note(context.spaceId, tabs.tabUrl(tab), tab.titleIsExplicit ? tab.title : '', action.text)) return 'unavailable';
        }
        closeOverlay(true);
        return 'done';
      }
      case 'copy':
        clipboard.writeText(action.text);
        closeOverlay(true);
        return 'done';
      case 'boost':
        if (!isValidBoostName(action.name)) return 'unavailable';
        boosts.create(action.name);
        tabs.navigate(`quiver://boosts?file=${encodeURIComponent(action.name)}`);
        break;
      case 'env':
        tabs.navigate(action.url);
        break;
      case 'internal':
        tabs.navigate(`quiver://${action.page}`);
        break;
      case 'browser':
        closeOverlay(true);
        d.runCommand(action.command);
        return 'done';
      case 'activate-tab': {
        const tab = tabs.tabs.get(action.target.id);
        const space = tab && tabs.spaces.find(({ id }) => id === tab.spaceId);
        if (!tab || !space || tab.view.webContents.isDestroyed() ||
            !tabTargetMatches(action.target, commandTabTarget(tab, space.name))) return 'stale';
        tabs.activateTab(tab.id);
        break;
      }
    }
    closeOverlay(false);
    return 'done';
  });
  handle('shell', 'cmd:run', (_e, action: unknown) => {
    const choice = action as Partial<{ type: string; page: string; topic: string }> | null;
    if (choice?.type !== 'internal') return;
    if (choice.page === 'boosts' || choice.page === 'settings') tabs.navigate(`quiver://${choice.page}`);
    if (choice.page === 'research') {
      const topic = typeof choice.topic === 'string' && research.get(choice.topic) ? `?topic=${encodeURIComponent(choice.topic)}` : '';
      tabs.navigate(`quiver://research${topic}`);
    }
  });
  // research notes page
  const topicId = (id: unknown) => (typeof id === 'string' ? id : '');
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  handle('research', 'research:list', () => {
    const names = new Map(tabs.spaces.map((sp) => [sp.id, sp.name]));
    return research.list().map((t) => ({ ...t, spaceName: names.get(t.spaceId) ?? '' }));
  });
  handle('research', 'research:get', (_e, id: string) => research.get(topicId(id)) ?? null);
  handle('research', 'research:rename', (_e, id: string, name: string) => research.rename(topicId(id), text(name)));
  handle('research', 'research:notes', (_e, id: string, notes: string) => research.setNotes(topicId(id), text(notes)));
  handle('research', 'research:item-note', (_e, id: string, kind: string, url: string, note: string) =>
    research.setItemNote(topicId(id), kind, url, text(note)));
  handle('research', 'research:item-remove', (_e, id: string, kind: string, url: string) => research.removeItem(topicId(id), kind, url));
  handle('research', 'research:delete', (_e, id: string) => research.delete(topicId(id)));
  handle('research', 'research:resume', (_e, id: string) => research.resume(topicId(id)));
  handle('research', 'research:stop', (_e, id: string) => {
    const topic = research.get(topicId(id));
    if (topic && research.active(topic.spaceId)?.id === topic.id) research.stop(topic.spaceId);
  });
  handle('research', 'research:open', (_e, id: string, url: string) => {
    // Only URLs already on the topic's trail can be opened from the page, and only in the topic's Space.
    const topic = research.get(topicId(id));
    const item = topic?.items.find((i) => i.url === url);
    if (!topic || !item || !tabs.spaces.some((sp) => sp.id === topic.spaceId)) return;
    if (tabs.activeSpaceId !== topic.spaceId) tabs.activateSpace(topic.spaceId);
    tabs.openTab(item.url, { spaceId: topic.spaceId });
  });
  handle('research', 'research:export', (_e, id: string) => {
    const topic = research.get(topicId(id));
    if (!topic) return false;
    clipboard.writeText(topicMarkdown(topic));
    return true;
  });

  // settings
  handle('settings', 'settings:get', () => store.state.settings);
  /** Apply a settings change from the Settings page or from sync. Every field is validated. */
  const applySettings = (patch: Partial<Settings>) => {
    if (!patch || typeof patch !== 'object') return;
    const s = store.state.settings;
    if (patch.envGroups !== undefined) s.envGroups = sanitizeEnvGroups(patch.envGroups);
    if (typeof patch.searchEngine === 'string' && /^https?:\/\/.+%s/.test(patch.searchEngine)) s.searchEngine = patch.searchEngine;
    if (typeof patch.devServerScan === 'boolean') s.devServerScan = patch.devServerScan;
    if (patch.privacy !== undefined && typeof patch.privacy === 'object') {
      s.privacy = normalizePrivacy({ ...s.privacy, ...patch.privacy }, process.platform);
      d.onPrivacyChanged();
    }
    store.save();
    if (s.devServerScan && !devWatcher.active) devWatcher.start();
    if (!s.devServerScan) {
      devWatcher.stop();
      devWatcher.servers = [];
      tabs.clearDevServers();
    }
    tabs.emit();
  };
  handle('settings', 'settings:set', (_e, patch: Partial<Settings>) => applySettings(patch));

  // sync
  handle('settings', 'sync:status', () => d.sync.status());
  handle('settings', 'sync:choose', async () => {
    const result = await dialog.showOpenDialog({ title: 'Choose a folder to sync through', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return d.sync.status();
    await d.sync.setFolder(result.filePaths[0]);
    return d.sync.status();
  });
  handle('settings', 'sync:disconnect', async () => {
    await d.sync.setFolder(null);
    return d.sync.status();
  });
  handle('settings', 'sync:options', (_e, include: unknown, deviceName: unknown) => {
    d.sync.setOptions((include && typeof include === 'object' ? include : {}) as Record<string, boolean>, typeof deviceName === 'string' ? deviceName : undefined);
    return d.sync.status();
  });
  handle('settings', 'sync:now', async () => {
    await d.sync.syncNow();
    return d.sync.status();
  });

  const imports = new BookmarkImports<WebFrameMain>(store.state, () => {
    const saved = store.flush();
    if (!saved) store.save(); // Retain any unrelated pending settings or session writes after rollback.
    return saved;
  });
  let trackedBookmarkReview: { frame: WebFrameMain; release: () => void } | undefined;
  const clearBookmarkReview = (frame: WebFrameMain) => {
    imports.cancel(frame);
    if (trackedBookmarkReview?.frame === frame) {
      trackedBookmarkReview.release();
      trackedBookmarkReview = undefined;
    }
  };
  const beginBookmarkReview = (event: IpcMainInvokeEvent, frame: WebFrameMain) => {
    trackedBookmarkReview?.release();
    const sender = event.sender;
    const clear = () => clearBookmarkReview(frame);
    const navigation = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
      if (details.isMainFrame && !details.isSameDocument) clear();
    };
    sender.on('did-start-navigation', navigation);
    sender.once('destroyed', clear);
    trackedBookmarkReview = { frame, release: () => {
      sender.off('did-start-navigation', navigation);
      sender.off('destroyed', clear);
    } };
    return imports.begin(frame);
  };
  const browserData = process.platform === 'win32' ? process.env.LOCALAPPDATA ?? '' : '';
  handle('settings', 'bookmarks:list', (): BookmarkLibraryView => {
    return { bookmarks: store.state.bookmarks, undo: imports.getUndo() };
  });
  handle('settings', 'bookmarks:profiles', () => discoverBookmarkProfiles(browserData));
  handle('settings', 'bookmarks:review-profile', async (event, browser: unknown, profile: unknown) => {
    const frame = event.senderFrame;
    const generation = beginBookmarkReview(event, frame);
    try {
      const source = bookmarkProfileLabel(browser, profile);
      if (!source) throw new BookmarkProfileReadError('The selected browser profile is no longer available.');
      const scan = await readChromiumBookmarkCandidates(browserData, browser, profile);
      return imports.finish(frame, generation, source, scan.candidates, scan.scanLimited);
    } catch (error) {
      if (imports.isCurrent(frame, generation)) clearBookmarkReview(frame);
      return { error: error instanceof BookmarkProfileReadError ? error.message : 'Quiver could not read this browser profile.' };
    }
  });
  handle('settings', 'bookmarks:review-file', (event, name: unknown, input: unknown, scanLimited: unknown) => {
    const frame = event.senderFrame;
    const generation = beginBookmarkReview(event, frame);
    const file = typeof name === 'string' ? name.slice(0, 260).split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 120) : '';
    return imports.finish(frame, generation, file || 'HTML bookmark export', input, scanLimited === true);
  });
  handle('settings', 'bookmarks:cancel-review', (event) => clearBookmarkReview(event.senderFrame));
  handle('settings', 'bookmarks:confirm', (event, id: unknown) => {
    const frame = event.senderFrame;
    const result = imports.commit(frame, id);
    if ('added' in result) clearBookmarkReview(frame);
    return result;
  });
  handle('settings', 'bookmarks:undo', (_event, id: unknown) => {
    const result = imports.undo(id);
    if ('removed' in result && trackedBookmarkReview) clearBookmarkReview(trackedBookmarkReview.frame);
    return result;
  });
  handle('settings', 'bookmarks:open', (_event, url: unknown) => {
    const bookmark = store.state.bookmarks.find((item) => item.url === url);
    if (bookmark) tabs.openTab(bookmark.url);
  });

  // boosts
  handle('boosts', 'boost:list', () => boosts.list());
  handle('boosts', 'boost:read', (_e, name: string) => boosts.read(String(name)));
  handle('boosts', 'boost:save', (_e, name: string, content: string) => boosts.save(String(name), String(content)));
  handle('boosts', 'boost:create', (_e, name: string) => boosts.create(String(name)));
  handle('boosts', 'boost:delete', (_e, name: string) => boosts.remove(String(name)));
  handle('boosts', 'boost:dir', () => boosts.dir);

  // dev servers
  handle('shell', 'devserver:open', (_e, url: string) => {
    const existing = [...tabs.tabs.values()].find((t) => !t.internal && t.spaceId === tabs.activeSpaceId && tabs.tabUrl(t).replace(/\/$/, '') === String(url).replace(/\/$/, ''));
    if (existing) tabs.activateTab(existing.id);
    else tabs.navigate(String(url), { newTab: true });
  });
  handle('shell', 'devserver:refresh', () => store.state.settings.devServerScan && devWatcher.tick());
  handle('shell', 'devserver:retry', (_e, tabId: unknown, url: unknown) => {
    if (typeof tabId !== 'number' || !Number.isSafeInteger(tabId) || typeof url !== 'string') return false;
    return tabs.retryDevServer(tabId, url);
  });

  function openCommandBar(text?: string, mode: CommandMode = 'current', invoker?: 'address' | 'new-tab') {
    const cur = tabs.activeTab;
    const prefill = typeof text === 'string' ? text : cur && !cur.internal ? displayUrl(tabs.tabUrl(cur)) : '';
    command = { id: ++nextCommandId, mode, request: 0, suggestions: [] };
    tabs.setOverlayOpen(true, false, invoker);
    const tooLong = prefill.length > MAX_COMMAND_LENGTH;
    overlay.webContents.send('cmd:opened', {
      id: command.id, mode, text: tooLong ? '' : prefill, maxInputLength: MAX_COMMAND_LENGTH,
      message: tooLong ? 'This address is too long to edit here. Enter a shorter command.' : undefined,
    });
  }

  return { openCommandBar, toggleSidebar, applySettings };
}
