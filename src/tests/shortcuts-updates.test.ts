import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Input } from 'electron';
import {
  bindingOf, bindingProblem, formatBinding, isPageFirst, isReservedBinding, normalizeShortcutOverrides, parseBinding,
  setShortcutOverrides, shortcutFor, shortcutLabel,
} from '../main/shortcuts';
import { BROWSER_COMMANDS, commandKeys } from '../main/palette';
import { compareVersions, fetchLatestRelease, isNewer, normalizeUpdateState, parseVersion, UpdateChecker, validateRelease, type FetchLike, type UpdateState } from '../main/updates';

const input = (code: string, mods: Partial<Input> = {}) => ({ type: 'keyDown', code, control: false, shift: false, alt: false, meta: false, ...mods } as Input);

test('bindings are canonical and need Ctrl/Alt unless they are function keys', () => {
  assert.equal(parseBinding('Shift+Ctrl+KeyB'), 'Ctrl+Shift+KeyB');
  assert.equal(parseBinding('F7'), 'F7');
  assert.equal(parseBinding('Shift+KeyB'), null, 'would type a capital B');
  assert.equal(parseBinding('KeyB'), null);
  assert.equal(parseBinding('Ctrl+Ctrl+KeyB'), null);
  assert.equal(parseBinding('Ctrl+Win+KeyB'), null);
  assert.equal(parseBinding('Ctrl+Bogus'), null);
  assert.equal(parseBinding(42), null);
  assert.equal(bindingOf(input('KeyB', { meta: true, shift: true })), 'Ctrl+Shift+KeyB');
  assert.equal(formatBinding('Ctrl+KeyB'), 'Ctrl+B');
  assert.equal(formatBinding('Alt+ArrowLeft'), 'Alt+←');
  assert.equal(formatBinding('Ctrl+Equal'), 'Ctrl+=');
});

test('reserved shortcuts vs page-first shortcuts', () => {
  for (const b of ['Ctrl+KeyT', 'Ctrl+KeyW', 'Ctrl+KeyL', 'Ctrl+KeyK', 'Ctrl+Tab', 'Ctrl+Shift+Tab', 'Ctrl+Digit4', 'Alt+Digit2', 'F5', 'Ctrl+KeyR',
    'F12', 'Ctrl+Shift+KeyT', 'Ctrl+Shift+KeyN', 'Ctrl+Shift+KeyI', 'Ctrl+KeyJ', 'Ctrl+Shift+PageUp', 'Ctrl+PageDown']) {
    assert.ok(isReservedBinding(b), b);
  }
  for (const b of ['Ctrl+KeyB', 'Ctrl+KeyF', 'F3', 'Ctrl+Equal', 'Ctrl+Shift+KeyP', 'Ctrl+Alt+Digit7']) assert.ok(!isReservedBinding(b), b);
  assert.ok(isPageFirst('toggle-sidebar'));
  assert.ok(isPageFirst('find'));
  assert.ok(isPageFirst('zoom-in'));
  assert.ok(!isPageFirst('close-tab'));
  assert.ok(!isPageFirst('tab-3'));
  assert.ok(!isPageFirst('back'), 'Alt+← stays with the browser, as in Chrome');
});

test('overrides are validated: known actions, valid keys, no reserved or duplicate keys', () => {
  assert.deepEqual(normalizeShortcutOverrides({ 'toggle-sidebar': 'Ctrl+Shift+KeyS', bogus: 'Ctrl+KeyQ' }), { 'toggle-sidebar': 'Ctrl+Shift+KeyS' });
  assert.deepEqual(normalizeShortcutOverrides({ 'toggle-sidebar': 'Ctrl+KeyT' }), {}, 'reserved');
  assert.deepEqual(normalizeShortcutOverrides({ 'toggle-sidebar': 'Ctrl+KeyC' }), {}, 'editing key');
  assert.deepEqual(normalizeShortcutOverrides({ 'toggle-sidebar': 'KeyB' }), {});
  assert.deepEqual(normalizeShortcutOverrides({ 'toggle-sidebar': 'Ctrl+KeyF' }), {}, "find's default");
  assert.deepEqual(normalizeShortcutOverrides({ 'toggle-sidebar': 'Ctrl+KeyF', find: 'Ctrl+KeyG' }), { 'toggle-sidebar': 'Ctrl+KeyF', find: 'Ctrl+KeyG' }, 'a swap is fine');
  assert.deepEqual(normalizeShortcutOverrides({ find: 'Ctrl+KeyG', 'copy-link': 'Ctrl+KeyG' }), { find: 'Ctrl+KeyG' }, 'first action wins');
  assert.deepEqual(normalizeShortcutOverrides({ 'toggle-sidebar': '' }), { 'toggle-sidebar': '' }, 'unbound');
  assert.deepEqual(normalizeShortcutOverrides({ 'toggle-sidebar': 'Ctrl+KeyB' }), {}, 'same as default');
  assert.deepEqual(normalizeShortcutOverrides(['x']), {});
  assert.deepEqual(normalizeShortcutOverrides(null), {});
});

