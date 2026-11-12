import { BaseWindow, WebContentsView, session, type Rectangle, type WebContents } from 'electron';
import path from 'node:path';
import {
  INTERNAL_ORIGIN,
  INTERNAL_PARTITION,
  MOBILE_UA,
  PHONE_LABEL_H,
  PHONE_MARGIN,
  PHONE_W,
  SHARED_PARTITION,
  SIDEBAR_COLLAPSED_W,
  SIDEBAR_W,
  TOOLBAR_H,
} from '../shared/constants';
import { badgeFor, isLocalHost, switchEnv } from '../shared/env';
import type { DevServer, EnvBadge, ShellState, Space, TabInfo } from '../shared/types';
import { boostKind, boostMatchesHost, transpileBoost, wrapScript, type Boosts } from './boosts';
import { shortcutFor, type ShortcutAction } from './shortcuts';
import type { Store } from './store';

interface Tab {
  id: number;
  spaceId: string;
  partition: string;
  view: WebContentsView;
  internal: boolean;
  pendingUrl: string | null;
  errorFor: string | null;
  title: string;
  favicon: string;
  loading: boolean;
  errors: number;
  navigation: number;
  cssKeys: Map<string, string>;
}

const PRELOAD = path.join(__dirname, '..', 'preload', 'internal.js');
const ERR_PREFIX = 'data:text/html;charset=utf-8,%3C!--quiver-error--%3E';
const SPACE_COLORS = ['#5b8cff', '#ff7a59', '#3ecf8e', '#f5b73b', '#b57bff', '#ff5d8f', '#2cc5d9'];

export function toInternalUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.host === 'app') return url;
    return `quiver://app/${u.host || 'newtab'}.html${u.search}`;
  } catch {
    return 'quiver://app/newtab.html';
  }
}

