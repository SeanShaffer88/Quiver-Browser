import { contextBridge, ipcRenderer } from 'electron';

// Only Quiver's own pages (quiver://app/*) ever get this preload. Channels are allow-listed.
const INVOKE = new Set([
  'state:get',
  'tab:new', 'tab:close', 'tab:activate', 'tab:back', 'tab:forward', 'tab:reload',
  'space:create', 'space:menu', 'space:rename', 'space:activate',
  'sidebar:toggle', 'preview:toggle', 'env:switch',
  'cmd:open', 'cmd:close', 'cmd:suggest', 'cmd:run',
  'settings:set',
  'bookmarks:list', 'bookmarks:profiles', 'bookmarks:import-profile', 'bookmarks:import-file', 'bookmarks:open',
  'boost:list', 'boost:read', 'boost:save', 'boost:create', 'boost:delete', 'boost:dir',
  'devserver:open', 'devserver:refresh',
  'clipboard:write',
]);
const ON = new Set(['state', 'cmd:opened', 'boost:changed', 'space:rename-start']);

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
