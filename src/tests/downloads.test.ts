import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRiskyFile, normalizeDownloads, safeFileName, uniqueName } from '../main/downloads';

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
