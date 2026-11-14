import assert from 'node:assert/strict';
import test from 'node:test';
import { ArcImports, validArcImportUndo, type ArcImportSpace } from '../main/arc-import';
import { normalizeArcSpace, webSpacePartition } from '../main/space-session';
import { snapshotSpace } from '../main/session-recovery';
import type { PersistedState } from '../main/store';

function source(): string {
  const normal = { default: true };
  const other = { custom: { _0: { directoryBasename: 'Private profile', machineID: 'private-machine' } } };
  const tab = (url: string, title?: string) => ({ title, data: { tab: { savedURL: url } } });
  return JSON.stringify({ sidebar: { containers: [{
    spaces: [
      'b', { title: 'Work', profile: normal, containerIDs: ['pinned', 'pin', 'unpinned', 'today'] },
      'a', { title: 'Personal', profile: normal },
      'c', { title: 'Work', profile: other },
    ],
    items: [
      'pin', { childrenIds: ['folder'] },
      'folder', { title: 'Projects', data: { list: {} }, childrenIds: ['nested'] },
      'nested', { title: 'Archive', data: { tabGroup: {} }, childrenIds: ['leaf'] },
      'leaf', tab('https://pin.test/private?key=secret#anchor', 'A custom name'),
      'today', { childrenIds: ['ordinary'] },
      'ordinary', tab('https://today.test/page'),
      'favorites', { childrenIds: ['favorite'] },
      'favorite', tab('https://favorite.test/page', 'A favorite'),
    ],
    topAppsContainerIDs: [normal, 'favorites'],
  }] } });
}

function fixture(state = {
  version: 1, spaces: [{ id: 'main', name: 'Main', color: '#5b8cff', isolated: false }],
  activeSpaceId: 'main', tabsBySpace: { main: [{ url: 'https://existing.test/' }] },
  activeIndexBySpace: { main: 0 }, recentlyClosed: [], bookmarks: [{ url: 'https://bookmark.test/', title: 'Unrelated' }],
} as unknown as PersistedState) {
  const runtime = new Map<string, ArcImportSpace>();
  let acceptSave = true;
  let stageFailure = false;
  let requeued = 0;
  const imports = new ArcImports(state, () => acceptSave, () => { requeued++; }, {
    stage: (entries) => {
      if (stageFailure) throw new Error('Cannot create view');
      for (const entry of entries) runtime.set(entry.space.id, entry);
      return () => { for (const { space } of entries) runtime.delete(space.id); };
    },
    remove: (spaces) => { for (const space of spaces) runtime.delete(space.id); },
  }, () => 100);
  return {
    imports, runtime, state, owner: {}, failedSaves: () => requeued,
    rejectSave: (reject: boolean) => { acceptSave = !reject; },
    rejectStage: (reject: boolean) => { stageFailure = reject; },
  };
}

function review(f: ReturnType<typeof fixture>, raw = source()) {
  const result = f.imports.preview(f.owner, raw);
  assert.ok('token' in result);
  return result;
}

test('review is read-only, owner and token bound, and commits ordered grouped lazy Spaces', () => {
  const f = fixture();
  const before = JSON.stringify(f.state);
  const { token, preview } = review(f);
  assert.ok(token);
  assert.doesNotMatch(JSON.stringify(preview), /secret|anchor|private-machine|Private profile|https:/);
  assert.equal(JSON.stringify(f.state), before);
  assert.equal(f.runtime.size, 0);
  assert.ok('error' in f.imports.commit({}, token));
  assert.ok('error' in f.imports.commit(f.owner, 'wrong-token'));
  assert.deepEqual(f.imports.commit(f.owner, token), { importedSpaces: 3, importedTabs: 4 });
  assert.ok('error' in f.imports.commit(f.owner, token));
  assert.equal(f.state.activeSpaceId, 'main');
  const [main, work, personal, custom] = f.state.spaces;
  assert.deepEqual(f.state.spaces.map((s) => s.name), ['Main', 'Work', 'Personal', 'Work']);
  assert.equal(webSpacePartition(work), webSpacePartition(personal));
  assert.notEqual(webSpacePartition(work), webSpacePartition(custom));
  assert.notEqual(webSpacePartition(work), webSpacePartition(main));
  assert.match(webSpacePartition(work), /^persist:[\w-]{1,80}$/);
  assert.ok(work.folders);
  assert.deepEqual(work.folders.map(({ name, parentId }) => [name, parentId]), [
    ['Projects', null], ['Archive', work.folders[0].id],
  ]);
  const [favorite, pin, today] = f.state.tabsBySpace[work.id];
  assert.equal(favorite.folderId, undefined);
  assert.equal(pin.url, 'https://pin.test/private?key=secret#anchor');
  assert.equal(pin.customTitle, 'A custom name');
  assert.equal(pin.folderId, work.folders![1].id);
  assert.equal(pin.pinned, true);
  assert.equal(today.pinned, undefined);
  assert.equal(f.state.tabsBySpace[personal.id].length, 1);
  assert.equal(f.state.tabsBySpace[custom.id].length, 0);
});

