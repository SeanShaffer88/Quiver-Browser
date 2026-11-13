import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampSplitRatio, opensInPeek, PEEK_HEADER_H, peekRects, ratioAt, relativeTo, SPLIT_DIVIDER_W, SPLIT_STRIP_H, splitPairKey, splitPartner, splitRects,
} from '../main/split';
import { splitSearchQuery, splitSuggestions } from '../main/tab-search';
import { paletteSuggestions } from '../main/palette';
import { commandChoice, type CommandContext } from '../shared/command-preview';
import type { TabCommandTarget } from '../shared/types';

test('split ratios are clamped to 20–80% and bad input falls back to half', () => {
  assert.equal(clampSplitRatio(0.5), 0.5);
  assert.equal(clampSplitRatio(0.05), 0.2);
  assert.equal(clampSplitRatio(0.95), 0.8);
  assert.equal(clampSplitRatio(Number.NaN), 0.5);
  assert.equal(clampSplitRatio(Infinity), 0.5);
  assert.equal(clampSplitRatio('0.3'), 0.5);
  assert.equal(clampSplitRatio(undefined), 0.5);
});

test('a pair has one ratio whichever side each tab is on', () => {
  assert.equal(splitPairKey(3, 7), splitPairKey(7, 3));
  assert.notEqual(splitPairKey(3, 7), splitPairKey(3, 8));
});

test('split panes fill the page area around the divider gap', () => {
  const area = { x: 264, y: 48, width: 1000, height: 700 };
  const r = splitRects(area, 0.5);
  assert.equal(r.left.x, 264);
  assert.equal(r.left.width + r.divider.width + r.right.width, 1000);
  assert.equal(r.divider.width, SPLIT_DIVIDER_W);
  assert.equal(r.divider.x, r.left.x + r.left.width);
  assert.equal(r.right.x, r.divider.x + SPLIT_DIVIDER_W);
  assert.equal(r.right.x + r.right.width, 1264);
  assert.equal(r.left.y, 48 + SPLIT_STRIP_H);
  assert.equal(r.left.height, 700 - SPLIT_STRIP_H);
  assert.equal(r.divider.height, 700);
  const wide = splitRects(area, 0.99);
  assert.equal(wide.left.width, Math.round((1000 - SPLIT_DIVIDER_W) * 0.8));
});

test('the divider position under the pointer maps back to the same ratio', () => {
  const area = { x: 264, y: 48, width: 1008, height: 700 };
  const r = splitRects(area, 0.3);
  const centre = r.divider.x + SPLIT_DIVIDER_W / 2;
  assert.ok(Math.abs(ratioAt(area, centre) - 0.3) < 0.002);
  assert.equal(ratioAt(area, 0), 0.2);
  assert.equal(ratioAt(area, 5000), 0.8);
  assert.equal(ratioAt({ x: 0, width: 4 }, 2), 0.5);
});

test('the split partner is the next tab, else the previous, else none', () => {
  const order = [{ id: 1 }, { id: 2 }, { id: 3 }];
  assert.equal(splitPartner(order, 1), 2);
  assert.equal(splitPartner(order, 3), 2);
  assert.equal(splitPartner([{ id: 1 }], 1), null);
  assert.equal(splitPartner(order, 9), null);
});

test('only http(s) links from pinned web tabs open in Peek, and only when the setting is on', () => {
  const pinned = { pinned: true, internal: false };
  assert.equal(opensInPeek(pinned, true, 'https://example.com/a'), true);
  assert.equal(opensInPeek(pinned, true, 'http://127.0.0.1:3000/'), true);
  assert.equal(opensInPeek(pinned, false, 'https://example.com/a'), false);
  assert.equal(opensInPeek({ pinned: false, internal: false }, true, 'https://example.com/a'), false);
  assert.equal(opensInPeek({ pinned: true, internal: true }, true, 'https://example.com/a'), false);
  assert.equal(opensInPeek(pinned, true, 'javascript:alert(1)'), false);
  assert.equal(opensInPeek(pinned, true, 'file:///C:/x'), false);
  assert.equal(opensInPeek(pinned, true, 'about:blank'), false);
});

test('a Peek is a centred card at 85% with the header above the page', () => {
  const area = { x: 264, y: 48, width: 1000, height: 800 };
  const r = peekRects(area);
  assert.equal(r.frame.width, 850);
  assert.equal(r.frame.height, 680);
  assert.equal(r.frame.x, 264 + 75);
  assert.equal(r.frame.y, 48 + 60);
  assert.deepEqual(r.header, { x: r.frame.x, y: r.frame.y, width: 850, height: PEEK_HEADER_H });
  assert.deepEqual(r.view, { x: r.frame.x, y: r.frame.y + PEEK_HEADER_H, width: 850, height: 680 - PEEK_HEADER_H });
  assert.deepEqual(relativeTo(r.header, { x: 264, y: 48 }), { x: 75, y: 60, width: 850, height: PEEK_HEADER_H });
});

const target = (id: number, spaceId: string, title: string, host = ''): TabCommandTarget => ({
  id, spaceId, spaceName: spaceId, revision: 0, url: host ? `https://${host}/` : 'quiver://app/newtab.html', title, host, environment: null,
});

test('`split …` offers the other tabs of the current Space', () => {
  assert.equal(splitSearchQuery('split'), '');
  assert.equal(splitSearchQuery('split docs'), 'docs');
  assert.equal(splitSearchQuery('Split view with Docs'), 'docs');
  assert.equal(splitSearchQuery('splitter'), undefined);
  const tabs = [target(1, 'm', 'Mail', 'mail.example'), target(2, 'm', 'Docs', 'docs.example'), target(3, 'w', 'Other', 'other.example')];
  const all = splitSuggestions('', 'm', 1, tabs);
  assert.deepEqual(all.map((s) => s.label), ['Split view with Docs']);
  assert.equal(all[0].action.type, 'split-with');
  assert.equal(splitSuggestions('nothing', 'm', 1, tabs)[0].action.type, 'noop');
  const context: CommandContext = {
    spaceId: 'm', spaceName: 'Main', tabId: 1, url: 'https://mail.example/', internal: false, mode: 'current', navigation: 0, navigationPending: false,
  };
  const choice = commandChoice(all[0], context);
  assert.equal(choice.preview.title, 'Split view');
  assert.equal(choice.preview.canRun, true);
  assert.match(choice.accessibleLabel, /^Split view with Docs/);
});

test('the palette lists the split actions', () => {
  const labels = paletteSuggestions('actions', 'split', { activeSpaceId: 'm', tabs: [], bookmarks: [] }).map((s) => s.label);
  assert.ok(labels.includes('Split view with the next tab'));
  assert.ok(labels.includes('Exit split view'));
});
