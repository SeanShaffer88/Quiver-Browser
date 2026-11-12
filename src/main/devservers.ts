import { execFile } from 'node:child_process';
import http from 'node:http';
import { isIPv4 } from 'node:net';
import path from 'node:path';
import type { DevServer } from '../shared/types';

const SKIP_PORTS = new Set([135, 139, 445, 5040, 5357, 7680]);

interface LocalEndpoint {
  host: string;
  port: number;
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

function listListening(): Promise<LocalEndpoint[]> {
  const windows = process.env.SystemRoot;
  if (process.platform !== 'win32' || !windows) return Promise.resolve([]);
  return new Promise((resolve) => {
    // The unfiltered Windows listing includes TCP and TCPv6. The parser skips UDP.
    execFile(path.join(windows, 'System32', 'netstat.exe'), ['-ano'], {
      windowsHide: true, timeout: 4000, maxBuffer: 4_000_000,
    }, (err, stdout) => {
      resolve(err ? [] : parseNetstat(stdout));
    });
  });
}

export function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return '';
  return m[1].replace(/\s+/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim().slice(0, 120);
}

function probe({ host, port }: LocalEndpoint): Promise<DevServer | null> {
  return new Promise((resolve) => {
    const address = host === '::1' ? `[${host}]:${port}` : `${host}:${port}`;
    const url = `http://${address}/`;
    let response: DevServer | null = null;
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

export async function scanDevServers(): Promise<DevServer[]> {
  const endpoints = await listListening();
  const res = await mapLimit(endpoints, 12, probe);
  return res.filter((x): x is DevServer => x !== null);
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
      if (generation !== this.generation) return;
      if (JSON.stringify(next) !== JSON.stringify(this.servers)) {
        this.servers = next;
        this.onUpdate(next);
      }
    } finally {
      this.running = false;
    }
  }
}
