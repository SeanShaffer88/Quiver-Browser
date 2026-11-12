import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BookmarkImports, validBookmarkUndo, type BookmarkLibrary } from '../main/bookmark-import';
import { BOOKMARK_LIMIT } from '../main/bookmarks';
import { chromiumBookmarkCandidates } from '../main/chromium-bookmarks';

const bookmark = (name: string) => ({ title: name, url: `https://example.test/${name}` });

test('review counts duplicates, unsupported links and capacity without changing the library', () => {
  const state: BookmarkLibrary = { bookmarks: Array.from({ length: BOOKMARK_LIMIT - 1 }, (_, i) => bookmark(String(i))) };
  const owner = {};
  const imports = new BookmarkImports<object>(state, () => true);
  const preview = imports.finish(owner, imports.begin(owner), 'Test source', [
    bookmark('0'), bookmark('new'), bookmark('new'), { url: 'file:///private.txt' }, bookmark('over-capacity'),
  ], true);
  assert.ok('id' in preview);
  assert.deepEqual([preview.toAdd, preview.duplicates, preview.unsupported, preview.overCapacity, preview.scanLimited], [1, 2, 1, 1, true]);
  assert.deepEqual(preview.sample, [bookmark('new')]);
  assert.equal(state.bookmarks.length, BOOKMARK_LIMIT - 1);
});

test('a different owner and an obsolete generation cannot confirm a review', () => {
  const state: BookmarkLibrary = { bookmarks: [] };
  const owner = {};
  const another = {};
  const imports = new BookmarkImports<object>(state, () => true);
  const obsolete = imports.begin(owner);
  const current = imports.begin(another);
  assert.ok('error' in imports.finish(owner, obsolete, 'Slow profile', [bookmark('hidden')], false));
  const preview = imports.finish(another, current, 'Current file', [bookmark('one')], false);
  assert.ok('id' in preview);
  assert.ok('error' in imports.commit(owner, preview.id));
  assert.deepEqual(state.bookmarks, []);
  imports.cancel(another);
  assert.ok('error' in imports.commit(another, preview.id));
});

test('a changed library cannot apply additions from an obsolete preview', () => {
  const state: BookmarkLibrary = { bookmarks: [bookmark('old')] };
  const owner = {};
  const imports = new BookmarkImports<object>(state, () => true);
  const preview = imports.finish(owner, imports.begin(owner), 'Test source', [bookmark('one')], false);
  assert.ok('id' in preview);
  state.bookmarks = [...state.bookmarks, bookmark('another')];
  assert.ok('error' in imports.commit(owner, preview.id));
  assert.deepEqual(state.bookmarks, [bookmark('old'), bookmark('another')]);
});

test('undo removes only the latest saved batch and rejects stale undo controls', () => {
  const state: BookmarkLibrary = { bookmarks: [bookmark('original')] };
  const owner = {};
  const imports = new BookmarkImports<object>(state, () => true);
  const first = imports.finish(owner, imports.begin(owner), 'First import', [bookmark('first')], false);
  assert.ok('id' in first && 'added' in imports.commit(owner, first.id));
  const firstUndo = state.bookmarkUndo;
  const second = imports.finish(owner, imports.begin(owner), 'Second import', [bookmark('second')], false);
  assert.ok('id' in second && 'added' in imports.commit(owner, second.id));
  const secondUndo = validBookmarkUndo(JSON.parse(JSON.stringify(state.bookmarkUndo)), state.bookmarks);
  assert.ok(secondUndo);
  assert.equal(validBookmarkUndo({ ...secondUndo, start: 0 }, state.bookmarks), undefined);
  const restarted = new BookmarkImports<object>(state, () => true);
  assert.ok('error' in restarted.undo(firstUndo?.id));
  assert.deepEqual(restarted.undo(secondUndo.id), { removed: 1 });
  assert.deepEqual(state.bookmarks, [bookmark('original'), bookmark('first')]);
});

test('duplicate-only reviews and failed saves preserve the last undo and library', () => {
  const state: BookmarkLibrary = { bookmarks: [bookmark('original')] };
  const owner = {};
  let save = true;
  const imports = new BookmarkImports<object>(state, () => save);
  const first = imports.finish(owner, imports.begin(owner), 'First import', [bookmark('first')], false);
  assert.ok('id' in first && 'added' in imports.commit(owner, first.id));
  const marker = state.bookmarkUndo;
  const duplicate = imports.finish(owner, imports.begin(owner), 'Duplicates', [bookmark('first')], false);
  assert.ok('id' in duplicate);
  assert.equal(duplicate.toAdd, 0);
  assert.deepEqual(imports.commit(owner, duplicate.id), { added: 0 });
  save = false;
  const failed = imports.finish(owner, imports.begin(owner), 'Failed import', [bookmark('second')], false);
  assert.ok('id' in failed && 'error' in imports.commit(owner, failed.id));
  assert.ok('error' in imports.undo(marker?.id));
  assert.equal(state.bookmarkUndo, marker);
  assert.deepEqual(state.bookmarks, [bookmark('original'), bookmark('first')]);
});

test('Chromium candidate scan retains invalid and duplicate rows for review within the scan cap', () => {
  const repeated = { type: 'url', name: 'Repeated', url: 'https://example.test/' };
  const result = chromiumBookmarkCandidates({ roots: { bar: { type: 'folder', children: [
    { type: 'url', url: 'file:///private' }, ...Array(BOOKMARK_LIMIT).fill(repeated),
  ] } } });
  assert.equal(result.candidates.length, BOOKMARK_LIMIT);
  assert.equal(result.candidates[0].url, 'file:///private');
  assert.equal(result.scanLimited, true);
});
