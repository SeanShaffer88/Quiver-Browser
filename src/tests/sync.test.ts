import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashSection, normalizeDeviceFile, planSync, type DeviceFile, type SyncMemory } from '../main/sync';

const remote = (deviceId: string, sections: DeviceFile['sections']): DeviceFile => ({ version: 1, deviceId, deviceName: deviceId, writtenAt: 0, sections });

test('hashes ignore key order', () => {
  assert.equal(hashSection({ a: 1, b: [1, { c: 2, d: 3 }] }), hashSection({ b: [1, { d: 3, c: 2 }], a: 1 }));
  assert.notEqual(hashSection({ a: 1 }), hashSection({ a: 2 }));
});

test('a device joining merges with what others share instead of overwriting it', () => {
  const memory: SyncMemory = {};
  const shared = remote('a', {
    bookmarks: { updatedAt: 50, data: [{ title: 'A', url: 'https://a.example/' }] },
    settings: { updatedAt: 50, data: { engine: 'kagi' } },
    spaces: { updatedAt: 50, data: [{ id: 'm', name: 'Main', folders: [{ id: 'f1' }], pinned: [{ url: 'https://p.example/' }] }] },
  });
  const plan = planSync({
    bookmarks: [{ title: 'B', url: 'https://b.example/' }, { title: 'A2', url: 'https://a.example/' }],
    settings: { engine: 'ddg' },
    spaces: [{ id: 'm', name: 'Mine', folders: [{ id: 'f2' }], pinned: [{ url: 'https://q.example/' }] }, { id: 'x', name: 'Extra', pinned: [] }],
  }, memory, [shared], 1000);
  assert.deepEqual(plan.apply.bookmarks, [{ title: 'A', url: 'https://a.example/' }, { title: 'B', url: 'https://b.example/' }]);
  assert.deepEqual(plan.apply.settings, { engine: 'kagi' });
  assert.deepEqual(plan.apply.spaces, [
    { id: 'm', name: 'Main', folders: [{ id: 'f1' }, { id: 'f2' }], pinned: [{ url: 'https://p.example/' }, { url: 'https://q.example/' }] },
    { id: 'x', name: 'Extra', pinned: [] },
  ]);
  assert.equal(plan.publish.bookmarks?.updatedAt, 1000);
  assert.equal(plan.publish.settings?.updatedAt, 50);
});

test('first sync publishes local sections and applies nothing', () => {
  const memory: SyncMemory = {};
  const plan = planSync({ bookmarks: [{ title: 'A', url: 'https://a.example/' }] }, memory, [], 100);
  assert.deepEqual(plan.apply, {});
  assert.deepEqual(plan.publish.bookmarks, { updatedAt: 100, data: [{ title: 'A', url: 'https://a.example/' }] });
  assert.equal(memory.bookmarks?.updatedAt, 100);
});

test('a newer remote section is applied; an older one is ignored', () => {
  const memory: SyncMemory = {};
  planSync({ bookmarks: ['local'] }, memory, [], 100);
  const newer = planSync({ bookmarks: ['local'] }, memory, [remote('b', { bookmarks: { updatedAt: 200, data: ['remote'] } })], 300);
  assert.deepEqual(newer.apply, { bookmarks: ['remote'] });
  assert.equal(memory.bookmarks?.updatedAt, 200);
  assert.deepEqual(newer.publish.bookmarks, { updatedAt: 200, data: ['remote'] });
  const older = planSync({ bookmarks: ['remote'] }, memory, [remote('c', { bookmarks: { updatedAt: 150, data: ['stale'] } })], 400);
  assert.deepEqual(older.apply, {});
});

test('a local edit since the last sync wins over an older remote and is stamped now', () => {
  const memory: SyncMemory = {};
  planSync({ settings: { engine: 'ddg' } }, memory, [], 100);
  const plan = planSync({ settings: { engine: 'kagi' } }, memory, [remote('b', { settings: { updatedAt: 150, data: { engine: 'bing' } } })], 500);
  assert.deepEqual(plan.apply, {});
  assert.deepEqual(plan.publish.settings, { updatedAt: 500, data: { engine: 'kagi' } });
});

test('a remote with identical content is not reapplied', () => {
  const memory: SyncMemory = {};
  planSync({ research: [1] }, memory, [], 100);
  const plan = planSync({ research: [1] }, memory, [remote('b', { research: { updatedAt: 900, data: [1] } })], 1000);
  assert.deepEqual(plan.apply, {});
});

