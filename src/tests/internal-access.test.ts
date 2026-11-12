import assert from 'node:assert/strict';
import { test } from 'node:test';
import { internalPage, internalRole } from '../main/internal-access';

test('only the registered view for a packaged document receives its role', () => {
  const documents = [
    ['quiver://app/shell.html', 'shell', 'shell'],
    ['quiver://app/commandbar.html', 'overlay', 'commandbar'],
    ['quiver://app/settings.html?import=bookmarks', 'tab', 'settings'],
    ['quiver://app/boosts.html?file=localhost.css#editor', 'tab', 'boosts'],
  ] as const;
  for (const [url, owner, role] of documents) {
    for (const sender of ['shell', 'overlay', 'tab', undefined] as const) {
      assert.equal(internalRole(url, sender, true), sender === owner ? role : undefined);
      assert.equal(internalRole(url, sender, false), undefined);
    }
  }
});

test('new tabs and packaged assets have no privileged role', () => {
  assert.equal(internalPage('quiver://app/newtab.html'), 'newtab');
  assert.equal(internalRole('quiver://app/newtab.html', 'tab', true), undefined);
  assert.equal(internalPage('quiver://app/settings.js'), undefined);
  assert.equal(internalPage('quiver://app/'), undefined);
});

test('external URLs and aliases cannot identify a privileged document', () => {
  for (const url of [
    'https://app/settings.html',
    'quiver://app.example/settings.html',
    'quiver://app@other/settings.html',
    'quiver://user@app/settings.html',
    'quiver://app:42/settings.html',
    'quiver://app/assets/../settings.html',
    'quiver://app/%73ettings.html',
  ]) {
    assert.equal(internalPage(url), undefined, url);
    assert.equal(internalRole(url, 'tab', true), undefined, url);
  }
});
