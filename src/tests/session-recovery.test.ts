import assert from 'node:assert/strict';
import { test } from 'node:test';
import { placeWindow } from '../main/window-placement';
import { CLOSED_TAB_LIMIT, rememberClosed, restoreSelection, snapshotSpace, type ClosedTab } from '../main/session-recovery';

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
