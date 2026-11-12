import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Input } from 'electron';
import { shortcutFor } from '../main/shortcuts';
import { placeWindow } from '../main/window-placement';
import { CLOSED_TAB_LIMIT, hasSavedNewTabPlaceholder, normalizeRecentlyClosed, rememberClosed, restoreRecentlyClosed, restoreSelection, snapshotRecentlyClosed, snapshotSpace, type ClosedTab } from '../main/session-recovery';

const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const left = { x: -1280, y: 80, width: 1280, height: 720 };

test('window placement preserves a negative-coordinate monitor and fits its work area', () => {
  const saved = { x: -1210, y: 100, width: 1000, height: 600, maximized: true };
  const placement = placeWindow(saved, [left, primary], primary);
  assert.deepEqual(placement.bounds, { x: -1210, y: 100, width: 1000, height: 600 });
  assert.equal(placement.maximized, true);
  assert.equal(placement.relocated, false);
});

test('window from a disconnected display is centered on the primary work area', () => {
  const saved = { x: -1210, y: 100, width: 1000, height: 600 };
  const placement = placeWindow(saved, [primary], primary);
  assert.deepEqual(placement.bounds, { x: 460, y: 220, width: 1000, height: 600 });
  assert.equal(placement.relocated, true);
});

test('oversize window and window minimum adapt to a small scaled work area', () => {
  const scaled = { x: 20, y: 32, width: 680, height: 432 };
  const saved = { x: -20, y: 0, width: 2000, height: 1100 };
  const placement = placeWindow(saved, [scaled], scaled);
  assert.deepEqual(placement.bounds, scaled);
  assert.equal(placement.minWidth, 680);
  assert.equal(placement.minHeight, 432);
  assert.equal(placement.relocated, false);
});

test('partially visible window chooses the display with the greatest overlap', () => {
  const placement = placeWindow({ x: -600, y: 160, width: 900, height: 520 }, [left, primary], primary);
  assert.deepEqual(placement.bounds, { x: -900, y: 160, width: 900, height: 520 });
});

test('invalid saved coordinates and dimensions fall back to centered defaults', () => {
  const placement = placeWindow({ x: 2 ** 32, y: NaN, width: -10, height: Infinity }, [primary], primary);
  assert.deepEqual(placement.bounds, { x: 280, y: 90, width: 1360, height: 860 });
  assert.equal(placement.relocated, false);
});

test('session selection follows the active tab after skipping non-restorable entries', () => {
  const entries = [
    { id: 1, url: 'data:text/html,private' },
    { id: 2, url: 'https://example.test/first' },
    { id: 3, url: 'https://example.test/active?filter=a#results' },
  ];
  const state = snapshotSpace(entries, 3);
  assert.equal(state.activeIndex, 1);
  assert.equal(state.tabs[1].url, entries[2].url);
  assert.equal(restoreSelection(entries, 0).entries[0].id, 2);
  assert.equal(restoreSelection(entries, 99).activeIndex, 1);
});

test('recently closed tabs retain original Space and order without recording placeholders or data URLs', () => {
  let stack: ClosedTab[] = [];
  for (let i = 0; i < 25; i++) {
    stack = rememberClosed(stack, { id: i, spaceId: 'qa', index: i, url: 'https://example.test/' + i, title: 'Test tab' });
  }
  stack = rememberClosed(stack, { id: 99, spaceId: 'work', index: 0, url: 'quiver://app/newtab.html', title: 'New Tab' });
  stack = rememberClosed(stack, { id: 99, spaceId: 'work', index: 0, url: 'data:text/html,private', title: 'Data tab' });
  assert.equal(stack.length, CLOSED_TAB_LIMIT);
  assert.equal(stack[0].spaceId, 'qa');
  assert.equal(stack[0].index, 24);
  assert.equal(stack.at(-1)?.index, 5);
});

