import { BaseWindow, clipboard, nativeTheme, screen, WebContentsView, type WebContents } from 'electron';
import { windowBackground } from '../shared/theme';
import type { LittleQuiverState } from '../shared/types';
import { LITTLE_MIN_SIZE, LITTLE_TOOLBAR_H, littleBounds, littleHeading, normalizeLittleSize } from './little-quiver-layout';
import { shortcutFor } from './shortcuts';
import type { Store } from './store';
import { restrictInternalNavigation, type TabManager } from './tabs';

interface LittleWindow {
  win: BaseWindow;
  toolbar: WebContentsView;
  page: WebContentsView;
  spaceId: string;
  partition: string;
  /** Opened while a private Space was active: never recorded in history, even if that Space is gone later. */
  private: boolean;
  url: string;
  /** Set once the page has moved into the main window, so closing this window leaves it alone. */
  adopted: boolean;
  fullscreen: boolean;
  /** The state last sent to the toolbar, so unchanged state is not sent again. */
  sent: string;
  /** Removes the listeners that only make sense while the page is in this window. */
  detach: () => void;
}

export interface LittleQuiverDeps {
  tabs: TabManager;
  store: Store;
  mainWindow: BaseWindow;
  /** webPreferences for Quiver's own pages (the toolbar). */
  internalPrefs: () => Electron.WebPreferences;
  icon?: string;
  /** Called after the set of open windows changes (the command bar offers "Open in Quiver" while any is open). */
  changed?: () => void;
}

/**
 * Little Quiver: a link another app opens (Quiver as the default browser) shows in a small window of its own with a
 * compact toolbar, instead of adding a tab to the main window. "Open in Quiver" moves the live page into the active
 * Space as a tab. Each window uses the storage partition of the Space that was active when it opened.
 */
export class LittleQuiver {
  private readonly windows = new Set<LittleWindow>();
  /** Most recently focused first, for the command bar's "Open in Quiver". */
  private recent: LittleWindow[] = [];

  constructor(private readonly d: LittleQuiverDeps) {}

  get count(): number {
    return this.windows.size;
  }

  /** The window whose toolbar is this webContents (IPC sender check). */
  fromToolbar(sender: WebContents): LittleWindow | undefined {
    for (const lw of this.windows) if (lw.toolbar.webContents === sender) return lw;
    return undefined;
  }

  isToolbar(sender: WebContents): boolean {
    return this.fromToolbar(sender) !== undefined;
  }

  open(url: string): void {
    const { tabs, store } = this.d;
    const external = tabs.createExternalView();
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const bounds = littleBounds(normalizeLittleSize(store.state.littleQuiverSize), display.workArea, this.windows.size);
    const win = new BaseWindow({
      ...bounds,
      minWidth: LITTLE_MIN_SIZE.width,
      minHeight: LITTLE_MIN_SIZE.height,
      backgroundColor: windowBackground(nativeTheme.shouldUseDarkColors),
      title: 'Little Quiver',
      icon: this.d.icon,
      show: false,
    });
    const toolbar = new WebContentsView({ webPreferences: this.d.internalPrefs() });
    restrictInternalNavigation(toolbar.webContents, 'little');
    toolbar.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const page = external.view;
    win.contentView.addChildView(page);
    win.contentView.addChildView(toolbar);
    const lw: LittleWindow = {
      win, toolbar, page, spaceId: external.spaceId, partition: external.partition, private: external.private, url,
      adopted: false, fullscreen: false, sent: '', detach: () => {},
    };
    this.windows.add(lw);
    this.recent.unshift(lw);
    this.wire(lw);
    this.layout(lw);
    win.on('resize', () => this.layout(lw));
    win.on('resized', () => {
      if (win.isDestroyed() || win.isMaximized() || win.isFullScreen()) return;
      const [width, height] = win.getSize();
      const size = normalizeLittleSize({ width, height });
      if (size) {
        store.state.littleQuiverSize = size;
        store.save();
      }
    });
    win.on('focus', () => {
      this.recent = [lw, ...this.recent.filter((other) => other !== lw)];
    });
    win.on('closed', () => this.disposeWindow(lw));
    void toolbar.webContents.loadURL('quiver://app/little.html').catch(() => undefined);
    void page.webContents.loadURL(url).catch(() => undefined);
    win.show();
    win.focus();
    page.webContents.focus();
    this.d.changed?.();
  }

  private layout(lw: LittleWindow): void {
    if (lw.win.isDestroyed()) return;
    const [width, height] = lw.win.getContentSize();
    // HTML fullscreen (a video) gives the page the whole window.
    const top = lw.fullscreen ? 0 : LITTLE_TOOLBAR_H;
    lw.toolbar.setVisible(!lw.fullscreen);
    lw.toolbar.setBounds({ x: 0, y: 0, width, height: LITTLE_TOOLBAR_H });
    if (!lw.adopted) lw.page.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
  }

