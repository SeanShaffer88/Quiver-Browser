import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTheme, windowBackground } from '../shared/theme';
// The renderer build emits this module as ESM; Node's module syntax detection loads it here.
import { currentSection, searchTerms, sectionMatches } from '../renderer/settings-search';

test('theme setting keeps known values and falls back to system', () => {
  assert.equal(normalizeTheme('light'), 'light');
  assert.equal(normalizeTheme('dark'), 'dark');
  assert.equal(normalizeTheme('system'), 'system');
  for (const bad of [undefined, null, '', 'Dark', 'blue', 1, {}]) assert.equal(normalizeTheme(bad), 'system');
});

test('window background matches the palette', () => {
  assert.equal(windowBackground(true), '#14161a');
  assert.equal(windowBackground(false), '#f6f7f9');
});

test('settings search matches every word in any order, ignoring case and spacing', () => {
  const privacy = 'Privacy  Secure DNS\nClear on exit Delete cookies';
  assert.deepEqual(searchTerms('  Clear   EXIT '), ['clear', 'exit']);
  assert.equal(sectionMatches(privacy, searchTerms('dns secure')), true);
  assert.equal(sectionMatches(privacy, searchTerms('clear exit')), true);
  assert.equal(sectionMatches(privacy, searchTerms('clear bookmarks')), false);
  assert.equal(sectionMatches(privacy, searchTerms('')), true);
  assert.equal(sectionMatches('on\nexit', searchTerms('on exit')), true);
});

test('current section is the last one at or above the reading line', () => {
  assert.equal(currentSection([20, 400, 900], 96), 0);
  assert.equal(currentSection([-300, 96, 500], 96), 1);
  assert.equal(currentSection([-900, -400, -10], 96), 2);
  assert.equal(currentSection([200, 400], 96), 0);
});
