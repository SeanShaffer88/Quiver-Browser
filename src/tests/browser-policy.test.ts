import assert from 'node:assert/strict';
import test from 'node:test';
import { allowsInternalNavigation, allowsSitePermission, allowsWebNavigation, internalTabUrl, isInternalTabPage } from '../main/browser-policy';

test('web views permit ordinary URLs and local links with a local file initiator', () => {
  for (const url of ['http://localhost:3000/dev', 'http://[::1]:8080/', 'https://example.test/', 'about:blank',
    'about:srcdoc', 'data:text/html,hello', 'blob:https://example.test/test']) {
    assert.equal(allowsWebNavigation(url), true, url);
  }
  assert.equal(allowsWebNavigation('file:///C:/fixture/other.html', 'file:///C:/fixture/index.html'), true);
});

test('web views reject privileged and OS protocols and file links without a local initiator', () => {
  const local = 'file:///C:/fixture/index.html';
  for (const url of ['quiver://app/settings.html', 'chrome://settings/', 'devtools://devtools/',
    'mailto:test@example.test', 'ms-settings:display', 'about:config', 'invalid',
    'file://server/share/index.html', 'file:////server/share/index.html', 'file:///%5cserver/share/index.html']) {
    assert.equal(allowsWebNavigation(url, local), false, url);
  }
  for (const initiator of [undefined, 'about:blank', 'https://example.test/', 'file://server/share/index.html']) {
    assert.equal(allowsWebNavigation(local, initiator), false, initiator);
  }
});

test('internal renderer navigation stays within its exact top-level document', () => {
  assert.equal(allowsInternalNavigation('quiver://app/settings.html?import=bookmarks#status', true, 'settings'), true);
  assert.equal(allowsInternalNavigation('quiver://app/boosts.html?file=localhost.css', true, 'boosts'), true);
  assert.equal(allowsInternalNavigation('quiver://app/shell.html', true, 'shell'), true);
  assert.equal(allowsInternalNavigation('quiver://app/settings.html', true, 'shell'), false);
  assert.equal(allowsInternalNavigation('quiver://app/settings.html', false, 'settings'), false);
  assert.equal(allowsInternalNavigation('quiver://app/settings.html', true, undefined), false);
  assert.equal(allowsInternalNavigation('quiver://app/unused/../settings.html', true, 'settings'), false);
  assert.equal(allowsInternalNavigation('https://example.test/settings.html', true, 'settings'), false);
  assert.equal(isInternalTabPage('newtab'), true);
  assert.equal(isInternalTabPage('shell'), false);
  assert.equal(isInternalTabPage('commandbar'), false);
});

test('internal tab recovery keeps the assigned document after a same-document URL change', () => {
  const initial = 'quiver://app/settings.html?import=bookmarks';
  const sameRole = 'quiver://app/settings.html?import=bookmarks#status';
  assert.equal(internalTabUrl('settings', initial, sameRole), sameRole);
  assert.equal(internalTabUrl('settings', initial, 'quiver://app/boosts.html'), initial);
  assert.equal(internalTabUrl('settings', initial, 'about:blank'), initial);
});

const request = {
  permission: 'fullscreen',
  isMainFrame: true,
  topLevelUrl: 'http://localhost:3000/page',
  requestingUrl: 'http://localhost:3000/page',
  requestingOrigin: 'http://localhost:3000',
};

test('permission requests and checks allow only the existing top-level web capabilities', () => {
  assert.equal(allowsSitePermission(request), true);
  assert.equal(allowsSitePermission({ ...request, requestingOrigin: undefined }), true);
  assert.equal(allowsSitePermission({ ...request, permission: 'clipboard-sanitized-write', requestingUrl: undefined }), true);
  assert.equal(allowsSitePermission({ ...request, topLevelUrl: 'file:///C:/fixture.html',
    requestingUrl: 'file:///C:/fixture.html#section', requestingOrigin: 'file://' }), true);
  for (const permission of ['camera', 'media', 'display-capture', 'geolocation', 'notifications', 'clipboard-read',
    'automatic-fullscreen', 'openExternal', 'hid', 'serial', 'usb', 'unknown']) {
    assert.equal(allowsSitePermission({ ...request, permission }), false, permission);
  }
});

test('permission decisions deny mismatched origins, embedded frames, unknown sources and internal pages', () => {
  for (const changes of [
    { isMainFrame: false },
    { topLevelUrl: undefined },
    { requestingUrl: undefined, requestingOrigin: undefined },
    { requestingOrigin: 'http://localhost:3001' },
    { requestingUrl: 'https://example.test/' },
    { requestingUrl: 'https://example.test/', requestingOrigin: undefined },
    { topLevelUrl: 'quiver://app/settings.html', requestingUrl: 'quiver://app/settings.html' },
    { topLevelUrl: 'file:///C:/fixture.html', requestingUrl: undefined, requestingOrigin: 'file://' },
    { topLevelUrl: 'file:///C:/fixture.html', requestingUrl: 'file:///C:/other.html', requestingOrigin: undefined },
    { topLevelUrl: 'file:////server/share/a.html', requestingUrl: 'file:////server/share/a.html', requestingOrigin: undefined },
  ]) {
    assert.equal(allowsSitePermission({ ...request, ...changes }), false, JSON.stringify(changes));
  }
});
