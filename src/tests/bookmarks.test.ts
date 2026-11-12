import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { mergeBookmarks, normalizeBookmarks } from '../main/bookmarks';
import { discoverBookmarkProfiles, parseChromiumBookmarks, readChromiumBookmarks } from '../main/chromium-bookmarks';
import { parseLaunchArgs } from '../main/launch-args';

test('normalizes HTTP(S) bookmarks and rejects credentials, local files and duplicates', () => {
  assert.deepEqual(normalizeBookmarks([
    { url: ' HTTPS://Example.com:443 ', title: 'Example' },
    { url: 'https://example.com/', title: 'Duplicate' },
    { url: 'http://example.test/path' },
    { url: 'https://user:password@example.com' },
    { url: 'javascript:alert(1)' },
    { url: 'file:///private.txt' },
    { url: 'https://example.com/a\tb' },
    { url: 'https://example.com/' + 'x'.repeat(4096) },
  ]), [
    { url: 'https://example.com/', title: 'Example' },
    { url: 'http://example.test/path', title: 'example.test' },
  ]);
});

test('preserves existing titles and order across repeated imports', () => {
  const saved = [{ url: 'https://example.com/', title: 'My example' }];
  const imported = mergeBookmarks(saved, [
    { url: 'https://example.com', title: 'Other name' },
    { url: 'https://example.com/two', title: 'Second' },
  ]);
  assert.equal(imported.added, 1);
  assert.deepEqual(imported.bookmarks, [...saved, { url: 'https://example.com/two', title: 'Second' }]);
  assert.equal(mergeBookmarks(imported.bookmarks, imported.bookmarks).added, 0);
});

test('parses Chromium bookmark folders without collecting unrelated data', () => {
  const bookmarks = parseChromiumBookmarks({
    roots: {
      bookmark_bar: {
        type: 'folder', children: [
          { type: 'url', name: 'First', url: 'https://example.test/' },
          { type: 'folder', children: [
            { type: 'url', name: 'Second', url: 'http://example.test/two' },
            { type: 'url', name: 'Duplicate', url: 'https://EXAMPLE.test:443/' },
          ] },
          { type: 'unrecognized', url: 'https://example.test/ignored' },
        ],
      },
    },
  });
  assert.deepEqual(bookmarks, [
    { url: 'https://example.test/', title: 'First' },
    { url: 'http://example.test/two', title: 'Second' },
  ]);
  assert.throws(() => parseChromiumBookmarks({ roots: [] }), /Invalid bookmark file/);
});

test('discovers only known Chromium bookmark profiles and reads an explicitly selected file', async () => {
  const localAppData = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'quiver-bookmark-test-')));
  try {
    const profile = path.join(localAppData, 'Google/Chrome/User Data/Default');
    const other = path.join(localAppData, 'Google/Chrome/User Data/Guest Profile');
    await fs.mkdir(profile, { recursive: true });
    await fs.mkdir(other, { recursive: true });
    const payload = JSON.stringify({ roots: { other: { type: 'folder', children: [
      { type: 'url', name: 'Example', url: 'https://example.test/' },
    ] } } });
    await fs.writeFile(path.join(profile, 'Bookmarks'), payload);
    await fs.writeFile(path.join(other, 'Bookmarks'), 'invalid');
    assert.deepEqual(await discoverBookmarkProfiles(localAppData), [{ browser: 'chrome', profile: 'Default', label: 'Google Chrome · Default' }]);
    assert.deepEqual(await readChromiumBookmarks(localAppData, 'chrome', 'Default'), [{ url: 'https://example.test/', title: 'Example' }]);
    await assert.rejects(readChromiumBookmarks(localAppData, 'chrome', '..'), /no longer available/);
    await assert.rejects(readChromiumBookmarks(localAppData, '__proto__', 'Default'), /no longer available/);
    await fs.writeFile(path.join(profile, 'Bookmarks'), 'invalid');
    await assert.rejects(readChromiumBookmarks(localAppData, 'chrome', 'Default'), /file is invalid/);
  } finally {
    await fs.rm(localAppData, { recursive: true, force: true });
  }
});

test('launch argument handling retains cold and warm browser links and matches only the exact import flag', () => {
  assert.deepEqual(parseLaunchArgs(['Quiver.exe', 'HTTPS://example.test/?a=1&b=2', '--import-bookmarks']), {
    urls: ['HTTPS://example.test/?a=1&b=2'], importBookmarks: true,
  });
  assert.deepEqual(parseLaunchArgs(['Quiver.exe', 'https://example.test/?a=--import-bookmarks', 'file:///x', '--import-bookmarks=on']), {
    urls: ['https://example.test/?a=--import-bookmarks'], importBookmarks: false,
  });
  assert.deepEqual(parseLaunchArgs(['Quiver.exe', '--', 'https://example.test/', '--import-bookmarks']), {
    urls: ['https://example.test/'], importBookmarks: false,
  });
});
