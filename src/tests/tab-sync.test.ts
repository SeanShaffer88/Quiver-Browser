import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  collectDeviceTabs, HANDOFF_TTL_MS, incomingHandoffs, normalizeDeviceTabs, normalizeHandoffs, otherDevices, planContinue, pruneOutbox,
  publishableUrl, STALE_AFTER_MS, type ContinuityRemote, type DeviceTabs, type LocalTab,
} from '../main/continuity';
import { deviceSuggestions, devicesQuery, remoteTabMatches, sendMatches, sendQuery, sendSuggestions } from '../main/device-commands';
import { normalizeDeviceFile } from '../main/sync';
import { normalizeSyncState, SYNC_DIR, SyncService, type SectionAdapter } from '../main/sync-service';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const tab = (spaceId: string, url: string, extra: Partial<LocalTab> = {}): LocalTab => ({ spaceId, url, title: url, pinned: false, lastActiveAt: NOW - 1000, internal: false, ...extra });

// ───────── privacy filtering ─────────

test('only web addresses without credentials may leave the device', () => {
  assert.equal(publishableUrl('https://example.com/a?b#c'), true);
  assert.equal(publishableUrl('http://localhost:3000/'), true);
  for (const url of [
    'https://user:secret@example.com/', 'https://user@example.com/', 'quiver://settings', 'quiver://app/newtab.html',
    'file:///C:/Users/me/notes.txt', 'data:text/html,hi', 'blob:https://example.com/1', 'about:blank', 'javascript:alert(1)',
    'ftp://example.com/', 'https://exa mple.com/', `https://example.com/${'a'.repeat(5000)}`, '', 42,
  ]) assert.equal(publishableUrl(url), false, String(url));
});

test('published tabs leave out private Spaces, internal pages and credentials', () => {
  const published = collectDeviceTabs(
    [{ id: 'work', name: 'Work', color: '#ff7a59' }, { id: 'private-1', name: 'Private', color: '#000000', private: true }, { id: 'empty', name: 'Empty', color: '#5b8cff' }],
    [
      tab('work', 'https://docs.example/', { title: 'Docs\u202e', pinned: true }),
      tab('work', 'quiver://settings', { internal: true }),
      tab('work', 'https://me:pw@intranet.example/'),
      tab('work', 'file:///home/me/secret.txt'),
      tab('work', 'https://docs.example/'),
      tab('private-1', 'https://bank.example/'),
      tab('empty', 'quiver://app/newtab.html', { internal: true }),
    ],
    'private-1', NOW,
  );
  assert.deepEqual(published, {
    activeSpaceId: null,
    spaces: [{ id: 'work', name: 'Work', color: '#ff7a59', tabs: [{ url: 'https://docs.example/', title: 'Docs', pinned: true, lastActiveAt: NOW - 1000 }] }],
  });
  assert.ok(!JSON.stringify(published).includes('bank.example'));
});

test("another device's tabs are filtered again when read", () => {
  const read = normalizeDeviceTabs({
    activeSpaceId: 'x',
    spaces: [
      { id: 'x', name: 'X', color: 'red', tabs: [{ url: 'https://ok.example/', title: 't', lastActiveAt: NOW + DAY }, { url: 'https://a:b@bad.example/' }, { url: 'quiver://settings' }] },
      { id: 'p', name: 'P', private: true, tabs: [{ url: 'https://p.example/' }] },
      { id: '../bad', name: 'Bad', tabs: [{ url: 'https://bad.example/' }] },
    ],
  }, NOW);
  assert.deepEqual(read, { activeSpaceId: 'x', spaces: [{ id: 'x', name: 'X', color: '#5b8cff', tabs: [{ url: 'https://ok.example/', title: 't', pinned: false, lastActiveAt: NOW }] }] });
  assert.equal(normalizeDeviceTabs('nope', NOW), undefined);
});

test('a device file keeps continuity fields only when valid', () => {
  const file = normalizeDeviceFile({
    version: 1, deviceId: 'a', deviceName: 'Laptop', writtenAt: NOW, sections: {}, acceptsHandoff: true,
    tabs: { activeSpaceId: null, spaces: [] },
    handoffs: [{ id: 'h1', to: 'b', url: 'https://x.example/', title: 'X', sentAt: NOW }, { id: 'h2', to: 'b', url: 'quiver://settings', sentAt: NOW }],
    handoffAck: ['h9', 'bad id', 3],
  }, NOW);
  assert.equal(file?.acceptsHandoff, true);
  assert.deepEqual(file?.handoffs?.map((h) => h.id), ['h1']);
  assert.deepEqual(file?.handoffAck, ['h9']);
  const old = normalizeDeviceFile({ version: 1, deviceId: 'a', sections: {} }, NOW);
  assert.equal(old?.acceptsHandoff, undefined);
  assert.equal(old?.tabs, undefined);
});

// ───────── staleness ─────────

