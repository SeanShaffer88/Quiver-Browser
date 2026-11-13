import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { JobControl, type JobContext } from '../main/native/job';
import { nativeKind, runDash, runHls, runMetalink } from '../main/native/runners';

function serve(routes: Record<string, Buffer | string | number>) {
  const hits: string[] = [];
  const srv = http.createServer((req, res) => {
    hits.push(req.url!);
    const body = routes[req.url!];
    if (body === undefined || typeof body === 'number') { res.statusCode = typeof body === 'number' ? body : 404; return res.end(); }
    res.end(body);
  });
  return new Promise<{ base: string; hits: string[]; close: () => void }>((res) => srv.listen(0, '127.0.0.1', () =>
    res({ base: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, hits, close: () => srv.close() })));
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiver-native-'));
  const progress: string[] = [];
  const ctx: JobContext = { fetch: (u, i) => fetch(u, i), control: new JobControl(), progress: (p) => progress.push(p.detail) };
  return { dir, ctx, progress, place: (name: string) => path.join(dir, name) };
}

const seg = (n: number) => Buffer.alloc(1000 + n, n);

test('HLS: master → best muxed variant, AES-128 segments decrypted in order, saved as one .ts', async () => {
  const key = Buffer.alloc(16, 7);
  const enc = (data: Buffer, sequence: number) => {
    const iv = Buffer.alloc(16); iv.writeBigUInt64BE(BigInt(sequence), 8);
    const c = createCipheriv('aes-128-cbc', key, iv); return Buffer.concat([c.update(data), c.final()]);
  };
  const s = await serve({
    '/master.m3u8': '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nlow/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=900\nhi/index.m3u8\n',
    '/hi/index.m3u8': ['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:3', '#EXT-X-KEY:METHOD=AES-128,URI="/key"', ...[0, 1, 2, 3, 4].flatMap((i) => ['#EXTINF:2,', `s${i}.ts`]), '#EXT-X-ENDLIST'].join('\n'),
    '/key': key,
    ...Object.fromEntries([0, 1, 2, 3, 4].map((i) => [`/hi/s${i}.ts`, enc(seg(i), 3 + i)])),
  });
  const { ctx, place, progress } = setup();
  try {
    const [file] = await runHls(`${s.base}/master.m3u8`, 'show', ctx, place);
    assert.ok(file.endsWith('show.ts'));
    assert.ok(fs.readFileSync(file).equals(Buffer.concat([0, 1, 2, 3, 4].map(seg))));
    assert.equal(s.hits.filter((h) => h === '/key').length, 1, 'the key is fetched once');
    assert.equal(progress.at(-1), '5 of 5 segments');
    assert.ok(!s.hits.some((h) => h.startsWith('/low/')));
  } finally { s.close(); }
});

test('HLS: live and DRM streams are refused without leaving files', async () => {
  const s = await serve({
    '/live.m3u8': '#EXTM3U\n#EXTINF:2,\na.ts\n',
    '/drm.m3u8': '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x"\n#EXTINF:2,\na.ts\n#EXT-X-ENDLIST\n',
  });
  const { ctx, place, dir } = setup();
  try {
    await assert.rejects(runHls(`${s.base}/live.m3u8`, 'x', ctx, place), /Live streams/);
    await assert.rejects(runHls(`${s.base}/drm.m3u8`, 'x', ctx, place), /(DRM|Unsupported)/);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { s.close(); }
});

test('DASH: best video and audio saved as separate files with their init segments', async () => {
  const s = await serve({
    '/m.mpd': `<MPD type="static" mediaPresentationDuration="PT6S"><Period>
      <AdaptationSet contentType="video"><Representation id="v" bandwidth="9" mimeType="video/mp4"><SegmentTemplate media="v$Number$.m4s" initialization="vi.mp4" duration="2" startNumber="1"/></Representation></AdaptationSet>
      <AdaptationSet contentType="audio"><Representation id="a" bandwidth="1" mimeType="audio/mp4"><SegmentList><Initialization sourceURL="ai.mp4"/><SegmentURL media="a1.m4s"/></SegmentList></Representation></AdaptationSet>
    </Period></MPD>`,
    '/vi.mp4': 'VI', '/v1.m4s': 'V1', '/v2.m4s': 'V2', '/v3.m4s': 'V3', '/ai.mp4': 'AI', '/a1.m4s': 'A1',
  });
  const { ctx, place } = setup();
  try {
    const files = await runDash(`${s.base}/m.mpd`, 'talk', ctx, place);
    assert.deepEqual(files.map((f) => path.basename(f)), ['talk.video.mp4', 'talk.audio.m4a']);
    assert.equal(fs.readFileSync(files[0], 'utf8'), 'VIV1V2V3');
    assert.equal(fs.readFileSync(files[1], 'utf8'), 'AIA1');
  } finally { s.close(); }
});

test('Metalink: a mirror with the wrong checksum is skipped for the next one', async () => {
  const good = Buffer.from('the real file');
  const sha = createHash('sha256').update(good).digest('hex');
  const s = await serve({ '/bad/f.bin': 'tampered!!!!!', '/down/f.bin': 500, '/good/f.bin': good });
  const meta = `<metalink xmlns="urn:ietf:params:xml:ns:metalink"><file name="f.bin"><size>${good.length}</size><hash type="sha-256">${sha}</hash>
    <url priority="1">${s.base}/bad/f.bin</url><url priority="2">${s.base}/down/f.bin</url><url priority="3">${s.base}/good/f.bin</url></file></metalink>`;
  const s2 = await serve({ '/f.meta4': meta, '/wrong.meta4': meta.replace(`${s.base}/good/f.bin`, `${s.base}/bad/f.bin`) });
  const { ctx, place, dir } = setup();
  try {
    const [file] = await runMetalink(`${s2.base}/f.meta4`, ctx, place);
    assert.ok(fs.readFileSync(file).equals(good));
    await assert.rejects(runMetalink(`${s2.base}/wrong.meta4`, setup().ctx, (n) => path.join(dir, 'x-' + n)), /Every mirror failed/);
    assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.part')));
  } finally { s.close(); s2.close(); }
});

test('addresses route to the right downloader', () => {
  assert.equal(nativeKind('ftp://h/x.iso'), 'ftp');
  assert.equal(nativeKind('https://h/v/index.m3u8?token=1'), 'hls');
  assert.equal(nativeKind('https://h/stream', 'application/vnd.apple.mpegurl; charset=utf-8'), 'hls');
  assert.equal(nativeKind('https://h/m.mpd'), 'dash');
  assert.equal(nativeKind('https://h/x.meta4'), 'metalink');
  assert.equal(nativeKind('https://h/x.zip'), null);
  assert.equal(nativeKind('file:///x.m3u8'), null);
});
