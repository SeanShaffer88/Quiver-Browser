import { clipboard, ipcMain, Menu, type IpcMainInvokeEvent, type WebContentsView } from 'electron';
import { INTERNAL_ORIGIN } from '../shared/constants';
import { parseCommand, resolveInput } from '../shared/parser';
import type { EnvGroup, Settings, Suggestion, SuggestionAction } from '../shared/types';
import { isValidBoostName, type Boosts } from './boosts';
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

export function sanitizeEnvGroups(input: unknown): EnvGroup[] {
  if (!Array.isArray(input)) return [];
  const s = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 300) : '');
  return input
    .slice(0, 50)
    .map((g) => ({ name: s((g as EnvGroup)?.name) || 'App', local: s((g as EnvGroup)?.local), staging: s((g as EnvGroup)?.staging), prod: s((g as EnvGroup)?.prod) }))
    .filter((g) => g.local || g.staging || g.prod);
}

export function registerIpc(d: IpcDeps): { openCommandBar: (text?: string, mode?: 'new' | 'current') => void; toggleSidebar: () => void } {
  const { tabs, store, boosts, devWatcher, overlay, shell } = d;

  const handle = (channel: string, fn: (e: IpcMainInvokeEvent, ...args: any[]) => unknown) => {
    ipcMain.handle(channel, (e, ...args) => {
      const url = e.senderFrame?.url ?? '';
      if (e.senderFrame !== e.sender.mainFrame || !url.startsWith(INTERNAL_ORIGIN)) throw new Error('forbidden sender');
      return fn(e, ...args);
    });
  };

  const closeOverlay = () => tabs.setOverlayOpen(false);

  const runAction = (action: SuggestionAction, mode: 'new' | 'current') => {
    switch (action.type) {
      case 'navigate':
        tabs.navigate(action.url, { newTab: mode === 'new' });
        closeOverlay();
        break;
      case 'copy':
        clipboard.writeText(action.text);
        closeOverlay();
        break;
      case 'boost':
        if (isValidBoostName(action.name)) {
          boosts.create(action.name);
          tabs.navigate(`quiver://boosts?file=${encodeURIComponent(action.name)}`);
        }
        closeOverlay();
        break;
      case 'env':
        tabs.switchEnvironment(action.target);
        closeOverlay();
        break;
      case 'internal':
        tabs.navigate(`quiver://${action.page}`);
        closeOverlay();
        break;
      case 'noop':
        break;
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
  handle('cmd:open', (_e, text?: string, mode?: 'new' | 'current') => openCommandBar(text, mode));
  handle('cmd:close', () => closeOverlay());
  handle('cmd:suggest', (_e, text: string): Suggestion[] => {
    const cur = tabs.activeTab;
    return parseCommand(String(text ?? ''), {
      searchEngine: store.state.settings.searchEngine,
      envGroups: store.state.settings.envGroups,
      currentUrl: cur && !cur.internal ? tabs.tabUrl(cur) : undefined,
    });
  });
  handle('cmd:run', (_e, action: SuggestionAction, mode: 'new' | 'current') => runAction(action, mode === 'new' ? 'new' : 'current'));
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

  function openCommandBar(text?: string, mode: 'new' | 'current' = 'current') {
    const cur = tabs.activeTab;
    const prefill = typeof text === 'string' ? text : cur && !cur.internal ? displayUrl(tabs.tabUrl(cur)) : '';
    tabs.setOverlayOpen(true);
    overlay.webContents.send('cmd:opened', { text: prefill, mode });
  }

  return { openCommandBar, toggleSidebar };
}
