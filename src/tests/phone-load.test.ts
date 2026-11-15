import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TabManager } from '../main/tabs';
import type { MediaDelegate } from '../main/browser-policy';

test('a superseded load cannot mark a newer request for the same phone URL unavailable', async () => {
  const pending: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  const phone = { webContents: { loadURL: () => new Promise<void>((resolve, reject) => pending.push({ resolve, reject })) } };
  const updates: boolean[] = [];
  const manager = Object.assign(Object.create(TabManager.prototype), {
    phone,
    phoneUnavailable: false,
    emit: () => updates.push(manager.phoneUnavailable),
  });
  const load = (url: string) => Reflect.get(manager, 'loadPhone').call(manager, phone, url);
  load('http://127.0.0.1:4000/a');
  load('http://127.0.0.1:4000/b');
  load('http://127.0.0.1:4000/a');
  pending[0].reject(new Error('first A failed'));
  pending[1].reject(new Error('B failed'));
  await Promise.resolve();
  assert.deepEqual(updates, []);
  pending[2].resolve();
  await Promise.resolve();
  assert.deepEqual(updates, [false]);
});

test('Phone Preview media requests stay denied after the preview closes', async () => {
  const url = 'http://127.0.0.1:4000/call';
  const desktop = { id: 1, getURL: () => url, isDestroyed: () => false };
  const preview = { ...desktop, id: 2 };
  const little = { ...desktop, id: 3 };
  const calls: number[] = [];
  const manager = Object.assign(Object.create(TabManager.prototype), {
    phone: { webContents: preview },
    phoneContents: new WeakSet([preview]),
    externalContents: new WeakSet([little]),
    media: {
      check: (id: number) => { calls.push(id); return true; },
      request: (id: number) => { calls.push(id); return Promise.resolve(true); },
    },
  });
  const delegate: MediaDelegate = Reflect.get(manager, 'mediaDelegate').call(manager);
  const desktopContents = desktop as Parameters<MediaDelegate['check']>[0];
  const previewContents = preview as Parameters<MediaDelegate['check']>[0];

  assert.equal(delegate.check(desktopContents, true), true);
  assert.equal(await delegate.request(desktopContents, url, true, ['camera']), true);
  assert.equal(delegate.check(previewContents, true), false);
  assert.equal(await delegate.request(previewContents, url, true, ['microphone']), false);
  // A Little Quiver page has nowhere to show the prompt until it is opened in Quiver.
  const littleContents = little as Parameters<MediaDelegate['check']>[0];
  assert.equal(delegate.check(littleContents, true), false);
  assert.equal(await delegate.request(littleContents, url, true, ['camera']), false);
  manager.phone = null;
  assert.equal(await delegate.request(previewContents, url, true, ['camera']), false);
  assert.deepEqual(calls, [1, 1]);
});