test('undo survives the persisted restore/snapshot round trip and preserves unrelated edits', () => {
  const f = fixture();
  f.imports.commit(f.owner, review(f).token);
  const state = JSON.parse(JSON.stringify(f.state)) as PersistedState;
  state.arcImportUndo = validArcImportUndo(state.arcImportUndo);
  state.spaces = state.spaces.map(normalizeArcSpace);
  for (const space of state.spaces.slice(1)) {
    const entries = state.tabsBySpace[space.id].map((tab, id) => ({ id, ...tab }));
    state.tabsBySpace[space.id] = snapshotSpace(entries, 0).tabs;
  }
  const restarted = fixture(state);
  const { canUndo, undoId } = restarted.imports.status();
  assert.equal(canUndo, true);
  assert.ok(undoId);
  state.spaces[0].name = 'Changed Main';
  state.tabsBySpace.main.push({ url: 'https://new.test/' });
  assert.deepEqual(restarted.imports.undo(undoId), { removedSpaces: 3 });
  assert.equal(state.spaces[0].name, 'Changed Main');
  assert.equal(state.tabsBySpace.main.length, 2);
  assert.equal(state.bookmarks.length, 1);
  assert.deepEqual(restarted.imports.status(), { canUndo: false });
});

test('failed commits and undo restore candidate state, and edits make undo unavailable', () => {
  const f = fixture();
  const before = JSON.stringify(f.state);
  f.rejectStage(true);
  assert.ok('error' in f.imports.commit(f.owner, review(f).token));
  assert.equal(JSON.stringify(f.state), before);
  f.rejectStage(false);
  f.rejectSave(true);
  assert.ok('error' in f.imports.commit(f.owner, review(f).token));
  assert.equal(JSON.stringify(f.state), before);
  assert.equal(f.runtime.size, 0);
  f.rejectSave(false);
  f.imports.commit(f.owner, review(f).token);
  const beforeUndo = JSON.stringify(f.state);
  const { undoId } = f.imports.status();
  f.rejectSave(true);
  assert.ok('error' in f.imports.undo(undoId));
  assert.equal(JSON.stringify(f.state), beforeUndo);
  assert.equal(f.runtime.size, 3);
  assert.equal(f.failedSaves(), 3);
  f.rejectSave(false);
  assert.ok('error' in f.imports.undo('another-batch'));
  const imported = f.state.spaces[1].id;
  f.state.tabsBySpace[imported][0].lastActiveAt = 200;
  assert.deepEqual(f.imports.status(), { canUndo: false, importedSpaces: 3 });
  assert.ok('error' in f.imports.undo(undoId));
});

test('separate import batches use fresh groups and latest undo cannot remove an earlier batch', () => {
  const f = fixture();
  f.imports.commit(f.owner, review(f).token);
  const first = f.imports.status().undoId;
  f.imports.commit(f.owner, review(f).token);
  const second = f.imports.status().undoId;
  assert.notEqual(first, second);
  assert.notEqual(webSpacePartition(f.state.spaces[1]), webSpacePartition(f.state.spaces[4]));
  assert.ok('error' in f.imports.undo(first));
  assert.deepEqual(f.imports.undo(second), { removedSpaces: 3 });
  assert.equal(f.state.spaces.length, 4);
  assert.equal(f.runtime.size, 3);
});

test('opening a previously empty imported Space prevents undo from removing new tabs', () => {
  const f = fixture();
  f.imports.commit(f.owner, review(f).token);
  const { undoId } = f.imports.status();
  const empty = f.state.spaces[3].id;
  assert.equal(f.state.tabsBySpace[empty].length, 0);
  f.state.activeSpaceId = empty;
  assert.ok('error' in f.imports.undo(undoId));
  f.state.tabsBySpace[empty].push({ url: 'quiver://app/newtab.html', lastActiveAt: 200 });
  f.state.activeSpaceId = 'main';
  assert.equal(f.imports.status().canUndo, false);
  assert.ok('error' in f.imports.undo(undoId));
});

test('keeps pins inside the deepest supported folder and reports flattened source folders', () => {
  const f = fixture();
  const items: unknown[] = ['root', { childrenIds: ['folder-0'] }];
  for (let index = 0; index < 9; index++) {
    items.push(`folder-${index}`, { title: `Folder ${index}`, data: { list: {} }, childrenIds: [index < 8 ? `folder-${index + 1}` : 'tab'] });
  }
  items.push('tab', { data: { tab: { savedURL: 'https://nested.test/' } } });
  const raw = JSON.stringify({ sidebar: { containers: [{ spaces: ['a', { containerIDs: ['pinned', 'root'] }], items }] } });
  const { token, preview } = review(f, raw);
  assert.equal(preview.flattenedFolders, 1);
  assert.deepEqual(f.imports.commit(f.owner, token), { importedSpaces: 1, importedTabs: 1 });
  const [, space] = f.state.spaces;
  assert.equal(space.folders?.length, 8);
  assert.equal(f.state.tabsBySpace[space.id][0].folderId, space.folders?.[7].id);
});
