import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LITTLE_CASCADE_STEP, LITTLE_CASCADE_STEPS, LITTLE_DEFAULT_SIZE, LITTLE_MIN_SIZE, littleBounds, littleHeading, normalizeLittleSize, opensInLittle,
} from '../main/little-quiver-layout';
import { isShiftClickOpen, openTarget } from '../main/split';
import { BROWSER_COMMANDS, paletteSuggestions } from '../main/palette';
import { internalPage, internalRole } from '../main/internal-access';
import { allowsInternalNavigation, isInternalTabPage } from '../main/browser-policy';
import { parseLaunchArgs } from '../main/launch-args';
import { defaultState, Store } from '../main/store';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const area = { x: 0, y: 0, width: 1920, height: 1040 };

test('a remembered Little Quiver size is used only when it is a sensible whole-pixel size', () => {
  assert.deepEqual(normalizeLittleSize({ width: 800, height: 600 }), { width: 800, height: 600 });
  assert.equal(normalizeLittleSize({ width: 100, height: 600 }), undefined);
  assert.equal(normalizeLittleSize({ width: 800, height: 10 }), undefined);
  assert.equal(normalizeLittleSize({ width: 800.5, height: 600 }), undefined);
  assert.equal(normalizeLittleSize({ width: '800', height: 600 }), undefined);
  assert.equal(normalizeLittleSize({ width: 1e9, height: 600 }), undefined);
  assert.equal(normalizeLittleSize(null), undefined);
  assert.equal(normalizeLittleSize([800, 600]), undefined);
});

test('Little Quiver windows open at the remembered size and cascade without leaving the work area', () => {
  const first = littleBounds(undefined, area, 0);
  assert.equal(first.width, LITTLE_DEFAULT_SIZE.width);
  assert.equal(first.height, LITTLE_DEFAULT_SIZE.height);
  const second = littleBounds(undefined, area, 1);
  assert.equal(second.x - first.x, LITTLE_CASCADE_STEP);
  assert.equal(second.y - first.y, LITTLE_CASCADE_STEP);
  // The cascade wraps back to the first position.
  assert.deepEqual(littleBounds(undefined, area, LITTLE_CASCADE_STEPS), first);
  for (let i = 0; i < 20; i++) {
    const r = littleBounds({ width: 1200, height: 900 }, area, i);
    assert.ok(r.x >= area.x && r.y >= area.y && r.x + r.width <= area.x + area.width && r.y + r.height <= area.y + area.height, `index ${i}`);
  }
  assert.deepEqual(littleBounds({ width: 700, height: 500 }, area, 0).width, 700);
});

test('Little Quiver fits a small or offset display', () => {
  const small = { x: -1280, y: 40, width: 1280, height: 680 };
  const r = littleBounds({ width: 1600, height: 1000 }, small, 3);
  assert.equal(r.width, 1280);
  assert.equal(r.height, 680);
  assert.equal(r.x, -1280);
  assert.equal(r.y, 40);
  const tiny = littleBounds(undefined, { x: 0, y: 0, width: 300, height: 200 }, 0);
  assert.ok(tiny.width <= 300 && tiny.height <= 200);
  assert.ok(LITTLE_MIN_SIZE.width > 300);
});

test('the toolbar label uses the page title and falls back to the host', () => {
  assert.deepEqual(littleHeading('https://example.com/a', 'Example page'), { title: 'Example page', host: 'example.com' });
  assert.deepEqual(littleHeading('https://example.com:8443/a', '  '), { title: 'example.com:8443', host: 'example.com:8443' });
  assert.equal(littleHeading('https://example.com/', 'a\u202eb\nc').title, 'a b c');
  assert.equal(littleHeading('about:blank', '').host, '');
});

test('only web links from other apps open in Little Quiver, and only when it is on', () => {
  assert.equal(opensInLittle(true, 'https://example.com/'), true);
  assert.equal(opensInLittle(true, 'http://localhost:3000/'), true);
  assert.equal(opensInLittle(false, 'https://example.com/'), false);
  assert.equal(opensInLittle(true, 'file:///C:/x'), false);
  assert.equal(opensInLittle(true, 'javascript:alert(1)'), false);
  // Launch arguments still only carry http(s) addresses.
  assert.deepEqual(parseLaunchArgs(['quiver', 'https://example.com/', '--flag', 'file:///x']).urls, ['https://example.com/']);
});

