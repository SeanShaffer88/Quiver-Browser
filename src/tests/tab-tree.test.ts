import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canNest, deleteFolder, displayOrder, normalizeFolders, placeRelative, sidebarRows, type TreeTab } from '../main/tab-tree';
import type { Folder } from '../shared/types';

const folders: Folder[] = [
  { id: 'f1', name: 'Work', parentId: null, collapsed: false },
  { id: 'f2', name: 'Docs', parentId: 'f1', collapsed: false },
  { id: 'f3', name: 'Later', parentId: null, collapsed: true },
];
const tabs: TreeTab[] = [
  { id: 1, pinned: false, folderId: null },
  { id: 2, pinned: true, folderId: 'f2' },
  { id: 3, pinned: true, folderId: null },
  { id: 4, pinned: true, folderId: 'f1' },
  { id: 5, pinned: true, folderId: 'f3' },
  { id: 6, pinned: false, folderId: null },
];

test('sidebar rows list pinned folders and tabs, a divider, then temporary tabs', () => {
  assert.deepEqual(sidebarRows(tabs, folders).map((r) => r.kind === 'tab' ? `t${r.tabId}@${r.depth}` : r.kind === 'folder' ? `${r.id}@${r.depth}:${r.count}` : '--'), [
    'f1@0:2', 'f2@1:1', 't2@2', 't4@1', 'f3@0:1', 't3@0', '--', 't1@0', 't6@0',
  ]);
});

test('no divider without pinned tabs or folders', () => {
  assert.deepEqual(sidebarRows([{ id: 1, pinned: false, folderId: null }], []).map((r) => r.kind), ['tab']);
});

test('display order includes tabs inside collapsed folders', () => {
  assert.deepEqual(displayOrder(tabs, folders), [2, 4, 5, 3, 1, 6]);
});

test('normalize drops bad entries, breaks cycles and re-roots orphans', () => {
  const raw = [
    { id: 'a', name: '  A  ', parentId: 'b', collapsed: false },
    { id: 'b', name: 'B', parentId: 'a', collapsed: 'yes' },
    { id: 'c', name: 'C', parentId: 'missing' },
    { id: 'c', name: 'dup' },
    { id: '', name: 'x' },
    null,
    { id: 'd', name: 'x'.repeat(100), parentId: null },
  ];
  const out = normalizeFolders(raw);
  assert.deepEqual(out.map((f) => [f.id, f.parentId, f.name.length]), [['a', 'b', 1], ['b', null, 1], ['c', null, 1], ['d', null, 40]]);
  assert.equal(out[1].collapsed, false);
  assert.deepEqual(normalizeFolders('nope'), []);
});

test('deleting a folder moves its folders and tabs to its parent', () => {
  const result = deleteFolder(folders, tabs, 'f1');
  assert.deepEqual(result.folders.map((f) => [f.id, f.parentId]), [['f2', null], ['f3', null]]);
  assert.deepEqual(result.tabs.find((t) => t.id === 4), { id: 4, pinned: true, folderId: null });
});

test('a folder cannot nest inside itself or its descendants', () => {
  assert.equal(canNest(folders, 'f1', 'f2'), false);
  assert.equal(canNest(folders, 'f1', 'f1'), false);
  assert.equal(canNest(folders, 'f2', 'f3'), true);
  assert.equal(canNest(folders, 'f2', null), true);
});

test('place a tab before or after another', () => {
  const ids = (l: { id: number }[]) => l.map((t) => t.id);
  assert.deepEqual(ids(placeRelative(tabs, 6, 2, false)), [1, 6, 2, 3, 4, 5]);
  assert.deepEqual(ids(placeRelative(tabs, 1, 4, true)), [2, 3, 4, 1, 5, 6]);
  assert.deepEqual(ids(placeRelative(tabs, 1, 99, true)), [2, 3, 4, 5, 6, 1]);
});

test('session snapshots keep pinned state and folder only for pinned tabs', async () => {
  const { snapshotSpace } = await import('../main/session-recovery');
  const url = 'https://example.test/';
  assert.deepEqual(snapshotSpace([
    { id: 1, url, pinned: true, folderId: 'f1' },
    { id: 2, url, pinned: true, folderId: null },
    { id: 3, url, pinned: false, folderId: 'f1' },
  ], 1).tabs, [{ url, pinned: true, folderId: 'f1' }, { url, pinned: true }, { url }]);
});
