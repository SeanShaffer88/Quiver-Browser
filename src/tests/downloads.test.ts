import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import type { Session } from 'electron';
import { Downloads, isRiskyFile, normalizeDownloads, safeFileName, uniqueName } from '../main/downloads';

test('file names are made safe for Windows', () => {
  assert.equal(safeFileName('report.pdf'), 'report.pdf');
  assert.equal(safeFileName('..\\..\\evil.exe'), 'evil.exe');
  assert.equal(safeFileName('a<b>c:d"e/f|g?h*.txt'), 'f_g_h_.txt');
  assert.equal(safeFileName('CON.txt'), '_CON.txt');
  assert.equal(safeFileName('trailing. . '), 'trailing');
  assert.equal(safeFileName(''), 'download');
  assert.equal(safeFileName('x'.repeat(300) + '.zip').length, 200);
  assert.ok(safeFileName('x'.repeat(300) + '.zip').endsWith('.zip'));
});

test('unique names add a counter before the extension', () => {
  const taken = new Set(['a.txt', 'a (1).txt', 'archive.tar.gz']);
  assert.equal(uniqueName('a.txt', (n) => taken.has(n)), 'a (2).txt');
  assert.equal(uniqueName('b.txt', (n) => taken.has(n)), 'b.txt');
  assert.equal(uniqueName('archive.tar.gz', (n) => taken.has(n)), 'archive (1).tar.gz');
  assert.equal(uniqueName('README', () => false), 'README');
});

test('risky file types need confirmation before opening', () => {
  for (const n of ['setup.exe', 'x.MSI', 'run.ps1', 'a.bat', 'link.lnk', 'doc.js', 'app.appx']) assert.equal(isRiskyFile(n), true, n);
  for (const n of ['photo.png', 'notes.txt', 'paper.pdf', 'data.zip']) assert.equal(isRiskyFile(n), false, n);
});

test('stored downloads are validated and unfinished ones become interrupted', () => {
  const out = normalizeDownloads([
    { id: 'd1', url: 'https://a.example/f.zip', filename: 'f.zip', savePath: 'C:\\Users\\me\\Downloads\\f.zip', partition: 'persist:quiver-shared',
      state: 'progressing', received: 10, total: 100, startedAt: 1, mime: 'application/zip', urlChain: ['https://a.example/f.zip'], etag: '"x"' },
    { id: 'd2', url: 'javascript:alert(1)', filename: 'x', savePath: 'C:\\x', state: 'completed' },
    { id: 'd1', url: 'https://dup.example/', filename: 'dup', savePath: 'C:\\dup', state: 'completed' },
    { id: 'd3', url: 'https://b.example/g', filename: 'g', savePath: 'relative\\g', state: 'completed' },
    null,
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].state, 'interrupted');
  assert.equal(out[0].canResume, true);
});

test('checkpoint survives Chromium shutdown cancellation and resumes the same download', async (t) => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'quiver-resume-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const partialDirectory = path.join(directory, 'download-partials');
  const savePath = path.join(directory, 'fixture.bin');
  const url = 'https://a.example/fixture.bin';
  const partition = 'persist:quiver-shared';
  const bytes = Buffer.from('partial bytes');
  let persisted: unknown = [];
  let creation: Parameters<Session['createInterruptedDownload']>[0] | undefined;
  let resumed = 0;

  const makeItem = (state: string) => Object.assign(new EventEmitter(), {
    getURL: () => url, getURLChain: () => [url], getFilename: () => 'fixture.bin', getMimeType: () => 'application/octet-stream',
    getSavePath: () => savePath, getState: () => state, getTotalBytes: () => 100,
    getReceivedBytes: () => bytes.length, getETag: () => '"fixture"', getLastModifiedTime: () => '',
    isPaused: () => false, canResume: () => true, pause: () => {}, resume: () => { resumed++; },
  });
  const session = () => {
    const emitter = new EventEmitter();
    return Object.assign(emitter, {
      createInterruptedDownload(options: Parameters<Session['createInterruptedDownload']>[0]) {
        creation = options;
        emitter.emit('will-download', {}, makeItem('interrupted'));
      },
    });
  };
  const makeDownloads = (session: Session) => new Downloads(persisted, {
    directory: () => directory, partialDirectory, askWhereToSave: () => false, fromPartition: () => session,
    persist: (records) => { persisted = structuredClone(records); }, changed: () => {},
  });

  const originalSession = session();
  const initial = makeDownloads(originalSession as unknown as Session);
  initial.attach(originalSession as unknown as Session, partition);
  await writeFile(savePath, Buffer.concat([bytes, Buffer.from('unrecorded trailing bytes')]));
  const item = makeItem('progressing');
  originalSession.emit('will-download', {}, item);
  item.emit('updated', {}, 'progressing');
  const id = initial.list()[0].id;
  const checkpoint = initial.checkpointOnClose();
  assert.ok(checkpoint);
  await checkpoint;
  item.emit('done', {}, 'cancelled');
  await unlink(savePath);
  const [partial, ...others] = await readdir(partialDirectory);
  assert.ok(partial);
  assert.deepEqual(others, []);
  assert.deepEqual(await readFile(path.join(partialDirectory, partial)), bytes);

  const restarted = makeDownloads(session() as unknown as Session);
  assert.equal(restarted.list()[0].canResume, true);
  assert.equal(await restarted.act(id, 'resume'), '');
  await setImmediate();
  assert.equal(resumed, 1);
  assert.equal(creation?.offset, bytes.length);
  assert.equal(creation?.path, savePath);
  assert.deepEqual(restarted.list().map((download) => download.id), [id]);
  assert.deepEqual(await readFile(savePath), bytes);
});