  private wire(lw: LittleWindow): void {
    const wc = lw.page.webContents;
    const onKey = (event: Electron.Event, input: Electron.Input) => {
      if (input.type !== 'keyDown') return;
      const plain = !input.control && !input.alt && !input.meta && !input.shift;
      // Esc first leaves a page's fullscreen video, as in any browser; otherwise it puts the little window away.
      if (input.key === 'Escape' && plain) {
        if (lw.fullscreen) return;
        event.preventDefault();
        this.close(lw);
        return;
      }
      if ((input.control || input.meta) && !input.alt && !input.shift && input.code === 'KeyO') {
        event.preventDefault();
        this.openInQuiver(lw);
        return;
      }
      const action = shortcutFor(input);
      if (!action) return;
      // Only the keys that make sense for a single page; the rest (tabs, Spaces, sidebar) stay with the page.
      const handled = this.runShortcut(lw, action);
      if (handled) event.preventDefault();
    };
    const onChange = () => this.push(lw);
    const onFullscreen = (on: boolean) => () => {
      lw.fullscreen = on;
      this.layout(lw);
    };
    const enter = onFullscreen(true);
    const leave = onFullscreen(false);
    const visit = () => {
      if (lw.private || wc.isDestroyed()) return;
      const url = wc.getURL();
      if (/^https?:\/\//i.test(url)) this.d.tabs.onVisit?.(lw.spaceId, url, '', 'navigate');
    };
    const onNavigate = () => {
      visit();
      onChange();
    };
    const onTitle = (_event: Electron.Event, title: string, explicitSet: boolean) => {
      if (!lw.private && explicitSet && !wc.isDestroyed() && /^https?:\/\//i.test(wc.getURL())) this.d.tabs.onVisit?.(lw.spaceId, wc.getURL(), title, 'title');
      onChange();
    };
    const onGone = () => this.push(lw);
    wc.on('before-input-event', onKey);
    lw.toolbar.webContents.on('before-input-event', onKey);
    wc.on('page-title-updated', onTitle);
    wc.on('did-navigate', onNavigate);
    wc.on('did-navigate-in-page', onChange);
    wc.on('did-start-loading', onChange);
    wc.on('did-stop-loading', onChange);
    wc.on('enter-html-full-screen', enter);
    wc.on('leave-html-full-screen', leave);
    wc.on('render-process-gone', onGone);
    // A link that asks for a new tab or window opens right here: the little window stays one quick look.
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url) && URL.canParse(url)) void wc.loadURL(url).catch(() => undefined);
      return { action: 'deny' };
    });
    lw.detach = () => {
      wc.removeListener('before-input-event', onKey);
      wc.removeListener('page-title-updated', onTitle);
      wc.removeListener('did-navigate', onNavigate);
      wc.removeListener('did-navigate-in-page', onChange);
      wc.removeListener('did-start-loading', onChange);
      wc.removeListener('did-stop-loading', onChange);
      wc.removeListener('enter-html-full-screen', enter);
      wc.removeListener('leave-html-full-screen', leave);
      wc.removeListener('render-process-gone', onGone);
    };
  }

  private runShortcut(lw: LittleWindow, action: string): boolean {
    const wc = lw.page.webContents;
    if (wc.isDestroyed()) return false;
    switch (action) {
      case 'close-tab':
        this.close(lw);
        return true;
      case 'reload':
        wc.reload();
        return true;
      case 'back':
        if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
        return true;
      case 'forward':
        if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
        return true;
      case 'devtools':
        wc.toggleDevTools();
        return true;
      case 'copy-link':
        this.copyLink(lw);
        return true;
      default:
        return false;
    }
  }

  state(lw: LittleWindow): LittleQuiverState {
    const wc = lw.page.webContents;
    const url = wc.isDestroyed() ? lw.url : wc.getURL() || lw.url;
    const heading = littleHeading(url, wc.isDestroyed() ? '' : wc.getTitle());
    return { ...heading, url, loading: !wc.isDestroyed() && wc.isLoading(), space: this.d.tabs.spaces.find((sp) => sp.id === this.d.tabs.activeSpaceId)?.name ?? '' };
  }

  private push(lw: LittleWindow): void {
    if (lw.win.isDestroyed()) return;
    const state = this.state(lw);
    const sent = JSON.stringify(state);
    if (sent === lw.sent) return;
    lw.sent = sent;
    lw.win.setTitle(`${state.title} - Little Quiver`);
    if (!lw.toolbar.webContents.isDestroyed()) lw.toolbar.webContents.send('little:state', state);
  }

  /** Refresh every toolbar (the active Space's name is shown on "Open in Quiver"). */
  refresh(): void {
    for (const lw of this.windows) this.push(lw);
  }

  copyLink(lw: LittleWindow): string {
    const { url } = this.state(lw);
    if (/^https?:\/\//i.test(url)) clipboard.writeText(url);
    return url;
  }

  close(lw: LittleWindow): void {
    if (!lw.win.isDestroyed()) lw.win.close();
  }

  /** "Open in Quiver" from the command bar: the little window used most recently. */
  openMostRecentInQuiver(): boolean {
    const lw = this.recent.find((w) => this.windows.has(w));
    if (!lw) return false;
    this.openInQuiver(lw);
    return true;
  }

  /** Move the page into the active Space as a tab, keeping its state where the storage partition allows. */
  openInQuiver(lw: LittleWindow): void {
    if (lw.adopted || !this.windows.has(lw)) return;
    const main = this.d.mainWindow;
    if (main.isDestroyed()) return;
    lw.adopted = true;
    lw.detach();
    if (!lw.win.isDestroyed()) lw.win.contentView.removeChildView(lw.page);
    const kept = this.d.tabs.adoptExternalView(lw.page, lw.partition, lw.url);
    if (!kept) lw.adopted = false;
    if (main.isMinimized()) main.restore();
    main.show();
    // openTab activated the new tab, which focuses its page.
    main.focus();
    this.close(lw);
  }

  private disposeWindow(lw: LittleWindow): void {
    if (!this.windows.delete(lw)) return;
    this.recent = this.recent.filter((other) => other !== lw);
    if (!lw.adopted) {
      lw.detach();
      if (!lw.page.webContents.isDestroyed()) lw.page.webContents.close();
    }
    if (!lw.toolbar.webContents.isDestroyed()) lw.toolbar.webContents.close();
    this.d.changed?.();
  }

  closeAll(): void {
    for (const lw of [...this.windows]) {
      this.close(lw);
      this.disposeWindow(lw);
    }
  }
}
