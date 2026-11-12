import { clipboard, ipcMain, Menu, type IpcMainInvokeEvent, type WebContentsView, type WebFrameMain } from 'electron';
import { commandChoice, commandContextMatches, type CommandContext } from '../shared/command-preview';
import { INTERNAL_ORIGIN } from '../shared/constants';
import { detectEnv } from '../shared/env';
import { parseCommand, resolveInput } from '../shared/parser';
import type { BookmarkLibraryView, CommandCommitResult, CommandMode, EnvGroup, Settings, Suggestion } from '../shared/types';
import { BookmarkImports } from './bookmark-import';
import { isValidBoostName, type Boosts } from './boosts';
import { BookmarkProfileReadError, bookmarkProfileLabel, discoverBookmarkProfiles, readChromiumBookmarkCandidates } from './chromium-bookmarks';
import type { DevServerWatcher } from './devservers';
import type { Store } from './store';
import { displayUrl, type TabManager } from './tabs';

export interface IpcDeps {
  tabs: TabManager;
  store: Store;
  boosts: Boosts;
  devWatcher: DevServerWatcher;
  overlay: WebContentsView;
  shell: WebContentsView;
}

const MAX_COMMAND_LENGTH = 65536;

export function sanitizeEnvGroups(input: unknown): EnvGroup[] {
  if (!Array.isArray(input)) return [];
  const s = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 300) : '');
  return input
    .slice(0, 50)
    .map((g) => ({ name: s((g as EnvGroup)?.name) || 'App', local: s((g as EnvGroup)?.local), staging: s((g as EnvGroup)?.staging), prod: s((g as EnvGroup)?.prod) }))
    .filter((g) => g.local || g.staging || g.prod);
}

