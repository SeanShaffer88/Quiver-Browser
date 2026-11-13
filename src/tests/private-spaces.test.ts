import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPrivatePartition, isPrivateSpace, newPrivateSpace, persistableState, privatePartition, publicSpaces } from '../main/private-spaces';
import { defaultState, Store, type PersistedState } from '../main/store';
import { BROWSER_COMMANDS } from '../main/palette';
import { shortcutFor } from '../main/shortcuts';

function withPrivate(): { state: PersistedState; id: string } {
  const state = defaultState();
  const space = newPrivateSpace(1_700_000_000_000, 0.5);
  state.spaces.push(space);
  state.activeSpaceId = space.id;
  state.tabsBySpace = { 'space-main': [{ url: 'https://a.example/' }], [space.id]: [{ url: 'https://secret.example/' }] };
  state.activeIndexBySpace = { 'space-main': 0, [space.id]: 0 };
  state.recentlyClosed = [
    { url: 'https://closed.example/', title: 'Closed', spaceId: 'space-main', index: 0 },
    { url: 'https://secret-closed.example/', title: 'Secret', spaceId: space.id, index: 0 },
  ];
  state.archive = [{ url: 'https://secret-archived.example/', title: '', spaceId: space.id, archivedAt: 1 }];
  state.topics = [{ id: 't', name: 'Secret topic', spaceId: space.id, createdAt: 1, updatedAt: 1, notes: '', items: [] } as never];
  state.activeTopicBySpace = { [space.id]: 't' };
  state.downloads = [{ id: 'a', partition: 'persist:quiver-shared' }, { id: 'b', partition: privatePartition(space.id) }];
  return { state, id: space.id };
}

test('a private Space uses an in-memory partition and is marked private', () => {
  const space = newPrivateSpace();
  assert.equal(space.private, true);
  assert.equal(space.name, 'Private');
  const partition = privatePartition(space.id);
  // Electron keeps a partition on disk only when its name starts with "persist:".
  assert.ok(!partition.startsWith('persist:'));
  assert.equal(isPrivatePartition(partition), true);
  assert.equal(isPrivatePartition('persist:quiver-shared'), false);
  assert.equal(isPrivateSpace([space], space.id), true);
  assert.equal(isPrivateSpace(defaultState().spaces, 'space-main'), false);
});

test('private Spaces and everything in them are left out of the saved state', () => {
  const { state, id } = withPrivate();
  const saved = persistableState(state);
  const text = JSON.stringify(saved);
  assert.ok(!text.includes('secret'), text);
  assert.ok(!text.includes(id));
  assert.deepEqual(saved.spaces.map((sp) => sp.id), ['space-main']);
  assert.equal(saved.activeSpaceId, 'space-main');
  assert.deepEqual(saved.recentlyClosed.map((t) => t.url), ['https://closed.example/']);
  assert.deepEqual(saved.downloads, [{ id: 'a', partition: 'persist:quiver-shared' }]);
  // The live state is not changed: the private Space keeps working until it is closed.
  assert.equal(state.spaces.length, 2);
  assert.equal(state.activeSpaceId, id);
});

test('state without private Spaces is saved as is', () => {
  const state = defaultState();
  assert.equal(persistableState(state), state);
});

test('sync never publishes a private Space', () => {
  const { state } = withPrivate();
  assert.deepEqual(publicSpaces(state.spaces).map((sp) => sp.id), ['space-main']);
});

test('the store writes no private Space and ignores one in a hand-edited file', (t: TestContext) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiver-private-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json');
  const store = new Store(file);
  store.state = withPrivate().state;
  assert.equal(store.flush(), true);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('secret'));
  const edited = JSON.parse(fs.readFileSync(file, 'utf8'));
  edited.spaces.push({ id: 'private-x', name: 'Private', color: '#000', isolated: true, private: true });
  edited.activeSpaceId = 'private-x';
  fs.writeFileSync(file, JSON.stringify(edited));
  const reloaded = new Store(file);
  assert.deepEqual(reloaded.state.spaces.map((sp) => sp.id), ['space-main']);
  assert.equal(reloaded.state.activeSpaceId, 'space-main');
});

test('Ctrl+Shift+N opens a private Space and the command bar lists it', () => {
  const key = (code: string, extra: Partial<Electron.Input> = {}) => ({ type: 'keyDown', code, key: '', control: true, shift: true, alt: false, meta: false, ...extra }) as Electron.Input;
  assert.equal(shortcutFor(key('KeyN')), 'private-space');
  assert.equal(shortcutFor(key('KeyN', { shift: false })), null);
  assert.ok(BROWSER_COMMANDS.some((c) => c.command === 'private-space' && c.keys === 'Ctrl+Shift+N'));
});