test('Shift+click is told apart from popups and tab clicks', () => {
  assert.equal(isShiftClickOpen({ url: 'https://a.test/', disposition: 'new-window', features: '' }), true);
  assert.equal(isShiftClickOpen({ url: 'https://a.test/', disposition: 'new-window', features: 'width=500,height=600' }), false);
  assert.equal(isShiftClickOpen({ url: 'https://a.test/', disposition: 'new-window', features: 'popup' }), false);
  assert.equal(isShiftClickOpen({ url: 'https://a.test/', disposition: 'foreground-tab', features: '' }), false);
  assert.equal(isShiftClickOpen({ url: 'https://a.test/', disposition: 'background-tab', features: '' }), false);
});

test('new-window requests go to Peek, a tab, or nowhere', () => {
  const regular = { pinned: false, internal: false };
  const pinned = { pinned: true, internal: false };
  const on = { peekLinks: true, peekShiftClick: true };
  const shift = { url: 'https://a.test/', disposition: 'new-window', features: '' };
  const blank = { url: 'https://a.test/', disposition: 'foreground-tab', features: '' };
  assert.equal(openTarget(regular, on, shift), 'peek');
  assert.equal(openTarget(regular, on, blank), 'tab');
  assert.equal(openTarget(regular, { ...on, peekShiftClick: false }, shift), 'tab');
  assert.equal(openTarget(pinned, on, blank), 'peek');
  assert.equal(openTarget(pinned, { peekLinks: false, peekShiftClick: true }, blank), 'tab');
  assert.equal(openTarget(pinned, { peekLinks: false, peekShiftClick: true }, shift), 'peek');
  // A sign-in popup stays a tab, as before.
  assert.equal(openTarget(regular, on, { ...shift, features: 'width=500' }), 'tab');
  assert.equal(openTarget({ pinned: false, internal: true }, on, shift), 'tab');
  assert.equal(openTarget(regular, on, { ...shift, url: 'javascript:alert(1)' }), 'none');
  assert.equal(openTarget(regular, on, { ...shift, url: 'file:///C:/x' }), 'none');
});

test('the command bar offers "Open in Quiver" only while a Little Quiver window is open', () => {
  const sources = { activeSpaceId: 's', tabs: [], bookmarks: [] };
  const labels = (n?: number) => paletteSuggestions('actions', 'open in quiver', { ...sources, littleWindows: n }).map((s) => s.action);
  assert.ok(!labels(0).some((a) => a.type === 'browser' && a.command === 'little-open'));
  assert.ok(!labels(undefined).some((a) => a.type === 'browser' && a.command === 'little-open'));
  assert.deepEqual(labels(2)[0], { type: 'browser', command: 'little-open' });
  assert.equal(BROWSER_COMMANDS.find((c) => c.command === 'little-open')?.keys, 'Ctrl+O');
});

test('the Little Quiver toolbar is its own internal page that no tab can become', () => {
  assert.equal(internalPage('quiver://app/little.html'), 'little');
  assert.equal(internalRole('quiver://app/little.html', 'little', true), 'little');
  assert.equal(internalRole('quiver://app/little.html', 'little', false), undefined);
  assert.equal(internalRole('quiver://app/little.html', 'settings', true), undefined);
  assert.equal(internalRole('quiver://app/settings.html', 'little', true), undefined);
  assert.equal(isInternalTabPage('little'), false);
  assert.equal(allowsInternalNavigation('quiver://app/little.html', true, 'little'), true);
  assert.equal(allowsInternalNavigation('https://example.com/', true, 'little'), false);
});

test('the state file keeps a valid Little Quiver size and both new settings default to on', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiver-little-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json');
  const saved = { ...defaultState(), littleQuiverSize: { width: 840, height: 640 } } as unknown as Record<string, unknown>;
  const settings = { ...(saved.settings as Record<string, unknown>) };
  delete settings.littleQuiver;
  delete settings.peekShiftClick;
  saved.settings = settings;
  fs.writeFileSync(file, JSON.stringify(saved));
  const store = new Store(file);
  assert.deepEqual(store.state.littleQuiverSize, { width: 840, height: 640 });
  assert.equal(store.state.settings.littleQuiver, true);
  assert.equal(store.state.settings.peekShiftClick, true);
  fs.writeFileSync(file, JSON.stringify({ ...saved, littleQuiverSize: { width: -5, height: 'x' }, settings: { ...settings, littleQuiver: false } }));
  const edited = new Store(file);
  assert.equal(edited.state.littleQuiverSize, undefined);
  assert.equal(edited.state.settings.littleQuiver, false);
});
