import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, resolveInput } from '../shared/parser';
import { decodeJwt, decodeUnix } from '../shared/decoders';
import { badgeFor, detectEnv, switchEnv } from '../shared/env';
import type { EnvGroup, ParseContext } from '../shared/types';

const groups: EnvGroup[] = [
  { name: 'app', local: 'localhost:3000', staging: 'https://staging.example.com', prod: 'https://example.com' },
];
const ctx = (currentUrl?: string): ParseContext => ({ searchEngine: 'https://duckduckgo.com/?q=%s', envGroups: groups, currentUrl });

const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

test('resolveInput', () => {
  assert.equal(resolveInput('example.com/a', 'x%s'), 'https://example.com/a');
  assert.equal(resolveInput('localhost:3000/x', 'x%s'), 'http://localhost:3000/x');
  assert.equal(resolveInput(':8080', 'x%s'), 'http://localhost:8080');
  assert.equal(resolveInput('hello world', 'https://s/?q=%s'), 'https://s/?q=hello%20world');
  assert.equal(resolveInput('https://a.b', 'x%s'), 'https://a.b');
});

test('prefixes', () => {
  const nav = (s: string) => {
    const a = parseCommand(s, ctx())[0].action;
    return a.type === 'navigate' ? a.url : '';
  };
  assert.equal(nav('gh facebook/react'), 'https://github.com/facebook/react');
  assert.equal(nav('gh facebook/react#12'), 'https://github.com/facebook/react/pull/12');
  assert.equal(nav('npm left-pad'), 'https://www.npmjs.com/package/left-pad');
  assert.equal(nav('mdn flex gap'), 'https://developer.mozilla.org/en-US/search?q=flex%20gap');
  assert.equal(nav('caniuse grid'), 'https://caniuse.com/?search=grid');
  assert.equal(nav('so cors error'), 'https://stackoverflow.com/search?q=cors%20error');
});

test('jwt decode is local', () => {
  const token = `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ sub: '1', exp: 4102444800 })}.sig`;
  const d = decodeJwt(token);
  assert.equal(d?.payload.sub, '1');
  const s = parseCommand(`Bearer ${token}`, ctx());
  assert.equal(s[0].kind, 'jwt');
  assert.match(s[0].label, /HS256/);
  assert.equal(decodeJwt('not.a.jwt'), null);
});

test('malformed token input stays local', () => {
  for (const input of ['Bearer abc123', 'Authorization: Bearer opaque', 'eyJhbGciOi.bad.payload']) {
    const suggestions = parseCommand(input, ctx());
    assert.equal(suggestions[0].kind, 'jwt');
    assert.deepEqual(suggestions.map(({ action }) => action.type), ['noop']);
  }
});

test('JWT timestamps outside the Date range remain plain claims', () => {
  const token = `${b64u({ alg: 'none' })}.${b64u({ exp: 1e40, iat: -1e40, nbf: 1700000000 })}.`;
  const suggestions = parseCommand(token, ctx());
  assert.doesNotMatch(suggestions[0].label, /(?:exp|iat) /);
  assert.ok(suggestions.some(({ label }) => label === 'exp: 1e+40'));
  assert.ok(suggestions.some(({ label }) => label.includes('2023-11-14T22:13:20.000Z')));
});

test('unix decode', () => {
  assert.equal(decodeUnix('1700000000')?.iso, '2023-11-14T22:13:20.000Z');
  assert.equal(decodeUnix('1700000000000')?.iso, '2023-11-14T22:13:20.000Z');
  assert.equal(decodeUnix('12345'), null);
});

test('env switching keeps path and query', () => {
  const url = 'http://localhost:3000/a/b?x=1#h';
  assert.equal(detectEnv(url, groups)?.env, 'LOCAL');
  assert.equal(switchEnv(url, groups), 'https://staging.example.com/a/b?x=1#h');
  assert.equal(switchEnv('https://staging.example.com/a/b?x=1#h', groups), 'https://example.com/a/b?x=1#h');
  assert.equal(switchEnv('https://example.com/p', groups), 'http://localhost:3000/p');
  assert.equal(switchEnv(url, groups, 'PROD'), 'https://example.com/a/b?x=1#h');
  assert.equal(switchEnv('https://other.dev/', groups), null);
  assert.equal(badgeFor('http://localhost:9999/', groups), 'LOCAL');
  assert.equal(badgeFor('http://127.0.0.2:4173/', groups), 'LOCAL');
  assert.equal(badgeFor('http://[::1]:8080/', groups), 'LOCAL');
  assert.equal(badgeFor('https://example.com/', groups), 'PROD');
  assert.equal(badgeFor('https://other.dev/', groups), null);
});

test('boost commands', () => {
  const s = parseCommand('boost', ctx('https://www.github.com/x'));
  assert.ok(s.some((x) => x.action.type === 'boost' && x.action.name === 'github.com.css'));
  const t = parseCommand('boost all', ctx());
  assert.equal(t[0].action.type === 'boost' && t[0].action.name, 'all.css');
});

import { parseNetstat, extractTitle } from '../main/devservers';
import { boostMatchesHost, isValidBoostName } from '../main/boosts';

test('netstat parse', () => {
  const out = `  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       1234
  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       99
  TCP    [::1]:8080             [::]:0                 LISTENING       55
  TCP    192.168.1.5:9000       0.0.0.0:0              LISTENING       12
  TCP    [::]:8080             [::]:0                 LISTENING       55
  TCP    [::]:5173             [::]:0                 LISTENING       99
  TCP    127.0.0.2:4173        0.0.0.0:0              LISTENING       99
  TCP    [2001:db8::1]:8888    [::]:0                 LISTENING       55
  TCP    127.0.0.1:65536       0.0.0.0:0              LISTENING       99
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       4`;
  assert.deepEqual(parseNetstat(out), [
    { host: '127.0.0.1', port: 3000 },
    { host: '127.0.0.2', port: 4173 },
    { host: '127.0.0.1', port: 5173 },
    { host: '::1', port: 5173 },
    { host: '::1', port: 8080 },
  ]);
  assert.equal(extractTitle('<html><title> My  App &amp; Co </title>'), 'My App & Co');
});

test('boost names', () => {
  assert.ok(isValidBoostName('github.com.css'));
  assert.ok(isValidBoostName('all.css'));
  assert.ok(isValidBoostName('localhost.ts'));
  assert.ok(!isValidBoostName('../x.css'));
  for (const name of ['con.css', 'prn.ts', 'aux.example.css', 'nul.ts', 'com1.css', 'lpt9.ts']) {
    assert.ok(!isValidBoostName(name), name);
  }
  assert.ok(isValidBoostName('console.example.css'));
  assert.ok(boostMatchesHost('github.com.css', 'www.github.com'));
  assert.ok(!boostMatchesHost('github.com.css', 'gist.github.com'));
  assert.ok(boostMatchesHost('all.css', 'anything.dev'));
});
