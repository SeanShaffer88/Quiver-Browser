import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostResolverOptions, normalizePrivacy, PrivacyController, privacyHeaders } from '../main/privacy';

test('defaults favour privacy; spell check is on only where the OS checker avoids downloads', () => {
  assert.deepEqual(normalizePrivacy(undefined, 'win32'), { gpc: true, hideLocalIp: true, secureDns: 'automatic', dohTemplate: '', spellcheck: true, clearOnExit: false });
  assert.equal(normalizePrivacy(undefined, 'linux').spellcheck, false);
  assert.equal(normalizePrivacy({ spellcheck: true }, 'linux').spellcheck, true);
});

test('invalid values fall back; a custom DNS server must be a plain https template', () => {
  assert.deepEqual(normalizePrivacy({ gpc: 'yes', secureDns: 'custom', dohTemplate: 'http://dns.example/dns-query' }, 'win32'),
    normalizePrivacy(undefined, 'win32'));
  assert.equal(normalizePrivacy({ secureDns: 'custom', dohTemplate: 'https://u:p@dns.example/q' }, 'win32').secureDns, 'automatic');
  const custom = normalizePrivacy({ secureDns: 'custom', dohTemplate: ' https://dns.example/dns-query{?dns} ' }, 'win32');
  assert.equal(custom.secureDns, 'custom');
  assert.equal(custom.dohTemplate, 'https://dns.example/dns-query{?dns}');
  assert.equal(normalizePrivacy({ secureDns: 'off', dohTemplate: 'https://x'.padEnd(400, 'x') }, 'win32').dohTemplate, '');
});

test('GPC adds Sec-GPC and DNT, and leaves headers alone when off', () => {
  assert.deepEqual(privacyHeaders({ Accept: '*/*' }, true), { Accept: '*/*', 'Sec-GPC': '1', DNT: '1' });
  assert.deepEqual(privacyHeaders({ Accept: '*/*' }, false), { Accept: '*/*' });
});

test('host resolver options follow the Secure DNS choice', () => {
  const p = normalizePrivacy(undefined, 'win32');
  assert.deepEqual(hostResolverOptions(p), { secureDnsMode: 'automatic' });
  assert.deepEqual(hostResolverOptions({ ...p, secureDns: 'off' }), { secureDnsMode: 'off' });
  assert.deepEqual(hostResolverOptions({ ...p, secureDns: 'custom', dohTemplate: 'https://d.example/q' }),
    { secureDnsMode: 'secure', secureDnsServers: ['https://d.example/q'] });
});

test('the controller applies settings to sessions and pages and reapplies on change', () => {
  let settings = normalizePrivacy(undefined, 'win32');
  const calls: string[] = [];
  let listener: ((d: { requestHeaders: Record<string, string> }, cb: (r: { requestHeaders: Record<string, string> }) => void) => void) | undefined;
  const ses = {
    setSpellCheckerEnabled: (on: boolean) => calls.push(`spell:${on}`),
    webRequest: { onBeforeSendHeaders: (_f: unknown, fn: typeof listener) => { listener = fn; } },
  };
  const wc = { isDestroyed: () => false, setWebRTCIPHandlingPolicy: (p: string) => calls.push(`webrtc:${p}`) };
  const dns: unknown[] = [];
  const c = new PrivacyController(() => settings, (o) => dns.push(o));
  c.configureSession(ses as never);
  c.configureContents(wc as never);
  let sent: Record<string, string> = {};
  listener!({ requestHeaders: {} }, (r) => { sent = r.requestHeaders; });
  assert.equal(sent['Sec-GPC'], '1');
  settings = { ...settings, gpc: false, hideLocalIp: false, spellcheck: false, secureDns: 'off' };
  c.apply();
  listener!({ requestHeaders: {} }, (r) => { sent = r.requestHeaders; });
  assert.equal(sent['Sec-GPC'], undefined);
  assert.deepEqual(calls, ['spell:true', 'webrtc:default_public_interface_only', 'spell:false', 'webrtc:default']);
  assert.deepEqual(dns.at(-1), { secureDnsMode: 'off' });
});
