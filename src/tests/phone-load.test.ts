import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TabManager } from '../main/tabs';

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
