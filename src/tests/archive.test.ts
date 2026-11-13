import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ARCHIVE_LIMIT, ARCHIVE_OPTIONS, addArchived, archiveSuggestions, normalizeArchive, normalizeArchiveHours, tabsToArchive } from '../main/archive';

const H = 3_600_000;

test('only unpinned, inactive, silent tabs older than the limit are archived', () => {
  const now = 100 * H;
  const tabs = [
    { id: 1, pinned: false, active: false, audible: false, lastActiveAt: now - 13 * H },
    { id: 2, pinned: true, active: false, audible: false, lastActiveAt: now - 99 * H },
    { id: 3, pinned: false, active: true, audible: false, lastActiveAt: now - 99 * H },
    { id: 4, pinned: false, active: false, audible: true, lastActiveAt: now - 99 * H },
    { id: 5, pinned: false, active: false, audible: false, lastActiveAt: now - 11 * H },
  ];
  assert.deepEqual(tabsToArchive(tabs, now, 12), [1]);
  assert.deepEqual(tabsToArchive(tabs, now, 0), [], 'never');
});

test('archive hours accept only the offered choices', () => {
  assert.deepEqual(ARCHIVE_OPTIONS, [0, 12, 24, 168, 720]);
  assert.equal(normalizeArchiveHours(24), 24);
  assert.equal(normalizeArchiveHours(5), 12);
  assert.equal(normalizeArchiveHours(undefined), 12);
  assert.equal(normalizeArchiveHours(0), 0);
});

test('the archive keeps one entry per URL and Space, newest first, capped', () => {
  let list = addArchived([], { url: 'https://a.example/', title: 'A', spaceId: 's', archivedAt: 1 });
  list = addArchived(list, { url: 'https://b.example/', title: 'B', spaceId: 's', archivedAt: 2 });
  list = addArchived(list, { url: 'https://a.example/', title: 'A2', spaceId: 's', archivedAt: 3 });
  assert.deepEqual(list.map((e) => e.title), ['A2', 'B']);
  for (let i = 0; i < ARCHIVE_LIMIT + 5; i++) list = addArchived(list, { url: `https://e.example/${i}`, title: '', spaceId: 's', archivedAt: 10 + i });
  assert.equal(list.length, ARCHIVE_LIMIT);
});

test('stored archive entries are validated', () => {
  assert.deepEqual(normalizeArchive([
    { url: 'https://a.example/', title: 'A\u0000', spaceId: 's', archivedAt: 5 },
    { url: 'javascript:alert(1)', spaceId: 's' }, { url: 'https://x.example/', spaceId: 'gone' }, null,
  ], new Set(['s'])), [{ url: 'https://a.example/', title: 'A', spaceId: 's', archivedAt: 5 }]);
});

test('archive search', () => {
  const list = [{ url: 'https://react.dev/learn', title: 'Quick Start – React', spaceId: 's', archivedAt: 2 }, { url: 'https://vuejs.org/', title: 'Vue', spaceId: 's', archivedAt: 1 }];
  assert.deepEqual(archiveSuggestions('react', list).map((s) => s.label), ['Quick Start – React']);
  assert.deepEqual(archiveSuggestions('', list).map((s) => s.action), [{ type: 'unarchive', url: 'https://react.dev/learn', archivedAt: 2 }, { type: 'unarchive', url: 'https://vuejs.org/', archivedAt: 1 }]);
  assert.equal(archiveSuggestions('zzz', list)[0].action.type, 'noop');
});