test('device files are validated', () => {
  assert.equal(normalizeDeviceFile(null), null);
  assert.equal(normalizeDeviceFile({ version: 2, deviceId: 'a', sections: {} }), null);
  assert.equal(normalizeDeviceFile({ version: 1, deviceId: '../x', sections: {} }), null);
  const file = normalizeDeviceFile({ version: 1, deviceId: 'dev-1', deviceName: 'Laptop\u0000', writtenAt: 5,
    sections: { bookmarks: { updatedAt: 3, data: [] }, unknown: { updatedAt: 1, data: 1 }, settings: { updatedAt: 'x', data: {} } } });
  assert.deepEqual(file, { version: 1, deviceId: 'dev-1', deviceName: 'Laptop', writtenAt: 5, sections: { bookmarks: { updatedAt: 3, data: [] } } });
});

test('two devices converge through a shared folder without touching each other\'s files', async () => {
  const { SyncService, normalizeSyncState, SYNC_DIR } = await import('../main/sync-service');
  const os = await import('node:os');
  const fsp = await import('node:fs/promises');
  const path = await import('node:path');
  const folder = await fsp.mkdtemp(path.join(os.tmpdir(), 'quiver-sync-'));
  let clock = 1000;
  const device = (name: string) => {
    const data = { bookmarks: [] as unknown, settings: { engine: 'ddg' } as unknown };
    const state = normalizeSyncState({ folder, deviceName: name }, name);
    const adapter = (key: 'bookmarks' | 'settings') => ({ get: () => data[key], set: (v: unknown) => { data[key] = v; } });
    const none = { get: () => [], set: () => {} };
    const service = new SyncService(state, { bookmarks: adapter('bookmarks'), settings: adapter('settings'), spaces: none, research: none, boosts: none }, () => {}, () => {}, () => clock++);
    return { data, state, service };
  };
  const a = device('A');
  const b = device('B');
  await a.service.syncNow();
  await b.service.syncNow();
  a.data.bookmarks = [{ title: 'X', url: 'https://x.example/' }];
  await a.service.syncNow();
  await b.service.syncNow();
  assert.deepEqual(b.data.bookmarks, [{ title: 'X', url: 'https://x.example/' }]);
  assert.match(b.state.last!.message, /Updated bookmarks/);
  b.data.settings = { engine: 'kagi' };
  await b.service.syncNow();
  await a.service.syncNow();
  assert.deepEqual(a.data.settings, { engine: 'kagi' });
  assert.deepEqual(a.data.bookmarks, [{ title: 'X', url: 'https://x.example/' }]);
  const files = (await fsp.readdir(path.join(folder, SYNC_DIR))).sort();
  assert.deepEqual(files, [`${a.state.deviceId}.json`, `${b.state.deviceId}.json`].sort());
  await fsp.writeFile(path.join(folder, SYNC_DIR, 'garbage.json'), '{not json');
  await a.service.syncNow();
  assert.equal(a.state.last!.ok, false);
  assert.deepEqual(a.data.settings, { engine: 'kagi' });
  await fsp.rm(folder, { recursive: true, force: true });
});

test('synced Spaces are validated before they touch tabs', async () => {
  const { normalizeSyncedSpaces } = await import('../main/sync');
  const ok = (url: string) => url.startsWith('https://');
  assert.deepEqual(normalizeSyncedSpaces([
    { id: 'w', name: ' Work\u0000 ', color: '#ABCDEF', isolated: true, folders: [], pinned: [
      { url: 'https://a.example/', title: ' A ', folderId: 'f1' }, { url: 'javascript:alert(1)' }, { url: 'https://b.example/', folderId: '../x' }] },
    { id: 'w', name: 'dup' }, { id: 'bad id' }, null,
    { id: 'p', name: '', color: 'red', pinned: 'nope' },
  ], ok), [
    { id: 'w', name: 'Work', color: '#ABCDEF', isolated: true, folders: [], pinned: [{ url: 'https://a.example/', title: 'A', folderId: 'f1' }, { url: 'https://b.example/' }] },
    { id: 'p', name: 'Space', color: '#5b8cff', isolated: false, folders: undefined, pinned: [] },
  ]);
});
