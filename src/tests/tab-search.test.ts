import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tabCommandTarget, tabSearchQuery, tabSearchSuggestions, tabTargetMatches } from '../main/tab-search';
import { commandChoice, type CommandContext } from '../shared/command-preview';
import type { TabCommandTarget } from '../shared/types';

const context: CommandContext = {
  spaceId: 'work', spaceName: 'Work', tabId: 1, url: 'https://staging.example/',
  internal: false, mode: 'current', navigation: 0, navigationPending: false,
};
const url = 'https://user:password@prod.example:8443/dashboard?token=secret#private';
const groups = [{ name: 'App', local: '', staging: 'https://staging.example', prod: 'https://prod.example:8443' }];
const tab = { id: 4, spaceId: 'isolated', title: 'Orders dashboard', commandRevision: 2 };
const target = tabCommandTarget(tab, url, 'Isolated', groups);

test('tab search reserves only the complete command prefix', () => {
  assert.equal(tabSearchQuery(' tab '), '');
  assert.equal(tabSearchQuery('TAB\tOrders'), 'orders');
  for (const text of ['tablet', 'tab.example', 'https://example.com/tab', 'browser tab']) {
    assert.equal(tabSearchQuery(text), undefined);
  }
});

test('search uses titles and hostnames, prioritizes the active Space, and limits results', () => {
  const sameSpace = { ...target, id: 1, spaceId: context.spaceId, spaceName: context.spaceName, host: 'staging.example' };
  const results = (query: string, tabs: TabCommandTarget[]) => tabSearchSuggestions(query, context.spaceId, tabs).map(({ action }) =>
    action.type === 'activate-tab' ? action.target.id : action.type);
  assert.deepEqual(results('orders', [target, sameSpace]), [1, 4]);
  assert.deepEqual(results('prod.example', [target, sameSpace]), [4]);
  assert.deepEqual(results('token=secret', [target, sameSpace]), ['noop']);
  assert.deepEqual(results('no matches', []), ['noop']);
  const many = Array.from({ length: 25 }, (_, index) => ({ ...target, id: index + 2 }));
  assert.deepEqual(results('', [...many, sameSpace]), [1, ...many.slice(0, 19).map(({ id }) => id)]);
});

test('the result previews the existing tab and sends only display metadata to the command bar', () => {
  const [suggestion] = tabSearchSuggestions('', context.spaceId, [target]);
  const choice = commandChoice(suggestion, context);
  assert.equal(choice.detail, 'prod.example:8443 · Isolated · PROD');
  assert.equal(choice.preview.title, 'Switch to open tab');
  assert.equal(choice.preview.tab, 'existing');
  assert.equal(choice.preview.space, 'Isolated');
  assert.equal(choice.preview.environment, 'PROD');
  assert.equal(choice.accessibleLabel, 'Switch to Orders dashboard, prod.example:8443, Space: Isolated, PROD');
  assert.equal(choice.acceptsAltEnter, false);
  assert.equal(choice.alternative, undefined);
  assert.doesNotMatch(JSON.stringify(choice), /password|dashboard\?|token=|#private/);
  assert.equal(tabCommandTarget({ ...tab, title: url }, url, 'Isolated', groups).title, 'prod.example:8443');
  const [noMatch] = tabSearchSuggestions('missing', context.spaceId, [target]);
  assert.equal(commandChoice(noMatch, context).preview.canRun, false);
});

test('tab target validation catches changes to identity, location, preview and navigation', () => {
  assert.equal(tabTargetMatches(target, { ...target }), true);
  for (const changed of [{ id: 5 }, { spaceId: 'work' }, { spaceName: 'Renamed' }, { title: 'Dashboard' },
    { environment: 'STAGING' as const }, { host: 'staging.example' }, { revision: 3 }, { url: url + '-updated' }]) {
    assert.equal(tabTargetMatches(target, { ...target, ...changed }), false);
  }
});