test('devices not seen in 30 days are hidden; newest first; a reinstalled device shows once', () => {
  const remotes: ContinuityRemote[] = [
    { deviceId: 'old', deviceName: 'Old PC', writtenAt: NOW - STALE_AFTER_MS - 1 },
    { deviceId: 'desk', deviceName: 'Desk', writtenAt: NOW - 2 * DAY },
    { deviceId: 'lap', deviceName: 'Laptop', writtenAt: NOW - 60_000, acceptsHandoff: true },
    { deviceId: 'lap-old', deviceName: 'laptop', writtenAt: NOW - 10 * DAY },
    { deviceId: 'me', deviceName: 'Me', writtenAt: NOW },
    { deviceId: 'never', deviceName: 'Never', writtenAt: 0 },
  ];
  const list = otherDevices(remotes, 'me', NOW);
  assert.deepEqual(list.map((d) => d.id), ['lap', 'desk']);
  assert.equal(list[0].acceptsHandoff, true);
  assert.equal(otherDevices([{ deviceId: 'edge', deviceName: 'Edge', writtenAt: NOW - STALE_AFTER_MS }], 'me', NOW).length, 1);
});

// ───────── merge: Continue here ─────────

const remoteSpace = {
  id: 'work', name: 'Work', color: '#3ecf8e',
  tabs: [
    { url: 'https://a.example/', title: 'A', pinned: false, lastActiveAt: 10 },
    { url: 'https://b.example/', title: 'B', pinned: false, lastActiveAt: 30 },
    { url: 'https://c.example/', title: 'C', pinned: true, lastActiveAt: 20 },
  ],
};

test('Continue here merges into the same Space and skips tabs already open', () => {
  const plan = planContinue(remoteSpace, [{ id: 'home', name: 'Home', color: '#000000' }, { id: 'work', name: 'Job', color: '#000000' }],
    (id) => (id === 'work' ? ['https://a.example/'] : []));
  assert.deepEqual(plan, { spaceId: 'work', name: 'Work', color: '#3ecf8e', urls: [{ url: 'https://b.example/', title: 'B' }, { url: 'https://c.example/', title: 'C' }], focusUrl: 'https://b.example/' });
});

test('Continue here matches a Space by name, never a private one, else plans a new Space', () => {
  const byName = planContinue(remoteSpace, [{ id: 'w2', name: ' work ', color: '#000000' }], () => ['https://b.example/', 'https://c.example/']);
  assert.equal(byName.spaceId, 'w2');
  assert.deepEqual(byName.urls.map((u) => u.url), ['https://a.example/']);
  const privateOnly = planContinue(remoteSpace, [{ id: 'work', name: 'Work', color: '#000000', private: true }], () => ['https://a.example/']);
  assert.equal(privateOnly.spaceId, null);
  assert.equal(privateOnly.urls.length, 3);
});

// ───────── handoff ─────────

test('handoffs addressed here are offered until seen or expired, and senders drop acknowledged ones', () => {
  const sent = [
    { id: 'h1', to: 'me', url: 'https://one.example/', title: 'One', sentAt: NOW - 1000 },
    { id: 'h2', to: 'other', url: 'https://two.example/', title: 'Two', sentAt: NOW - 1000 },
    { id: 'h3', to: 'me', url: 'https://three.example/', title: 'Three', sentAt: NOW - 500 },
    { id: 'h4', to: 'me', url: 'https://old.example/', title: 'Old', sentAt: NOW - HANDOFF_TTL_MS - 1 },
  ];
  const remotes: ContinuityRemote[] = [{ deviceId: 'lap', deviceName: 'Laptop', writtenAt: NOW, handoffs: sent }];
  const incoming = incomingHandoffs(remotes, 'me', { h1: NOW }, NOW);
  assert.deepEqual(incoming.map((h) => [h.id, h.from]), [['h3', 'Laptop']]);
  assert.deepEqual(normalizeHandoffs(sent, NOW).map((h) => h.id), ['h1', 'h2', 'h3']);
  const outbox = pruneOutbox(sent, [{ deviceId: 'me', deviceName: 'Me', writtenAt: NOW, handoffAck: ['h1'] }], NOW);
  assert.deepEqual(outbox.map((h) => h.id), ['h2', 'h3']);
});

// ───────── command bar ─────────

const devices = otherDevices([{
  deviceId: 'lap', deviceName: 'Laptop', writtenAt: NOW - 120_000, acceptsHandoff: true,
  tabs: { activeSpaceId: 'work', spaces: [remoteSpace] } as DeviceTabs,
}], 'me', NOW);
const ctx = { syncing: true, openTabs: true, now: NOW, localUrls: new Set(['https://a.example/']) };

