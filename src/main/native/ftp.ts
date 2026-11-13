import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import type { JobContext } from './job';

export interface FtpTarget {
  host: string;
  port: number;
  user: string;
  password: string;
  path: string;
  /** ftps:// = implicit TLS; ftp:// tries explicit TLS (AUTH TLS) first. */
  implicitTls: boolean;
  anonymous: boolean;
}

export function parseFtpUrl(raw: string): FtpTarget {
  const url = new URL(raw);
  if (url.protocol !== 'ftp:' && url.protocol !== 'ftps:') throw new Error('Not an FTP address.');
  if (!url.hostname) throw new Error('The FTP address has no server.');
  const path = decodeURIComponent(url.pathname);
  if (!path || path.endsWith('/')) throw new Error('The FTP address points to a folder, not a file.');
  if (/[\r\n]/.test(path) || /[\r\n]/.test(decodeURIComponent(url.username + url.password))) throw new Error('The FTP address is not valid.');
  const implicitTls = url.protocol === 'ftps:';
  return {
    host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port) || (implicitTls ? 990 : 21),
    user: decodeURIComponent(url.username) || 'anonymous', password: decodeURIComponent(url.password) || 'anonymous@',
    anonymous: !url.username, path, implicitTls,
  };
}

interface Reply { code: number; text: string }

/** One FTP control connection: send a command, read its (possibly multi-line) reply. */
class Control {
  private buffer = '';
  private waiting: ((r: Reply) => void) | null = null;
  private failed: Error | null = null;
  private replies: Reply[] = [];
  private lines: string[] = [];

  constructor(public socket: net.Socket | tls.TLSSocket, private readonly onError: (e: Error) => void) {
    this.attach(socket);
  }

  attach(socket: net.Socket | tls.TLSSocket): void {
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.feed(chunk));
    socket.on('error', (e) => { this.failed = e; this.onError(e); });
    socket.on('close', () => { if (!this.failed) { this.failed = new Error('The FTP server closed the connection.'); this.onError(this.failed); } });
  }

  private feed(chunk: string): void {
    this.buffer += chunk;
    let i: number;
    while ((i = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, i).replace(/\r$/, '');
      this.buffer = this.buffer.slice(i + 1);
      this.lines.push(line);
      const first = this.lines[0];
      const end = /^(\d{3}) /.exec(line);
      if (end && (!/^\d{3}-/.test(first) || first.startsWith(end[1]))) {
        const reply = { code: Number(end[1]), text: this.lines.join('\n') };
        this.lines = [];
        if (this.waiting) { const w = this.waiting; this.waiting = null; w(reply); } else this.replies.push(reply);
      }
    }
  }

  read(): Promise<Reply> {
    const ready = this.replies.shift();
    if (ready) return Promise.resolve(ready);
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting = null; reject(new Error('The FTP server stopped answering.')); }, 30_000);
      this.waiting = (r) => { clearTimeout(timer); resolve(r); };
    });
  }

  async send(command: string, expect?: (code: number) => boolean): Promise<Reply> {
    this.socket.write(`${command}\r\n`);
    const reply = await this.read();
    if (expect && !expect(reply.code)) {
      const shown = command.startsWith('PASS ') ? 'PASS ***' : command;
      throw new Error(`FTP ${shown}: ${reply.text.split('\n').pop()}`);
    }
    return reply;
  }
}

function connect(host: string, port: number, secure: boolean, session?: Buffer): Promise<net.Socket | tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, session })
      : net.connect({ host, port });
    const timer = setTimeout(() => socket.destroy(new Error('Could not reach the FTP server.')), 20_000);
    socket.once(secure ? 'secureConnect' : 'connect', () => { clearTimeout(timer); resolve(socket); });
    socket.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

function upgrade(socket: net.Socket, host: string): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: net.isIP(host) ? undefined : host });
    secure.once('secureConnect', () => resolve(secure));
    secure.once('error', reject);
  });
}