export function displayUrl(url: string): string {
  if (url.startsWith('quiver://app/')) {
    const u = new URL(url);
    const page = u.pathname.replace(/^\//, '').replace(/\.html$/, '');
    return page === 'newtab' ? '' : `quiver://${page}${u.search}`;
  }
  return url;
}

function errorPage(url: string, desc: string): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
  const html = `<!--quiver-error--><!doctype html><meta charset="utf-8"><title>Cannot reach page</title><body style="margin:0;background:#14161a;color:#d7dae0;font:15px system-ui,sans-serif;display:grid;place-items:center;height:100vh"><div style="max-width:560px;padding:24px"><h2 style="margin:0 0 8px;font-weight:600">This page can’t be reached</h2><p style="margin:0 0 6px;color:#9aa1ad;word-break:break-all">${esc(url)}</p><p style="margin:0;color:#ff7a59">${esc(desc)}</p><p style="margin-top:18px;color:#9aa1ad">Press Ctrl+R to retry.</p></div></body>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html).replace(/^%3C!--quiver-error--%3E/, '%3C!--quiver-error--%3E');
}

export function restrictInternalNavigation(wc: WebContents): void {
  const guard = (event: { url: string; isMainFrame: boolean; preventDefault(): void }) => {
    if (!event.isMainFrame || !event.url.startsWith(INTERNAL_ORIGIN)) event.preventDefault();
  };
  wc.on('will-frame-navigate', guard);
  wc.on('will-redirect', guard);
}

export class TabManager {
  readonly tabs = new Map<number, Tab>();
  private nextId = 1;
  activeTabId: number | null = null;
  private lastActive: Record<string, number> = {};
  preview = false;
  devServers: DevServer[] = [];

  private phone: WebContentsView | null = null;
  private phonePartition = '';
  private phoneUrl = '';
  private phoneReady = false;
  private phoneEmulated = false;
  private readonly preparedPartitions = new Set<string>();
  private emitTimer: NodeJS.Timeout | null = null;
  private overlayOpen = false;

  constructor(
    private readonly win: BaseWindow,
    private readonly shell: WebContentsView,
    private readonly overlay: WebContentsView,
    private readonly store: Store,
    private readonly boosts: Boosts,
    private readonly onState: (s: ShellState) => void,
    private readonly onShortcut: (a: ShortcutAction) => void,
    private readonly prepareInternalSession: (partition: string) => void,
  ) {
    boosts.onChange((name, kind, removed) => void this.onBoostChanged(name, kind, removed));
  }

  // ───────── state ─────────
  get spaces(): Space[] {
    return this.store.state.spaces;
  }
  get activeSpaceId(): string {
    return this.store.state.activeSpaceId;
  }
  get settings() {
    return this.store.state.settings;
  }

  get activeTab(): Tab | null {
    return this.activeTabId === null ? null : (this.tabs.get(this.activeTabId) ?? null);
  }

  tabUrl(t: Tab): string {
    if (t.errorFor) return t.errorFor;
    if (t.pendingUrl) return t.pendingUrl;
    const u = t.view.webContents.isDestroyed() ? '' : t.view.webContents.getURL();
    return u;
  }

  private info(t: Tab): TabInfo {
    const wc = t.view.webContents;
    const url = this.tabUrl(t);
    let local = false;
    try {
      const u = new URL(url);
      local = (u.protocol === 'http:' || u.protocol === 'https:') && isLocalHost(u.hostname);
    } catch {
      /* ignore */
    }
    const nav = wc.isDestroyed() ? null : wc.navigationHistory;
    return {
      id: t.id,
      spaceId: t.spaceId,
      url: displayUrl(url),
      title: t.title || displayUrl(url) || 'New Tab',
      favicon: t.favicon,
      loading: t.loading,
      canGoBack: nav ? nav.canGoBack() : false,
      canGoForward: nav ? nav.canGoForward() : false,
      errors: t.errors,
      local,
      internal: t.internal,
      env: t.internal ? null : badgeFor(url, this.settings.envGroups),
    };
  }

  snapshot(): ShellState {
    return {
      spaces: this.spaces,
      activeSpaceId: this.activeSpaceId,
      tabs: [...this.tabs.values()].map((t) => this.info(t)),
      activeTabId: this.activeTabId,
      devServers: this.devServers,
      preview: this.preview,
      settings: this.settings,
    };
  }

  emit(): void {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.onState(this.snapshot());
    }, 16);
  }

  // ───────── sessions / views ─────────
  private partitionFor(spaceId: string, internal: boolean): string {
    if (internal) return INTERNAL_PARTITION;
    const space = this.spaces.find((s) => s.id === spaceId);
    return space?.isolated ? `persist:quiver-space-${spaceId}` : SHARED_PARTITION;
  }

  private prepareSession(partition: string): void {
    if (this.preparedPartitions.has(partition)) return;
    this.preparedPartitions.add(partition);
    const ses = session.fromPartition(partition);
    const allowed = new Set(['fullscreen', 'clipboard-sanitized-write']);
    ses.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
    ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
    if (partition === INTERNAL_PARTITION) this.prepareInternalSession(partition);
  }

  attachShortcuts(wc: WebContents): void {
    wc.on('before-input-event', (event, input) => {
      const action = shortcutFor(input);
      if (action) {
        event.preventDefault();
        this.onShortcut(action);
      }
    });
  }

  private createView(partition: string, internal: boolean): WebContentsView {
    this.prepareSession(partition);
    const view = new WebContentsView({
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        preload: internal ? PRELOAD : undefined,
      },
    });
    if (internal) restrictInternalNavigation(view.webContents);
    return view;
  }

  private bringOverlayToTop(): void {
    this.win.contentView.addChildView(this.overlay);
  }

  // ───────── tabs ─────────
  openTab(rawUrl: string, opts: { spaceId?: string; activate?: boolean; lazy?: boolean } = {}): Tab {
    const spaceId = opts.spaceId ?? this.activeSpaceId;
    const internal = rawUrl.startsWith('quiver://') || rawUrl === '';
    const url = internal ? toInternalUrl(rawUrl || 'quiver://newtab') : rawUrl;
    const partition = this.partitionFor(spaceId, internal);
    const view = this.createView(partition, internal);
    const tab: Tab = {
      id: this.nextId++,
      spaceId,
      partition,
      view,
      internal,
      pendingUrl: null,
      errorFor: null,
      title: '',
      favicon: '',
      loading: false,
      errors: 0,
      navigation: 0,
      cssKeys: new Map(),
    };
    this.tabs.set(tab.id, tab);
    this.win.contentView.addChildView(view);
    this.bringOverlayToTop();
    view.setVisible(false);
    this.wire(tab);
    if (opts.lazy) tab.pendingUrl = url;
    else this.load(tab, url);
    if (opts.activate !== false) this.activateTab(tab.id);
    else this.layout();
    this.persist();
    this.emit();
    return tab;
  }

  private load(tab: Tab, url: string): void {
    tab.pendingUrl = null;
    tab.errorFor = null;
    tab.view.webContents.loadURL(url).catch(() => {
      /* navigation errors surface via did-fail-load */
    });
  }

  private wire(tab: Tab): void {
    const wc = tab.view.webContents;
    this.attachShortcuts(wc);
    const touch = () => this.emit();
    wc.on('page-title-updated', (_e, title) => {
      tab.title = title;
      touch();
      this.persist();
    });
    wc.on('page-favicon-updated', (_e, favicons) => {
      tab.favicon = favicons[0] ?? '';
      touch();
    });
    wc.on('did-start-loading', () => {
      tab.loading = true;
      touch();
    });
    wc.on('did-stop-loading', () => {
      tab.loading = false;
      touch();
    });
    wc.on('did-navigate', () => {
      this.persist();
      touch();
      this.followPhone(tab);
    });
    wc.on('did-navigate-in-page', () => {
      this.persist();
      touch();
      this.followPhone(tab);
    });
    wc.on('did-start-navigation', ({ isMainFrame, isSameDocument, url }) => {
      if (!isMainFrame || isSameDocument) return;
      tab.navigation++;
      tab.cssKeys.clear();
      if (url.startsWith(ERR_PREFIX)) return;
      tab.errors = 0;
      tab.errorFor = null;
      touch();
    });
    wc.on('did-fail-load', (_e, code, desc, validatedUrl, isMainFrame) => {
      if (!isMainFrame || tab.internal || code === -3 || validatedUrl.startsWith('data:')) return;
      tab.errorFor = validatedUrl;
      tab.title = 'Cannot reach page';
      wc.loadURL(errorPage(validatedUrl, `${desc} (${code})`)).catch(() => undefined);
      touch();
    });
    wc.on('dom-ready', () => {
      void this.applyBoosts(tab);
      if (!tab.internal && this.activeTabId === tab.id) this.followPhone(tab);
    });
    wc.on('console-message', ({ level }) => {
      if (level === 'error') {
        tab.errors++;
        touch();
      }
    });
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) this.openTab(url, { spaceId: tab.spaceId });
      return { action: 'deny' };
    });
    if (!tab.internal) {
      const guard = (event: { url: string; preventDefault(): void }) => {
        if (event.url.startsWith('quiver://')) event.preventDefault();
      };
      wc.on('will-frame-navigate', guard);
      wc.on('will-redirect', guard);
    }
    wc.on('render-process-gone', (_e, details) => {
      tab.title = 'Page crashed';
      tab.loading = false;
      console.warn(`[quiver] tab ${tab.id} renderer gone: ${details.reason}`);
      touch();
    });
  }

  activateTab(id: number): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    if (tab.spaceId !== this.activeSpaceId) {
      this.store.state.activeSpaceId = tab.spaceId;
      this.store.save();
    }
    this.activeTabId = id;
    this.lastActive[tab.spaceId] = id;
    if (tab.pendingUrl) this.load(tab, tab.pendingUrl);
    this.layout();
    this.syncPhone();
    if (!this.overlayOpen) tab.view.webContents.focus();
    this.persist();
    this.emit();
  }

  closeTab(id: number): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const sameSpace = [...this.tabs.values()].filter((t) => t.spaceId === tab.spaceId);
    const idx = sameSpace.findIndex((t) => t.id === id);
    this.tabs.delete(id);
    this.win.contentView.removeChildView(tab.view);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    if (this.activeTabId === id) {
      const rest = sameSpace.filter((t) => t.id !== id);
      this.activeTabId = null;
      if (rest.length) this.activateTab(rest[Math.min(idx, rest.length - 1)].id);
      else this.openTab('quiver://newtab', { spaceId: tab.spaceId });
    }
    this.layout();
    this.syncPhone();
    this.persist();
    this.emit();
  }

  cycleTab(delta: number): void {
    const list = [...this.tabs.values()].filter((t) => t.spaceId === this.activeSpaceId);
    if (list.length < 2) return;
    const i = list.findIndex((t) => t.id === this.activeTabId);
    this.activateTab(list[(i + delta + list.length) % list.length].id);
  }

  tabByIndex(n: number): void {
    const list = [...this.tabs.values()].filter((t) => t.spaceId === this.activeSpaceId);
    const t = n >= 9 ? list[list.length - 1] : list[n - 1];
    if (t) this.activateTab(t.id);
  }

  getTab(id?: number): Tab {
    const t = id === undefined ? this.activeTab : this.tabs.get(id);
    if (!t) throw new Error(id === undefined ? 'no active tab' : `no tab with id ${id}`);
    return t;
  }

  contents(id?: number): WebContents {
    return this.getTab(id).view.webContents;
  }

  /** Navigate the active tab; internal targets and internal-page tabs open a new tab (different preload/session). */
  navigate(url: string, opts: { newTab?: boolean; tabId?: number } = {}): Tab {
    const cur = opts.tabId !== undefined ? this.getTab(opts.tabId) : this.activeTab;
    const internal = url.startsWith('quiver://');
    if (!cur || opts.newTab || cur.internal || internal) return this.openTab(url);
    this.load(cur, url);
    cur.title = '';
    this.emit();
    return cur;
  }

  goBack(): void {
    const wc = this.activeTab?.view.webContents;
    if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  }
  goForward(): void {
    const wc = this.activeTab?.view.webContents;
    if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  }
  reload(): void {
    const t = this.activeTab;
    if (!t) return;
    if (t.errorFor) this.load(t, t.errorFor);
    else t.view.webContents.reload();
  }

  toggleDevTools(): void {
    this.activeTab?.view.webContents.toggleDevTools();
  }

  // ───────── environments ─────────
  switchEnvironment(target?: EnvBadge): boolean {
    const t = this.activeTab;
    if (!t || t.internal) return false;
    const next = switchEnv(this.tabUrl(t), this.settings.envGroups, target);
    if (!next) return false;
    this.load(t, next);
    return true;
  }

  // ───────── spaces ─────────
  createSpace(name: string, isolated: boolean): Space {
    const id = `space-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
    const space: Space = {
      id,
      name: name.trim().slice(0, 40) || 'Space',
      color: SPACE_COLORS[this.spaces.length % SPACE_COLORS.length],
      isolated,
    };
    this.store.state.spaces.push(space);
    this.activateSpace(id);
    return space;
  }

  renameSpace(id: string, name: string): void {
    const s = this.spaces.find((x) => x.id === id);
    const n = name.trim().slice(0, 40);
    if (!s || !n) return;
    s.name = n;
    this.store.save();
    this.emit();
  }

  async deleteSpace(id: string): Promise<void> {
    if (this.spaces.length < 2) return;
    const space = this.spaces.find((s) => s.id === id);
    if (!space) return;
    for (const t of [...this.tabs.values()].filter((t) => t.spaceId === id)) {
      this.tabs.delete(t.id);
      this.win.contentView.removeChildView(t.view);
      if (!t.view.webContents.isDestroyed()) t.view.webContents.close();
    }
    this.store.state.spaces = this.spaces.filter((s) => s.id !== id);
    delete this.store.state.tabsBySpace[id];
    if (space.isolated) {
      try {
        await session.fromPartition(`persist:quiver-space-${id}`).clearStorageData();
      } catch {
        /* best effort */
      }
    }
    if (this.activeSpaceId === id) this.activateSpace(this.spaces[0].id);
    else this.emit();
    this.persist();
  }

  activateSpace(id: string): void {
    if (!this.spaces.some((s) => s.id === id)) return;
    this.store.state.activeSpaceId = id;
    const inSpace = [...this.tabs.values()].filter((t) => t.spaceId === id);
    if (inSpace.length === 0) {
      this.openTab('quiver://newtab', { spaceId: id });
      return;
    }
    const remembered = this.lastActive[id];
    this.activateTab(inSpace.some((t) => t.id === remembered) ? remembered : inSpace[0].id);
  }

  // ───────── layout / preview ─────────
  sidebarWidth(): number {
    return this.settings.sidebarCollapsed ? SIDEBAR_COLLAPSED_W : SIDEBAR_W;
  }

  setOverlayOpen(open: boolean): void {
    this.overlayOpen = open;
    this.overlay.setVisible(open);
    if (open) {
      this.bringOverlayToTop();
      this.overlay.webContents.focus();
    } else this.activeTab?.view.webContents.focus();
  }

  layout(): void {
    if (this.win.isDestroyed()) return;
    const [W, H] = this.win.getContentSize();
    const sb = this.sidebarWidth();
    this.shell.setBounds({ x: 0, y: 0, width: W, height: H });
    this.overlay.setBounds({ x: 0, y: 0, width: W, height: H });
    const reserve = this.preview ? PHONE_W + PHONE_MARGIN * 2 : 0;
    const desktopW = Math.max(240, W - sb - reserve);
    const rect: Rectangle = { x: sb, y: TOOLBAR_H, width: desktopW, height: Math.max(100, H - TOOLBAR_H) };
    for (const t of this.tabs.values()) {
      t.view.setBounds(rect);
      t.view.setVisible(t.id === this.activeTabId && t.spaceId === this.activeSpaceId);
    }
    if (this.phone) {
      const pr: Rectangle = {
        x: sb + desktopW + PHONE_MARGIN,
        y: TOOLBAR_H + PHONE_LABEL_H,
        width: PHONE_W,
        height: Math.max(200, H - TOOLBAR_H - PHONE_LABEL_H - PHONE_MARGIN),
      };
      this.phone.setBounds(pr);
      this.applyEmulation(pr);
    }
  }

  setPreview(on: boolean): void {
    this.preview = on;
    this.syncPhone();
    this.layout();
    this.emit();
  }

  dispose(): void {
    if (this.emitTimer) clearTimeout(this.emitTimer);
    if (this.phone && !this.phone.webContents.isDestroyed()) this.phone.webContents.close();
    for (const tab of this.tabs.values()) {
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    }
    this.tabs.clear();
  }

  private destroyPhone(): void {
    if (!this.phone) return;
    this.win.contentView.removeChildView(this.phone);
    if (!this.phone.webContents.isDestroyed()) this.phone.webContents.close();
    this.phone = null;
    this.phoneUrl = '';
    this.phoneReady = false;
    this.phoneEmulated = false;
  }

  /** Create/destroy/retarget the phone view so it mirrors the active tab, same cookie jar. */
  syncPhone(): void {
    const t = this.activeTab;
    if (!this.preview || !t || t.internal) {
      this.destroyPhone();
      return;
    }
    if (this.phone && this.phonePartition !== t.partition) this.destroyPhone();
    if (!this.phone) {
      this.phonePartition = t.partition;
      this.phone = this.createView(t.partition, false);
      this.phone.webContents.setUserAgent(MOBILE_UA);
      this.phone.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/i.test(url)) void this.phone?.webContents.loadURL(url).catch(() => undefined);
        return { action: 'deny' };
      });
      // Device emulation needs a live renderer: apply only after the first dom-ready, and again after every load.
      this.phone.webContents.on('dom-ready', () => {
        this.phoneReady = true;
        this.layout();
      });
      this.attachShortcuts(this.phone.webContents);
      this.win.contentView.addChildView(this.phone);
      this.bringOverlayToTop();
    }
    this.layout();
    this.followPhone(t);
  }

  private followPhone(tab: Tab): void {
    if (!this.preview || !this.phone || tab.id !== this.activeTabId || tab.internal) return;
    const url = this.tabUrl(tab);
    if (!/^https?:/i.test(url) || url === this.phoneUrl) return;
    this.phoneUrl = url;
    void this.phone.webContents.loadURL(url).catch(() => undefined);
  }

  /**
   * Phone emulation through the DevTools protocol: mobile device metrics (393 px wide, DPR 3),
   * touch events, and mouse-to-touch mapping. enableDeviceEmulation alone does not switch on touch.
   */
  private applyEmulation(r: Rectangle): void {
    const wc = this.phone?.webContents;
    if (!wc || wc.isDestroyed() || !this.phoneReady) return;
    void (async () => {
      try {
        if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
        const send = (m: string, p: object) => wc.debugger.sendCommand(m, p);
        await send('Emulation.setDeviceMetricsOverride', { width: PHONE_W, height: r.height, deviceScaleFactor: 3, mobile: true, screenWidth: PHONE_W, screenHeight: r.height });
        await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
        await send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
        if (!this.phoneEmulated) {
          this.phoneEmulated = true;
          wc.reload(); // touch support is decided at document creation, so load the page once more
        }
      } catch (err) {
        console.warn('[quiver] phone emulation failed:', (err as Error).message);
      }
    })();
  }

  // ───────── dev servers ─────────
  setDevServers(list: DevServer[]): void {
    this.devServers = list;
    this.emit();
  }

  // ───────── boosts ─────────
  private hostOf(tab: Tab): string | null {
    const wc = tab.view.webContents;
    if (tab.internal || wc.isDestroyed()) return null;
    try {
      const u = new URL(wc.getURL());
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname : null;
    } catch {
      return null;
    }
  }

  private async applyBoosts(tab: Tab): Promise<void> {
    const host = this.hostOf(tab);
    const wc = tab.view.webContents;
    if (!host || wc.isDestroyed()) return;
    const navigation = tab.navigation;
    const frame = wc.mainFrame;
    const origin = new URL(wc.getURL()).origin;
    const isCurrent = () => !wc.isDestroyed() && navigation === tab.navigation && frame === wc.mainFrame;
    const m = this.boosts.matching(host);
    for (const name of m.css) {
      if (!isCurrent()) return;
      const css = this.boosts.readIfExists(name);
      if (css) {
        try {
          const key = await wc.insertCSS(css, { cssOrigin: 'user' });
          if (isCurrent()) tab.cssKeys.set(name, key);
        } catch {
          /* page navigated away */
        }
      }
    }
    for (const name of m.ts) {
      if (!isCurrent()) return;
      const src = this.boosts.readIfExists(name);
      if (!src) continue;
      try {
        const script = wrapScript(transpileBoost(src), name);
        await frame.executeJavaScript(`if (location.origin === ${JSON.stringify(origin)}) { ${script} }`, true);
      } catch (err) {
        console.warn(`[quiver] boost ${name} failed:`, (err as Error).message);
      }
    }
  }

  private async onBoostChanged(name: string, kind: 'css' | 'ts', removed: boolean): Promise<void> {
    for (const tab of this.tabs.values()) {
      const host = this.hostOf(tab);
      if (!host || !boostMatchesHost(name, host)) continue;
      const wc = tab.view.webContents;
      if (wc.isDestroyed()) continue;
      if (kind === 'ts') {
        if (!removed) wc.reload();
        continue;
      }
      const navigation = tab.navigation;
      const old = tab.cssKeys.get(name);
      if (old) {
        try {
          await wc.removeInsertedCSS(old);
        } catch {
          /* gone */
        }
        if (wc.isDestroyed() || navigation !== tab.navigation) continue;
        tab.cssKeys.delete(name);
      }
      if (!removed) {
        const css = this.boosts.readIfExists(name);
        if (css !== null) {
          try {
            const key = await wc.insertCSS(css, { cssOrigin: 'user' });
            if (!wc.isDestroyed() && navigation === tab.navigation) tab.cssKeys.set(name, key);
          } catch {
            /* ignore */
          }
        }
      }
    }
  }

  // ───────── persistence ─────────
  persist(): void {
    const st = this.store.state;
    st.tabsBySpace = {};
    st.activeIndexBySpace = {};
    for (const s of this.spaces) {
      const list = [...this.tabs.values()].filter((t) => t.spaceId === s.id);
      st.tabsBySpace[s.id] = list.map((t) => ({ url: this.rawUrl(t) })).filter((t) => t.url && !t.url.startsWith('data:'));
      const idx = list.findIndex((t) => t.id === this.lastActive[s.id]);
      st.activeIndexBySpace[s.id] = Math.max(0, idx);
    }
    this.store.save();
  }

  private rawUrl(t: Tab): string {
    return this.tabUrl(t);
  }

  restore(): void {
    // openTab persists the partially restored session, replacing both state maps.
    const { tabsBySpace, activeIndexBySpace, activeSpaceId } = this.store.state;
    for (const s of this.spaces) {
      const saved = tabsBySpace[s.id] ?? [];
      const isActive = s.id === activeSpaceId;
      const idx = activeIndexBySpace[s.id] ?? 0;
      saved.forEach((p, i) => {
        const t = this.openTab(p.url, { spaceId: s.id, activate: false, lazy: !isActive || i !== idx });
        if (i === idx) this.lastActive[s.id] = t.id;
      });
    }
    const inActive = [...this.tabs.values()].filter((t) => t.spaceId === activeSpaceId);
    if (inActive.length === 0) this.openTab('quiver://newtab', { spaceId: activeSpaceId });
    else this.activateTab(inActive.some((t) => t.id === this.lastActive[activeSpaceId]) ? this.lastActive[activeSpaceId] : inActive[0].id);
  }

  async waitForLoad(tab: Tab, timeoutMs: number): Promise<void> {
    const wc = tab.view.webContents;
    if (!wc.isLoading()) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        wc.removeListener('did-stop-loading', done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      wc.on('did-stop-loading', done);
    });
  }
}

export { boostKind };
