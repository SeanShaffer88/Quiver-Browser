import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { isIPv4 } from 'node:net';
import path from 'node:path';
import type { DevServer } from '../shared/types';
import { parseNetstatPids, ProjectNames } from './devserver-projects';

const SKIP_PORTS = new Set([135, 139, 445, 5040, 5357, 7680]);

interface LocalEndpoint {
  host: string;
  port: number;
  /** The listening process, when the platform reports it. */
  pid?: number;
}

export function parseNetstat(out: string): LocalEndpoint[] {
  const endpoints = new Map<string, LocalEndpoint>();
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^\s*TCP\s+(\[[^\]]+\]|[\d.]+):(\d+)\s+\S+\s+LISTENING/i);
    if (!m) continue;
    const address = m[1];
    const port = Number(m[2]);
    if (port < 1 || port > 65535 || SKIP_PORTS.has(port)) continue;

    // Wildcard listeners can be reached through their family's loopback.
    let host: string;
    if (address === '0.0.0.0') host = '127.0.0.1';
    else if (address === '[::]' || address === '[::1]') host = '::1';
    else if (address.startsWith('127.') && isIPv4(address)) host = address;
    else continue;
    endpoints.set(`${host}:${port}`, { host, port });
  }
  return [...endpoints.values()].sort((a, b) => a.port - b.port || (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));
}

/** Listening loopback/wildcard TCP sockets from /proc/net/tcp or tcp6, with their socket inode. */
export function parseProcNetTcp(text: string, v6: boolean): { host: string; port: number; inode: number }[] {
  const out: { host: string; port: number; inode: number }[] = [];
  for (const line of text.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || f[3] !== '0A') continue; // 0A = LISTEN
    const [addr, portHex] = f[1].split(':');
    const port = parseInt(portHex, 16);
    if (!(port >= 1 && port <= 65535) || SKIP_PORTS.has(port)) continue;
    let host: string | null = null;
    if (!v6) {
      // Little-endian IPv4: 0100007F is 127.0.0.1.
      const ip = [3, 2, 1, 0].map((i) => parseInt(addr.slice(i * 2, i * 2 + 2), 16)).join('.');
      host = ip === '0.0.0.0' ? '127.0.0.1' : ip.startsWith('127.') ? ip : null;
    } else if (/^0{32}$/.test(addr) || addr === '00000000000000000000000001000000') host = '::1';
    if (host) out.push({ host, port, inode: Number(f[9]) });
  }
  return out;
}

/** Linux (used by the test suite and Linux runs): sockets from /proc, owners found through /proc/<pid>/fd. */
function listLinux(): LocalEndpoint[] | null {
  let sockets: { host: string; port: number; inode: number }[] = [];
  try {
    sockets = parseProcNetTcp(fs.readFileSync('/proc/net/tcp', 'utf8'), false);
    try { sockets.push(...parseProcNetTcp(fs.readFileSync('/proc/net/tcp6', 'utf8'), true)); } catch { /* no IPv6 */ }
  } catch {
    return null;
  }
  const owners = new Map<number, number>();
  const wanted = new Set(sockets.map((s) => s.inode));
  for (const pid of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    let fds: string[] = [];
    try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; } // other users' processes
    for (const fd of fds) {
      try {
        const inode = Number(fs.readlinkSync(`/proc/${pid}/fd/${fd}`).match(/^socket:\[(\d+)\]$/)?.[1]);
        if (wanted.has(inode) && !owners.has(inode)) owners.set(inode, Number(pid));
      } catch { /* closed meanwhile */ }
    }
  }
  const endpoints = new Map<string, LocalEndpoint>();
  for (const s of sockets) endpoints.set(`${s.host}:${s.port}`, { host: s.host, port: s.port, pid: owners.get(s.inode) });
  return [...endpoints.values()].sort((a, b) => a.port - b.port || (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));
}

function listListening(): Promise<LocalEndpoint[] | null> {
  if (process.platform === 'linux') return Promise.resolve(listLinux());
  const windows = process.env.SystemRoot;
  if (process.platform !== 'win32' || !windows) return Promise.resolve(null);
  return new Promise((resolve) => {
    // The unfiltered Windows listing includes TCP and TCPv6. The parser skips UDP.
    execFile(path.join(windows, 'System32', 'netstat.exe'), ['-ano'], {
      windowsHide: true, timeout: 4000, maxBuffer: 4_000_000,
    }, (err, stdout) => {
      if (err) { resolve(null); return; }
      const pids = parseNetstatPids(stdout);
      resolve(parseNetstat(stdout).map((e) => ({ ...e, pid: pids.get(e.port) })));
    });
  });
}

export function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return '';
  return m[1].replace(/\s+/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim().slice(0, 120);
}

type Probed = Pick<DevServer, 'port' | 'url' | 'title'>;

function probe({ host, port }: LocalEndpoint): Promise<Probed | null> {
  return new Promise((resolve) => {
    const address = host === '::1' ? `[${host}]:${port}` : `${host}:${port}`;
    const url = `http://${address}/`;
    let response: Probed | null = null;
    const finish = () => {
      clearTimeout(deadline);
      resolve(response);
    };
    const req = http.get({ host, port, path: '/', agent: false, headers: { accept: 'text/html', 'user-agent': 'Quiver-devscan' } }, (res) => {
      response = { port, url, title: address };
      if (!String(res.headers['content-type'] ?? '').includes('html')) {
        res.destroy();
        finish();
        return;
      }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk.slice(0, 65536 - buf.length);
        if (buf.length === 65536 || /<\/title>/i.test(buf)) {
          res.destroy();
          end();
        }
      });
      const end = () => {
        response = { port, url, title: extractTitle(buf) || address };
        finish();
      };
      res.on('end', end);
      res.on('close', end);
      res.on('error', end);
    });
    // An absolute deadline also caps responses that drip data continuously.
    const deadline = setTimeout(() => {
      req.destroy();
      finish();
    }, 800);
    req.on('error', finish);
  });
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

const projectNames = new ProjectNames();

export async function scanDevServers(): Promise<DevServer[] | null> {
  const endpoints = await listListening();
  if (!endpoints) return null;
  const res = await mapLimit(endpoints, 12, probe);
  const found = endpoints.flatMap((e, i) => { const r = res[i]; return r ? [{ ...r, pid: e.pid }] : []; });
  // Only servers that answered HTTP are worth a process lookup; it runs in the background so it never delays discovery.
  const names = projectNames.cached(found.flatMap((s) => (s.pid ? [s.pid] : [])));
  return found.map(({ pid, ...s }) => {
    const project = (pid && names.get(pid)) || null;
    return { ...s, project, label: serverLabel({ ...s, project }) };
  });
}

/** The sidebar label: "project — Page title", or whichever of the two is known. */
export function serverLabel(server: Pick<DevServer, 'project' | 'title' | 'url'>): string {
  const address = server.url.replace(/^http:\/\//, '').replace(/\/$/, '');
  if (!server.project) return server.title;
  return server.title && server.title !== address && server.title !== server.project ? `${server.project} — ${server.title}` : server.project;
}

export class DevServerWatcher {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private generation = 0;
  servers: DevServer[] = [];

  constructor(
    private readonly onUpdate: (s: DevServer[]) => void,
    private readonly intervalMs = 5000,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.generation++;
  }

  get active(): boolean {
    return this.timer !== null;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const generation = this.generation;
      const next = await scanDevServers();
      if (!next || generation !== this.generation) return;
      if (JSON.stringify(next) !== JSON.stringify(this.servers)) {
        this.servers = next;
        this.onUpdate(next);
      }
    } finally {
      this.running = false;
    }
  }
}
