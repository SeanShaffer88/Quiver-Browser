import assert from 'node:assert/strict';
import { test } from 'node:test';
import { internalPage, internalRole } from '../main/internal-access';

test('only a main frame matching its assigned packaged page receives a role', () => {
  const documents = [
    ['quiver://app/shell.html', 'shell'],
    ['quiver://app/commandbar.html', 'commandbar'],
    ['quiver://app/settings.html?import=bookmarks', 'settings'],
    ['quiver://app/boosts.html?file=localhost.css#editor', 'boosts'],
  ] as const;
  for (const [url, role] of documents) {
    for (const assignedPage of ['shell', 'commandbar', 'settings', 'boosts', 'newtab', undefined] as const) {
      assert.equal(internalRole(url, assignedPage, true), assignedPage === role ? role : undefined);
      assert.equal(internalRole(url, assignedPage, false), undefined);
    }
  }
});

test('new tabs and packaged assets have no privileged role', () => {
  assert.equal(internalPage('quiver://app/newtab.html'), 'newtab');
  assert.equal(internalRole('quiver://app/newtab.html', 'newtab', true), undefined);
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
    assert.equal(internalRole(url, 'settings', true), undefined, url);
  }
});
