import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuzzyScore, paletteQuery, paletteSuggestions } from '../main/palette';
import type { TabCommandTarget } from '../shared/types';

test('fuzzy matching accepts substrings, word starts and camel humps, and rejects scattered letters', () => {
  for (const [q, text] of [['dash', 'Orders dashboard'], ['gh', 'GitHub'], ['ghub', 'GitHub'], ['rct', 'Reopen closed tab'], ['phone', 'Toggle phone preview'], ['side', 'Collapse sidebar']]) {
    assert.ok(fuzzyScore(q, text) > 0, `${q} ~ ${text}`);
  }
  for (const [q, text] of [['ad', 'Orders dashboard'], ['xyz', 'GitHub'], ['', 'anything'], ['zzzz', 'z']]) {
    assert.equal(fuzzyScore(q, text), q ? -1 : 0, `${q} !~ ${text}`);
  }
});

test('fuzzy ranking prefers prefixes, then word starts, then later matches', () => {
  assert.ok(fuzzyScore('set', 'Settings') > fuzzyScore('set', 'Reset zoom'));
  assert.ok(fuzzyScore('rel', 'Reload') > fuzzyScore('rel', 'Pull request release notes'));
  assert.ok(fuzzyScore('open settings', 'Open Settings') > fuzzyScore('open settings', 'Reopen closed tab, Settings'));
});

test('palette prefixes narrow the source', () => {
  assert.deepEqual(paletteQuery('> reload'), { scope: 'actions', query: 'reload' });
  assert.deepEqual(paletteQuery('>'), { scope: 'actions', query: '' });
  assert.deepEqual(paletteQuery('bm  docs '), { scope: 'bookmarks', query: 'docs' });
  assert.deepEqual(paletteQuery('bookmark'), { scope: 'bookmarks', query: '' });
  assert.deepEqual(paletteQuery('react docs'), { scope: 'all', query: 'react docs' });
  assert.equal(paletteQuery('bmx'), undefined);
});

const target = (id: number, title: string, spaceId = 'work'): TabCommandTarget => ({
  id, spaceId, spaceName: spaceId, revision: 0, url: `https://${title.toLowerCase().replace(/\W/g, '')}.example/`,
  title, host: `${title.toLowerCase().replace(/\W/g, '')}.example`, environment: null,
});
const sources = {
  activeSpaceId: 'work',
  tabs: [target(1, 'React docs'), target(2, 'Mail', 'home')],
  bookmarks: [{ title: 'React reference', url: 'https://react.dev/reference' }, { title: 'Bad', url: 'javascript:alert(1)' }],
};

test('all-sources results mix actions, tabs and bookmarks by score with a per-kind cap', () => {
  const kinds = paletteSuggestions('all', 'react', sources).map((s) => `${s.kind}:${s.label}`);
  assert.deepEqual(kinds, ['tab:React docs', 'bookmark:React reference']);
  const reload = paletteSuggestions('all', 'reload', sources);
  assert.equal(reload[0].kind, 'action');
  assert.deepEqual(reload[0].action, { type: 'browser', command: 'reload' });
  assert.equal(reload[0].detail, 'Ctrl+R');
});

test('bookmark results only navigate to web or file URLs', () => {
  const urls = paletteSuggestions('bookmarks', '', sources).map((s) => s.action.type === 'navigate' ? s.action.url : s.action.type);
  assert.deepEqual(urls, ['https://react.dev/reference']);
});

test('empty scoped queries list the source; empty results say so', () => {
  assert.ok(paletteSuggestions('actions', '', sources).length >= 10);
  assert.deepEqual(paletteSuggestions('bookmarks', 'nothing here', sources).map((s) => s.action.type), ['noop']);
  assert.deepEqual(paletteSuggestions('all', 'qqqq', sources), []);
});
