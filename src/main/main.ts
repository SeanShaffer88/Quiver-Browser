import { app, BaseWindow, Menu, protocol, screen, session, WebContentsView, type Display, type Event } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { INTERNAL_PARTITION, INTERNAL_SCHEME } from '../shared/constants';
import { Boosts } from './boosts';
import { DevServerWatcher } from './devservers';
import { registerIpc } from './ipc';
import { parseLaunchArgs } from './launch-args';
import type { ShortcutAction } from './shortcuts';
import { Store } from './store';
import { restrictInternalNavigation, TabManager } from './tabs';
import { placeWindow } from './window-placement';

// Portable build: keep every byte next to the executable (data\), never in %APPDATA%.
if (process.env.PORTABLE_EXECUTABLE_DIR) {
  app.setPath('userData', path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'data'));
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
  session.fromPartition(INTERNAL_PARTITION).protocol.handle(INTERNAL_SCHEME, async (req) => {
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
  if (!app.requestSingleInstanceLock({ argv: process.argv })) {
    app.quit();
    return;
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
  await app.whenReady();
  if (process.platform === 'win32') app.setAppUserModelId('dev.quiver.browser');
  Menu.setApplicationMenu(null);
  registerInternalProtocol();

  const store = new Store();
  const boosts = new Boosts();
  boosts.startWatching();

  const launchPlacement = screenPlacement(store.state.bounds);
  const win = new BaseWindow({
    ...launchPlacement.bounds,
    minWidth: launchPlacement.minWidth,
    minHeight: launchPlacement.minHeight,
    backgroundColor: '#14161a',
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
  for (const view of [shell, overlay]) {
    restrictInternalNavigation(view.webContents);
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  }
  overlay.setBackgroundColor('#00000000');
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
        if (tabs.activeTabId !== null) tabs.closeTab(tabs.activeTabId);
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
      case 'prev-tab':
        tabs.cycleTab(-1);
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
      default: {
        const m = a.match(/^tab-(\d)$/);
        if (m) tabs.tabByIndex(Number(m[1]));
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
    registerInternalProtocol,
  );
  tabs.attachShortcuts(shell.webContents);

  actions = registerIpc({ tabs, store, boosts, devWatcher, overlay, shell });

  await Promise.all([shell.webContents.loadURL('quiver://app/shell.html'), overlay.webContents.loadURL('quiver://app/commandbar.html')]);
  const interrupted = store.state.sessionOpen === true;
  const restored = tabs.restore();
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

  win.on('resize', () => tabs.layout());
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
