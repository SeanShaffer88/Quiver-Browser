import fs from 'node:fs';
import path from 'node:path';
import { safeFileName } from '../downloads';
import { fetchOk, type JobContext } from './job';
import { children, child, parseXml } from './xml';

const SCHEMES: Record<string, 'http:' | 'https:'> = { 'dav:': 'http:', 'webdav:': 'http:', 'davs:': 'https:', 'webdavs:': 'https:' };
const FILE_LIMIT = 10_000;
const DEPTH_LIMIT = 20;

export interface DavTarget { url: string; authorization: string | null }

/**
 * dav:// and webdav:// (HTTP), davs:// and webdavs:// (HTTPS). A user name and password in the address become
 * Basic authentication, which is only sent over HTTPS.
 */
export function parseDavUrl(raw: string): DavTarget {
  const url = new URL(raw);
  const protocol = SCHEMES[url.protocol];
  if (!protocol) throw new Error('Not a WebDAV address (dav://, davs://, webdav:// or webdavs://).');
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if ((user || password) && protocol !== 'https:') throw new Error('Quiver only sends a WebDAV password over HTTPS. Use davs://.');
  const web = new URL(`${protocol}//${url.host}${url.pathname}${url.search}`);
  return { url: web.href, authorization: user || password ? `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` : null };
}

export interface DavEntry { url: string; collection: boolean; size: number }

const PROPFIND = '<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><prop><resourcetype/><getcontentlength/></prop></propfind>';

export function parseMultistatus(source: string, requestUrl: string): DavEntry[] {
  const root = parseXml(source);
  if (root.name !== 'multistatus') throw new Error('The server did not answer like a WebDAV server.');
  const out: DavEntry[] = [];
  for (const response of children(root, 'response')) {
    const href = child(response, 'href')?.text.trim();
    if (!href) continue;
    const ok = children(response, 'propstat').find((p) => /\s200\s/.test(` ${child(p, 'status')?.text ?? ''} `)) ?? child(response, 'propstat');
    const prop = ok && child(ok, 'prop');
    const type = prop && child(prop, 'resourcetype');
    out.push({
      url: new URL(href, requestUrl).href,
      collection: !!(type && child(type, 'collection')),
      size: Number(prop && child(prop, 'getcontentlength')?.text) || 0,
    });
  }
  return out;
}

/** Is `candidate` inside the folder `root`, on the same server? Servers cannot send Quiver elsewhere. */
export function insideFolder(root: string, candidate: string): boolean {
  const r = new URL(root);
  const c = new URL(candidate);
  const prefix = r.pathname.endsWith('/') ? r.pathname : `${r.pathname}/`;
  return r.origin === c.origin && (c.pathname === r.pathname || c.pathname.startsWith(prefix));
}

/** The local relative path for a remote file below the root folder, each part made safe for Windows. */
export function localPath(root: string, file: string): string {
  const prefix = new URL(root).pathname.replace(/\/?$/, '/');
  const rest = new URL(file).pathname.slice(prefix.length);
  const parts = rest.split('/').filter(Boolean).map((p) => safeFileName(decodeURIComponent(p)));
  if (!parts.length) throw new Error('Empty WebDAV path.');
  return path.join(...parts);
}

async function propfind(ctx: JobContext, url: string, depth: 0 | 1, authorization: string | null): Promise<DavEntry[]> {
  const headers: Record<string, string> = { Depth: String(depth), 'Content-Type': 'application/xml; charset=utf-8' };
  if (authorization) headers.Authorization = authorization;
  const response = await ctx.fetch(url, { method: 'PROPFIND', headers, body: PROPFIND, signal: ctx.control.signal } as never);
  if (response.status === 401) throw new Error('The WebDAV server needs a user name and password: davs://user:password@server/…');
  if (response.status !== 207) throw new Error(`${new URL(url).host} answered ${response.status} to a folder listing.`);
  return parseMultistatus(await response.text(), url);
}

/**
 * Download a WebDAV file, or a whole folder into a local folder of the same name, keeping its structure.
 * Listings stay inside the requested folder on the same server, and local names are sanitized.
 */
export async function runWebDav(raw: string, ctx: JobContext, place: (name: string) => string): Promise<string[]> {
  const { url, authorization } = parseDavUrl(raw);
  const [self] = await propfind(ctx, url, 0, authorization);
  if (!self) throw new Error('The WebDAV server returned nothing for that address.');
  const auth: Record<string, string> = authorization ? { Authorization: authorization } : {};
  if (!self.collection) {
    const final = place(safeFileName(decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? 'download')));
    await getFile(ctx, url, `${final}.part`, auth, (n) => ctx.progress({ received: n, total: self.size, detail: '' }));
    fs.renameSync(`${final}.part`, final);
    return [final];
  }
  const root = url.endsWith('/') ? url : `${url}/`;
  const files: DavEntry[] = [];
  const queue: { url: string; depth: number }[] = [{ url: root, depth: 0 }];
  const seen = new Set<string>([root]);
  while (queue.length) {
    await ctx.control.ready();
    const folder = queue.shift()!;
    for (const entry of await propfind(ctx, folder.url, 1, authorization)) {
      if (seen.has(entry.url) || !insideFolder(root, entry.url)) continue;
      seen.add(entry.url);
      if (entry.collection) {
        if (folder.depth + 1 > DEPTH_LIMIT) throw new Error('The WebDAV folder is nested too deeply.');
        queue.push({ url: entry.url.endsWith('/') ? entry.url : `${entry.url}/`, depth: folder.depth + 1 });
      } else {
        files.push(entry);
        if (files.length > FILE_LIMIT) throw new Error('The WebDAV folder has more than 10,000 files.');
      }
    }
    ctx.progress({ received: 0, total: 0, detail: `Listing… ${files.length} files found` });
  }
  const folderName = safeFileName(decodeURIComponent(new URL(root).pathname.split('/').filter(Boolean).pop() ?? new URL(root).host));
  const target = place(folderName);
  const total = files.reduce((n, f) => n + f.size, 0);
  let received = 0;
  const saved: string[] = [];
  for (const [i, file] of files.entries()) {
    const local = path.join(target, localPath(root, file.url));
    if (!path.resolve(local).startsWith(path.resolve(target) + path.sep)) throw new Error('A WebDAV name tried to leave the folder.');
    fs.mkdirSync(path.dirname(local), { recursive: true });
    await getFile(ctx, file.url, `${local}.part`, auth, (n) => ctx.progress({ received: received + n, total, detail: `${i + 1} of ${files.length} files` }));
    fs.renameSync(`${local}.part`, local);
    received += fs.statSync(local).size;
    saved.push(local);
  }
  if (!saved.length) fs.mkdirSync(target, { recursive: true });
  return [target];
}

async function getFile(ctx: JobContext, url: string, file: string, headers: Record<string, string>, onTotal: (n: number) => void): Promise<void> {
  const response = await fetchOk(ctx, url, headers);
  if (!response.body) throw new Error('Empty response.');
  const out = fs.createWriteStream(file);
  let n = 0;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      await ctx.control.ready();
      await new Promise<void>((resolve, reject) => out.write(chunk, (e) => (e ? reject(e) : resolve())));
      n += chunk.length;
      onTotal(n);
    }
  } finally {
    await new Promise<void>((resolve) => out.end(() => resolve()));
  }
}
