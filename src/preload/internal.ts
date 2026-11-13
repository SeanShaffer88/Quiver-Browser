import { contextBridge, ipcRenderer } from 'electron';

// The main process checks the page role and sender for every invocation.
const INVOKE = new Set([
  'state:get',
  'tab:close', 'tab:activate', 'tab:place', 'tab:menu', 'tab:back', 'tab:forward', 'tab:reload',
  'tab:reopen', 'tab:retry-crash', 'recovery:dismiss',
  'space:create', 'space:menu', 'space:rename', 'space:activate',
  'folder:toggle', 'folder:rename', 'folder:move', 'folder:menu',
  'sidebar:toggle', 'preview:toggle', 'env:switch',
  'cmd:open', 'cmd:close', 'cmd:suggest', 'cmd:commit', 'cmd:run',
  'settings:get', 'settings:set',
  'bookmarks:list', 'bookmarks:profiles', 'bookmarks:review-profile', 'bookmarks:review-file',
  'bookmarks:cancel-review', 'bookmarks:confirm', 'bookmarks:undo', 'bookmarks:open',
  'boost:list', 'boost:read', 'boost:save', 'boost:create', 'boost:delete', 'boost:dir',
  'devserver:open', 'devserver:refresh', 'devserver:retry',
  'research:list', 'research:get', 'research:rename', 'research:notes', 'research:item-note', 'research:item-remove',
  'research:delete', 'research:resume', 'research:stop', 'research:open', 'research:export',
]);
const ON = new Set(['state', 'cmd:opened', 'cmd:restore-focus', 'boost:changed', 'space:rename-start', 'folder:rename-start', 'research:changed']);

contextBridge.exposeInMainWorld('quiver', {
  invoke: (channel: string, ...args: unknown[]): Promise<unknown> =>
    INVOKE.has(channel) ? ipcRenderer.invoke(channel, ...args) : Promise.reject(new Error(`blocked channel ${channel}`)),
  on: (channel: string, cb: (payload: unknown) => void): (() => void) => {
    if (!ON.has(channel)) throw new Error(`blocked channel ${channel}`);
    const handler = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