export function registerIpc(d: IpcDeps): { openCommandBar: (text?: string, mode?: CommandMode) => void; toggleSidebar: () => void } {
  const { tabs, store, boosts, devWatcher, overlay, shell } = d;

  const handle = (channel: string, fn: (e: IpcMainInvokeEvent, ...args: any[]) => unknown) => {
    ipcMain.handle(channel, (e, ...args) => {
      const url = e.senderFrame?.url ?? '';
      if (e.senderFrame !== e.sender.mainFrame || !url.startsWith(INTERNAL_ORIGIN)) throw new Error('forbidden sender');
      return fn(e, ...args);
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
      navigationPending: !!tab && (!!tab.requestedUrl || tab.view.webContents.isDestroyed() || tab.view.webContents.isLoadingMainFrame()),
    };
  };

  const parseContext = (context: CommandContext) => ({
    searchEngine: store.state.settings.searchEngine,
    envGroups: store.state.settings.envGroups,
    currentUrl: context.internal ? undefined : context.url,
  });

  const fromOverlay = (e: IpcMainInvokeEvent) => {
    if (e.sender !== overlay.webContents || new URL(e.senderFrame!.url).pathname !== '/commandbar.html') {
      throw new Error('forbidden sender');
    }
  };

  handle('state:get', () => tabs.snapshot());

  // tabs
  handle('tab:new', (_e, url?: string) => {
    tabs.openTab(typeof url === 'string' && url ? resolveInput(url, store.state.settings.searchEngine) : 'quiver://newtab');
  });
  handle('tab:close', (_e, id: number) => tabs.closeTab(Number(id)));
  handle('tab:activate', (_e, id: number) => tabs.activateTab(Number(id)));
  handle('tab:back', () => tabs.goBack());
  handle('tab:forward', () => tabs.goForward());
  handle('tab:reload', () => tabs.reload());
  handle('tab:reopen', (e, id: number) => {
    if (e.sender !== shell.webContents || !Number.isSafeInteger(id)) throw new Error('invalid reopen request');
    tabs.reopenClosedTab(id);
  });
  handle('tab:retry-crash', (e, id: number) => {
    if (e.sender !== shell.webContents || !Number.isSafeInteger(id)) throw new Error('invalid retry request');
    tabs.retryCrashedTab(id);
  });
  handle('recovery:dismiss', (e) => {
    if (e.sender !== shell.webContents) throw new Error('forbidden sender');
    tabs.dismissRecovery();
  });

  // spaces
  handle('space:create', (_e, name: string, isolated: boolean) => {
    tabs.createSpace(String(name ?? ''), !!isolated);
  });
  handle('space:rename', (_e, id: string, name: string) => tabs.renameSpace(String(id), String(name)));
  handle('space:activate', (_e, id: string) => tabs.activateSpace(String(id)));
  handle('space:menu', (_e, id: string) => {
    const menu = Menu.buildFromTemplate([
      { label: 'Rename Space', click: () => shell.webContents.send('space:rename-start', id) },
      { type: 'separator' },
      { label: 'Delete Space and its tabs', enabled: tabs.spaces.length > 1, click: () => void tabs.deleteSpace(String(id)) },
    ]);
    menu.popup();
  });

  // chrome
  handle('sidebar:toggle', () => toggleSidebar());
  handle('preview:toggle', () => tabs.setPreview(!tabs.preview));
  handle('env:switch', (_e, target?: 'LOCAL' | 'STAGING' | 'PROD') => tabs.switchEnvironment(target));

  function toggleSidebar() {
    store.state.settings.sidebarCollapsed = !store.state.settings.sidebarCollapsed;
    store.save();
    tabs.layout();
    tabs.emit();
  }

  // command bar
  handle('cmd:open', (e, text?: string, mode?: CommandMode, invoker?: unknown) => {
    if (e.sender !== shell.webContents) throw new Error('forbidden sender');
    openCommandBar(text, mode === 'new' ? 'new' : 'current', invoker === 'address' || invoker === 'new-tab' ? invoker : undefined);
  });
  handle('cmd:close', (e, id: number) => {
    fromOverlay(e);
    if (command?.id === id) closeOverlay(true);
  });
  handle('cmd:suggest', (e, id: number, request: number, text: string) => {
    fromOverlay(e);
    if (!command || command.id !== id || !Number.isSafeInteger(request) || request <= command.request) return [];
    command.request = request;
    command.suggestions = [];
    if (typeof text !== 'string' || text.length > MAX_COMMAND_LENGTH) return [];
    const context = commandContext(command.mode);
    command.context = context;
    command.suggestions = parseCommand(text, parseContext(context));
    return command.suggestions.map((suggestion) => commandChoice(suggestion, context));
  });
  handle('cmd:commit', (e, id: number, request: number, index: number, alternate: boolean): CommandCommitResult => {
    fromOverlay(e);
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
        tabs.navigate(action.url, { newTab: preview.tab === 'new' });
        break;
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
    }
    closeOverlay(false);
    return 'done';
  });
  handle('cmd:run', (e, action: unknown) => {
    if (e.sender !== shell.webContents) throw new Error('forbidden sender');
    const choice = action as Partial<{ type: string; page: string }> | null;
    if (choice?.type === 'internal' && (choice.page === 'boosts' || choice.page === 'settings')) tabs.navigate(`quiver://${choice.page}`);
  });
  handle('clipboard:write', (_e, text: string) => clipboard.writeText(String(text).slice(0, 100000)));

  // settings
  handle('settings:set', (_e, patch: Partial<Settings>) => {
    const s = store.state.settings;
    if (patch.envGroups !== undefined) s.envGroups = sanitizeEnvGroups(patch.envGroups);
    if (typeof patch.searchEngine === 'string' && /^https?:\/\/.+%s/.test(patch.searchEngine)) s.searchEngine = patch.searchEngine;
    if (typeof patch.devServerScan === 'boolean') s.devServerScan = patch.devServerScan;
    store.save();
    if (s.devServerScan && !devWatcher.active) devWatcher.start();
    if (!s.devServerScan) {
      devWatcher.stop();
      devWatcher.servers = [];
      tabs.setDevServers([]);
    }
    tabs.emit();
  });

  const fromSettings = (event: IpcMainInvokeEvent) => {
    const frame = event.senderFrame;
    if (!frame || new URL(frame.url).pathname !== '/settings.html') throw new Error('forbidden sender');
    return frame;
  };
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
  handle('bookmarks:list', (event): BookmarkLibraryView => {
    fromSettings(event);
    return { bookmarks: store.state.bookmarks, undo: imports.getUndo() };
  });
  handle('bookmarks:profiles', (event) => {
    fromSettings(event);
    return discoverBookmarkProfiles(browserData);
  });
  handle('bookmarks:review-profile', async (event, browser: unknown, profile: unknown) => {
    const frame = fromSettings(event);
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
  handle('bookmarks:review-file', (event, name: unknown, input: unknown, scanLimited: unknown) => {
    const frame = fromSettings(event);
    const generation = beginBookmarkReview(event, frame);
    const file = typeof name === 'string' ? name.slice(0, 260).split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 120) : '';
    return imports.finish(frame, generation, file || 'HTML bookmark export', input, scanLimited === true);
  });
  handle('bookmarks:cancel-review', (event) => clearBookmarkReview(fromSettings(event)));
  handle('bookmarks:confirm', (event, id: unknown) => {
    const frame = fromSettings(event);
    const result = imports.commit(frame, id);
    if ('added' in result) clearBookmarkReview(frame);
    return result;
  });
  handle('bookmarks:undo', (event, id: unknown) => {
    fromSettings(event);
    const result = imports.undo(id);
    if ('removed' in result && trackedBookmarkReview) clearBookmarkReview(trackedBookmarkReview.frame);
    return result;
  });
  handle('bookmarks:open', (event, url: unknown) => {
    fromSettings(event);
    const bookmark = store.state.bookmarks.find((item) => item.url === url);
    if (bookmark) tabs.openTab(bookmark.url);
  });

  // boosts
  handle('boost:list', () => boosts.list());
  handle('boost:read', (_e, name: string) => boosts.read(String(name)));
  handle('boost:save', (_e, name: string, content: string) => boosts.save(String(name), String(content)));
  handle('boost:create', (_e, name: string) => boosts.create(String(name)));
  handle('boost:delete', (_e, name: string) => boosts.remove(String(name)));
  handle('boost:dir', () => boosts.dir);

  // dev servers
  handle('devserver:open', (_e, url: string) => {
    const existing = [...tabs.tabs.values()].find((t) => !t.internal && t.spaceId === tabs.activeSpaceId && tabs.tabUrl(t).replace(/\/$/, '') === String(url).replace(/\/$/, ''));
    if (existing) tabs.activateTab(existing.id);
    else tabs.navigate(String(url), { newTab: true });
  });
  handle('devserver:refresh', () => devWatcher.tick());

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

  return { openCommandBar, toggleSidebar };
}
