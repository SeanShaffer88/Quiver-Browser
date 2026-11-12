import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { Store, writeFileAtomic } from '../main/store';

function fixture(t: TestContext): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quiver-store-'));
  t.after(() => {
    for (const file of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, file));
    fs.rmdirSync(directory);
  });
  return path.join(directory, 'state.json');
}

function denied(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error('fixture rename failure'), { code, syscall: 'rename' });
}

function savedSession(file: string): boolean {
  return JSON.parse(fs.readFileSync(file, 'utf8')).sessionOpen;
}

test('scheduled save retries a transient Windows rename with the latest state', { skip: process.platform !== 'win32' }, (t) => {
  const file = fixture(t);
  const store = new Store(file);
  const rename = fs.renameSync;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const attempts = t.mock.method(fs, 'renameSync', (source: string, destination: string) => {
    if (attempts.mock.callCount() === 0) throw denied('EPERM');
    rename(source, destination);
  });
  store.state.sessionOpen = false;
  store.save();
  t.mock.timers.tick(250);
  assert.equal(attempts.mock.callCount(), 1);
  assert.equal(fs.existsSync(file), false);
  store.state.sessionOpen = true;
  t.mock.timers.tick(74);
  assert.equal(attempts.mock.callCount(), 1);
  t.mock.timers.tick(1);
  assert.equal(savedSession(file), true);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['state.json']);
});

test('scheduled save logs once for permanent or exhausted rename errors', { skip: process.platform !== 'win32' }, (t) => {
  const file = fixture(t);
  const store = new Store(file);
  let code = 'EACCES';
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const log = t.mock.method(console, 'error', () => undefined);
  const attempts = t.mock.method(fs, 'renameSync', () => { throw denied(code); });
  store.save();
  t.mock.timers.tick(250);
  t.mock.timers.tick(600);
  assert.equal(attempts.mock.callCount(), 1);
  assert.equal(log.mock.callCount(), 1);
  code = 'EBUSY';
  store.save();
  for (const delay of [250, 75, 150]) {
    t.mock.timers.tick(delay);
    assert.equal(log.mock.callCount(), 1);
  }
  t.mock.timers.tick(300);
  t.mock.timers.tick(1000);
  assert.equal(attempts.mock.callCount(), 5);
  assert.equal(log.mock.callCount(), 2);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), []);
});

test('new save supersedes retries and flush stays synchronous', { skip: process.platform !== 'win32' }, (t) => {
  const file = fixture(t);
  const store = new Store(file);
  const rename = fs.renameSync;
  let locked = true;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const log = t.mock.method(console, 'error', () => undefined);
  const attempts = t.mock.method(fs, 'renameSync', (source: string, destination: string) => {
    if (locked) throw denied('EPERM');
    rename(source, destination);
  });
  store.save();
  t.mock.timers.tick(250);
  store.save();
  t.mock.timers.tick(75);
  assert.equal(attempts.mock.callCount(), 1);
  t.mock.timers.tick(175);
  assert.equal(attempts.mock.callCount(), 2);
  assert.equal(store.flush(), false);
  assert.equal(log.mock.callCount(), 1);
  t.mock.timers.tick(1000);
  assert.equal(attempts.mock.callCount(), 3);
  locked = false;
  store.state.sessionOpen = true;
  assert.equal(store.flush(), true);
  assert.equal(savedSession(file), true);
});

test('atomic write cleans its own temp file and preserves the destination on rename failure', (t) => {
  const file = fixture(t);
  fs.writeFileSync(file, 'previous');
  fs.writeFileSync(path.join(path.dirname(file), 'unrelated.tmp'), 'keep');
  const expected = denied('EPERM');
  t.mock.method(fs, 'renameSync', () => { throw expected; });
  assert.throws(() => writeFileAtomic(file, 'replacement'), (error) => error === expected);
  assert.equal(fs.readFileSync(file, 'utf8'), 'previous');
  assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['state.json', 'unrelated.tmp']);
});