test('conflict detection explains why a key is refused', () => {
  assert.match(bindingProblem('toggle-sidebar', 'Ctrl+KeyF', {})!, /already used by Find in page/);
  assert.match(bindingProblem('toggle-sidebar', 'Ctrl+KeyW', {})!, /reserved/);
  assert.match(bindingProblem('toggle-sidebar', 'Ctrl+KeyV', {})!, /editing/);
  assert.equal(bindingProblem('toggle-sidebar', 'Ctrl+KeyF', { find: 'Ctrl+KeyG' }), null);
  assert.equal(bindingProblem('copy-link', 'Ctrl+Shift+KeyC', {}), null);
});

test('shortcutFor follows overrides; labels and palette hints follow them too', () => {
  try {
    assert.equal(shortcutFor(input('KeyB', { control: true })), 'toggle-sidebar');
    assert.equal(shortcutLabel('toggle-sidebar'), 'Ctrl+B');
    const sidebar = BROWSER_COMMANDS.find((c) => c.command === 'toggle-sidebar')!;
    assert.equal(commandKeys(sidebar), 'Ctrl+B');
    setShortcutOverrides(normalizeShortcutOverrides({ 'toggle-sidebar': 'Ctrl+Shift+KeyS', 'copy-link': 'Ctrl+Shift+KeyC' }));
    assert.equal(shortcutFor(input('KeyB', { control: true })), null);
    assert.equal(shortcutFor(input('KeyS', { control: true, shift: true })), 'toggle-sidebar');
    assert.equal(shortcutFor(input('KeyC', { control: true, shift: true })), 'copy-link');
    assert.equal(commandKeys(sidebar), 'Ctrl+Shift+S');
    assert.equal(commandKeys(BROWSER_COMMANDS.find((c) => c.command === 'copy-link')!), 'Ctrl+Shift+C');
    assert.equal(commandKeys(BROWSER_COMMANDS.find((c) => c.command === 'reload')!), 'Ctrl+R');
    assert.equal(shortcutFor(input('KeyT', { control: true })), 'command-new', 'reserved keys unaffected');
    setShortcutOverrides({ 'toggle-sidebar': '' });
    assert.equal(shortcutLabel('toggle-sidebar'), '');
    assert.equal(shortcutFor(input('KeyB', { control: true })), null);
  } finally {
    setShortcutOverrides({});
  }
  assert.equal(shortcutFor(input('KeyB', { control: true }), { 'toggle-sidebar': 'Ctrl+KeyY' }), null, 'explicit overrides');
  // Defaults the sidebar and toolbar labels depend on.
  assert.equal(shortcutLabel('preview'), 'Ctrl+Shift+P');
  assert.equal(shortcutLabel('boosts'), 'Ctrl+Shift+B');
  assert.equal(shortcutLabel('back'), 'Alt+←');
  assert.equal(shortcutLabel('env'), 'Ctrl+Alt+E');
  assert.equal(shortcutLabel('zoom-reset'), 'Ctrl+0');
});

test('semver comparison including prereleases', () => {
  const cmp = (a: string, b: string) => Math.sign(compareVersions(parseVersion(a)!, parseVersion(b)!));
  const order = ['0.1.0-alpha', '0.1.0-alpha.1', '0.1.0-alpha.beta', '0.1.0-beta', '0.1.0-beta.2', '0.1.0-beta.11', '0.1.0-rc.1', '0.1.0', '0.1.1', '0.2.0', '1.0.0'];
  for (let i = 0; i + 1 < order.length; i++) {
    assert.equal(cmp(order[i], order[i + 1]), -1, `${order[i]} < ${order[i + 1]}`);
    assert.equal(cmp(order[i + 1], order[i]), 1);
  }
  assert.equal(cmp('v0.1.0-beta.4', '0.1.0-beta.4'), 0);
  assert.equal(cmp('1.0.0+build.5', '1.0.0'), 0);
  assert.ok(isNewer('v0.1.0-beta.4', '0.1.0-beta.3'));
  assert.ok(!isNewer('v0.1.0-beta.3', '0.1.0-beta.3'));
  assert.ok(!isNewer('garbage', '0.1.0'));
  for (const bad of ['1.0', '01.0.0', '1.0.0-01', '1.0.0-', 'v', '1.0.0 ']) assert.equal(parseVersion(bad), null, bad);
});

