import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Input } from 'electron';
import { shortcutFor } from '../main/shortcuts';
import { markdownLink, recentOrder } from '../main/keyboard-workflows';
import { paletteQuery } from '../main/palette';

const key = (code: string, mods: Partial<Input> = {}) => shortcutFor({ type: 'keyDown', code, control: false, shift: false, alt: false, ...mods } as Input);

test('Ctrl+Tab walks recently used tabs; Ctrl+PageUp/PageDown keep sidebar order', () => {
  assert.equal(key('Tab', { control: true }), 'recent-tab');
  assert.equal(key('Tab', { control: true, shift: true }), 'recent-tab-back');
  assert.equal(key('PageDown', { control: true }), 'next-tab');
  assert.equal(key('PageUp', { control: true }), 'prev-tab');
});

test('Alt+1..9 switch Spaces; Ctrl+Alt (AltGr) digits stay with the page', () => {
  assert.equal(key('Digit3', { alt: true }), 'space-3');
  assert.equal(key('Digit7', { alt: true, control: true }), null, 'AltGr+7 types { on German layouts');
  assert.equal(key('Digit3', { control: true }), 'tab-3');
});

test('recent order puts the active tab first, then most recent, then the rest in sidebar order', () => {
  assert.deepEqual(recentOrder([5, 3, 9, 1], [1, 2, 3, 4, 5], 3), [3, 5, 1, 2, 4]);
  assert.deepEqual(recentOrder([], [1, 2], 2), [2, 1]);
});

test('Markdown links escape brackets and parentheses', () => {
  assert.equal(markdownLink('Issue [#12] (draft)', 'https://x.example/a_(b)'), '[Issue \\[#12\\] (draft)](https://x.example/a_%28b%29)');
  assert.equal(markdownLink('', 'https://x.example/'), '[x.example](https://x.example/)');
  assert.equal(markdownLink('a', 'https://x.example/a b'), '[a](https://x.example/a%20b)');
});

test('? lists actions like >', () => {
  assert.deepEqual(paletteQuery('?'), { scope: 'actions', query: '' });
  assert.deepEqual(paletteQuery('? zoom'), { scope: 'actions', query: 'zoom' });
});
