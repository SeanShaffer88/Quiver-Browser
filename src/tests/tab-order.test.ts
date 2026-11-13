import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveInGroup } from '../main/tab-order';

const tabs = [
  { id: 1, spaceId: 'a' }, { id: 2, spaceId: 'b' }, { id: 3, spaceId: 'a' },
  { id: 4, spaceId: 'a' }, { id: 5, spaceId: 'b' },
];
const ids = (list: readonly { id: number }[] | null) => list?.map(({ id }) => id);

test('moves a tab to an index within its own Space only', () => {
  assert.deepEqual(ids(moveInGroup(tabs, 4, 0, (t) => t.spaceId)), [4, 2, 1, 3, 5]);
  assert.deepEqual(ids(moveInGroup(tabs, 1, 2, (t) => t.spaceId)), [3, 2, 4, 1, 5]);
  assert.deepEqual(ids(moveInGroup(tabs, 5, 0, (t) => t.spaceId)), [1, 5, 3, 4, 2]);
});

test('clamps out-of-range indexes', () => {
  assert.deepEqual(ids(moveInGroup(tabs, 1, 99, (t) => t.spaceId)), [3, 2, 4, 1, 5]);
  assert.deepEqual(ids(moveInGroup(tabs, 4, -5, (t) => t.spaceId)), [4, 2, 1, 3, 5]);
});

test('returns null when nothing changes or the tab is unknown', () => {
  assert.equal(moveInGroup(tabs, 3, 1, (t) => t.spaceId), null);
  assert.equal(moveInGroup(tabs, 9, 0, (t) => t.spaceId), null);
  assert.equal(moveInGroup(tabs, 1, Number.NaN, (t) => t.spaceId), null);
});

test('Ctrl+Shift+PageUp/PageDown move the tab; Ctrl+PageUp/PageDown switch tabs', async () => {
  const { shortcutFor } = await import('../main/shortcuts');
  const key = { type: 'keyDown', code: 'PageUp', control: true, shift: true, alt: false } as Electron.Input;
  assert.equal(shortcutFor(key), 'move-tab-up');
  assert.equal(shortcutFor({ ...key, code: 'PageDown' }), 'move-tab-down');
  assert.equal(shortcutFor({ ...key, shift: false }), 'prev-tab');
  assert.equal(shortcutFor({ ...key, shift: false, code: 'PageDown' }), 'next-tab');
});
