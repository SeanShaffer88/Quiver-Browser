import fs from 'node:fs/promises';
import path from 'node:path';
import type { Bookmark, BookmarkProfile } from '../shared/types';
import { BOOKMARK_LIMIT, normalizeBookmarks } from './bookmarks';

const BROWSERS = {
  chrome: ['Google Chrome', 'Google/Chrome/User Data'],
  edge: ['Microsoft Edge', 'Microsoft/Edge/User Data'],
  brave: ['Brave', 'BraveSoftware/Brave-Browser/User Data'],
  vivaldi: ['Vivaldi', 'Vivaldi/User Data'],
} as const;

const PROFILE_NAME = /^(Default|Profile [0-9]{1,5})$/;
const FILE_LIMIT = 16 * 1024 * 1024;

function browserDirectory(localAppData: string, browser: unknown): string | undefined {
  if (!path.isAbsolute(localAppData) || typeof browser !== 'string' || !Object.hasOwn(BROWSERS, browser)) return undefined;
  return path.join(localAppData, BROWSERS[browser as keyof typeof BROWSERS][1]);
}

async function bookmarkFile(localAppData: string, browser: unknown, profile: unknown): Promise<string | undefined> {
  const directory = browserDirectory(localAppData, browser);
  if (!directory || typeof profile !== 'string' || !PROFILE_NAME.test(profile)) return undefined;
  const file = path.join(directory, profile, 'Bookmarks');
  try {
    if (!(await fs.lstat(file)).isFile()) return undefined;
    const resolved = await fs.realpath(file);
    // Reject symlinks and junctions out of the selected browser's known profile.
    return path.normalize(resolved).toLowerCase() === path.normalize(file).toLowerCase() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

export async function discoverBookmarkProfiles(localAppData: string): Promise<BookmarkProfile[]> {
  const matches = await Promise.all(Object.entries(BROWSERS).map(async ([browser, [name]]) => {
    const directory = browserDirectory(localAppData, browser);
    if (!directory) return [];
    try {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      const profiles = entries
        .filter((entry) => entry.isDirectory() && PROFILE_NAME.test(entry.name))
        .map(({ name: profile }) => profile)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .slice(0, 100);
      const files = await Promise.all(profiles.map((profile) => bookmarkFile(localAppData, browser, profile)));
      return profiles.flatMap((profile, i) => files[i] ? [{ browser, profile, label: `${name} · ${profile}` }] : []);
    } catch {
      return [];
    }
  }));
  return matches.flat();
}

export function parseChromiumBookmarks(input: unknown): Bookmark[] {
  if (!input || typeof input !== 'object') throw new Error('Invalid bookmark file.');
  const { roots } = input as { roots?: unknown };
  if (!roots || typeof roots !== 'object' || Array.isArray(roots)) throw new Error('Invalid bookmark file.');
  const found = new Map<string, Bookmark>();
  const pending: unknown[] = Object.values(roots).reverse();
  while (pending.length && found.size < BOOKMARK_LIMIT) {
    const node = pending.pop();
    if (!node || typeof node !== 'object') continue;
    const { type, name, url, children } = node as Record<string, unknown>;
    if (type === 'folder' && Array.isArray(children)) {
      for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]);
    } else if (type === 'url') {
      const [bookmark] = normalizeBookmarks([{ title: name, url }]);
      if (bookmark && !found.has(bookmark.url)) found.set(bookmark.url, bookmark);
    }
  }
  return [...found.values()];
}

export async function readChromiumBookmarks(localAppData: string, browser: unknown, profile: unknown): Promise<Bookmark[]> {
  const file = await bookmarkFile(localAppData, browser, profile);
  if (!file) throw new Error('The selected browser profile is no longer available.');
  const handle = await fs.open(file, 'r').catch(() => {
    throw new Error('The selected bookmark file could not be opened. Close the other browser and try again.');
  });
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > FILE_LIMIT) throw new Error('The selected bookmark file exceeds the 16 MB import limit.');
    const buffer = Buffer.alloc(stats.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== stats.size) throw new Error('The selected bookmark file changed during import. Try again.');
    try {
      return parseChromiumBookmarks(JSON.parse(buffer.toString('utf8', 0, size).replace(/^\uFEFF/, '')));
    } catch {
      throw new Error('The selected browser bookmark file is invalid.');
    }
  } finally {
    await handle.close();
  }
}