test('devices lists Continue here and the tabs on other devices', () => {
  assert.equal(devicesQuery('devices'), '');
  assert.equal(devicesQuery('device lap'), 'lap');
  assert.equal(devicesQuery('devicesx'), undefined);
  const all = deviceSuggestions('', devices, ctx);
  assert.equal(all[0].action.type, 'continue');
  assert.match(all[0].label, /Continue here: Work from Laptop/);
  assert.deepEqual(all.slice(1).map((s) => s.label), ['B', 'C', 'A']);
  assert.deepEqual(deviceSuggestions('C', devices, ctx).filter((s) => s.action.type === 'remote-tab').map((s) => s.label)[0], 'C');
  assert.equal(deviceSuggestions('', devices, { ...ctx, openTabs: false })[0].action.type, 'internal');
  assert.equal(deviceSuggestions('', devices, { ...ctx, syncing: false })[0].action.type, 'internal');
});

test('typing finds other devices’ tabs that are not open here', () => {
  assert.deepEqual(remoteTabMatches('example', devices, ctx).map((s) => s.label).sort(), ['B', 'C']);
  assert.deepEqual(remoteTabMatches('example', devices, { ...ctx, openTabs: false }), []);
});

test('send offers devices that can receive tabs, without capturing ordinary searches', () => {
  assert.deepEqual(sendQuery('send'), { query: '', explicit: true });
  assert.deepEqual(sendQuery('send tab to lap'), { query: 'lap', explicit: true });
  assert.deepEqual(sendQuery('send flowers'), { query: 'flowers', explicit: false });
  assert.equal(sendMatches('flowers', devices), false);
  assert.equal(sendMatches('lap', devices), true);
  assert.deepEqual(sendSuggestions('', devices, ctx).map((s) => s.action), [{ type: 'send-tab', deviceId: 'lap', device: 'Laptop' }]);
  assert.equal(sendSuggestions('', devices, ctx, 'Tabs in a private Space are never sent to other devices')[0].action.type, 'noop');
});

// ───────── defaults ─────────

test('Sync open tabs is on for new sync setups and off for folders already syncing', () => {
  assert.equal(normalizeSyncState(undefined, 'pc').openTabs, true);
  assert.equal(normalizeSyncState({ folder: null }, 'pc').openTabs, true);
  assert.equal(normalizeSyncState({ folder: path.resolve('/sync') }, 'pc').openTabs, false);
  assert.equal(normalizeSyncState({ folder: path.resolve('/sync'), openTabs: true }, 'pc').openTabs, true);
});

// ───────── two devices through one folder ─────────

function device(folder: string, id: string, name: string, open: () => DeviceTabs, clock: () => number) {
  const state = normalizeSyncState({ folder, deviceId: id, deviceName: name, openTabs: true }, name);
  const none: SectionAdapter = { get: () => null, set: () => undefined };
  return new SyncService(state, { settings: none, bookmarks: none, spaces: none, research: none, boosts: none }, () => undefined, () => undefined, clock, { tabs: open, changed: () => undefined });
}

test('two devices see each other’s tabs and hand off a tab through the folder', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'quiver-tabsync-'));
  try {
    let now = NOW;
    const clock = () => now;
    const lapTabs: DeviceTabs = { activeSpaceId: 'work', spaces: [remoteSpace] };
    const lap = device(folder, 'lap', 'Laptop', () => lapTabs, clock);
    const desk = device(folder, 'desk', 'Desk', () => ({ activeSpaceId: null, spaces: [] }), clock);
    await lap.syncNow();
    await desk.syncNow();
    await lap.syncNow();
    assert.deepEqual(desk.devices().map((d) => [d.name, d.tabs?.spaces[0]?.tabs.length]), [['Laptop', 3]]);
    assert.equal(desk.remoteTab('lap', 'https://b.example/')?.title, 'B');
    assert.equal(desk.remoteTab('lap', 'https://evil.example/'), undefined);

    assert.equal(lap.sendTab('desk', 'https://a:b@x.example/', 'X'), false);
    assert.equal(lap.sendTab('nobody', 'https://x.example/', 'X'), false);
    assert.equal(lap.sendTab('desk', 'https://x.example/', 'X'), true);
    await lap.syncNow();
    now += 1000;
    await desk.syncNow();
    const [handoff] = desk.pendingHandoffs();
    assert.equal(handoff.from, 'Laptop');
    assert.equal(desk.takeHandoff(handoff.id)?.url, 'https://x.example/');
    assert.deepEqual(desk.pendingHandoffs(), []);
    await desk.syncNow();
    await lap.syncNow();
    const lapFile = JSON.parse(await fs.readFile(path.join(folder, SYNC_DIR, 'lap.json'), 'utf8'));
    assert.equal(lapFile.handoffs, undefined, 'acknowledged handoff is dropped by the sender');

    // Turning open tabs off removes them from the file and hides other devices' tabs.
    lap.setOptions({ openTabs: false });
    await lap.syncNow();
    const off = JSON.parse(await fs.readFile(path.join(folder, SYNC_DIR, 'lap.json'), 'utf8'));
    assert.equal(off.tabs, undefined);
    assert.equal(lap.devices()[0].tabs, undefined);

    // A month later the laptop is hidden from the desk.
    now += STALE_AFTER_MS + DAY;
    await desk.syncNow();
    assert.deepEqual(desk.devices(), []);
    lap.stop();
    desk.stop();
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
});
