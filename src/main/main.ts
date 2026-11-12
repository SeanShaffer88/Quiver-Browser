import { app, BaseWindow, Menu, protocol, screen, session, WebContentsView, type Rectangle } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { INTERNAL_PARTITION, INTERNAL_SCHEME } from '../shared/constants';
import { Boosts } from './boosts';
import { DevServerWatcher } from './devservers';
import { registerIpc } from './ipc';
import type { ShortcutAction } from './shortcuts';
import { Store } from './store';
import { restrictInternalNavigation, TabManager } from './tabs';

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

function savedBounds(store: Store): Partial<Rectangle> & { width: number; height: number; maximized: boolean } {
  const b = store.state.bounds ?? { width: 1360, height: 860, maximized: false };
  if (b.x === undefined || b.y === undefined) return b;
  const visible = screen.getAllDisplays().some((d) => {
    const w = d.workArea;
    return b.x! < w.x + w.width - 80 && b.x! + b.width > w.x + 80 && b.y! >= w.y - 10 && b.y! < w.y + w.height - 80;
  });
  return visible ? b : { width: b.width, height: b.height, maximized: b.maximized };
}

async function main(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  await app.whenReady();
  Menu.setApplicationMenu(null);
  registerInternalProtocol();

  const store = new Store();
  const boosts = new Boosts();
  boosts.startWatching();

  const b = savedBounds(store);
  const win = new BaseWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    minWidth: 760,
    minHeight: 480,
    backgroundColor: '#14161a',
    title: 'Quiver',
    show: false,
  });
  if (b.maximized) win.maximize();

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
  tabs.restore();
  const extra = process.argv.slice(1).filter((a) => /^https?:\/\//i.test(a));
  for (const u of extra) tabs.openTab(u);
  tabs.layout();
  win.show();

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
    const maximized = win.isMaximized();
    const r = maximized ? (store.state.bounds ?? win.getNormalBounds()) : win.getBounds();
    store.state.bounds = { x: r.x, y: r.y, width: r.width, height: r.height, maximized };
    store.save();
  };
  win.on('resized', saveBounds);
  win.on('moved', saveBounds);
  win.on('maximize', saveBounds);
  win.on('unmaximize', saveBounds);

  win.on('close', () => {
    saveBounds();
    tabs.persist();
    store.flush();
    devWatcher.stop();
    boosts.stopWatching();
  });
  win.on('closed', () => {
    tabs.dispose();
    for (const view of [shell, overlay]) {
      if (!view.webContents.isDestroyed()) view.webContents.close();
    }
    app.quit();
  });

  app.on('second-instance', (_e, argv) => {
    if (win.isMinimized()) win.restore();
    win.focus();
    for (const u of argv.slice(1).filter((a) => /^https?:\/\//i.test(a))) tabs.openTab(u);
  });
  app.on('window-all-closed', () => app.quit());
}

main().catch((err) => {
  console.error('[quiver] fatal:', err);
  app.exit(1);
});
