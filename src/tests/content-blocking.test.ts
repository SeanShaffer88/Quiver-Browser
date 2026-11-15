import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLOCKED_DOMAINS } from '../main/blocklist';
import { DomainList, hostMatches, MAX_ALLOWED_SITES, normalizeAllowList, shouldBlock, siteAllowed, toggleSite } from '../main/content-blocking';
import { normalizePrivacy, PrivacyController } from '../main/privacy';

const list = new DomainList();

test('the bundled list is a few hundred plain, unique hostnames', () => {
  assert.ok(BLOCKED_DOMAINS.length >= 300 && BLOCKED_DOMAINS.length <= 2000, String(BLOCKED_DOMAINS.length));
  for (const d of BLOCKED_DOMAINS) assert.match(d, /^[a-z0-9.-]+\.[a-z0-9-]+$/, d);
  assert.equal(list.size, new Set(BLOCKED_DOMAINS).size);
  // Hosts that serve real content must never be on it.
  for (const d of ['google.com', 'facebook.com', 'gstatic.com', 'googleapis.com', 'youtube.com', 'cloudfront.net', 'github.com']) {
    assert.equal(list.match(d), null, d);
  }
});

test('a host matches a listed domain or any subdomain of it, but not a look-alike', () => {
  assert.equal(list.match('doubleclick.net'), 'doubleclick.net');
  assert.equal(list.match('stats.g.doubleclick.net'), 'doubleclick.net');
  assert.equal(list.match('WWW.Google-Analytics.com.'), 'google-analytics.com');
  assert.equal(list.match('notdoubleclick.net'), null);
  assert.equal(list.match('doubleclick.net.example.com'), null);
  assert.equal(list.match('www.facebook.com'), null);
  assert.equal(list.match('connect.facebook.net'), 'connect.facebook.net');
  assert.equal(hostMatches('a.b.com', 'b.com'), true);
  assert.equal(hostMatches('ab.com', 'b.com'), false);
});

test('only third-party subresources to listed hosts are blocked', () => {
  const page = 'https://news.example.com/story';
  assert.equal(shouldBlock({ url: 'https://securepubads.g.doubleclick.net/tag/js/gpt.js', resourceType: 'script', pageUrl: page }, list, []), true);
  assert.equal(shouldBlock({ url: 'https://www.google-analytics.com/g/collect', resourceType: 'xhr', pageUrl: page }, list, []), true);
  // Navigating to a listed site, or a listed site loading its own files, keeps working.
  assert.equal(shouldBlock({ url: 'https://doubleclick.net/', resourceType: 'mainFrame', pageUrl: page }, list, []), false);
  assert.equal(shouldBlock({ url: 'https://static.criteo.com/a.js', resourceType: 'script', pageUrl: 'https://www.criteo.com/' }, list, []), false);
  assert.equal(shouldBlock({ url: 'https://cdn.example.com/app.js', resourceType: 'script', pageUrl: page }, list, []), false);
  assert.equal(shouldBlock({ url: 'data:text/plain,hi', resourceType: 'image', pageUrl: page }, list, []), false);
  // With no known page (a service worker, say) a listed host is still blocked.
  assert.equal(shouldBlock({ url: 'https://doubleclick.net/x', resourceType: 'xhr' }, list, []), true);
});

test('the allow list turns blocking off for a site and its subdomains', () => {
  const allow = ['example.com'];
  assert.equal(shouldBlock({ url: 'https://doubleclick.net/x', resourceType: 'script', pageUrl: 'https://news.example.com/' }, list, allow), false);
  assert.equal(shouldBlock({ url: 'https://doubleclick.net/x', resourceType: 'script', pageUrl: 'https://example.org/' }, list, allow), true);
  assert.equal(siteAllowed('https://www.example.com/a', allow), true);
  assert.equal(siteAllowed('quiver://settings', allow), false);
});

