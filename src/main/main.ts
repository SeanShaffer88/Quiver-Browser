import { app, BaseWindow, clipboard, crashReporter, dialog, desktopCapturer, Menu, nativeTheme, protocol, screen, session, WebContentsView, type Display, type Event } from 'electron';
import { app, BaseWindow, clipboard, net, crashReporter, dialog, desktopCapturer, Menu, protocol, screen, session, WebContentsView, type Display, type Event } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { INTERNAL_PARTITION, INTERNAL_SCHEME, SHARED_PARTITION } from '../shared/constants';
import type { Settings } from '../shared/types';
import { windowBackground } from '../shared/theme';
import { findArcSidebar } from './arc-import';
import { normalizeBookmarks } from './bookmarks';
import { Boosts, isValidBoostName } from './boosts';
import { configureSitePermissions } from './browser-policy';
import { DevServerWatcher } from './devservers';
import { History } from './history';
import { Downloads } from './downloads';
import { cleanUserAgent } from './browsing';
import { registerIpc } from './ipc';
import { meetingProvider } from './meetings';
import { MediaPermissions } from './site-permissions';
import { clearSessions, PrivacyController } from './privacy';
import { normalizeTopics, Research } from './research';
import { normalizeSyncState, SyncService } from './sync-service';
import os from 'node:os';
import { parseLaunchArgs } from './launch-args';
import { setShortcutOverrides, type ShortcutAction } from './shortcuts';
import { UpdateChecker } from './updates';
import { Store } from './store';
import { restrictInternalNavigation, TabManager } from './tabs';
import { placeWindow } from './window-placement';

function createPortableDirectory(parent: string, name: string): string {
  const directory = path.join(parent, name);
  let entry = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!entry) {
    try {
      fs.mkdirSync(directory);
    } catch (error) {
      // Another launch can create the directory before either process takes the instance lock.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    entry = fs.lstatSync(directory);
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`The portable ${name} path must be an ordinary directory.`);
  }
  if (path.relative(directory, fs.realpathSync.native(directory)) !== '') {
    throw new Error(`The portable ${name} directory points outside its expected path.`);
  }
  return directory;
}

function configurePortablePaths(root: string | undefined): string | undefined {
  if (!root) return undefined;
  if (!path.isAbsolute(root) || (process.platform === 'win32' && path.parse(root).root.length < 3)) {
    throw new Error('The portable profile requires a fully qualified package path.');
  }
  const data = createPortableDirectory(fs.realpathSync.native(root), 'Data');
  createPortableDirectory(data, 'Partitions');
  createPortableDirectory(data, 'boosts');
  const stateFile = path.join(data, 'quiver-state.json');
  const state = fs.lstatSync(stateFile, { throwIfNoEntry: false });
  if (state && (!state.isFile() || path.relative(stateFile, fs.realpathSync.native(stateFile)) !== '')) {
    throw new Error('The portable quiver-state.json path must be an ordinary file.');
  }
  const downloads = createPortableDirectory(data, 'Downloads');
  const paths = {
    userData: data,
    sessionData: data,
    userCache: createPortableDirectory(data, 'Cache'),
    temp: createPortableDirectory(data, 'Temp'),
    logs: createPortableDirectory(data, 'Logs'),
    crashDumps: createPortableDirectory(data, 'CrashDumps'),
    downloads,
  };
  for (const [name, directory] of Object.entries(paths)) app.setPath(name, directory);
  return downloads;
}

