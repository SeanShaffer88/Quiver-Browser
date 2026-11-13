import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { JobControl, type JobContext } from '../main/native/job';
import { insideFolder, localPath, parseDavUrl, runWebDav } from '../main/native/webdav';

test('WebDAV addresses map to HTTP(S) and passwords only travel over HTTPS', () => {
  assert.deepEqual(parseDavUrl('davs://me:p%40ss@cloud.example/remote.php/dav/files/me/'), {
    url: 'https://cloud.example/remote.php/dav/files/me/', authorization: `Basic ${Buffer.from('me:p@ss').toString('base64')}`,
  });
  assert.equal(parseDavUrl('webdav://nas.local:8080/share/').url, 'http://nas.local:8080/share/');
  assert.throws(() => parseDavUrl('dav://me:secret@nas.local/share/'), /only sends a WebDAV password over HTTPS/);
  assert.throws(() => parseDavUrl('https://x.example/'), /Not a WebDAV address/);
});

test('listings stay inside the folder and local names are safe', () => {
  assert.equal(insideFolder('https://h.example/a/', 'https://h.example/a/b/c.txt'), true);
  assert.equal(insideFolder('https://h.example/a/', 'https://h.example/ab/c.txt'), false);
  assert.equal(insideFolder('https://h.example/a/', 'https://evil.example/a/c.txt'), false);
  assert.equal(localPath('https://h.example/a/', 'https://h.example/a/sub/CON.txt'), path.join('sub', '_CON.txt'));
  assert.equal(localPath('https://h.example/a/', 'https://h.example/a/x%5C..%5Cy.txt'), 'y.txt');
});

test('a WebDAV folder downloads with its structure; outside entries are ignored', async () => {
  const files: Record<string, string> = { '/dav/docs/a.txt': 'AAA', '/dav/docs/sub/b.txt': 'BBBBB' };
  const listing = (entries: [string, boolean, number][]) => `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${entries.map(([href, dir, size]) =>
    `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:resourcetype>${dir ? '<d:collection/>' : ''}</d:resourcetype><d:getcontentlength>${size}</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join('')}</d:multistatus>`;
  const gets: string[] = [];
  let auth = '';
  const srv = http.createServer((req, res) => {
    auth = req.headers.authorization ?? '';
    if (req.method === 'PROPFIND') {
      res.statusCode = 207;
      if (req.url === '/dav/docs' || req.url === '/dav/docs/') {
        if (req.headers.depth === '0') return res.end(listing([['/dav/docs/', true, 0]]));
        return res.end(listing([['/dav/docs/', true, 0], ['/dav/docs/a.txt', false, 3], ['/dav/docs/sub/', true, 0], ['/dav/secret.txt', false, 9], ['http://evil.example/dav/docs/x', false, 1]]));
      }
      if (req.url === '/dav/docs/sub/') return res.end(listing([['/dav/docs/sub/', true, 0], ['/dav/docs/sub/b.txt', false, 5]]));
      res.statusCode = 404; return res.end();
    }
    gets.push(req.url!);
    const body = files[req.url!];
    if (body === undefined) { res.statusCode = 404; return res.end(); }
    res.end(body);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiver-dav-'));
  const ctx: JobContext = { fetch: (u, i) => fetch(u, i as RequestInit), control: new JobControl(), progress: () => {} };
  try {
    const [folder] = await runWebDav(`dav://127.0.0.1:${port}/dav/docs`, ctx, (n) => path.join(dir, n));
    assert.equal(path.basename(folder), 'docs');
    assert.equal(fs.readFileSync(path.join(folder, 'a.txt'), 'utf8'), 'AAA');
    assert.equal(fs.readFileSync(path.join(folder, 'sub', 'b.txt'), 'utf8'), 'BBBBB');
    assert.deepEqual(gets.sort(), ['/dav/docs/a.txt', '/dav/docs/sub/b.txt']);
    assert.equal(auth, '');
  } finally { srv.close(); }
});