test('toggling a site adds it without www and removes the entry that covers it', () => {
  const on = toggleSite('https://www.Example.com/page', []);
  assert.deepEqual(on, ['example.com']);
  assert.deepEqual(toggleSite('https://shop.example.com/', on), []);
  assert.deepEqual(toggleSite('quiver://newtab', on), on);
});

test('stored allow lists are validated, deduplicated and capped', () => {
  assert.deepEqual(normalizeAllowList(['B.com', 'b.com', 'a.com.', '', 'not a host', 'http://x.com', 7, null]), ['a.com', 'b.com']);
  assert.deepEqual(normalizeAllowList('example.com'), []);
  assert.equal(normalizeAllowList(Array.from({ length: 900 }, (_, i) => `s${i}.com`)).length, MAX_ALLOWED_SITES);
  const p = normalizePrivacy({ blockTrackers: 'no', adAllowList: ['ok.com', '<bad>'] }, 'win32');
  assert.equal(p.blockTrackers, true);
  assert.deepEqual(p.adAllowList, ['ok.com']);
  assert.equal(normalizePrivacy({ blockTrackers: false }, 'win32').blockTrackers, false);
});

type BeforeRequest = (d: Record<string, unknown>, cb: (r: { cancel?: boolean }) => void) => void;

function fakeSession() {
  let listener: BeforeRequest | undefined;
  return {
    get listener() { return listener!; },
    setSpellCheckerEnabled: () => undefined,
    webRequest: { onBeforeSendHeaders: () => undefined, onBeforeRequest: (_f: unknown, fn: BeforeRequest) => { listener = fn; } },
  };
}

test('the controller cancels listed requests, counts them per page and resets the count on navigation', () => {
  let settings = normalizePrivacy(undefined, 'win32');
  const changed: number[] = [];
  const c = new PrivacyController(() => settings, () => undefined, { changed: (wc) => changed.push(wc.id) });
  const ses = fakeSession();
  c.configureSession(ses as never);
  const handlers: Record<string, (d: { isMainFrame: boolean; isSameDocument: boolean }) => void> = {};
  const wc = {
    id: 7, isDestroyed: () => false, getURL: () => 'https://news.example.com/', setWebRTCIPHandlingPolicy: () => undefined,
    once: () => undefined, on: (event: string, fn: (d: { isMainFrame: boolean; isSameDocument: boolean }) => void) => { handlers[event] = fn; },
  };
  c.configureContents(wc as never);
  const send = (url: string, resourceType = 'script') => {
    let result: { cancel?: boolean } = {};
    ses.listener({ url, resourceType, webContents: wc }, (r) => { result = r; });
    return result.cancel === true;
  };
  assert.equal(send('https://www.googletagmanager.com/gtm.js'), true);
  assert.equal(send('https://cdn.example.com/app.js'), false);
  assert.equal(send('https://ads.pubmatic.com/x', 'image'), true);
  assert.equal(c.blockedCount(7), 2);
  handlers['did-start-navigation']({ isMainFrame: true, isSameDocument: true });
  assert.equal(c.blockedCount(7), 2);
  handlers['did-start-navigation']({ isMainFrame: true, isSameDocument: false });
  assert.equal(c.blockedCount(7), 0);
  assert.deepEqual(changed, [7, 7, 7]);
  // Turning the setting off applies to the next request without re-registering anything.
  settings = { ...settings, blockTrackers: false };
  assert.equal(send('https://www.googletagmanager.com/gtm.js'), false);
  settings = { ...settings, blockTrackers: true, adAllowList: ['example.com'] };
  assert.equal(send('https://www.googletagmanager.com/gtm.js'), false);
});

test('sessions the controller is told to skip never block', () => {
  const c = new PrivacyController(() => normalizePrivacy(undefined, 'win32'), () => undefined, { appliesTo: () => false });
  const ses = fakeSession();
  c.configureSession(ses as never);
  let result: { cancel?: boolean } = {};
  ses.listener({ url: 'https://doubleclick.net/x', resourceType: 'script' }, (r) => { result = r; });
  assert.equal(result.cancel, undefined);
});