/**
 * Download one FTP file into `file`, appending from its current size when the server allows REST.
 * Passive data connections always go to the control host: the address in a PASV reply is ignored, so a
 * server cannot point Quiver at another machine (FTP bounce).
 */
export async function ftpDownload(url: string, file: string, ctx: JobContext): Promise<void> {
  const target = parseFtpUrl(url);
  let failure: Error | null = null;
  const sockets: net.Socket[] = [];
  const onAbort = () => { for (const s of sockets) s.destroy(); };
  ctx.control.signal.addEventListener('abort', onAbort);
  try {
    let socket = await connect(target.host, target.port, target.implicitTls);
    sockets.push(socket);
    const control = new Control(socket, (e) => { failure = e; });
    const greeting = await control.read();
    if (greeting.code !== 220) throw new Error(`FTP server refused the connection: ${greeting.text}`);
    let secure = target.implicitTls;
    if (!secure) {
      const auth = await control.send('AUTH TLS');
      if (auth.code === 234) {
        socket.removeAllListeners('data');
        socket = await upgrade(socket as net.Socket, target.host);
        sockets.push(socket);
        control.attach(socket);
        secure = true;
      } else if (!target.anonymous) {
        throw new Error('This FTP server does not support encryption, so Quiver will not send your password to it.');
      }
    }
    if (secure) {
      await control.send('PBSZ 0', (c) => c < 400);
      await control.send('PROT P', (c) => c < 400);
    }
    const user = await control.send(`USER ${target.user}`, (c) => c === 230 || c === 331);
    if (user.code === 331) await control.send(`PASS ${target.password}`, (c) => c === 230 || c === 202);
    await control.send('TYPE I', (c) => c === 200);
    const sizeReply = await control.send(`SIZE ${target.path}`);
    const total = sizeReply.code === 213 ? Number(sizeReply.text.split(' ').pop()) || 0 : 0;
    let offset = fs.existsSync(file) ? fs.statSync(file).size : 0;
    if (total && offset >= total) offset = 0;

    let port: number;
    const epsv = await control.send('EPSV');
    if (epsv.code === 229) port = Number(/\|\|\|(\d+)\|/.exec(epsv.text)?.[1]);
    else {
      const pasv = await control.send('PASV', (c) => c === 227);
      const n = /(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/.exec(pasv.text);
      if (!n) throw new Error('The FTP server gave no data port.');
      port = Number(n[5]) * 256 + Number(n[6]);
    }
    if (!port || port > 65535) throw new Error('The FTP server gave an invalid data port.');
    const data = await connect(target.host, port, secure, secure ? (socket as tls.TLSSocket).getSession() : undefined);
    sockets.push(data);
    if (offset > 0) {
      const rest = await control.send(`REST ${offset}`);
      if (rest.code !== 350) offset = 0;
    }
    const out = fs.createWriteStream(file, { flags: offset > 0 ? 'a' : 'w' });
    const done = new Promise<void>((resolve, reject) => {
      let received = offset;
      data.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (!out.write(chunk)) { data.pause(); out.once('drain', () => data.resume()); }
        ctx.progress({ received, total, detail: '' });
        if (ctx.control.paused) data.destroy(new Error('Paused'));
      });
      data.once('end', () => out.end(resolve));
      data.once('error', (e) => out.end(() => reject(e)));
    });
    await control.send(`RETR ${target.path}`, (c) => c === 125 || c === 150);
    await done;
    const final = await control.read();
    if (final.code >= 400) throw new Error(`FTP transfer failed: ${final.text.split('\n').pop()}`);
    if (total && fs.statSync(file).size !== total) throw new Error('The FTP download ended early.');
    control.socket.write('QUIT\r\n');
  } catch (error) {
    if (ctx.control.cancelled) throw new Error('Cancelled');
    throw failure && !(error instanceof Error && error.message.startsWith('FTP')) ? failure : error;
  } finally {
    ctx.control.signal.removeEventListener('abort', onAbort);
    for (const s of sockets) s.destroy();
  }
}
