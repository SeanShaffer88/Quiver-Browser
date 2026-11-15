import { app, clipboard, dialog, ipcMain, Menu, session, shell as electronShell, type IpcMainInvokeEvent, type MenuItemConstructorOptions, type WebContentsView, type WebFrameMain } from 'electron';
import { commandChoice, commandContextMatches, type CommandContext } from '../shared/command-preview';
import { detectEnv } from '../shared/env';
import { parseCommand } from '../shared/parser';
import type { BookmarkLibraryView, BrowserCommand, CommandCommitResult, CommandMode, EnvGroup, ProfileContext, Settings, ShortcutRow, Space, SpaceSettingsView, Suggestion } from '../shared/types';
import fs from 'node:fs';
import path from 'node:path';
import { BookmarkImports } from './bookmark-import';
import { ADD_TO_BOARD_PREFIX, boardSuggestions, CAPTURE_TO_BOARD_PREFIX } from './board-commands';
import { faviconPng, type CaptureMode } from './board-capture';
import { cardLabel, cardUrls, type Board, type Boards } from './boards';
import { renderNote } from './board-text';
import { researchUrl } from './research';
import { ArcImports } from './arc-import';
import { isValidBoostName, type Boosts } from './boosts';
import { BookmarkProfileReadError, bookmarkProfileLabel, discoverBookmarkProfiles, readChromiumBookmarkCandidates } from './chromium-bookmarks';
import type { DevServerWatcher } from './devservers';
import { internalRole, type InternalPage, type InternalRole } from './internal-access';
import type { Store } from './store';
import { paletteQuery, paletteSuggestions } from './palette';
import { normalizePrivacy } from './privacy';
import { siteAllowed } from './content-blocking';
import { topicMarkdown, type Research } from './research';
import { researchSuggestions } from './research-commands';
import { meetSuggestions } from './meetings';
import { archiveSuggestions, normalizeArchiveHours } from './archive';
import { nativeKind } from './native/runners';
import { shareTarget } from './native/share';
import type { SyncService } from './sync-service';
import { planContinue, publishableUrl } from './continuity';
import { deviceSuggestions, devicesQuery, remoteTabMatches, sendMatches, sendQuery, sendSuggestions } from './device-commands';
import type { ProfileHistories } from './history';
import { bookmarksElsewhere, bookmarksForProfile, profileKind, profileLabel, readingProfile, separateProfiles, SHARED_PROFILE, spaceProfile, spacesInProfile } from './profiles';
import type { DownloadAction, Downloads } from './downloads';
import { splitSearchQuery, splitSuggestions, tabCommandTarget, tabSearchQuery, tabSearchSuggestions, tabTargetMatches } from './tab-search';
import { displayUrl, type TabManager } from './tabs';
import { normalizeMotion, normalizeTheme, spaceColor, SPACE_PRESETS } from '../shared/theme';
import {
  bindingProblem, currentShortcutOverrides, effectiveBindings, formatBinding, isRebindable, normalizeShortcutOverrides, parseBinding,
  REBINDABLE, setShortcutOverrides,
} from './shortcuts';
import type { UpdateChecker } from './updates';
import type { LittleQuiver } from './little-quiver';

export interface IpcDeps {
  tabs: TabManager;
  store: Store;
  boosts: Boosts;
  devWatcher: DevServerWatcher;
  overlay: WebContentsView;
  shell: WebContentsView;
  /** Runs a browser action chosen in the command palette. */
  runCommand: (command: Exclude<BrowserCommand, BoardCommand>) => void;
  research: Research;
  boards: Boards;
  capture: CaptureMode;
  sync: SyncService;
  history: ProfileHistories;
  downloads: Downloads;
  /** Reapply privacy settings after they change. */
  onPrivacyChanged: () => void;
  onThemeChanged: () => void;
  updates: UpdateChecker;
  /** Little Quiver windows (links from other apps); their toolbars are the 'little' page. */
  little?: LittleQuiver;
}

const MAX_COMMAND_LENGTH = 65536;

type BoardCommand = 'boards' | 'board-add' | 'board-capture';

/** Native menus treat & as a mnemonic marker. */
const menuText = (value: string) => value.replace(/&/g, '&&');

const KIND_LABEL = { ftp: 'FTP', hls: 'HLS stream', dash: 'DASH stream', metalink: 'Metalink', webdav: 'WebDAV' } as const;

