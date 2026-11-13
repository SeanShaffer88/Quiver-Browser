import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ftpDownload, parseFtpUrl } from '../main/native/ftp';
import { JobControl, type JobContext } from '../main/native/job';

/** A tiny FTP server for tests: plain only, refuses AUTH TLS, supports SIZE/REST/EPSV/PASV/RETR. */
function server(content: Buffer, opts: { epsv?: boolean; pasvHost?: string } = {}) {
  const log: string[] = [];
  const open: { close(): void }[] = [];
  const sockets = new Set<net.Socket>();
  const srv = net.createServer((c) => {
    sockets.add(c);
    let rest = 0;
    let data: net.Server | null = null;
    let dataSocket: Promise<net.Socket> | null = null;
    c.write('220-Welcome\r\n220 Ready\r\n');
    let buf = '';
    c.on('data', (chunk) => {
      buf += chunk.toString();
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        log.push(line.startsWith('PASS') ? 'PASS ***' : line);
        const [cmd, ...args] = line.split(' ');
        const arg = args.join(' ');
        const openData = () => {
          data = net.createServer((d) => sockets.add(d));
          open.push(data);
          dataSocket = new Promise((res) => data!.once('connection', res));
          return new Promise<number>((res) => data!.listen(0, '127.0.0.1', () => res((data!.address() as net.AddressInfo).port)));
        };
        switch (cmd) {
          case 'AUTH': c.write('502 Not implemented\r\n'); break;
          case 'USER': c.write('331 Password\r\n'); break;
          case 'PASS': c.write('230 Logged in\r\n'); break;
          case 'TYPE': c.write('200 OK\r\n'); break;
          case 'SIZE': c.write(arg === '/pub/file.bin' ? `213 ${content.length}\r\n` : '550 No such file\r\n'); break;
          case 'EPSV': if (opts.epsv === false) c.write('500 No\r\n'); else void openData().then((p) => c.write(`229 Entering (|||${p}|)\r\n`)); break;
          case 'PASV': void openData().then((p) => c.write(`227 Entering (${(opts.pasvHost ?? '127,0,0,1')},${p >> 8},${p & 255})\r\n`)); break;
          case 'REST': rest = Number(arg); c.write('350 OK\r\n'); break;
          case 'RETR':
            if (arg !== '/pub/file.bin') { c.write('550 No such file\r\n'); break; }
            c.write('150 Sending\r\n');
            void dataSocket!.then((d) => d.end(content.subarray(rest), () => { c.write('226 Done\r\n'); data!.close(); }));
            break;
          case 'QUIT': c.end('221 Bye\r\n'); break;
          default: c.write('502 Unknown\r\n');
        }
      }
    });
    c.on('error', () => {});
  });
  return new Promise<{ port: number; log: string[]; close: () => void }>((res) =>
    srv.listen(0, '127.0.0.1', () => res({ port: (srv.address() as net.AddressInfo).port, log, close: () => { for (const x of sockets) x.destroy(); for (const d of open) d.close(); srv.close(); } })));
}

const ctx = (): JobContext => ({ fetch: fetch, control: new JobControl(), progress: () => {} });
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'quiver-ftp-')), 'out.part');

test('FTP addresses: implicit TLS for ftps, anonymous login, refusal of folders and CRLF', () => {
  assert.deepEqual(parseFtpUrl('ftp://ftp.example/pub/a%20b.iso'), { host: 'ftp.example', port: 21, user: 'anonymous', password: 'anonymous@', anonymous: true, path: '/pub/a b.iso', implicitTls: false });
  assert.equal(parseFtpUrl('ftps://me:pw@h.example/x').port, 990);
  assert.throws(() => parseFtpUrl('ftp://h.example/pub/'), /folder/);
  assert.throws(() => parseFtpUrl('ftp://h.example/a%0d%0aDELE%20x'), /not valid/);
});

test('anonymous FTP download over EPSV, and resume with REST', async () => {
  const content = Buffer.from('0123456789'.repeat(5000));
  const s = await server(content);
  const file = tmp();
  try {
    await ftpDownload(`ftp://127.0.0.1:${s.port}/pub/file.bin`, file, ctx());
    assert.ok(fs.readFileSync(file).equals(content));
    fs.writeFileSync(file, content.subarray(0, 1234));
    await ftpDownload(`ftp://127.0.0.1:${s.port}/pub/file.bin`, file, ctx());
    assert.ok(fs.readFileSync(file).equals(content));
    assert.ok(s.log.includes('REST 1234'));
  } finally { s.close(); }
});

test('PASV replies cannot redirect the data connection to another host', async () => {
  const content = Buffer.from('hello world');
  const s = await server(content, { epsv: false, pasvHost: '10,9,8,7' });
  const file = tmp();
  try {
    await ftpDownload(`ftp://127.0.0.1:${s.port}/pub/file.bin`, file, ctx());
    assert.equal(fs.readFileSync(file, 'utf8'), 'hello world');
  } finally { s.close(); }
});

test('a password is never sent to a server without TLS', async () => {
  const s = await server(Buffer.from('x'));
  try {
    await assert.rejects(ftpDownload(`ftp://me:secret@127.0.0.1:${s.port}/pub/file.bin`, tmp(), ctx()), /will not send your password/);
    assert.ok(!s.log.some((l) => l.startsWith('PASS') || l.startsWith('USER')));
  } finally { s.close(); }
});

test('a missing file reports the server reply', async () => {
  const s = await server(Buffer.from('x'));
  try {
    await assert.rejects(ftpDownload(`ftp://127.0.0.1:${s.port}/pub/missing.bin`, tmp(), ctx()), /550 No such file/);
  } finally { s.close(); }
});
