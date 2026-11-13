import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { ARC_IMPORT_TAB_LIMIT, findArcSidebar, planArcImport, type ExistingSpace } from '../main/arc-import';
import type { ArcSidebar, ArcSourceNode } from '../main/arc-sidebar';
import { FOLDER_DEPTH_LIMIT, FOLDER_LIMIT, normalizeFolders } from '../main/tab-tree';

const tab = (url: string, title = url): ArcSourceNode => ({ kind: 'tab', title, host: new URL(url).hostname, url });
const folder = (title: string, children: ArcSourceNode[], kind: 'folder' | 'split' = 'folder'): ArcSourceNode => ({ kind, title, children });

function arc(spaces: Array<[string, ArcSourceNode[]]>, favorites: ArcSourceNode[] = []): ArcSidebar {
  return {
    spaces: spaces.map(([title, pinned]) => ({ title, profile: 0, pinned, pinnedTabs: 0, todayTabs: 0 })),
    profiles: [{ label: 'Default profile', favorites, favoriteTabs: favorites.length }],
    skipped: 0,
    limited: false,
  };
}

function ids() {
  let n = 0;
  return () => `f${++n}`;
}

const main = (urls: string[] = [], extra: Partial<ExistingSpace> = {}): ExistingSpace => ({ id: 'm', name: 'Main', folders: [], urls: new Set(urls), ...extra });

test('maps Spaces, nested folders and pins; Favorites go first into the first Space; splits flatten', () => {
  const plan = planArcImport(arc([
    ['Work', [tab('https://a.test/'), folder('Docs', [tab('https://b.test/', 'B'), folder('Deep', [tab('https://c.test/')]), folder('Split view', [tab('https://d.test/')], 'split')])]],
    ['Home', [tab('https://e.test/')]],
  ], [tab('https://fav.test/')]), [main()], ids());

  assert.equal(plan.spaces.length, 2);
  const [work, home] = plan.spaces;
  assert.equal(work.spaceId, null);
  assert.equal(work.name, 'Work');
  assert.deepEqual(work.folders, [
    { id: 'f1', name: 'Docs', parentId: null, collapsed: false },
    { id: 'f2', name: 'Deep', parentId: 'f1', collapsed: false },
  ]);
  assert.deepEqual(work.tabs, [
    { url: 'https://fav.test/', title: 'https://fav.test/', folderId: null },
    { url: 'https://a.test/', title: 'https://a.test/', folderId: null },
    { url: 'https://b.test/', title: 'B', folderId: 'f1' },
    { url: 'https://c.test/', title: 'https://c.test/', folderId: 'f2' },
    { url: 'https://d.test/', title: 'https://d.test/', folderId: 'f1' },
  ]);
  assert.deepEqual(home.tabs.map((t) => t.url), ['https://e.test/']);
  assert.deepEqual(plan.counts, { spaces: 2, newSpaces: 2, mergedSpaces: 0, pinned: 5, favorites: 1, folders: 2, duplicates: 0, dropped: 0 });
});

test('merges Spaces by name, reuses same-named folders and skips URLs the Space already has, so a re-import adds nothing', () => {
  const docs = { id: 'existing', name: 'Docs', parentId: null, collapsed: true };
  const sidebar = arc([
    ['main', [tab('https://known.test/'), folder('docs', [tab('https://new.test/')])]],
    ['MAIN', [tab('https://new.test/'), tab('https://other.test/')]],
  ]);
  const plan = planArcImport(sidebar, [main(['https://known.test/'], { folders: [docs] })], ids());
  assert.equal(plan.spaces.length, 1);
  assert.equal(plan.spaces[0].spaceId, 'm');
  assert.deepEqual(plan.spaces[0].folders, []);
  assert.deepEqual(plan.spaces[0].tabs, [
    { url: 'https://new.test/', title: 'https://new.test/', folderId: 'existing' },
    { url: 'https://other.test/', title: 'https://other.test/', folderId: null },
  ]);
  assert.deepEqual(plan.counts, { spaces: 1, newSpaces: 0, mergedSpaces: 1, pinned: 2, favorites: 0, folders: 0, duplicates: 2, dropped: 0 });

  const again = planArcImport(sidebar, [main(['https://known.test/', 'https://new.test/', 'https://other.test/'], { folders: [docs] })], ids());
  assert.deepEqual(again.spaces, []);
  assert.equal(again.counts.duplicates, 4);
});