test('session and undo preserve local files and an intentional blank tab', () => {
  const entries = [
    { id: 1, url: 'file:///C:/Quiver%20Fixture/guide.html' },
    { id: 2, url: 'about:blank' },
    { id: 3, url: 'about:config' },
    { id: 4, url: 'javascript:void(0)' },
    { id: 5, url: '' },
  ];
  const state = snapshotSpace(entries, 2);
  assert.deepEqual(state.tabs, entries.slice(0, 2).map(({ url }) => ({ url })));
  assert.equal(state.activeIndex, 1);
  assert.equal(rememberClosed([], { ...entries[0], title: 'Guide', spaceId: 'work', index: 1 })[0].url, entries[0].url);
  assert.equal(rememberClosed([], { ...entries[1], title: 'Blank', spaceId: 'work', index: 2 })[0].url, entries[1].url);
});

test('Ctrl+Shift+T reopens a tab and Ctrl+T still opens the command bar', () => {
  const key = { type: 'keyDown', code: 'KeyT', control: true, shift: false, alt: false } as Input;
  assert.equal(shortcutFor({ ...key, shift: true }), 'reopen-tab');
  assert.equal(shortcutFor(key), 'command-new');
});

test('closed history handles legacy and malformed state without storing credentials', () => {
  const known = new Set(['qa', 'work']);
  const base = { spaceId: 'qa', index: 2, title: 'fixture', url: 'https://example.test/path' };
  assert.deepEqual(normalizeRecentlyClosed(undefined, known), []);
  assert.deepEqual(normalizeRecentlyClosed({ url: base.url }, known), []);
  const clean = normalizeRecentlyClosed([
    null,
    { ...base, spaceId: 'deleted' },
    { ...base, index: -1 },
    { ...base, index: Number.MAX_SAFE_INTEGER + 1 },
    { ...base, url: 'https://login:secret@example.test/path' },
    { ...base, url: 'quiver://app/newtab.html?blank=1' },
    { ...base, url: 'https://example.test/' + 'a'.repeat(9000) },
    { ...base, id: 999, placeholderId: 111, title: 'x'.repeat(9000), replacePlaceholder: 'true' },
  ], known);
  assert.deepEqual(clean, [{ ...base, title: 'x'.repeat(200) }]);
  assert.equal(rememberClosed([], { ...base, id: 1, url: 'https://login:secret@example.test/path' }).length, 1);
});

test('closed history keeps at most twenty newest entries and only one proven placeholder per Space', () => {
  const entries = Array.from({ length: 25 }, (_, index) => ({
    id: index + 10, spaceId: 'qa', index, title: 'fixture', url: 'https://example.test/' + index, placeholderId: 99,
  }));
  const known = new Set(['qa']);
  const snapshot = snapshotRecentlyClosed(entries, known, new Map([['qa', 99]]));
  assert.equal(snapshot.length, CLOSED_TAB_LIMIT);
  assert.deepEqual(snapshot.map(({ index }) => index), Array.from({ length: 20 }, (_, index) => index));
  assert.deepEqual(snapshot[0], { spaceId: 'qa', index: 0, title: 'fixture', url: 'https://example.test/0', replacePlaceholder: true });
  assert.equal(snapshot.slice(1).some((entry) => entry.replacePlaceholder), false);
  assert.equal(snapshotRecentlyClosed(entries, known, new Map([['qa', 100]]))[0].replacePlaceholder, undefined);
  assert.equal(normalizeRecentlyClosed(snapshot, known)[0].replacePlaceholder, undefined);
  let id = 101;
  const restored = restoreRecentlyClosed(snapshot, () => id++, new Map([['qa', 100]]));
  assert.equal(restored[0].id, 101);
  assert.equal(restored[0].placeholderId, 100);
  assert.equal(restored[1].placeholderId, undefined);
  assert.equal(restoreRecentlyClosed(snapshot, () => id++, new Map())[0].placeholderId, undefined);
});

test('placeholder provenance requires the sole saved New Tab to carry its own marker', () => {
  const url = 'quiver://app/newtab.html';
  assert.equal(hasSavedNewTabPlaceholder([{ url, automaticPlaceholder: true }]), true);
  assert.equal(hasSavedNewTabPlaceholder([{ url }]), false);
  assert.equal(hasSavedNewTabPlaceholder([{ url, automaticPlaceholder: 'true' }]), false);
  assert.equal(hasSavedNewTabPlaceholder([{ url, automaticPlaceholder: true }, { url }]), false);
  assert.equal(hasSavedNewTabPlaceholder([{ url: 'quiver://newtab', automaticPlaceholder: true }]), false);
});
