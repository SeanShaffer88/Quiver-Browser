import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinTarget, meetingProvider, meetSuggestions } from '../main/meetings';
import { mediaOrigin, normalizeSitePermissions } from '../main/site-permissions';

test('meeting providers are recognised by host and path', () => {
  const cases: [string, string | undefined][] = [
    ['https://meet.google.com/abc-defg-hij', 'Google Meet'],
    ['https://us02web.zoom.us/j/123456789?pwd=x', 'Zoom'],
    ['https://app.zoom.us/wc/join/123456789', 'Zoom'],
    ['https://teams.microsoft.com/l/meetup-join/19%3ameeting', 'Microsoft Teams'],
    ['https://teams.live.com/meet/9876', 'Microsoft Teams'],
    ['https://acme.webex.com/meet/jane', 'Webex'],
    ['https://meet.jit.si/MyRoom', 'Jitsi Meet'],
    ['https://whereby.com/team-room', 'Whereby'],
    ['https://evilzoom.us/j/1', undefined],
    ['https://meet.google.com.evil.example/abc', undefined],
    ['http://meet.google.com/abc-defg-hij', undefined],
    ['https://example.com/', undefined],
  ];
  for (const [url, provider] of cases) assert.equal(meetingProvider(url), provider, url);
});

test('join targets accept links, Meet codes and Zoom IDs, and open Zoom in its web client', () => {
  assert.deepEqual(joinTarget('abc-defg-hij'), { provider: 'Google Meet', url: 'https://meet.google.com/abc-defg-hij' });
  assert.deepEqual(joinTarget('https://us02web.zoom.us/j/123456789?pwd=Secret1'),
    { provider: 'Zoom', url: 'https://app.zoom.us/wc/join/123456789?pwd=Secret1' });
  assert.deepEqual(joinTarget('123 456 7890'), { provider: 'Zoom', url: 'https://app.zoom.us/wc/join/1234567890' });
  assert.deepEqual(joinTarget('meet.jit.si/Room'), { provider: 'Jitsi Meet', url: 'https://meet.jit.si/Room' });
  assert.equal(joinTarget('https://example.com/j/123'), undefined);
  assert.equal(joinTarget('12'), undefined);
});

test('meet commands', () => {
  assert.equal(meetSuggestions('meeting notes'), undefined);
  assert.deepEqual(meetSuggestions('meet')?.map((s) => s.label), ['Start a Google Meet', 'Start a Jitsi Meet room']);
  assert.deepEqual(meetSuggestions('meet abc-defg-hij')?.[0], {
    kind: 'meet', label: 'Join Google Meet', detail: 'meet.google.com/abc-defg-hij', action: { type: 'navigate', url: 'https://meet.google.com/abc-defg-hij' },
  });
  assert.equal(meetSuggestions('meet nonsense')?.[0].action.type, 'noop');
});

test('media is only offered to secure top-level origins', () => {
  assert.equal(mediaOrigin('https://meet.google.com/abc', true), 'https://meet.google.com');
  assert.equal(mediaOrigin('http://localhost:3000/call', true), 'http://localhost:3000');
  assert.equal(mediaOrigin('http://example.com/', true), undefined);
  assert.equal(mediaOrigin('https://meet.google.com/abc', false), undefined);
  assert.equal(mediaOrigin('file:///C:/x.html', true), undefined);
});

test('saved site permissions are validated', () => {
  assert.deepEqual(normalizeSitePermissions({
    'https://meet.google.com': 'allow', 'https://bad.example/path': 'allow', 'http://x.example': 'allow',
    'https://zoom.us': 'block', 'https://y.example': 'maybe', 'http://127.0.0.1:8080': 'allow',
  }), { 'https://meet.google.com': 'allow', 'https://zoom.us': 'block', 'http://127.0.0.1:8080': 'allow' });
  assert.deepEqual(normalizeSitePermissions('nope'), {});
});