/** `download <url>`, a typed ftp:// address, or a typed Windows share (\\server\share, smb://server/share). */
export function downloadSuggestions(text: string, currentUrl = ''): Suggestion[] | undefined {
  const trimmed = text.trim();
  const share = shareTarget(trimmed);
  if (share) {
    return [{ kind: 'share', label: 'Open in File Explorer', detail: `${share} · Windows may sign in to this server with your account`, action: { type: 'open-share', path: share } }];
  }
  const m = /^download(?:\s+(\S+))?$/i.exec(trimmed) ?? (/^(?:ftps?|(?:web)?davs?):\/\/\S+$/i.test(trimmed) ? [trimmed, trimmed] : null);
  if (!m) return undefined;
  const raw = m[1];
  if (!raw) {
    // Chromium plays HLS itself, so a stream open in the tab is offered for saving.
    const here = nativeKind(currentUrl);
    if (here === 'hls' || here === 'dash') return [{ kind: 'download', label: `Download this ${KIND_LABEL[here]}`, detail: URL.parse(currentUrl)?.host, action: { type: 'download', url: currentUrl } }];
    return [{ kind: 'download', label: 'Type an address to download: web, FTP, HLS (.m3u8), DASH (.mpd) or Metalink', action: { type: 'noop' } }];
  }
  const url = URL.parse(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (!url || !['http:', 'https:', 'ftp:', 'ftps:', 'dav:', 'davs:', 'webdav:', 'webdavs:'].includes(url.protocol)) {
    return [{ kind: 'download', label: 'Quiver downloads web, FTP, WebDAV, HLS, DASH and Metalink addresses', action: { type: 'noop' } }];
  }
  const kind = nativeKind(url.href);
  const leaf = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? url.host) + (kind === 'webdav' && url.pathname.endsWith('/') ? ' (folder)' : '');
  return [{ kind: 'download', label: kind ? `Download ${KIND_LABEL[kind]}: ${leaf}` : `Download ${leaf}`, detail: url.host, action: { type: 'download', url: url.href } }];
}
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
  const { tabs, store, boosts, devWatcher, overlay, shell, research, boards, capture } = d;

  /** The Space a Quiver page (Settings, Downloads) was opened in, which decides the profile it shows. */
  const senderSpace = (e: IpcMainInvokeEvent) => {
    let spaceId = tabs.activeSpaceId;
    for (const tab of tabs.tabs.values()) {
      if (tab.view.webContents === e.sender) {
        spaceId = tab.spaceId;
        break;
      }
    }
    return tabs.spaces.find((sp) => sp.id === spaceId) ?? tabs.spaces.find((sp) => sp.id === tabs.activeSpaceId);
  };
  const profileContext = (e: IpcMainInvokeEvent): ProfileContext => {
    const space = senderSpace(e);
    const profile = readingProfile(space);
    const kind = profileKind(space);
    return {
      spaceId: space?.id ?? '',
      spaceName: space?.name ?? '',
      kind,
      label: kind === 'private' ? 'Private Space' : profileLabel(tabs.spaces, profile),
      spaces: kind === 'private' ? [] : spacesInProfile(tabs.spaces, profile).map(({ name }) => name),
    };
  };
  /** The profile a separate-profile Space adds bookmarks to; undefined for the shared library (and private Spaces). */
  const bookmarkOwner = (e: IpcMainInvokeEvent) => {
    const profile = spaceProfile(senderSpace(e));
    return profile && profile !== SHARED_PROFILE ? profile : undefined;
  };

  const handle = (role: InternalRole, channel: string, fn: (e: AuthorizedInvokeEvent, ...args: any[]) => unknown) => {
    ipcMain.handle(channel, (e, ...args) => {
      const frame = e.senderFrame;
      if (!frame) throw new Error('forbidden sender');
      let assignedPage: InternalPage | undefined;
      if (e.sender === shell.webContents) assignedPage = 'shell';
      else if (e.sender === overlay.webContents) assignedPage = 'commandbar';
      else if (e.sender === capture.view.webContents) assignedPage = 'capture';
      else {
        for (const tab of tabs.tabs.values()) {
          if (tab.internalPage && e.sender === tab.view.webContents) {
            assignedPage = tab.internalPage;
            break;
          }
        }
        if (!assignedPage && d.little?.isToolbar(e.sender)) assignedPage = 'little';
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

  /** Why a tab cannot be sent to another device, or undefined when it can. */
  const sendBlocker = (tab: NonNullable<TabManager['activeTab']> | undefined | null): string | undefined => {
    if (!tab) return 'Open a web page to send it';
    if (tabs.isPrivate(tab.spaceId)) return 'Tabs in a private Space are never sent to other devices';
    if (tab.internal) return 'Quiver’s own pages stay on this device';
    if (!publishableUrl(tabs.tabUrl(tab))) return 'Only web pages without a user name or password in the address can be sent';
    return undefined;
  };

  const deviceContext = () => ({
    syncing: d.sync.status().folder !== null,
    openTabs: d.sync.status().openTabs,
    now: Date.now(),
    localUrls: new Set([...tabs.tabs.values()].map((t) => tabs.tabUrl(t))),
  });

  /** Tab search (`tab …`), palette scopes (`> …`, `bm …`), else the parser with palette matches below its default result. */
  const suggestionsFor = (text: string, context: CommandContext): Suggestion[] => {
    const meet = meetSuggestions(text);
    if (meet) return meet;
    const topics = researchSuggestions(text, research.inSpace(context.spaceId), research.active(context.spaceId), context.internal ? '' : context.url);
    if (topics) return topics;
    const boardList = boardSuggestions(text, boards.inSpace(context.spaceId), context.internal ? '' : context.url, tabs.isPrivate(context.spaceId));
    if (boardList) return boardList;
    const downloadSuggestion = downloadSuggestions(text, context.internal ? '' : context.url);
    if (downloadSuggestion) return downloadSuggestion;
    const archived = /^archive(?:\s+([\s\S]*))?$/i.exec(text.trim());
    if (archived) return archiveSuggestions((archived[1] ?? '').trim(), tabs.archive);
    const splitQuery = splitSearchQuery(text);
    if (splitQuery !== undefined) return splitSuggestions(splitQuery, context.spaceId, context.tabId, openTabTargets());
    const tabQuery = tabSearchQuery(text);
    if (tabQuery !== undefined) return tabSearchSuggestions(tabQuery, context.spaceId, openTabTargets());
    const devicesText = devicesQuery(text);
    if (devicesText !== undefined) return deviceSuggestions(devicesText, d.sync.devices(), deviceContext());
    const send = sendQuery(text);
    if (send && (send.explicit || sendMatches(send.query, d.sync.sendTargets()))) {
      return sendSuggestions(send.query, d.sync.sendTargets(), deviceContext(), sendBlocker(tabs.activeTab));
    }
    const palette = paletteQuery(text);
    // History and bookmarks come from the profile of the Space the command bar was opened in.
    const profile = readingProfile(tabs.spaces.find((sp) => sp.id === context.spaceId));
    const sources = () => ({
      activeSpaceId: context.spaceId, tabs: openTabTargets(),
      bookmarks: bookmarksForProfile(store.state.bookmarks, profile), history: d.history.list(profile),
      littleWindows: d.little?.count ?? 0,
    });
    if (palette && palette.scope !== 'all') return paletteSuggestions(palette.scope, palette.query, sources());
    const parsed = parseCommand(text, parseContext(context));
    const fellThrough = parsed.length === 1 && (parsed[0].kind === 'url' || parsed[0].kind === 'search');
    if (!palette || !fellThrough || palette.query.length < 2) return parsed;
    return [...parsed, ...paletteSuggestions('all', palette.query, sources()), ...remoteTabMatches(palette.query, d.sync.devices(), deviceContext())];
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
  handle('shell', 'tab:console', (_e, id: number) => tabs.openConsole(Number(id)));
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
      tabs.inSplit(tab.id)
        ? { label: 'Exit split view', click: () => tabs.exitSplit() }
        : { label: 'Open in split view', enabled: tabs.activeTabId !== null && tabs.activeTab?.spaceId === tab.spaceId, click: () => tabs.startSplit(tab.id) },
      { type: 'separator' },
      ...boardMenu(tab),
      { label: 'Copy link', enabled: !tab.internal, click: () => { tabs.activateTab(tab.id); const link = tabs.activeLink(false); if (link) clipboard.writeText(link); } },
      { label: 'Copy Markdown link', enabled: !tab.internal, click: () => { tabs.activateTab(tab.id); const link = tabs.activeLink(true); if (link) clipboard.writeText(link); } },
      { label: 'Open the console', enabled: !tab.internal, click: () => tabs.openConsole(tab.id) },
      sendMenu(tab),
      ...(!tab.internal && store.state.settings.privacy.blockTrackers ? [{
        label: 'Allow ads on this site',
        type: 'checkbox' as const,
        checked: siteAllowed(tabs.tabUrl(tab), store.state.settings.privacy.adAllowList),
        click: () => tabs.toggleSiteAds(tab.id),
      }] : []),
      { type: 'separator' },
      ...(tab.pinned ? [
        { label: 'Make this page the pinned page', enabled: !tab.internal, click: () => tabs.setPinnedPage(tab.id) },
        { label: 'Back to pinned page (Ctrl+W)', click: () => tabs.closeTab(tab.id) },
        { label: 'Remove pinned tab', click: () => tabs.closeTab(tab.id, { remove: true }) },
      ] : [{ label: 'Close tab', click: () => tabs.closeTab(tab.id) }]),
    ]).popup();
  });

  /** "Send tab to device" with one item per device that can receive it. */
  function sendMenu(tab: NonNullable<TabManager['activeTab']>): MenuItemConstructorOptions {
    const blocked = d.sync.status().folder === null ? 'Choose a sync folder in Settings first' : sendBlocker(tab);
    const targets = blocked ? [] : d.sync.sendTargets();
    if (blocked || !targets.length) {
      return { label: 'Send tab to device', enabled: false, toolTip: blocked ?? 'No other devices can receive tabs yet' };
    }
    return {
      label: 'Send tab to device',
      submenu: targets.map((device) => ({
        label: device.name,
        click: () => {
          // Re-read the tab: it may have navigated since the menu opened.
          const now = tabs.tabs.get(tab.id);
          if (now && !sendBlocker(now)) d.sync.sendTab(device.id, tabs.tabUrl(now), now.customTitle || now.title);
        },
      })),
    };
  }

  /** Open one tab another device has open, in a new tab in the current Space. */
  const openRemoteTab = (deviceId: unknown, url: unknown): boolean => {
    if (typeof deviceId !== 'string' || typeof url !== 'string' || !d.sync.remoteTab(deviceId, url)) return false;
    tabs.openTab(url);
    return true;
  };

  /** "Continue here": open another device's Space into the matching Space here, or a new one. */
  const continueHere = (deviceId: unknown, spaceId: unknown): number | null => {
    if (typeof deviceId !== 'string' || (spaceId !== undefined && typeof spaceId !== 'string')) return null;
    const remote = d.sync.remoteSpace(deviceId, spaceId as string | undefined);
    if (!remote) return null;
    return tabs.continueSession(planContinue(remote, tabs.spaces, (id) => tabs.openUrls(id)));
  };

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

  // camera, microphone and screen-share prompts
  handle('shell', 'permission:decide', (_e, id: number, choice: string) => {
    if (choice === 'once' || choice === 'always' || choice === 'block') tabs.media?.decide(Number(id), choice);
  });
  // find in page and zoom
  handle('shell', 'find:query', (_e, text: unknown, forward: unknown, findNext: unknown) => {
    if (typeof text === 'string') tabs.find(text, forward !== false, findNext === true);
  });
  handle('shell', 'find:close', () => tabs.stopFind(true));
  handle('shell', 'zoom:reset', () => tabs.zoom(0));
  // split view and Peek
  handle('shell', 'split:ratio', (_e, ratio: unknown) => {
    if (typeof ratio === 'number' && Number.isFinite(ratio)) tabs.setSplitRatio(ratio);
  });
  handle('shell', 'split:exit', () => tabs.exitSplit());
  handle('shell', 'peek:close', () => tabs.closePeek());
  handle('shell', 'peek:open-tab', () => tabs.peekToTab());

  // Little Quiver toolbar. The window is the sender's own; nothing the page sends names another one.
  const littleOf = (e: AuthorizedInvokeEvent) => {
    const lw = d.little?.fromToolbar(e.sender);
    if (!lw) throw new Error('forbidden sender');
    return lw;
  };
  handle('little', 'little:get', (e) => d.little!.state(littleOf(e)));
  handle('little', 'little:copy', (e) => d.little!.copyLink(littleOf(e)));
  handle('little', 'little:open', (e) => d.little!.openInQuiver(littleOf(e)));
  handle('little', 'little:close', (e) => d.little!.close(littleOf(e)));

  // spaces
  handle('shell', 'space:create', (_e, name: string, isolated: boolean) => {
    tabs.createSpace(String(name ?? ''), !!isolated);
  });
  handle('shell', 'space:create-private', () => {
    tabs.createPrivateSpace();
  });
  handle('shell', 'adblock:toggle-site', (_e, id: unknown) => {
    if (!Number.isSafeInteger(id)) throw new Error('invalid tab');
    return tabs.toggleSiteAds(id as number);
  });
  handle('shell', 'space:rename', (_e, id: string, name: string) => tabs.renameSpace(String(id), String(name)));
  handle('shell', 'space:activate', (_e, id: string) => tabs.activateSpace(String(id)));
  handle('shell', 'space:color', (_e, id: unknown, color: unknown, color2: unknown) => {
    const main = spaceColor(color);
    if (typeof id !== 'string' || !main || (color2 != null && !spaceColor(color2))) throw new Error('invalid Space colour');
    tabs.setSpaceColor(id, main, spaceColor(color2));
  });
  handle('shell', 'space:menu', (_e, id: string) => {
    const space = tabs.spaces.find((sp) => sp.id === String(id));
    if (!space) return;
    const kind = profileKind(space);
    const colorItems = (current: string | undefined, pick: (color: string) => void): MenuItemConstructorOptions[] =>
      SPACE_PRESETS.map((p) => ({ label: p.name, type: 'radio', checked: current === p.color, click: () => pick(p.color) }));
    const menu = Menu.buildFromTemplate([
      { label: kind === 'private' ? 'Profile: Private (in memory)' : kind === 'separate' ? 'Profile: Separate' : 'Profile: Shared', enabled: false },
      ...(kind === 'private' ? [] : [{ label: 'Space settings…', click: () => tabs.openTab(`quiver://settings?space=${encodeURIComponent(space.id)}#section-spaces`, { spaceId: space.id }) }]),
      { type: 'separator' },
      { label: 'Rename Space', click: () => shell.webContents.send('space:rename-start', id) },
      {
        label: 'Space color',
        submenu: [
          ...colorItems(space.color2 ? undefined : space.color, (color) => tabs.setSpaceColor(space.id, color, undefined)),
          { type: 'separator' },
          {
            label: 'Gradient',
            submenu: [
              { label: 'None', type: 'radio', checked: !space.color2, click: () => tabs.setSpaceColor(space.id, space.color, undefined) },
              { type: 'separator' },
              ...colorItems(space.color2, (color2) => tabs.setSpaceColor(space.id, space.color, color2)),
            ],
          },
          { label: 'Custom colors…', click: () => shell.webContents.send('space:color-start', id) },
        ],
      },
      { label: 'New private Space', accelerator: 'Ctrl+Shift+N', click: () => tabs.createPrivateSpace() },
      { type: 'separator' },
      { label: tabs.isPrivate(String(id)) ? 'Close private Space and discard everything' : 'Delete Space and its tabs', enabled: tabs.canDeleteSpace(String(id)), click: () => void tabs.deleteSpace(String(id)).then(() => {
        const left = new Set(tabs.spaces.map((sp) => sp.id));
        research.prune(left);
        boards.prune(left);
      }) },
    ]);
    menu.popup();
  });

  // chrome
  handle('shell', 'sidebar:toggle', () => toggleSidebar());
  handle('shell', 'preview:toggle', () => tabs.setPreview(!tabs.preview));
  handle('shell', 'env:switch', (_e, target?: 'LOCAL' | 'STAGING' | 'PROD') => tabs.switchEnvironment(target));

  // Hovering the collapsed sidebar shows it over the page until the pointer leaves; Ctrl+B is unaffected.
  handle('shell', 'sidebar:peek', (_e, on: unknown) => tabs.setSidebarPeek(on === true));

  function toggleSidebar() {
    tabs.setSidebarPeek(false);
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
      case 'download': {
        const kind = nativeKind(action.url);
        const partition = tabs.webPartition(context.spaceId);
        if (kind) d.downloads.startNative(kind, action.url, partition);
        else session.fromPartition(partition).downloadURL(action.url);
        closeOverlay(true);
        return 'done';
      }
      case 'open-share': {
        if (process.platform !== 'win32') return 'unavailable';
        const target = shareTarget(action.path);
        if (!target) return 'unavailable';
        closeOverlay(true);
        void electronShell.openPath(target);
        return 'done';
      }
      case 'unarchive':
        if (!tabs.unarchive(action.url, action.archivedAt)) return 'stale';
        break;
      case 'board': {
        if (tabs.isPrivate(context.spaceId)) return 'unavailable';
        const existing = 'boardId' in action ? boards.get(action.boardId) : undefined;
        if ('boardId' in action && existing?.spaceId !== context.spaceId) return 'stale';
        const tab = tabs.activeTab;
        if (action.op !== 'open' && (!tab || tab.internal || !researchUrl(tabs.tabUrl(tab)))) return 'unavailable';
        const board = existing ?? ('name' in action ? boardNamed(context.spaceId, action.name) : undefined);
        if (!board) return 'unavailable';
        if (action.op === 'open') {
          tabs.navigate(`quiver://boards?board=${encodeURIComponent(board.id)}`);
          break;
        }
        if (action.op === 'add-page') {
          closeOverlay(true);
          void addPageToBoard(tab!, board);
        } else {
          closeOverlay(false);
          startCapture(tab!, board);
        }
        return 'done';
      }
      case 'browser':
        if (action.command === 'boards') {
          tabs.navigate('quiver://boards');
          break;
        }
        if (action.command === 'board-add' || action.command === 'board-capture') {
          // Reopen the bar with the board picker typed in, so the next choice is the board.
          openCommandBar(action.command === 'board-add' ? ADD_TO_BOARD_PREFIX : CAPTURE_TO_BOARD_PREFIX, command.mode);
          return 'done';
        }
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
      case 'split-with': {
        const tab = tabs.tabs.get(action.target.id);
        const space = tab && tabs.spaces.find(({ id }) => id === tab.spaceId);
        if (!tab || !space || tab.view.webContents.isDestroyed() ||
            !tabTargetMatches(action.target, commandTabTarget(tab, space.name))) return 'stale';
        closeOverlay(true);
        return tabs.startSplit(tab.id) ? 'done' : 'unavailable';
      }
      case 'remote-tab':
        if (!openRemoteTab(action.deviceId, action.url)) return 'stale';
        break;
      case 'continue':
        if (continueHere(action.deviceId, action.spaceId) === null) return 'stale';
        break;
      case 'send-tab': {
        const tab = tabs.activeTab;
        if (!tab || sendBlocker(tab) || !d.sync.sendTab(action.deviceId, tabs.tabUrl(tab), tab.customTitle || tab.title)) return 'unavailable';
        closeOverlay(true);
        return 'done';
      }
    }
    closeOverlay(false);
    return 'done';
  });
  handle('shell', 'cmd:run', (_e, action: unknown) => {
    const choice = action as Partial<{ type: string; page: string; topic: string }> | null;
    if (choice?.type !== 'internal') return;
    if (choice.page === 'boosts' || choice.page === 'settings' || choice.page === 'downloads' || choice.page === 'boards') tabs.navigate(`quiver://${choice.page}`);
    if (choice.page === 'research') {
      const topic = typeof choice.topic === 'string' && research.get(choice.topic) ? `?topic=${encodeURIComponent(choice.topic)}` : '';
      tabs.navigate(`quiver://research${topic}`);
    }
  });
  // downloads page
  const DOWNLOAD_ACTIONS = new Set<DownloadAction>(['pause', 'resume', 'cancel', 'retry', 'open', 'show', 'remove']);
  // The Downloads page lists its own profile's downloads unless it asks for every profile.
  handle('downloads', 'downloads:list', (e, scope: unknown) => {
    if (scope === 'all') return d.downloads.list();
    return d.downloads.list(tabs.webPartition(senderSpace(e)?.id ?? tabs.activeSpaceId));
  });
  handle('downloads', 'profile:context', (e) => profileContext(e));
  handle('settings', 'settings:profile', (e) => profileContext(e));

  // Settings > Spaces
  const spaceView = (space: Space): SpaceSettingsView => {
    const profile = spaceProfile(space);
    return {
      id: space.id, name: space.name, color: space.color, icon: space.icon ?? '', kind: profileKind(space),
      sharesWith: profile && profile !== SHARED_PROFILE ? spacesInProfile(tabs.spaces, profile).filter((sp) => sp !== space).map(({ name }) => name) : [],
      behavior: { ...space.behavior },
    };
  };
  handle('settings', 'spaces:list', () => tabs.spaces.filter((sp) => !sp.private).map(spaceView));
  handle('settings', 'spaces:update', (_e, id: unknown, patch: unknown) => {
    if (typeof id !== 'string' || !patch || typeof patch !== 'object' || Array.isArray(patch)) return null;
    const { icon, color, behavior } = patch as Record<string, unknown>;
    const space = tabs.updateSpace(id, { icon, color, behavior });
    return space ? spaceView(space) : null;
  });
  handle('downloads', 'downloads:act', (_e, id: unknown, action: unknown, confirmedRisky: unknown) => {
    if (typeof id !== 'string' || !DOWNLOAD_ACTIONS.has(action as DownloadAction)) return 'Unknown action.';
    return d.downloads.act(id, action as DownloadAction, confirmedRisky === true);
  });
  handle('downloads', 'downloads:clear', () => d.downloads.clearFinished());

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

  // boards
  type AnyTab = NonNullable<TabManager['activeTab']>;
  /** An existing board of this name in the Space, else a new one. */
  function boardNamed(spaceId: string, name: string): Board | undefined {
    const wanted = name.replace(/\s+/g, ' ').trim().toLowerCase();
    return boards.inSpace(spaceId).find((b) => b.name.toLowerCase() === wanted) ?? boards.create(spaceId, name);
  }
  const pageTitle = (tab: AnyTab) => (tab.titleIsExplicit ? tab.title : '');
  async function addPageToBoard(tab: AnyTab, board: Board): Promise<void> {
    const url = tabs.tabUrl(tab);
    if (tab.internal || !researchUrl(url) || tabs.isPrivate(tab.spaceId)) return tabs.flash('Only web pages can be added to a board.');
    const icon = tab.favicon ? await faviconPng(tab.favicon, tab.partition) : null;
    const card = boards.add(board.id, { kind: 'link', url, title: pageTitle(tab), icon });
    tabs.flash(typeof card === 'string' ? card : `Added to “${board.name}”.`);
  }
  function startCapture(tab: AnyTab, board: Board): void {
    if (tab.internal || tab.view.webContents.isDestroyed() || !researchUrl(tabs.tabUrl(tab)) || tabs.isPrivate(tab.spaceId)) {
      tabs.flash('Only web pages can be captured.');
      return;
    }
    if (tabs.peekOpen) tabs.closePeek();
    if (tabs.activeTabId !== tab.id) tabs.activateTab(tab.id);
    if (!capture.start({ tabId: tab.id, boardId: board.id, boardName: board.name, contents: tab.view.webContents, bounds: tab.view.getBounds() })) {
      tabs.flash('Quiver could not start a capture here.');
    }
  }
  function boardMenu(tab: AnyTab): Electron.MenuItemConstructorOptions[] {
    if (tab.internal || tabs.isPrivate(tab.spaceId)) return [];
    const list = boards.inSpace(tab.spaceId).slice(0, 15);
    const items = (run: (b: Board) => void, prefix: string): Electron.MenuItemConstructorOptions[] => [
      ...list.map((b) => ({ label: menuText(b.name), click: () => run(b) })),
      ...(list.length ? [{ type: 'separator' as const }] : []),
      { label: 'New board…', click: () => { tabs.activateTab(tab.id); openCommandBar(prefix); } },
    ];
    return [
      { label: 'Add page to board', submenu: items((b) => void addPageToBoard(tab, b), ADD_TO_BOARD_PREFIX) },
      { label: 'Capture to board', submenu: items((b) => startCapture(tab, b), CAPTURE_TO_BOARD_PREFIX) },
      { type: 'separator' },
    ];
  }

  // capture overlay
  handle('capture', 'capture:done', async (_e, rect: unknown) => {
    const result = await capture.finish(rect);
    if (typeof result === 'string') {
      // A selection too small keeps capture mode open and the page shows why; anything else ends it.
      if (capture.active) return result;
      tabs.flash(result);
      return '';
    }
    if (!result) return '';
    const board = boards.get(result.target.boardId);
    const tab = tabs.tabs.get(result.target.tabId);
    if (!board || !tab) return '';
    const card = boards.add(board.id, {
      kind: 'capture', png: result.image.png, imageW: result.image.width, imageH: result.image.height, url: tabs.tabUrl(tab), title: pageTitle(tab),
    });
    tabs.flash(typeof card === 'string' ? card : `Captured to “${board.name}”.`);
    return '';
  });
  handle('capture', 'capture:cancel', () => {
    if (capture.active) tabs.flash('Capture cancelled.');
    capture.cancel();
  });

  // sidebar
  handle('shell', 'board:open', (_e, id: unknown) => {
    const board = boards.get(id);
    if (board && board.spaceId === tabs.activeSpaceId) tabs.navigate(`quiver://boards?board=${encodeURIComponent(board.id)}`);
  });
  handle('shell', 'board:new', () => openCommandBar('board ', 'current'));

  // Boards page
  const senderTab = (e: IpcMainInvokeEvent) => [...tabs.tabs.values()].find((t) => t.view.webContents === e.sender);
  const spaceName = (id: string) => tabs.spaces.find((sp) => sp.id === id)?.name ?? '';
  const boardView = (board: Board) => ({
    id: board.id, name: board.name, spaceId: board.spaceId, spaceName: spaceName(board.spaceId), updatedAt: board.updatedAt,
    cards: board.cards.map((c) => {
      const media = (file: string) => `quiver://app/board-media/${board.id}/${file}`;
      const extra = c.kind === 'text' ? { html: renderNote(c.text) } : c.kind === 'capture' ? { src: media(c.file) } : c.icon ? { iconSrc: media(c.icon) } : {};
      return { ...c, ...extra, label: cardLabel(c) };
    }),
  });
  handle('boards', 'boards:list', (e) => {
    const here = senderTab(e)?.spaceId ?? tabs.activeSpaceId;
    return {
      spaceId: here, spaceName: spaceName(here), privateSpace: tabs.isPrivate(here),
      boards: boards.list().filter((b) => tabs.spaces.some((sp) => sp.id === b.spaceId)).map((b) => ({ ...b, spaceName: spaceName(b.spaceId) })),
    };
  });
  handle('boards', 'boards:get', (_e, id: unknown) => {
    const board = boards.get(id);
    return board ? boardView(board) : null;
  });
  handle('boards', 'boards:create', (e, name: unknown) => {
    const spaceId = senderTab(e)?.spaceId ?? tabs.activeSpaceId;
    if (tabs.isPrivate(spaceId)) return null;
    return boards.create(spaceId, typeof name === 'string' ? name : '')?.id ?? null;
  });
  handle('boards', 'boards:rename', (_e, id: unknown, name: unknown) => boards.rename(id, name));
  handle('boards', 'boards:delete', (_e, id: unknown) => boards.delete(id));
  handle('boards', 'boards:add-note', (_e, id: unknown, at: unknown) => {
    const p = at && typeof at === 'object' ? at as Record<string, unknown> : null;
    const spot = p && typeof p.x === 'number' && typeof p.y === 'number' && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : undefined;
    const card = boards.add(id, { kind: 'text', text: '', at: spot });
    return typeof card === 'string' ? { error: card } : { id: card.id };
  });
  handle('boards', 'boards:update', (_e, id: unknown, cardId: unknown, patch: unknown) =>
    boards.update(id, cardId, patch && typeof patch === 'object' ? patch as Record<string, unknown> : {}));
  handle('boards', 'boards:reorder', (_e, id: unknown, cardId: unknown, index: unknown) => boards.reorder(id, cardId, index));
  handle('boards', 'boards:remove', (_e, id: unknown, cardId: unknown) => boards.remove(id, cardId));
  handle('boards', 'boards:open', (_e, id: unknown, cardId: unknown, url: unknown) => {
    // Only addresses that are on the card can be opened, and only in the board's Space.
    const found = boards.card(id, cardId);
    if (!found || !tabs.spaces.some((sp) => sp.id === found.board.spaceId)) return false;
    const allowed = cardUrls(found.card);
    const target = typeof url === 'string' ? url : allowed[0];
    if (!target || !allowed.includes(target)) return false;
    if (tabs.activeSpaceId !== found.board.spaceId) tabs.activateSpace(found.board.spaceId);
    tabs.openTab(target, { spaceId: found.board.spaceId });
    return true;
  });
  handle('boards', 'boards:export', async (_e, id: unknown) => {
    const board = boards.get(id);
    const html = board && boards.exportHtml(board.id);
    if (!board || !html) return { error: 'That board no longer exists.' };
    const base = board.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Board';
    const choice = await dialog.showSaveDialog({
      title: 'Export board', defaultPath: path.join(app.getPath('downloads'), `${base}.html`), filters: [{ name: 'Web page', extensions: ['html'] }],
    });
    if (choice.canceled || !choice.filePath) return { cancelled: true };
    try {
      await fs.promises.writeFile(choice.filePath, html, 'utf8');
      return { saved: path.basename(choice.filePath) };
    } catch {
      return { error: 'Quiver could not write that file.' };
    }
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
    if (typeof patch.rememberHistory === 'boolean') s.rememberHistory = patch.rememberHistory;
    if (typeof patch.askWhereToSave === 'boolean') s.askWhereToSave = patch.askWhereToSave;
    if (typeof patch.peekPinnedLinks === 'boolean') {
      s.peekPinnedLinks = patch.peekPinnedLinks;
      if (!s.peekPinnedLinks) tabs.closePeek();
    }
    if (typeof patch.peekShiftClick === 'boolean') s.peekShiftClick = patch.peekShiftClick;
    if (typeof patch.littleQuiver === 'boolean') s.littleQuiver = patch.littleQuiver;
    if (patch.archiveAfterHours !== undefined) s.archiveAfterHours = normalizeArchiveHours(patch.archiveAfterHours);
    if (patch.theme !== undefined) {
      s.theme = normalizeTheme(patch.theme);
      d.onThemeChanged();
    }
    if (patch.reduceMotion !== undefined) s.reduceMotion = normalizeMotion(patch.reduceMotion);
    if (patch.shortcuts !== undefined) {
      s.shortcuts = normalizeShortcutOverrides(patch.shortcuts) as Record<string, string>;
      setShortcutOverrides(s.shortcuts);
    }
    if (typeof patch.checkForUpdates === 'boolean' && patch.checkForUpdates !== s.checkForUpdates) {
      s.checkForUpdates = patch.checkForUpdates;
      // Turning the check on is the user's go-ahead to contact GitHub; check right away if a day has passed.
      if (s.checkForUpdates) void d.updates.maybeCheck().then(() => tabs.emit());
    }
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

  // shortcuts
  const shortcutRows = (): ShortcutRow[] => {
    const overrides = currentShortcutOverrides();
    return REBINDABLE.map((r) => {
      const bindings = effectiveBindings(r.action, overrides);
      return { action: r.action, label: r.label, bindings, keys: bindings.map(formatBinding), isDefault: overrides[r.action] === undefined, pageFirst: r.pageFirst };
    });
  };
  handle('settings', 'shortcuts:list', () => shortcutRows());
  handle('settings', 'shortcuts:set', (_e, action: unknown, raw: unknown) => {
    if (typeof action !== 'string' || !isRebindable(action)) return { error: 'Unknown action', rows: shortcutRows() };
    const binding = raw === '' ? '' : parseBinding(raw);
    if (binding === null) return { error: 'Use Ctrl or Alt with a key, or a function key (F1–F24)', rows: shortcutRows() };
    const overrides = { ...currentShortcutOverrides() };
    if (binding) {
      const problem = bindingProblem(action, binding, overrides);
      if (problem) return { error: problem, rows: shortcutRows() };
    }
    overrides[action] = binding;
    applySettings({ shortcuts: overrides as Record<string, string> });
    return { rows: shortcutRows() };
  });
  handle('settings', 'shortcuts:reset', (_e, action: unknown) => {
    const overrides = { ...currentShortcutOverrides() };
    if (action === undefined || action === null) applySettings({ shortcuts: {} });
    else if (typeof action === 'string' && isRebindable(action)) {
      delete overrides[action];
      applySettings({ shortcuts: overrides as Record<string, string> });
    }
    return shortcutRows();
  });
  handle('settings', 'shortcuts:recording', (e, on: unknown) => tabs.setRecordingKeys(e.sender, on === true));

  // opt-in update notice
  handle('settings', 'update:status', () => d.updates.status());
  handle('settings', 'update:check', async () => {
    const status = await d.updates.check();
    tabs.emit();
    return status;
  });
  handle('shell', 'update:open', () => {
    // Only the validated release page from the last check can be opened.
    const notice = d.updates.notice();
    if (notice) tabs.openTab(notice.url);
  });
  handle('shell', 'update:dismiss', () => {
    d.updates.dismiss();
    tabs.emit();
  });

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
  // other devices and tabs sent between them
  handle('settings', 'devices:list', () => d.sync.devices());
  handle('settings', 'devices:open-tab', (_e, deviceId: unknown, url: unknown) => openRemoteTab(deviceId, url));
  handle('settings', 'devices:continue', (_e, deviceId: unknown, spaceId: unknown) => continueHere(deviceId, spaceId));
  handle('shell', 'handoff:open', (_e, id: unknown) => {
    const handoff = typeof id === 'string' ? d.sync.takeHandoff(id) : undefined;
    // The address was validated when the sender's file was read; it opens in the Space you are in.
    if (handoff) tabs.openTab(handoff.url);
  });
  handle('shell', 'handoff:dismiss', (_e, id: unknown) => {
    if (typeof id === 'string') d.sync.takeHandoff(id);
  });

  // Camera / microphone decisions belong to the profile of the Space Settings is open in.
  const decisionsOf = (e: IpcMainInvokeEvent) => {
    const space = senderSpace(e);
    const partition = tabs.webPartition(space?.id ?? tabs.activeSpaceId);
    const profile = spaceProfile(space);
    const saved = profile === SHARED_PROFILE ? store.state.settings.sitePermissions
      : profile ? store.state.profilePermissions?.[profile] ?? {} : tabs.media?.savedFor(partition) ?? {};
    return { partition, saved };
  };
  handle('settings', 'sitepermissions:list', (e) => ({ ...decisionsOf(e).saved }));
  handle('settings', 'sitepermissions:forget', (e, origin: string) => {
    const { partition, saved } = decisionsOf(e);
    if (typeof origin === 'string' && Object.hasOwn(saved, origin)) tabs.media?.forget(origin, partition);
    return { ...decisionsOf(e).saved };
  });

  // History is kept per profile; private Spaces keep none.
  const historyProfile = (e: IpcMainInvokeEvent) => spaceProfile(senderSpace(e));
  handle('settings', 'history:clear', (e) => {
    const profile = historyProfile(e);
    if (profile) d.history.clear(profile);
    return profile ? d.history.list(profile).length : 0;
  });
  handle('settings', 'history:clear-all', () => {
    d.history.clearAll(separateProfiles(tabs.spaces));
    return 0;
  });
  handle('settings', 'history:count', (e) => {
    const profile = historyProfile(e);
    return profile ? d.history.list(profile).length : 0;
  });

  const arcImports = new ArcImports<WebFrameMain>(store.state, () => store.flush(), () => store.save(), {
    stage: (entries) => tabs.stageArcSpaces(entries),
    remove: (spaces) => tabs.removeArcSpaces(spaces),
  });
  let arcReview: { frame: WebFrameMain; token: string; release: () => void } | undefined;
  const cancelArcReview = (frame: WebFrameMain) => {
    arcImports.cancel(frame);
    if (arcReview?.frame === frame) {
      arcReview.release();
      arcReview = undefined;
    }
  };
  handle('settings', 'arc:preview', ({ sender, senderFrame }, raw: unknown) => {
    if (arcReview) cancelArcReview(arcReview.frame);
    const result = arcImports.preview(senderFrame, raw);
    if ('token' in result && result.token) {
      const cancel = () => cancelArcReview(senderFrame);
      const navigation = ({ isMainFrame, isSameDocument }: { isMainFrame: boolean; isSameDocument: boolean }) => {
        if (isMainFrame && !isSameDocument) cancel();
      };
      sender.on('did-start-navigation', navigation);
      sender.once('destroyed', cancel);
      sender.once('render-process-gone', cancel);
      arcReview = { frame: senderFrame, token: result.token, release: () => {
        sender.off('did-start-navigation', navigation);
        sender.off('destroyed', cancel);
        sender.off('render-process-gone', cancel);
      } };
    }
    return result;
  });
  handle('settings', 'arc:commit', ({ senderFrame }, token: unknown) => {
    const result = arcImports.commit(senderFrame, token);
    if (arcReview?.frame === senderFrame && arcReview.token === token) cancelArcReview(senderFrame);
    return result;
  });
  handle('settings', 'arc:cancel', ({ senderFrame }) => cancelArcReview(senderFrame));
  handle('settings', 'arc:status', () => arcImports.status());
  handle('settings', 'arc:undo', (_event, id: unknown) => arcImports.undo(id));

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
  handle('settings', 'bookmarks:list', (e): BookmarkLibraryView => {
    const bookmarks = bookmarksForProfile(store.state.bookmarks, readingProfile(senderSpace(e)));
    const elsewhere = bookmarksElsewhere(store.state.bookmarks, tabs.spaces);
    return { bookmarks, undo: imports.getUndo(), ...(elsewhere ? { elsewhere } : {}) };
  });
  handle('settings', 'bookmarks:profiles', () => discoverBookmarkProfiles(browserData));
  handle('settings', 'bookmarks:review-profile', async (event, browser: unknown, profile: unknown) => {
    const frame = event.senderFrame;
    const generation = beginBookmarkReview(event, frame);
    try {
      const source = bookmarkProfileLabel(browser, profile);
      if (!source) throw new BookmarkProfileReadError('The selected browser profile is no longer available.');
      const scan = await readChromiumBookmarkCandidates(browserData, browser, profile);
      return imports.finish(frame, generation, source, scan.candidates, scan.scanLimited, bookmarkOwner(event));
    } catch (error) {
      if (imports.isCurrent(frame, generation)) clearBookmarkReview(frame);
      return { error: error instanceof BookmarkProfileReadError ? error.message : 'Quiver could not read this browser profile.' };
    }
  });
  handle('settings', 'bookmarks:review-file', (event, name: unknown, input: unknown, scanLimited: unknown) => {
    const frame = event.senderFrame;
    const generation = beginBookmarkReview(event, frame);
    const file = typeof name === 'string' ? name.slice(0, 260).split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 120) : '';
    return imports.finish(frame, generation, file || 'HTML bookmark export', input, scanLimited === true, bookmarkOwner(event));
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
  handle('settings', 'bookmarks:open', (event, url: unknown) => {
    const space = senderSpace(event);
    const bookmark = bookmarksForProfile(store.state.bookmarks, readingProfile(space)).find((item) => item.url === url);
    if (bookmark) tabs.openTab(bookmark.url, space ? { spaceId: space.id } : {});
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
      id: command.id, mode, text: tooLong ? '' : prefill, maxInputLength: MAX_COMMAND_LENGTH, motion: store.state.settings.reduceMotion,
      message: tooLong ? 'This address is too long to edit here. Enter a shorter command.' : undefined,
    });
  }

  return { openCommandBar, toggleSidebar, applySettings };
}
