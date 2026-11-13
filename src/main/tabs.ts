import { BaseWindow, WebContentsView, session, webContents, type Rectangle, type WebContents } from 'electron';
import path from 'node:path';
import {
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
import type { DevServer, EnvBadge, LocalServerStatus, PhoneStatus, RecoveryNotice, ShellState, Space, TabInfo } from '../shared/types';
import { boostKind, boostMatchesHost, transpileBoost, wrapScript, type Boosts } from './boosts';
import {
  allowsInternalNavigation, allowsWebNavigation, configureSitePermissions, internalTabUrl, isInternalTabPage, type InternalTabPage,
} from './browser-policy';
import { EndpointStatus, type EndpointFailure } from './endpoint-status';
import { internalPage, type InternalPage } from './internal-access';
import { shortcutFor, type ShortcutAction } from './shortcuts';
import type { Store } from './store';
import {
  CANONICAL_NEW_TAB_URL,
  hasSavedNewTabPlaceholder,
  normalizeTabTitle,
  rememberClosed,
  restorableUrl,
  restoreRecentlyClosed,
  restoreSelection,
  snapshotRecentlyClosed,
  snapshotSpace,
  type ClosedTab,
} from './session-recovery';
import { moveInGroup } from './tab-order';

interface Tab {
  id: number;
  spaceId: string;
  partition: string;
  view: WebContentsView;
  internal: boolean;
  readonly internalPage: InternalTabPage | undefined;
  readonly initialInternalUrl: string | undefined;
  pendingUrl: string | null;
  requestedLoad: { url: string } | null;
  crashUrl: string | null;
  errorFor: string | null;
  title: string;
  titleIsExplicit: boolean;
  favicon: string;
  loading: boolean;
  errors: number;
  navigation: number;
  commandRevision: number;
  cssKeys: Map<string, string>;
  tsBoosts: Set<string>;
  cssJobs: Map<string, Promise<void>>;
  boostReadyNavigation: number;
  localFailure: EndpointFailure | null;
}

const PRELOAD = path.join(__dirname, '..', 'preload', 'internal.js');
const ERR_PREFIX = 'data:text/html;charset=utf-8,%3C!--quiver-error--%3E';
const SPACE_COLORS = ['#5b8cff', '#ff7a59', '#3ecf8e', '#f5b73b', '#b57bff', '#ff5d8f', '#2cc5d9'];

export function toInternalUrl(url: string): string {
  const u = URL.parse(url);
  if (!u) return CANONICAL_NEW_TAB_URL;
  const candidate = u.host === 'app' ? url : `quiver://app/${u.host || 'newtab'}.html${u.search}${u.hash}`;
  return isInternalTabPage(internalPage(candidate)) ? candidate : CANONICAL_NEW_TAB_URL;
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

export function restrictInternalNavigation(wc: WebContents, fixedPage: InternalPage): void {
  const guard = (event: { url: string; isMainFrame: boolean; preventDefault(): void }) => {
    if (!allowsInternalNavigation(event.url, event.isMainFrame, fixedPage)) event.preventDefault();
  };
  wc.on('will-frame-navigate', guard);
  wc.on('will-redirect', guard);
}

function restrictWebNavigation(wc: WebContents): void {
  const guard = (event: Electron.Event<Electron.WebContentsWillFrameNavigateEventParams>) => {
    // Only a known local file initiator may follow a renderer-driven local file link.
    let initiator: string | undefined;
    if (/^file:/i.test(event.url)) {
      try {
        initiator = event.initiator?.url;
      } catch {
        // The initiating frame can have been disposed before this event is handled.
      }
    }
    if (!allowsWebNavigation(event.url, initiator)) event.preventDefault();
  };
  wc.on('will-frame-navigate', guard);
  wc.on('will-redirect', guard);
}

export class TabManager {
  readonly tabs = new Map<number, Tab>();
  private nextId = 1;
  activeTabId: number | null = null;
  private lastActive: Record<string, number> = {};
  private recentlyClosed: ClosedTab[] = [];
  private recoveryNotice?: RecoveryNotice;
  private restoring = false;
  preview = false;
  devServers: DevServer[] = [];
  private readonly endpointStatus = new EndpointStatus();

  private phone: WebContentsView | null = null;
  private phonePartition = '';
  private phoneSpaceId = '';
  private phoneUrl = '';
  private phoneLoad: symbol | null = null;
  private phoneReady = false;
  private phoneEmulated = false;
  private phoneReloadedForTouch = false;
  private phoneUnavailable = false;
  private phoneEmulationHeight = 0;
  private phoneEmulationBusy: WebContents | null = null;
  private readonly preparedPartitions = new Set<string>();
  private emitTimer: NodeJS.Timeout | null = null;
  private overlayOpen = false;
  private commandFocus: { contents: WebContents; invoker?: 'address' | 'new-tab' } | null = null;

  constructor(
    private readonly win: BaseWindow,
    private readonly shell: WebContentsView,
    private readonly overlay: WebContentsView,
    private readonly store: Store,
    private readonly boosts: Boosts,
    private readonly onState: (s: ShellState) => void,
    private readonly onShortcut: (a: ShortcutAction) => void,
    private readonly portableDownloadPath?: string,
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
    if (t.crashUrl) return this.allowedTabUrl(t, t.crashUrl);
    if (t.errorFor) return this.allowedTabUrl(t, t.errorFor);
    if (t.pendingUrl) return this.allowedTabUrl(t, t.pendingUrl);
    const u = t.view.webContents.isDestroyed() ? '' : t.view.webContents.getURL();
    return this.allowedTabUrl(t, u || t.requestedLoad?.url || '');
  }

  private allowedTabUrl(t: Tab, url: string): string {
    return t.internalPage && t.initialInternalUrl ? internalTabUrl(t.internalPage, t.initialInternalUrl, url) : url;
  }

  private canNavigateHistory(t: Tab, offset: -1 | 1): boolean {
    const contents = t.view.webContents;
    if (contents.isDestroyed()) return false;
    const history = contents.navigationHistory;
    if (!(offset < 0 ? history.canGoBack() : history.canGoForward())) return false;
    if (!t.internalPage) return true;
    const entry = history.getEntryAtIndex(history.getActiveIndex() + offset);
    return !!entry && internalPage(entry.url) === t.internalPage;
  }

  private info(t: Tab): TabInfo {
    const url = this.tabUrl(t);
    let local = false;
    try {
      const u = new URL(url);
      local = (u.protocol === 'http:' || u.protocol === 'https:') && isLocalHost(u.hostname);
    } catch {
      /* ignore */
    }
    return {
      id: t.id,
      spaceId: t.spaceId,
      url: displayUrl(url),
      title: t.title || displayUrl(url) || 'New Tab',
      favicon: t.favicon,
      loading: t.loading,
      canGoBack: this.canNavigateHistory(t, -1),
      canRetryCrash: t.crashUrl !== null,
      canGoForward: this.canNavigateHistory(t, 1),
      errors: t.errors,
      local,
      internal: t.internal,
      env: t.internal ? null : badgeFor(url, this.settings.envGroups),
      activeBoosts: [...t.cssKeys.keys(), ...t.tsBoosts].sort(),
    };
  }

  snapshot(): ShellState {
    const recent = this.recentlyClosed[0];
    return {
      recentlyClosed: recent ? { id: recent.id, spaceId: recent.spaceId, title: recent.title } : undefined,
      recoveryNotice: this.recoveryNotice,
      spaces: this.spaces,
      activeSpaceId: this.activeSpaceId,
      tabs: [...this.tabs.values()].map((t) => this.info(t)),
      activeTabId: this.activeTabId,
      devServers: this.devServers,
      preview: this.preview,
      phoneStatus: this.getPhoneStatus(),
      localServerStatus: this.getLocalServerStatus(),
      settings: this.settings,
    };
  }

  showSessionRecovery(session: NonNullable<RecoveryNotice['session']>): void {
    this.recoveryNotice = { ...this.recoveryNotice, session };
    this.emit();
  }

  showWindowRecovery(): void {
    this.recoveryNotice = { ...this.recoveryNotice, movedToVisibleDisplay: true };
    this.emit();
  }

  dismissRecovery(): void {
    this.recoveryNotice = undefined;
    this.emit();
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
    const downloadPath = this.portableDownloadPath;
    if (downloadPath) {
      ses.setDownloadPath(downloadPath);
      ses.on('will-download', (_event, item) => {
        // Chromium otherwise prefers the last folder selected in Save As.
        const name = path.basename(item.getFilename());
        const safeName = name && name !== '.' && name !== '..' && !/[<>:"/\\|?*\u0000-\u001f]/u.test(name);
        item.setSaveDialogOptions({ ...item.getSaveDialogOptions(), defaultPath: safeName ? path.join(downloadPath, name) : downloadPath });
      });
    }
    if (partition !== INTERNAL_PARTITION) configureSitePermissions(ses, true);
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

  private createView(partition: string, page?: InternalTabPage): WebContentsView {
    this.prepareSession(partition);
    const view = new WebContentsView({
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        preload: page ? PRELOAD : undefined,
      },
    });
    if (page) restrictInternalNavigation(view.webContents, page);
    else restrictWebNavigation(view.webContents);
    return view;
  }

  private bringOverlayToTop(): void {
    this.win.contentView.addChildView(this.overlay);
  }

  // ───────── tabs ─────────
  openTab(rawUrl: string, opts: { spaceId?: string; activate?: boolean; lazy?: boolean; index?: number } = {}): Tab {
    const spaceId = opts.spaceId ?? this.activeSpaceId;
    const internal = rawUrl.startsWith('quiver://') || rawUrl === '';
    const url = internal ? toInternalUrl(rawUrl || 'quiver://newtab') : rawUrl;
    const parsedPage = internal ? internalPage(url) : undefined;
    const page = isInternalTabPage(parsedPage) ? parsedPage : undefined;
    const partition = this.partitionFor(spaceId, internal);
    const view = this.createView(partition, page);
    const tab: Tab = {
      id: this.nextId++,
      spaceId,
      partition,
      view,
      internal,
      internalPage: page,
      initialInternalUrl: page ? url : undefined,
      pendingUrl: null,
      requestedLoad: null,
      crashUrl: null,
      errorFor: null,
      title: '',
      titleIsExplicit: false,
      favicon: '',
      loading: false,
      errors: 0,
      navigation: 0,
      commandRevision: 0,
      cssKeys: new Map(),
      tsBoosts: new Set(),
      cssJobs: new Map(),
      boostReadyNavigation: -1,
      localFailure: null,
    };
    this.insertTab(tab, opts.index);
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

  private insertTab(tab: Tab, index?: number): void {
    const before = index === undefined ? undefined : [...this.tabs.values()].filter((other) => other.spaceId === tab.spaceId)[index];
    if (!before) {
      this.tabs.set(tab.id, tab);
      return;
    }
    const entries = [...this.tabs.entries()];
    this.tabs.clear();
    for (const [id, existing] of entries) {
      if (id === before.id) this.tabs.set(tab.id, tab);
      this.tabs.set(id, existing);
    }
  }

  private load(tab: Tab, url: string): void {
    tab.pendingUrl = null;
    const request = { url: this.allowedTabUrl(tab, url) };
    tab.requestedLoad = request;
    tab.crashUrl = null;
    tab.errorFor = null;
    tab.localFailure = null;
    const finish = () => {
      if (tab.requestedLoad === request) tab.requestedLoad = null;
    };
    // loadURL rejects on error or cancellation. The matching request clears in both cases.
    void tab.view.webContents.loadURL(request.url).then(finish, finish);
  }

  private wire(tab: Tab): void {
    const wc = tab.view.webContents;
    this.attachShortcuts(wc);
    const touch = () => this.emit();
    wc.on('page-title-updated', (_e, title, explicitSet) => {
      tab.title = title;
      tab.titleIsExplicit = explicitSet;
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
      if (tab.id === this.activeTabId) this.syncPhone();
    });
    wc.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
      if (!isMainFrame) return;
      this.persist();
      touch();
      this.followPhone(tab);
    });
    wc.on('did-start-navigation', ({ isMainFrame, isSameDocument, url }) => {
      if (!isMainFrame) return;
      tab.commandRevision++;
      if (isSameDocument) return;
      tab.titleIsExplicit = false;
      tab.navigation++;
      tab.cssKeys.clear();
      tab.tsBoosts.clear();
      tab.cssJobs.clear();
      tab.boostReadyNavigation = -1;
      if (url.startsWith(ERR_PREFIX)) return;
      tab.errors = 0;
      tab.errorFor = null;
      tab.localFailure = null;
      touch();
    });
    wc.on('did-fail-load', (_e, code, desc, validatedUrl, isMainFrame) => {
      if (!isMainFrame || tab.internal || code === -3 || validatedUrl.startsWith('data:')) return;
      tab.errorFor = validatedUrl;
      tab.localFailure = this.settings.devServerScan ? this.endpointStatus.failure(validatedUrl, code) : null;
      tab.title = 'Cannot reach page';
      wc.loadURL(errorPage(validatedUrl, `${desc} (${code})`)).catch(() => undefined);
      if (tab.id === this.activeTabId && this.preview) this.syncPhone();
      touch();
    });
    wc.on('dom-ready', () => {
      tab.boostReadyNavigation = tab.navigation;
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
    wc.on('render-process-gone', (_e, details) => {
      if (this.tabs.get(tab.id) !== tab) return;
      const url = this.tabUrl(tab);
      tab.crashUrl = restorableUrl(url) ? url : null;
      tab.title = 'Page stopped responding';
      tab.loading = false;
      tab.cssKeys.clear();
      tab.tsBoosts.clear();
      tab.cssJobs.clear();
      tab.boostReadyNavigation = -1;
      console.warn(`[quiver] tab ${tab.id} renderer gone: ${details.reason}`);
      if (tab.id === this.activeTabId && this.preview) this.syncPhone();
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
    const sameSpace = [...this.tabs.values()].filter((other) => other.spaceId === tab.spaceId);
    const index = sameSpace.findIndex((other) => other.id === id);
    const url = this.tabUrl(tab);
    const title = tab.title || 'tab';
    this.discardTab(tab);

    const remaining = sameSpace.filter((other) => other.id !== id);
    const neighbor = remaining[Math.min(index, remaining.length - 1)];
    if (this.lastActive[tab.spaceId] === id) {
      if (neighbor) this.lastActive[tab.spaceId] = neighbor.id;
      else delete this.lastActive[tab.spaceId];
    }
    let placeholderId: number | undefined;
    if (this.activeTabId === id) {
      this.activeTabId = null;
      if (neighbor) this.activateTab(neighbor.id);
      else placeholderId = this.openTab('quiver://newtab', { spaceId: tab.spaceId }).id;
    }
    this.recentlyClosed = rememberClosed(this.recentlyClosed, { id, url, title, spaceId: tab.spaceId, index, placeholderId });
    this.layout();
    this.syncPhone();
    this.persist();
    this.emit();
  }

  private discardTab(tab: Tab): void {
    this.tabs.delete(tab.id);
    this.win.contentView.removeChildView(tab.view);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
  }

  reopenClosedTab(expectedId?: number): void {
    const entry = this.recentlyClosed[0];
    if (!entry || (expectedId !== undefined && expectedId !== entry.id) || !this.spaces.some((space) => space.id === entry.spaceId)) return;
    const inSpace = [...this.tabs.values()].filter((tab) => tab.spaceId === entry.spaceId);
    const placeholder = inSpace.length === 1 && inSpace[0].id === entry.placeholderId ? inSpace[0] : undefined;
    const reopened = this.openTab(entry.url, { spaceId: entry.spaceId, index: entry.index, activate: false, lazy: true });
    if (placeholder && this.tabUrl(placeholder) === CANONICAL_NEW_TAB_URL) this.discardTab(placeholder);
    this.recentlyClosed.shift();
    this.activateTab(reopened.id);
  }

  retryCrashedTab(id: number): void {
    const tab = this.activeTab;
    if (!tab || tab.id !== id || !tab.crashUrl) return;
    this.load(tab, tab.crashUrl);
    tab.title = '';
    this.emit();
  }

  cycleTab(delta: number): void {
    const list = [...this.tabs.values()].filter((t) => t.spaceId === this.activeSpaceId);
    if (list.length < 2) return;
    const i = list.findIndex((t) => t.id === this.activeTabId);
    this.activateTab(list[(i + delta + list.length) % list.length].id);
  }

  /** Move a tab to `toIndex` within its Space. */
  moveTab(id: number, toIndex: number): void {
    const order = moveInGroup([...this.tabs.values()], id, toIndex, (t) => t.spaceId);
    if (!order) return;
    this.tabs.clear();
    for (const t of order) this.tabs.set(t.id, t);
    this.persist();
    this.emit();
  }

  shiftActiveTab(delta: number): void {
    const tab = this.activeTab;
    if (!tab) return;
    const list = [...this.tabs.values()].filter((t) => t.spaceId === tab.spaceId);
    this.moveTab(tab.id, list.indexOf(tab) + delta);
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
    const tab = this.activeTab;
    if (tab && this.canNavigateHistory(tab, -1)) tab.view.webContents.navigationHistory.goBack();
  }
  goForward(): void {
    const tab = this.activeTab;
    if (tab && this.canNavigateHistory(tab, 1)) tab.view.webContents.navigationHistory.goForward();
  }
  reload(): void {
    const t = this.activeTab;
    if (!t) return;
    if (t.crashUrl) this.retryCrashedTab(t.id);
    else if (t.errorFor) this.load(t, t.errorFor);
    else if (t.initialInternalUrl && internalPage(t.view.webContents.getURL()) !== t.internalPage) this.load(t, t.initialInternalUrl);
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
    for (const t of [...this.tabs.values()].filter((t) => t.spaceId === id)) this.discardTab(t);
    this.recentlyClosed = this.recentlyClosed.filter((tab) => tab.spaceId !== id);
    delete this.lastActive[id];
    this.store.state.spaces = this.spaces.filter((s) => s.id !== id);
    delete this.store.state.tabsBySpace[id];
    delete this.store.state.activeIndexBySpace[id];
    if (this.activeSpaceId === id) this.activateSpace(this.spaces[0].id);
    this.persist();
    this.emit();
    if (space.isolated) {
      try {
        await session.fromPartition(`persist:quiver-space-${id}`).clearStorageData();
      } catch {
        /* best effort */
      }
    }
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

  setOverlayOpen(open: boolean, restoreFocus = false, invoker?: 'address' | 'new-tab'): void {
    if (open && !this.overlayOpen) {
      const origin = invoker ? this.shell.webContents : webContents.getFocusedWebContents();
      if (origin) this.commandFocus = { contents: origin, invoker };
    }
    this.overlayOpen = open;
    this.overlay.setVisible(open);
    if (open) {
      this.bringOverlayToTop();
      this.overlay.webContents.focus();
      return;
    }
    const origin = this.commandFocus;
    this.commandFocus = null;
    const current = this.activeTab?.view.webContents;
    if (restoreFocus && origin && !origin.contents.isDestroyed()) {
      if (origin.contents === this.shell.webContents) {
        origin.contents.focus();
        origin.contents.send('cmd:restore-focus', origin.invoker);
        return;
      }
      if (origin.contents === current || (this.preview && origin.contents === this.phone?.webContents)) {
        origin.contents.focus();
        return;
      }
    }
    if (current && !current.isDestroyed()) current.focus();
  }

  layout(): void {
    if (this.win.isDestroyed()) return;
    const [W, H] = this.win.getContentSize();
    const sb = this.sidebarWidth();
    this.shell.setBounds({ x: 0, y: 0, width: W, height: H });
    this.overlay.setBounds({ x: 0, y: 0, width: W, height: H });
    const reserve = this.phone ? PHONE_W + PHONE_MARGIN * 2 : 0;
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
    const phone = this.phone;
    if (!phone) return;
    this.phone = null;
    this.phonePartition = '';
    this.phoneSpaceId = '';
    this.phoneUrl = '';
    this.phoneLoad = null;
    this.phoneReady = false;
    this.phoneEmulated = false;
    this.phoneReloadedForTouch = false;
    this.phoneUnavailable = false;
    this.phoneEmulationHeight = 0;
    this.phoneEmulationBusy = null;
    this.win.contentView.removeChildView(phone);
    if (!phone.webContents.isDestroyed()) phone.webContents.close();
  }

  private phoneTab(): Tab | null {
    const t = this.activeTab;
    return t && !t.internal && !t.crashUrl && !t.errorFor && /^https?:/i.test(this.tabUrl(t)) ? t : null;
  }

  private phoneFits(): boolean {
    return !this.win.isDestroyed() && this.win.getContentSize()[0] >= this.sidebarWidth() + 240 + PHONE_W + PHONE_MARGIN * 2;
  }

  private getPhoneStatus(): PhoneStatus {
    if (!this.preview) return 'off';
    const tab = this.phoneTab();
    if (!tab) return 'paused';
    if (!this.phoneFits()) return 'narrow';
    const contents = this.phone?.webContents;
    if (!contents || contents.isDestroyed() || this.phonePartition !== tab.partition || this.phoneSpaceId !== tab.spaceId) return 'starting';
    if (this.phoneUnavailable) return 'unavailable';
    return !this.phoneLoad && this.phoneReady && this.phoneEmulated && this.phoneReloadedForTouch && contents.debugger.isAttached() &&
      this.phoneUrl === this.tabUrl(tab) ? 'active' : 'starting';
  }

  /** Create/destroy/retarget the phone view so it mirrors the active tab's session. */
  syncPhone(): void {
    const t = this.preview ? this.phoneTab() : null;
    if (!t || !this.phoneFits()) {
      this.destroyPhone();
      this.layout();
      if (this.preview) this.emit();
      return;
    }
    if (this.phone && (this.phonePartition !== t.partition || this.phoneSpaceId !== t.spaceId || this.phone.webContents.isDestroyed())) {
      this.destroyPhone();
    }
    if (!this.phone) {
      this.phonePartition = t.partition;
      this.phoneSpaceId = t.spaceId;
      const phone = this.createView(t.partition);
      this.phone = phone;
      const wc = phone.webContents;
      wc.setUserAgent(MOBILE_UA);
      wc.setWindowOpenHandler(({ url }) => {
        if (this.phone === phone && /^https?:/i.test(url)) this.loadPhone(phone, url);
        return { action: 'deny' };
      });
      wc.on('did-start-navigation', ({ isMainFrame, isSameDocument }) => {
        if (this.phone !== phone || !isMainFrame || isSameDocument) return;
        this.phoneReady = false;
        this.phoneUnavailable = false;
        this.emit();
      });
      wc.on('dom-ready', () => {
        if (this.phone !== phone) return;
        this.phoneReady = true;
        this.phoneUnavailable = false;
        this.layout();
        this.emit();
      });
      wc.on('render-process-gone', () => {
        if (this.phone !== phone) return;
        this.phoneReady = false;
        this.phoneUnavailable = true;
        this.emit();
      });
      wc.on('did-stop-loading', () => {
        if (this.phone !== phone || this.phoneLoad || this.phoneReady || wc.isLoadingMainFrame()) return;
        this.phoneUnavailable = true;
        this.emit();
      });
      wc.debugger.on('detach', () => {
        if (this.phone !== phone) return;
        this.phoneEmulated = false;
        this.phoneReloadedForTouch = false;
        this.phoneUnavailable = true;
        this.emit();
      });
      this.attachShortcuts(wc);
      this.win.contentView.addChildView(phone);
      this.bringOverlayToTop();
    }
    this.followPhone(t);
    this.layout();
    this.emit();
  }

  private followPhone(tab: Tab): void {
    const phone = this.phone;
    if (!this.preview || !phone || tab.id !== this.activeTabId || tab.internal ||
        this.phoneSpaceId !== tab.spaceId || this.phonePartition !== tab.partition) return;
    const url = this.tabUrl(tab);
    if (!/^https?:/i.test(url) || url === this.phoneUrl) return;
    this.phoneUrl = url;
    this.loadPhone(phone, url);
  }

  private loadPhone(phone: WebContentsView, url: string): void {
    const request = Symbol();
    this.phoneLoad = request;
    this.phoneReady = false;
    this.phoneUnavailable = false;
    const finish = (failed: boolean) => {
      if (this.phone !== phone || this.phoneLoad !== request) return;
      this.phoneLoad = null;
      if (failed) this.phoneUnavailable = true;
      this.emit();
    };
    void phone.webContents.loadURL(url).then(() => finish(false), (error?: NodeJS.ErrnoException) => finish(error?.code !== 'ERR_ABORTED'));
  }

  /**
   * Phone emulation through the DevTools protocol: mobile device metrics (393 px wide, DPR 3),
   * touch events, and mouse-to-touch mapping. enableDeviceEmulation alone does not switch on touch.
   */
  private applyEmulation(r: Rectangle): void {
    const wc = this.phone?.webContents;
    if (!wc || wc.isDestroyed() || !this.phoneReady || this.phoneEmulationBusy === wc) return;
    if (this.phoneEmulated && this.phoneEmulationHeight === r.height && wc.debugger.isAttached()) {
      this.reloadPhoneForTouch(wc);
      return;
    }
    this.phoneEmulationBusy = wc;
    void (async () => {
      try {
        if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
        const send = (m: string, p: object) => wc.debugger.sendCommand(m, p);
        await send('Emulation.setDeviceMetricsOverride', { width: PHONE_W, height: r.height, deviceScaleFactor: 3, mobile: true, screenWidth: PHONE_W, screenHeight: r.height });
        await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
        await send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
        if (this.phone?.webContents !== wc || wc.isDestroyed() || !wc.debugger.isAttached()) return;
        this.phoneEmulated = true;
        this.phoneEmulationHeight = r.height;
        this.phoneUnavailable = false;
        this.reloadPhoneForTouch(wc);
      } catch (err) {
        if (this.phone?.webContents !== wc) return;
        this.phoneEmulated = false;
        this.phoneUnavailable = true;
        console.warn('[quiver] phone emulation failed:', (err as Error).message);
      } finally {
        if (this.phoneEmulationBusy === wc) this.phoneEmulationBusy = null;
        if (this.phone?.webContents === wc && !wc.isDestroyed()) {
          if (this.phone.getBounds().height !== r.height) this.layout();
          this.emit();
        }
      }
    })();
  }

  private reloadPhoneForTouch(contents: WebContents): void {
    if (this.phoneReloadedForTouch || !this.phoneReady) return;
    this.phoneReloadedForTouch = true;
    this.phoneReady = false;
    contents.reload(); // Touch support is decided at document creation.
  }

  // ───────── dev servers ─────────
  setDevServers(list: DevServer[]): void {
    if (!this.settings.devServerScan) return;
    this.devServers = list;
    this.endpointStatus.observe(list.map((server) => server.url));
    this.emit();
  }

  clearDevServers(): void {
    this.devServers = [];
    this.endpointStatus.clear();
    this.emit();
  }

  private getLocalServerStatus(): LocalServerStatus | null {
    const tab = this.activeTab;
    if (!this.settings.devServerScan || !tab || tab.internal) return null;
    const url = this.tabUrl(tab);
    if (tab.errorFor === url && this.endpointStatus.retry(url, tab.localFailure)) return { state: 'recovered', tabId: tab.id, url };
    if (this.endpointStatus.status(url)) return { state: 'missing', tabId: tab.id, url };
    return null;
  }

  retryDevServer(tabId: number, url: string): boolean {
    const tab = this.activeTab;
    if (!this.settings.devServerScan || !tab || tab.id !== tabId || tab.errorFor !== url || this.tabUrl(tab) !== url) return false;
    const destination = this.endpointStatus.retry(url, tab.localFailure);
    if (!destination) return false;
    this.load(tab, destination);
    return true;
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
    const isCurrent = () => this.tabs.get(tab.id) === tab && !wc.isDestroyed() && navigation === tab.navigation &&
      navigation === tab.boostReadyNavigation && frame === wc.mainFrame;
    let matching: ReturnType<Boosts['matching']>;
    try {
      matching = this.boosts.matching(host);
    } catch {
      return;
    }
    for (const name of matching.css) {
      if (!isCurrent()) return;
      await this.applyCssBoost(tab, name);
    }
    for (const name of matching.ts) {
      if (!isCurrent()) return;
      const src = this.boosts.readIfExists(name);
      if (!src) continue;
      try {
        const script = wrapScript(transpileBoost(src), name);
        const applied = await frame.executeJavaScript(`location.origin === ${JSON.stringify(origin)} && ${script}`, true);
        if (applied === true && isCurrent()) {
          tab.tsBoosts.add(name);
          this.emit();
        }
      } catch (err) {
        console.warn(`[quiver] boost ${name} failed:`, (err as Error).message);
      }
    }
  }

  private applyCssBoost(tab: Tab, name: string): Promise<void> {
    const wc = tab.view.webContents;
    const navigation = tab.navigation;
    const frame = wc.mainFrame;
    const isCurrent = () => this.tabs.get(tab.id) === tab && !wc.isDestroyed() && navigation === tab.navigation &&
      navigation === tab.boostReadyNavigation && frame === wc.mainFrame;
    const operation = (tab.cssJobs.get(name) ?? Promise.resolve()).then(async () => {
      if (!isCurrent()) return;
      try {
        const old = tab.cssKeys.get(name);
        if (old) {
          await wc.removeInsertedCSS(old);
          if (!isCurrent()) return;
          tab.cssKeys.delete(name);
          this.emit();
        }
        const css = this.boosts.readIfExists(name);
        if (!css) return;
        const key = await wc.insertCSS(css, { cssOrigin: 'user' });
        if (isCurrent()) {
          tab.cssKeys.set(name, key);
          this.emit();
        }
      } catch {
        // A failed CSS operation leaves the last confirmed state in place.
      }
    }).finally(() => {
      if (tab.cssJobs.get(name) === operation) tab.cssJobs.delete(name);
    });
    tab.cssJobs.set(name, operation);
    return operation;
  }

  private onBoostChanged(name: string, kind: 'css' | 'ts', removed: boolean): void {
    for (const tab of this.tabs.values()) {
      if (tab.boostReadyNavigation !== tab.navigation) continue;
      const host = this.hostOf(tab);
      if (!host || !boostMatchesHost(name, host)) continue;
      if (kind === 'ts') {
        if (!removed) tab.view.webContents.reload();
      } else void this.applyCssBoost(tab, name);
    }
  }

  // ───────── persistence ─────────
  persist(): void {
    if (this.restoring) return;
    const st = this.store.state;
    st.tabsBySpace = {};
    st.activeIndexBySpace = {};
    const soleNewTabs = new Map<string, number>();
    for (const space of this.spaces) {
      const list = [...this.tabs.values()]
        .filter((tab) => tab.spaceId === space.id)
        .map((tab) => ({ id: tab.id, url: this.tabUrl(tab), title: tab.titleIsExplicit ? tab.title : undefined }));
      if (list.length === 1 && list[0].url === CANONICAL_NEW_TAB_URL) soleNewTabs.set(space.id, list[0].id);
      const { tabs, activeIndex } = snapshotSpace(list, this.lastActive[space.id]);
      st.tabsBySpace[space.id] = tabs;
      st.activeIndexBySpace[space.id] = activeIndex;
    }
    st.recentlyClosed = snapshotRecentlyClosed(this.recentlyClosed, new Set(this.spaces.map(({ id }) => id)), soleNewTabs);
    for (const entry of st.recentlyClosed) {
      if (entry.replacePlaceholder) st.tabsBySpace[entry.spaceId][0].automaticPlaceholder = true;
    }
    this.store.save();
  }

  restore(): { tabs: number; spaces: number } {
    const { tabsBySpace, activeIndexBySpace, activeSpaceId, recentlyClosed } = this.store.state;
    const soleNewTabs = new Map<string, number>();
    const restored = { tabs: 0, spaces: 0 };
    this.restoring = true;
    try {
      for (const space of this.spaces) {
        const saved = tabsBySpace?.[space.id];
        if (!Array.isArray(saved)) continue;
        const { entries, activeIndex } = restoreSelection(saved, activeIndexBySpace?.[space.id] ?? 0);
        if (entries.length) restored.spaces++;
        restored.tabs += entries.length;
        entries.forEach(({ url, title }, index) => {
          const tab = this.openTab(url, { spaceId: space.id, activate: false, lazy: true });
          tab.title = normalizeTabTitle(title, url);
          tab.titleIsExplicit = !!tab.title;
          if (index === activeIndex) this.lastActive[space.id] = tab.id;
          if (hasSavedNewTabPlaceholder(saved)) soleNewTabs.set(space.id, tab.id);
        });
      }
      this.recentlyClosed = restoreRecentlyClosed(recentlyClosed, () => this.nextId++, soleNewTabs);
      this.activateSpace(activeSpaceId);
    } finally {
      this.restoring = false;
    }
    this.persist();
    return restored;
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
