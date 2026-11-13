import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HISTORY_LIMIT, historyUrl, normalizeHistory, recordVisit, type HistoryEntry } from '../main/history';
import { paletteQuery, paletteSuggestions } from '../main/palette';

test('history keeps web URLs without credentials or fragments', () => {
  assert.equal(historyUrl('https://u:p@example.com/a?b=1#c'), 'https://example.com/a?b=1');
  for (const bad of ['quiver://settings', 'file:///C:/x', 'data:text/html,x', 'about:blank']) assert.equal(historyUrl(bad), null);
});

test('visits update one entry per URL, newest first, and cap the list', () => {
  const list: HistoryEntry[] = [];
  recordVisit(list, 'https://a.example/', 'A', 1);
  recordVisit(list, 'https://b.example/', '', 2);
  recordVisit(list, 'https://a.example/#x', 'A again', 3);
  assert.deepEqual(list, [
    { url: 'https://a.example/', title: 'A again', visits: 2, lastVisit: 3 },
    { url: 'https://b.example/', title: '', visits: 1, lastVisit: 2 },
  ]);
  recordVisit(list, 'https://a.example/', '', 4);
  assert.equal(list[0].title, 'A again', 'an empty title keeps the known one');
  for (let i = 0; i < HISTORY_LIMIT + 10; i++) recordVisit(list, `https://e.example/${i}`, '', 10 + i);
  assert.equal(list.length, HISTORY_LIMIT);
  assert.equal(list[0].url, `https://e.example/${HISTORY_LIMIT + 9}`);
});

test('stored history is validated', () => {
  assert.deepEqual(normalizeHistory([{ url: 'https://a.example/', title: 'A\u0000', visits: 3, lastVisit: 9 }, { url: 'javascript:x' }, null, 'x',
    { url: 'https://a.example/', title: 'dup', visits: 1, lastVisit: 1 }, { url: 'https://b.example/', visits: -2, lastVisit: 'x' }]), [
    { url: 'https://a.example/', title: 'A', visits: 3, lastVisit: 9 },
    { url: 'https://b.example/', title: '', visits: 1, lastVisit: 0 },
  ]);
  assert.deepEqual(normalizeHistory({}), []);
});

test('history scope and mixed results in the palette', () => {
  assert.deepEqual(paletteQuery('h rust book'), { scope: 'history', query: 'rust book' });
  assert.deepEqual(paletteQuery('history'), { scope: 'history', query: '' });
  assert.equal(paletteQuery('hx')?.scope, 'all');
  const now = Date.now();
  const history: HistoryEntry[] = [
    { url: 'https://doc.rust-lang.org/book/', title: 'The Rust Programming Language', visits: 12, lastVisit: now },
    { url: 'https://rustacean.example/', title: 'Rust news', visits: 1, lastVisit: now - 90 * 86_400_000 },
    { url: 'https://react.dev/', title: 'React', visits: 3, lastVisit: now },
  ];
  const sources = { activeSpaceId: 's', tabs: [], bookmarks: [{ title: 'React docs', url: 'https://react.dev/' }], history };
  assert.deepEqual(paletteSuggestions('history', 'rust', sources).map((s) => s.label), ['The Rust Programming Language', 'Rust news']);
  assert.deepEqual(paletteSuggestions('history', '', sources).map((s) => s.label), ['The Rust Programming Language', 'React', 'Rust news']);
  assert.deepEqual(paletteSuggestions('history', 'zzz', sources).map((s) => s.action.type), ['noop']);
  const mixed = paletteSuggestions('all', 'react', sources);
  assert.deepEqual(mixed.map((s) => s.kind), ['bookmark'], 'a URL already bookmarked is not repeated from history');
  assert.equal(paletteSuggestions('history', 'rust', sources)[0].detail, 'doc.rust-lang.org/book/');
});