const RELEASE = { tag_name: 'v0.1.0-beta.4', html_url: 'https://github.com/SeanShaffer88/Quiver-Browser/releases/tag/v0.1.0-beta.4', draft: false };

test('release responses are validated strictly', () => {
  assert.deepEqual(validateRelease(RELEASE), { version: '0.1.0-beta.4', url: RELEASE.html_url });
  assert.equal(validateRelease({ ...RELEASE, html_url: 'http://github.com/SeanShaffer88/Quiver-Browser/releases/tag/v1.0.0' }), null);
  assert.equal(validateRelease({ ...RELEASE, html_url: 'https://evil.example/SeanShaffer88/Quiver-Browser/releases/tag/v1' }), null);
  assert.equal(validateRelease({ ...RELEASE, html_url: 'https://github.com/someone/else/releases/tag/v1' }), null);
  assert.equal(validateRelease({ ...RELEASE, html_url: 'https://github.com/SeanShaffer88/Quiver-Browser/releases/../../../evil' }), null);
  assert.equal(validateRelease({ ...RELEASE, html_url: 'https://user@github.com/SeanShaffer88/Quiver-Browser/releases/tag/v1' }), null);
  assert.equal(validateRelease({ ...RELEASE, tag_name: 'latest' }), null);
  assert.equal(validateRelease({ ...RELEASE, draft: true }), null);
  assert.equal(validateRelease(null), null);
  assert.equal(validateRelease([RELEASE]), null);
  assert.deepEqual(normalizeUpdateState({ lastCheckedAt: 'x', latest: { version: '1.0.0', url: 'https://evil.example/' }, dismissed: 'nope' }), { lastCheckedAt: 0 });
});

function fakeFetch(body: unknown, status = 200): FetchLike & { calls: { url: string; headers: Record<string, string> }[] } {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fn = (async (url, init) => {
    calls.push({ url, headers: init.headers });
    return { ok: status >= 200 && status < 300, status, text: async () => typeof body === 'string' ? body : JSON.stringify(body) };
  }) as FetchLike & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

test('fetchLatestRelease sends a plain request and rejects bad answers', async () => {
  const f = fakeFetch(RELEASE);
  assert.deepEqual(await fetchLatestRelease(f), { version: '0.1.0-beta.4', url: RELEASE.html_url });
  assert.equal(f.calls[0].url, 'https://api.github.com/repos/SeanShaffer88/Quiver-Browser/releases/latest');
  assert.equal(f.calls[0].headers['User-Agent'], 'Quiver');
  assert.equal(Object.keys(f.calls[0].headers).some((h) => /authorization/i.test(h)), false);
  await assert.rejects(fetchLatestRelease(fakeFetch(RELEASE, 403)), /403/);
  await assert.rejects(fetchLatestRelease(fakeFetch('not json')), /Unexpected/);
  await assert.rejects(fetchLatestRelease((async () => { throw new Error('offline'); }) as FetchLike), /Could not reach/);
});

test('UpdateChecker: off by default, once a day, notice only for newer releases, dismissible', async () => {
  let state: UpdateState = { lastCheckedAt: 0 };
  let enabled = false;
  let now = 1_000_000_000_000;
  const f = fakeFetch(RELEASE);
  const checker = new UpdateChecker(() => state, (s) => { state = s; }, () => enabled, '0.1.0-beta.3', f, () => now);
  assert.equal(await checker.maybeCheck(), null);
  await checker.check();
  assert.equal(f.calls.length, 0, 'no network while disabled');
  enabled = true;
  const status = await checker.maybeCheck();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(status?.notice, { version: '0.1.0-beta.4', url: RELEASE.html_url });
  assert.equal(await checker.maybeCheck(), null, 'not again the same day');
  now += 25 * 60 * 60 * 1000;
  await checker.maybeCheck();
  assert.equal(f.calls.length, 2);
  checker.dismiss();
  assert.equal(checker.notice(), undefined);
  enabled = false;
  assert.equal(checker.status().notice, undefined);

  const same = new UpdateChecker(() => state, (s) => { state = s; }, () => true, '0.1.0-beta.4', fakeFetch(RELEASE), () => now);
  state = { lastCheckedAt: 0 };
  assert.equal((await same.check()).notice, undefined, 'already up to date');
  const failing = new UpdateChecker(() => state, (s) => { state = s; }, () => true, '0.1.0-beta.3', fakeFetch({}, 500), () => now + 1);
  const failed = await failing.check();
  assert.match(failed.error!, /500/);
  assert.equal(state.lastCheckedAt, now + 1, 'failures count, so an offline machine is not retried every hour');
});
