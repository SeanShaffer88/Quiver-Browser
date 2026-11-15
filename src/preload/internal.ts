import { contextBridge, ipcRenderer } from 'electron';

// The main process checks the page role and sender for every invocation.
const INVOKE = new Set([
  'state:get',
  'tab:close', 'tab:activate', 'tab:place', 'tab:menu', 'tab:console', 'tab:back', 'tab:forward', 'tab:reload',
  'tab:reopen', 'tab:retry-crash', 'recovery:dismiss',
  'space:create', 'space:create-private', 'adblock:toggle-site', 'space:menu', 'space:rename', 'space:activate',
  'folder:toggle', 'folder:rename', 'folder:move', 'folder:menu',
  'permission:decide', 'sitepermissions:forget', 'sitepermissions:list',
  'profile:context', 'settings:profile', 'spaces:list', 'spaces:update', 'history:clear-all',
  'find:query', 'find:close', 'zoom:reset',
  'split:ratio', 'split:exit', 'peek:close', 'peek:open-tab',
  'little:get', 'little:copy', 'little:open', 'little:close',
  'sidebar:toggle', 'preview:toggle', 'env:switch',
  'sidebar:toggle', 'sidebar:peek', 'preview:toggle', 'env:switch',
  'cmd:open', 'cmd:close', 'cmd:suggest', 'cmd:commit', 'cmd:run',
  'settings:get', 'settings:set', 'sync:status', 'sync:choose', 'sync:disconnect', 'sync:options', 'sync:now',
  'devices:list', 'devices:open-tab', 'devices:continue', 'handoff:open', 'handoff:dismiss',
  'history:clear', 'history:count',
  'shortcuts:list', 'shortcuts:set', 'shortcuts:reset', 'shortcuts:recording',
  'update:status', 'update:check', 'update:open', 'update:dismiss',
  'bookmarks:list', 'bookmarks:profiles', 'bookmarks:review-profile', 'bookmarks:review-file',
  'bookmarks:cancel-review', 'bookmarks:confirm', 'bookmarks:undo', 'bookmarks:open',
  'arc:preview', 'arc:commit', 'arc:undo', 'arc:status', 'arc:cancel',
  'boost:list', 'boost:read', 'boost:save', 'boost:create', 'boost:delete', 'boost:dir',
  'devserver:open', 'devserver:refresh', 'devserver:retry',
  'downloads:list', 'downloads:act', 'downloads:clear',
  'research:list', 'research:get', 'research:rename', 'research:notes', 'research:item-note', 'research:item-remove',
  'research:delete', 'research:resume', 'research:stop', 'research:open', 'research:export',
  'board:open', 'board:new', 'boards:list', 'boards:get', 'boards:create', 'boards:rename', 'boards:delete', 'boards:add-note',
  'boards:update', 'boards:reorder', 'boards:remove', 'boards:open', 'boards:export', 'capture:done', 'capture:cancel',
]);
const ON = new Set(['state', 'cmd:opened', 'cmd:restore-focus', 'boost:changed', 'space:rename-start', 'folder:rename-start', 'research:changed', 'sync:changed', 'downloads:changed', 'find:focus', 'peek:backdrop', 'little:state', 'boards:changed', 'capture:start']);

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