protocol.registerSchemesAsPrivileged([{ scheme: INTERNAL_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

const RENDERER_DIR = path.resolve(__dirname, '..', 'renderer');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

let registeredInternal = false;
function registerInternalProtocol(): void {
  if (registeredInternal) return;
  registeredInternal = true;
  const internal = session.fromPartition(INTERNAL_PARTITION);
  configureSitePermissions(internal, false);
  internal.protocol.handle(INTERNAL_SCHEME, async (req) => {
    try {
      const u = new URL(req.url);
      if (u.host !== 'app') return new Response('not found', { status: 404 });
      const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'newtab.html';
      const file = path.resolve(RENDERER_DIR, rel);
      if (!file.startsWith(RENDERER_DIR + path.sep)) return new Response('forbidden', { status: 403 });
      const data = await fs.promises.readFile(file);
      return new Response(data, { headers: { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' } });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}

function screenPlacement(saved: Parameters<typeof placeWindow>[0]) {
  return placeWindow(saved, screen.getAllDisplays().map(({ workArea }) => workArea), screen.getPrimaryDisplay().workArea);
}

async function main(): Promise<void> {
  // Set the portable paths before Electron initializes sessions or selects its instance lock.
  const portableDownloadPath = configurePortablePaths(process.env.PORTABLE_EXECUTABLE_DIR);
  if (!app.requestSingleInstanceLock({ argv: process.argv })) {
    app.quit();
    return;
  }
  if (portableDownloadPath && app.isPackaged) {
    // Crashpad can otherwise prefer an inherited location over Electron's configured path.
    process.env.BREAKPAD_DUMP_LOCATION = app.getPath('crashDumps');
    crashReporter.start({ uploadToServer: false });
  }
  type LaunchTargets = ReturnType<typeof parseLaunchArgs>;
  let handleSecondInstance: ((targets: LaunchTargets) => void) | undefined;
  const pendingLaunches: LaunchTargets[] = [];
  app.on('second-instance', (_event, argv, _workingDirectory, additionalData) => {
    // Electron can reorder its event's argv. Use the original argument order for the option delimiter.
    const forwarded = (additionalData as { argv?: unknown } | null)?.argv;
    const targets = Array.isArray(forwarded) && forwarded.every((argument) => typeof argument === 'string')
      ? parseLaunchArgs(forwarded)
      : { urls: parseLaunchArgs(argv).urls, importBookmarks: false };
    if (handleSecondInstance) handleSecondInstance(targets);
    else pendingLaunches.push(targets);
  });
  // Before any session exists, so every page and request sees the plain Chromium user agent.
  app.userAgentFallback = cleanUserAgent(app.userAgentFallback, app.getName());
  await app.whenReady();
  if (process.platform === 'win32') app.setAppUserModelId('dev.quiver.browser');
  Menu.setApplicationMenu(null);
  // Privacy settings must reach every session before anything (including the internal protocol) creates one.
  const store = new Store();
  setShortcutOverrides(store.state.settings.shortcuts);
  const privacy = new PrivacyController(() => store.state.settings.privacy, (options) => app.configureHostResolver(options));
  app.on('session-created', (ses) => privacy.configureSession(ses));
  app.on('web-contents-created', (_event, contents) => privacy.configureContents(contents));
  privacy.configureSession(session.defaultSession);
  privacy.apply();
  registerInternalProtocol();

  let clearedOnExit = false;
  app.on('will-quit', (event) => {
    if (clearedOnExit || !store.state.settings.privacy.clearOnExit) return;
    // Clear web Spaces only; Quiver's own pages and settings are kept.
    event.preventDefault();
    clearedOnExit = true;
    const partitions = [SHARED_PARTITION, ...store.state.spaces.filter((sp) => sp.isolated).map((sp) => `persist:quiver-space-${sp.id}`)];
    void clearSessions(partitions.map((partition) => session.fromPartition(partition))).finally(() => app.quit());
  });
  const boosts = new Boosts();
  boosts.startWatching();

  // themeSource drives prefers-color-scheme in every renderer (Quiver's pages and websites) as well as native
  // menus and dialogs, so the CSS only needs @media (prefers-color-scheme) and no page has to ask for the setting.
  nativeTheme.themeSource = store.state.settings.theme;
  const launchPlacement = screenPlacement(store.state.bounds);
  const win = new BaseWindow({
    ...launchPlacement.bounds,
    minWidth: launchPlacement.minWidth,
    minHeight: launchPlacement.minHeight,
    backgroundColor: windowBackground(nativeTheme.shouldUseDarkColors),
    title: 'Quiver',
    icon: process.platform === 'win32' ? path.join(RENDERER_DIR, 'quiver-icon.ico') : undefined,
    show: false,
  });
  if (launchPlacement.maximized) win.maximize();

  const prefs = (extra: Record<string, unknown> = {}) => ({
    partition: INTERNAL_PARTITION,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    preload: path.join(__dirname, '..', 'preload', 'internal.js'),
    ...extra,
  });
  const shell = new WebContentsView({ webPreferences: prefs() });
  const overlay = new WebContentsView({ webPreferences: prefs() });
  for (const [view, page] of [[shell, 'shell'], [overlay, 'commandbar']] as const) {
    restrictInternalNavigation(view.webContents, page);
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  }
  overlay.setBackgroundColor('#00000000');
  // The shell paints its own background. Transparent lets the page show through its content area while the
  // collapsed sidebar peeks over the page (TabManager.setSidebarPeek raises the shell above the tab views).
  shell.setBackgroundColor('#00000000');
  // Covers both the setting changing and Windows switching app mode while the setting is 'system'.
  nativeTheme.on('updated', () => {
    if (!win.isDestroyed()) win.setBackgroundColor(windowBackground(nativeTheme.shouldUseDarkColors));
  });
  win.contentView.addChildView(shell);
  win.contentView.addChildView(overlay);
  overlay.setVisible(false);

  let actions: ReturnType<typeof registerIpc> | null = null;
  const devWatcher = new DevServerWatcher((list) => tabs.setDevServers(list));

  const onShortcut = (a: ShortcutAction) => {
    switch (a) {
      case 'command-new':
        actions?.openCommandBar('', 'new');
        break;
      case 'command':
        actions?.openCommandBar(undefined, 'current');
        break;
      case 'close-tab':
        // Ctrl+W in a Peek puts the Peek away rather than closing the pinned tab behind it.
        if (tabs.peekOpen) tabs.closePeek();
        else if (tabs.activeTabId !== null) tabs.closeTab(tabs.activeTabId);
        break;
      case 'split':
        tabs.startSplit();
        break;
      case 'unsplit':
        tabs.exitSplit();
        break;
      case 'reopen-tab':
        tabs.reopenClosedTab();
        break;
      case 'reload':
        tabs.reload();
        break;
      case 'toggle-sidebar':
        actions?.toggleSidebar();
        break;
      case 'preview':
        tabs.setPreview(!tabs.preview);
        break;
      case 'env':
        tabs.switchEnvironment();
        break;
      case 'next-tab':
        tabs.cycleTab(1);
        break;
      case 'recent-tab':
        tabs.cycleRecent(1);
        break;
      case 'recent-tab-back':
        tabs.cycleRecent(-1);
        break;
      case 'copy-link':
      case 'copy-markdown-link': {
        const link = tabs.activeLink(a === 'copy-markdown-link');
        if (link) clipboard.writeText(link);
        break;
      }
      case 'console':
        if (tabs.activeTabId !== null) tabs.openConsole(tabs.activeTabId);
        break;
      case 'next-space':
        tabs.cycleSpace(1);
        break;
      case 'prev-space':
        tabs.cycleSpace(-1);
        break;
      case 'prev-tab':
        tabs.cycleTab(-1);
        break;
      case 'move-tab-up':
        tabs.shiftActiveTab(-1);
        break;
      case 'move-tab-down':
        tabs.shiftActiveTab(1);
        break;
      case 'back':
        tabs.goBack();
        break;
      case 'forward':
        tabs.goForward();
        break;
      case 'devtools':
        tabs.toggleDevTools();
        break;
      case 'boosts':
        tabs.navigate('quiver://boosts');
        break;
      case 'downloads':
        tabs.navigate('quiver://downloads');
        break;
      case 'find':
        tabs.find(null);
        break;
      case 'find-next':
      case 'find-prev':
        tabs.find(null, a === 'find-next');
        break;
      case 'zoom-in':
        tabs.zoom(1);
        break;
      case 'zoom-out':
        tabs.zoom(-1);
        break;
      case 'zoom-reset':
        tabs.zoom(0);
        break;
      default: {
        const m = a.match(/^tab-(\d)$/);
        if (m) tabs.tabByIndex(Number(m[1]));
        const sp = a.match(/^space-(\d)$/);
        if (sp) tabs.spaceByIndex(Number(sp[1]));
      }
    }
  };

  const tabs: TabManager = new TabManager(
    win,
    shell,
    overlay,
    store,
    boosts,
    (state) => {
      if (!shell.webContents.isDestroyed()) shell.webContents.send('state', state);
    },
    onShortcut,
    portableDownloadPath,
  );
  tabs.attachShortcuts(shell.webContents);
  tabs.media = new MediaPermissions(
    () => store.state.settings.sitePermissions,
    (origin, decision) => {
      if (decision) store.state.settings.sitePermissions[origin] = decision;
      else delete store.state.settings.sitePermissions[origin];
      store.save();
    },
    () => tabs.emit(),
    (url) => meetingProvider(url) !== undefined,
  );
  tabs.pickScreen = async () => {
    // A native menu keeps the choice in Quiver's own UI, out of reach of the requesting page.
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
    if (!sources.length || win.isDestroyed()) return null;
    return new Promise((resolve) => {
      let chosen: Electron.DesktopCapturerSource | null = null;
      const screens = sources.filter((s) => s.id.startsWith('screen:'));
      const windows = sources.filter((s) => !s.id.startsWith('screen:'));
      const item = (s: Electron.DesktopCapturerSource) => ({ label: s.name.slice(0, 80) || 'Untitled', click: () => { chosen = s; } });
      const menu = Menu.buildFromTemplate([
        { label: 'Share your screen', enabled: false },
        ...screens.map(item),
        ...(windows.length ? [{ type: 'separator' as const }, { label: 'Share a window', enabled: false }, ...windows.slice(0, 30).map(item)] : []),
        { type: 'separator' },
        { label: 'Cancel' },
      ]);
      // Electron can report the menu closed before its click handler runs, so settle on the next turn.
      menu.on('menu-will-close', () => setTimeout(() => resolve(chosen), 0));
      menu.popup({ window: win });
    });
  };
  const downloads = new Downloads(store.state.downloads, {
    directory: () => portableDownloadPath ?? app.getPath('downloads'),
    askWhereToSave: () => store.state.settings.askWhereToSave,
    fromPartition: (partition) => session.fromPartition(partition),
    persist: (records) => {
      store.state.downloads = records;
      store.save();
    },
    changed: () => {
      tabs.emit();
      for (const tab of tabs.tabs.values()) {
        if (tab.internalPage === 'downloads' && !tab.view.webContents.isDestroyed()) tab.view.webContents.send('downloads:changed');
      }
    },
  });
  tabs.downloads = downloads;
  tabs.onFtpLink = (url, partition) => {
    // A page can navigate to ftp:// on its own, so the person confirms before anything downloads.
    const shown = url.replace(/\/\/[^/@]*@/, '//');
    void dialog.showMessageBox(win, {
      type: 'question', buttons: ['Download', 'Cancel'], defaultId: 0, cancelId: 1, noLink: true,
      message: 'Download this file over FTP?', detail: shown,
    }).then(({ response }) => { if (response === 0) downloads.startNative('ftp', url, partition); });
  };

  const research = new Research(store.state, () => store.save(), () => {
    tabs.emit();
    for (const tab of tabs.tabs.values()) {
      if (tab.internalPage === 'research' && !tab.view.webContents.isDestroyed()) tab.view.webContents.send('research:changed');
    }
  });
  research.prune(new Set(tabs.spaces.map(({ id }) => id)));
  const history = new History(path.join(app.getPath('userData'), 'history.json'), () => store.state.settings.rememberHistory);
  tabs.onVisit = (spaceId, url, title, kind) => {
    research.recordPage(spaceId, url, title);
    if (kind === 'title') history.title(url, title);
    else history.visit(url, title);
  };
  tabs.researchStatus = (spaceId) => {
    const topic = research.active(spaceId);
    return topic && { id: topic.id, name: topic.name, count: topic.items.length };
  };
  const MAX_SYNCED_BOOST = 256 * 1024;
  const sync = new SyncService(store.state.sync ??= normalizeSyncState(undefined, os.hostname()), {
    settings: {
      get: () => ({ envGroups: store.state.settings.envGroups, searchEngine: store.state.settings.searchEngine, devServerScan: store.state.settings.devServerScan }),
      set: (data) => actions?.applySettings((data && typeof data === 'object' ? data : {}) as Partial<Settings>),
    },
    bookmarks: {
      get: () => store.state.bookmarks,
      set: (data) => {
        store.state.bookmarks = normalizeBookmarks(data);
        delete store.state.bookmarkUndo;
        store.save();
      },
    },
    spaces: { get: () => tabs.syncedSpaces(), set: (data) => tabs.applySyncedSpaces(data) },
    research: {
      get: () => research.all(),
      set: (data) => research.replaceAll(normalizeTopics(data, new Set(tabs.spaces.map(({ id }) => id)))),
    },
    boosts: {
      get: () => Object.fromEntries(boosts.list().map(({ name }) => [name, boosts.read(name)])),
      set: (data) => {
        // Boosts run in every matching page, so only well-formed files are accepted and sync of them is opt-in.
        const files = data && typeof data === 'object' ? Object.entries(data as Record<string, unknown>) : [];
        const wanted = new Map(files.filter(([name, content]) => isValidBoostName(name) && typeof content === 'string' && content.length <= MAX_SYNCED_BOOST) as [string, string][]);
        for (const { name } of boosts.list()) if (!wanted.has(name)) boosts.remove(name);
        for (const [name, content] of wanted) if (boosts.readIfExists(name) !== content) boosts.save(name, content);
      },
    },
  }, () => store.save(), () => {
    for (const tab of tabs.tabs.values()) {
      if (tab.internalPage === 'settings' && !tab.view.webContents.isDestroyed()) tab.view.webContents.send('sync:changed');
    }
  });
  const updates = new UpdateChecker(
    () => store.state.updates ?? { lastCheckedAt: 0 },
    (next) => {
      store.state.updates = next;
      store.save();
    },
    () => store.state.settings.checkForUpdates,
    app.getVersion(),
    // Chromium's network stack, so the system proxy applies; the release check is the only request Quiver makes itself.
    (url, init) => net.fetch(url, init),
  );
  tabs.updateNotice = () => updates.notice();
  actions = registerIpc({
    tabs, store, boosts, devWatcher, overlay, shell, research, sync, history, downloads, updates,
    onPrivacyChanged: () => privacy.apply(),
    onThemeChanged: () => { nativeTheme.themeSource = store.state.settings.theme; },
    runCommand: (command) => (command === 'settings' ? void tabs.navigate('quiver://settings') : onShortcut(command)),
  });

  await Promise.all([shell.webContents.loadURL('quiver://app/shell.html'), overlay.webContents.loadURL('quiver://app/commandbar.html')]);
  const interrupted = store.state.sessionOpen === true;
  const restored = tabs.restore();
  // Offer the Arc import once, on the first launch of this profile, when Arc for Windows has a sidebar to bring over.
  if (store.firstRun && findArcSidebar(process.env.LOCALAPPDATA ?? '')) store.state.arcImportOffer = 'pending';
  tabs.arcImportOffer = store.state.arcImportOffer === 'pending';
  if (interrupted && restored.tabs > 0) tabs.showSessionRecovery(restored);
  if (launchPlacement.relocated) tabs.showWindowRecovery();
  store.state.bounds = { ...launchPlacement.bounds, maximized: launchPlacement.maximized };
  store.state.sessionOpen = true;
  store.flush();
  const openLaunchTargets = ({ urls, importBookmarks }: LaunchTargets) => {
    for (const url of urls) tabs.openTab(url);
    if (importBookmarks) tabs.navigate('quiver://settings?import=bookmarks');
  };
  openLaunchTargets(parseLaunchArgs(process.argv));
  sync.start();
  // Archive unused temporary tabs shortly after launch and then every few minutes.
  setTimeout(() => tabs.archiveStale(), 60_000).unref();
  setInterval(() => tabs.archiveStale(), 5 * 60_000).unref();
  // Opt-in release check: does nothing unless enabled in Settings, and then at most once a day.
  const checkForUpdates = () => void updates.maybeCheck().then((status) => status && tabs.emit());
  setTimeout(checkForUpdates, 30_000).unref();
  setInterval(checkForUpdates, 60 * 60_000).unref();
  tabs.layout();
  win.show();
  handleSecondInstance = (targets) => {
    if (win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    openLaunchTargets(targets);
  };
  for (const targets of pendingLaunches) handleSecondInstance(targets);
  pendingLaunches.length = 0;

  if (store.state.settings.devServerScan) devWatcher.start();

  win.on('resize', () => tabs.syncPhone());
  win.on('maximize', () => tabs.layout());
  win.on('unmaximize', () => tabs.layout());
  win.on('enter-full-screen', () => tabs.layout());
  win.on('leave-full-screen', () => tabs.layout());
  // No work while the window is in the background.
  win.on('blur', () => devWatcher.stop());
  win.on('focus', () => {
    if (store.state.settings.devServerScan) devWatcher.start();
  });
  win.on('minimize', () => devWatcher.stop());

  const saveBounds = () => {
    const r = win.getNormalBounds();
    const maximized = win.isMinimized() ? store.state.bounds?.maximized === true : win.isMaximized();
    store.state.bounds = { ...r, maximized };
    store.save();
  };
  win.on('resized', saveBounds);
  win.on('moved', saveBounds);
  win.on('maximize', saveBounds);
  win.on('unmaximize', saveBounds);

  let repairingPlacement = false;
  const repairPlacement = () => {
    if (repairingPlacement || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    const normal = win.getNormalBounds();
    const fitted = screenPlacement(normal);
    const maximized = win.isMaximized();
    // Let Windows keep a visible maximized window in place. Repair its normal bounds on unmaximize.
    if (maximized && !screenPlacement(win.getBounds()).relocated) return;
    repairingPlacement = true;
    try {
      if (maximized) win.unmaximize();
      const [minWidth, minHeight] = win.getMinimumSize();
      if (minWidth !== fitted.minWidth || minHeight !== fitted.minHeight) win.setMinimumSize(fitted.minWidth, fitted.minHeight);
      const { x, y, width, height } = fitted.bounds;
      if (x !== normal.x || y !== normal.y || width !== normal.width || height !== normal.height) win.setBounds(fitted.bounds);
      if (maximized) win.maximize();
      if (fitted.relocated) tabs.showWindowRecovery();
      saveBounds();
    } finally {
      repairingPlacement = false;
    }
  };
  const onDisplayMetrics = (_event: Event, display: Display, changedMetrics: string[]) => {
    if (win.isDestroyed() || !changedMetrics.some((metric) => ['bounds', 'workArea', 'scaleFactor', 'rotation'].includes(metric))) return;
    const normal = win.getNormalBounds();
    if (screen.getDisplayMatching(normal).id === display.id || screenPlacement(normal).relocated) repairPlacement();
  };
  screen.on('display-removed', repairPlacement);
  screen.on('display-metrics-changed', onDisplayMetrics);
  win.on('restore', repairPlacement);
  win.on('unmaximize', repairPlacement);
  win.on('leave-full-screen', repairPlacement);

  win.on('close', () => {
    saveBounds();
    tabs.persist();
    store.state.sessionOpen = false;
    store.flush();
    history.flush();
    devWatcher.stop();
    boosts.stopWatching();
  });
  win.on('closed', () => {
    screen.removeListener('display-removed', repairPlacement);
    screen.removeListener('display-metrics-changed', onDisplayMetrics);
    tabs.dispose();
    for (const view of [shell, overlay]) {
      if (!view.webContents.isDestroyed()) view.webContents.close();
    }
    app.quit();
  });

  app.on('window-all-closed', () => app.quit());
}

main().catch((err) => {
  console.error('[quiver] fatal:', err);
  app.exit(1);
});