test('only restorable URLs are imported and names are cleaned like folder names', () => {
  const plan = planArcImport(arc([
    ['‮evil\u0000 name', [{ kind: 'tab', title: 'x', host: 'x', url: 'javascript:alert(1)' }, tab('https://ok.test/')]],
    ['   ', []],
  ]), [main()], ids());
  assert.equal(plan.spaces[0].name, 'evil  name');
  assert.deepEqual(plan.spaces[0].tabs.map((t) => t.url), ['https://ok.test/']);
  assert.equal(plan.spaces[1].name, 'Arc Space 2');
  assert.equal(plan.counts.dropped, 1);
});

test('respects folder depth, folder count and tab limits without losing tabs above them', () => {
  let deep: ArcSourceNode = tab('https://deep.test/');
  for (let n = 0; n < FOLDER_DEPTH_LIMIT + 3; n++) deep = folder(`L${n}`, [deep]);
  const many = Array.from({ length: FOLDER_LIMIT + 5 }, (_, n) => folder(`F${n}`, [tab(`https://f${n}.test/`)]));
  const tabs = Array.from({ length: ARC_IMPORT_TAB_LIMIT + 10 }, (_, n) => tab(`https://t${n}.test/`));
  const plan = planArcImport(arc([['Deep', [deep]], ['Many', many], ['Tabs', tabs]]), [main()], ids());

  const [deepSpace, manySpace, tabsSpace] = plan.spaces;
  assert.equal(deepSpace.folders.length, FOLDER_DEPTH_LIMIT);
  assert.equal(normalizeFolders(deepSpace.folders).length, FOLDER_DEPTH_LIMIT);
  assert.equal(deepSpace.tabs[0].folderId, deepSpace.folders.at(-1)!.id);
  assert.equal(manySpace.folders.length, FOLDER_LIMIT);
  assert.equal(manySpace.tabs.length, FOLDER_LIMIT + 5);
  assert.equal(manySpace.tabs.at(-1)!.folderId, null);
  assert.equal(deepSpace.tabs.length + manySpace.tabs.length + tabsSpace.tabs.length, ARC_IMPORT_TAB_LIMIT);
  assert.equal(plan.counts.dropped, 3 + 5 + (FOLDER_LIMIT + 5 + 1 + ARC_IMPORT_TAB_LIMIT + 10 - ARC_IMPORT_TAB_LIMIT));
});

test('Favorites without Arc Spaces go to the first Quiver Space', () => {
  const plan = planArcImport(arc([], [tab('https://fav.test/')]), [main()], ids());
  assert.equal(plan.spaces[0].spaceId, 'm');
  assert.equal(plan.counts.favorites, 1);
});

test('finds the newest StorableSidebar.json among Arc packages', () => {
  const root = path.resolve('/local');
  const files = new Map([
    [path.join(root, 'Packages', 'TheBrowserCompany.Arc_old', 'LocalCache', 'Local', 'Arc', 'StorableSidebar.json'), 1],
    [path.join(root, 'Packages', 'TheBrowserCompany.Arc_ttt', 'LocalCache', 'Local', 'Arc', 'StorableSidebar.json'), 5],
    [path.join(root, 'Packages', 'Other.App_x', 'LocalCache', 'Local', 'Arc', 'StorableSidebar.json'), 9],
  ]);
  const fakeFs = {
    readdirSync: (dir: string) => {
      assert.equal(dir, path.join(root, 'Packages'));
      return ['Other.App_x', 'TheBrowserCompany.Arc_old', 'TheBrowserCompany.Arc_ttt', 'TheBrowserCompany.Arc_none'];
    },
    statSync: (file: string) => {
      const mtimeMs = files.get(file);
      if (mtimeMs === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return { isFile: () => true, mtimeMs };
    },
  } as unknown as Parameters<typeof findArcSidebar>[1];
  assert.equal(findArcSidebar(root, fakeFs), path.join(root, 'Packages', 'TheBrowserCompany.Arc_ttt', 'LocalCache', 'Local', 'Arc', 'StorableSidebar.json'));
  assert.equal(findArcSidebar('', fakeFs), undefined);
  assert.equal(findArcSidebar('relative', fakeFs), undefined);
});
