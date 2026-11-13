import { test } from 'node:test';
import assert from 'node:assert/strict';
// The renderer build emits this module as ESM; Node's module syntax detection loads it here.
import { scrollToReveal, visibleRows } from '../renderer/virtual-list';

const row = 32;

test('renders only the rows in view plus overscan', () => {
  assert.deepEqual(visibleRows({ count: 500, rowHeight: row, scrollTop: 3200, viewport: 320, overscan: 4 }), [
    96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113,
  ]);
});

test('clamps at both ends and handles empty or tiny lists', () => {
  assert.deepEqual(visibleRows({ count: 3, rowHeight: row, scrollTop: 0, viewport: 320, overscan: 4 }), [0, 1, 2]);
  assert.deepEqual(visibleRows({ count: 0, rowHeight: row, scrollTop: 0, viewport: 320, overscan: 4 }), []);
  assert.deepEqual(visibleRows({ count: 10, rowHeight: row, scrollTop: 9999, viewport: 64, overscan: 1 }), [7, 8, 9]);
});

test('keeps pinned rows (active, focused, dragged) rendered in order', () => {
  assert.deepEqual(visibleRows({ count: 500, rowHeight: row, scrollTop: 0, viewport: 64, overscan: 0, keep: [400, -1, 1, 600] }), [0, 1, 400]);
});

test('scrolls the least distance to reveal a row', () => {
  assert.equal(scrollToReveal(10, row, 0, 160), 192);
  assert.equal(scrollToReveal(2, row, 320, 160), 64);
  assert.equal(scrollToReveal(5, row, 100, 160), 100);
});