test('media requests prompt, remember choices and reset on navigation', async () => {
  const { MediaPermissions } = await import('../main/site-permissions');
  const saved: Record<string, 'allow' | 'block'> = {};
  let changes = 0;
  const m = new MediaPermissions(() => saved, (o, d) => { if (d) saved[o] = d; else delete saved[o]; }, () => changes++,
    (url) => url.startsWith('https://meet.google.com/'));
  const meet = 'https://meet.google.com/abc-defg-hij';
  assert.equal(m.check(1, meet, true), true, 'meeting sites are askable');
  assert.equal(m.check(1, 'https://other.example/', true), false);
  assert.equal(m.check(1, meet, false), false, 'never for subframes');

  const first = m.request(1, meet, meet, true, ['microphone']);
  const second = m.request(1, meet, meet, true, ['camera']);
  const prompt = m.promptFor(1)!;
  assert.deepEqual(prompt.kinds, ['microphone', 'camera']);
  m.decide(prompt.id, 'once');
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(m.hasPageGrant(1), true);
  assert.equal(m.hadPageGrant(1), true);
  assert.equal(await m.request(1, meet, meet, true, ['camera']), true, 'once lasts for the page');
  m.reset(1);
  assert.equal(m.hasPageGrant(1), false);
  assert.equal(m.hadPageGrant(1), false);

  const blocked = m.request(1, 'https://spy.example/', 'https://spy.example/', true, ['camera']);
  m.decide(m.promptFor(1)!.id, 'block');
  assert.equal(await blocked, false);
  assert.equal(saved['https://spy.example'], 'block');
  assert.equal(await m.request(2, 'https://spy.example/', 'https://spy.example/', true, ['camera']), false, 'blocked without asking');

  const always = m.request(3, meet, meet, true, ['camera']);
  m.decide(m.promptFor(3)!.id, 'always');
  assert.equal(await always, true);
  assert.equal(await m.request(4, meet, meet, true, ['microphone']), true, 'always skips the prompt');

  assert.equal(await m.request(5, meet, 'https://evil.example/', true, ['camera']), false, 'cross-origin requester');
  const pending = m.request(6, 'https://x.example/', 'https://x.example/', true, ['camera']);
  m.reset(6);
  assert.equal(await pending, false, 'navigating away denies');
  assert.ok(changes > 0);
});

test('forget clears same-origin page grants and prompts again in the same tab', async () => {
  const { MediaPermissions } = await import('../main/site-permissions');
  const saved: Record<string, 'allow' | 'block'> = {};
  const m = new MediaPermissions(() => saved, (origin, decision) => {
    if (decision) saved[origin] = decision;
    else delete saved[origin];
  }, () => undefined, () => false);
  const page = 'https://calls.example/room';
  const other = 'https://other.example/room';
  const grantOnce = m.request(1, page, page, true, ['camera']);
  m.decide(m.promptFor(1)!.id, 'once');
  assert.equal(await grantOnce, true);
  const unrelated = m.request(3, other, other, true, ['camera']);
  m.decide(m.promptFor(3)!.id, 'once');
  assert.equal(await unrelated, true);
  const grantAlways = m.request(2, page, page, true, ['microphone']);
  m.decide(m.promptFor(2)!.id, 'always');
  assert.equal(await grantAlways, true);
  assert.equal(saved['https://calls.example'], 'allow');

  m.forget('https://calls.example');
  assert.equal(saved['https://calls.example'], undefined);
  assert.equal(m.hasPageGrant(1), false);
  assert.equal(m.hasPageGrant(2), false);
  assert.equal(m.hasPageGrant(3), true);
  assert.equal(m.hadPageGrant(1), true, 'an existing stream may still be running');
  assert.equal(m.hadPageGrant(2), true);
  assert.equal(m.check(1, page, true), false);
  assert.equal(m.check(2, page, true), false);
  const afterForget = m.request(2, page, page, true, ['microphone']);
  assert.ok(m.promptFor(2), 'forget prompts again in the same tab');
  m.decide(m.promptFor(2)!.id, 'once');
  assert.equal(await afterForget, true);
});

test('blocking an origin clears other tabs’ grants and rejects their pending requests', async () => {
  const { MediaPermissions } = await import('../main/site-permissions');
  const saved: Record<string, 'allow' | 'block'> = {};
  const m = new MediaPermissions(() => saved, (origin, decision) => {
    if (decision) saved[origin] = decision;
    else delete saved[origin];
  }, () => undefined, () => false);
  const page = 'https://calls.example/room';
  const first = m.request(1, page, page, true, ['camera']);
  m.decide(m.promptFor(1)!.id, 'once');
  assert.equal(await first, true);
  const blocked = m.request(2, page, page, true, ['microphone']);
  const pending = m.request(3, page, page, true, ['screen']);
  m.decide(m.promptFor(2)!.id, 'block');

  assert.deepEqual(await Promise.all([blocked, pending]), [false, false]);
  assert.equal(m.promptFor(3), undefined);
  assert.equal(m.hasPageGrant(1), false);
  assert.equal(m.hadPageGrant(1), true);
  assert.equal(await m.request(1, page, page, true, ['camera']), false);
  m.forget('https://calls.example');
  const afterForget = m.request(1, page, page, true, ['camera']);
  assert.ok(m.promptFor(1), 'the one-time grant did not survive a site block');
  m.reset(1);
  assert.equal(await afterForget, false);
  assert.equal(m.hadPageGrant(1), false);
});
