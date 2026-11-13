import assert from 'node:assert/strict';
import test from 'node:test';
import { ARC_SIDEBAR_MAX_BYTES, parseArcSidebar, previewOf } from '../main/arc-sidebar';

function sidebar(spaces: unknown[], items: unknown[], topAppsContainerIDs: unknown[] = []): string {
  return JSON.stringify({ sidebar: { containers: [{ global: {} }, { spaces, items, topAppsContainerIDs }] } });
}

function parsed(text: string) {
  const result = parseArcSidebar(text);
  if (typeof result === 'string') assert.fail(result);
  return result;
}

/** The host-only preview Settings receives. */
function review(text: string) {
  return previewOf(parsed(text));
}

test('joins spaces by their ordered roots, preserves nested pinned items, and counts Today panes', () => {
  const custom = { custom: { _0: { directoryBasename: 'Private Directory', machineID: 'private-device' } } };
  const result = review(sidebar(
    [
      'second', { title: 'Same name', profile: { default: true }, containerIDs: ['pinned', 'older'] },
      'first', {
        title: 'Same name', profile: custom,
        newContainerIDs: [{ pinned: {} }, 'newer', { unpinned: {} }, 'today'],
      },
    ],
    [
      'older', { childrenIds: ['renamed'] },
      'renamed', { title: 'Custom title', data: { tab: { savedTitle: 'Saved title', savedURL: 'https://one.test/private?key=secret#part' } } },
      'newer', { childrenIds: ['folder'] },
      'folder', { title: 'Research', data: { list: {} }, childrenIds: ['subfolder', 'plain'] },
      'subfolder', { data: { tabGroup: { title: 'References' } }, childrenIds: ['ref'] },
      'ref', { data: { tab: { savedTitle: 'Reference', savedURL: 'https://ref.test' } } },
      'plain', { data: { tab: { title: 'https://plain.test/private', url: 'http://plain.test/private' } } },
      'today', { childrenIds: ['split'] },
      'split', { data: { splitView: {} }, childrenIds: ['ref', 'plain'] },
    ],
  ));
  assert.deepEqual(result.spaces, [
    {
      title: 'Same name', profile: 0, pinnedTabs: 1, todayTabs: 0,
      pinned: [{ kind: 'tab', title: 'Custom title', host: 'one.test' }],
    },
    {
      title: 'Same name', profile: 1, pinnedTabs: 2, todayTabs: 2,
      pinned: [{ kind: 'folder', title: 'Research', children: [
        { kind: 'folder', title: 'References', children: [{ kind: 'tab', title: 'Reference', host: 'ref.test' }] },
        { kind: 'tab', title: 'plain.test', host: 'plain.test' },
      ] }],
    },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /private|secret|#part/);
});

test('keeps Favorites on their profile and distinguishes custom profiles from different devices', () => {
  const standard = { default: true };
  const first = { custom: { _0: { directoryBasename: 'Same path', machineID: 'device-one' } } };
  const second = { custom: { _0: { directoryBasename: 'Same path', machineID: 'device-two' } } };
  const result = review(sidebar(
    ['one', { profile: first }, 'two', { profile: standard }, 'three', { profile: first }, 'four', { profile: second }],
    [
      'declared', { childrenIds: ['default-favorite'] },
      'owned', { childrenIds: ['custom-favorite'], data: { itemContainer: { containerType: { topApps: { _0: first } } } } },
      'default-favorite', { data: { tab: { savedURL: 'https://default.test' } } },
      'custom-favorite', { data: { tab: { savedURL: 'https://custom.test' } } },
    ],
    [standard, 'declared', first, 'owned'],
  ));
  assert.deepEqual(result.spaces.map((space) => space.profile), [0, 1, 0, 2]);
  assert.deepEqual(result.profiles.map((profile) => [profile.label, profile.favoriteTabs]), [
    ['Profile 1', 1], ['Default profile', 1], ['Profile 3', 0],
  ]);
  assert.deepEqual(result.profiles[0].favorites, [{ kind: 'tab', title: 'custom.test', host: 'custom.test' }]);
  assert.equal(result.skipped, 0);
});

test('skips duplicate, dangling, cyclic, and unsupported entries without hiding valid siblings', () => {
  const result = review(sidebar(
    ['space', { profile: { default: true }, containerIDs: ['pinned', 'root'] }],
    [
      'root', { childrenIds: ['cycle', 'absent', 'script', 'credentials', 'valid', 'valid'] },
      'cycle', { data: { list: {} }, childrenIds: ['root'] },
      'script', { data: { tab: { savedURL: 'javascript:alert(1)' } } },
      'credentials', { data: { tab: { savedURL: 'https://user:pass@example.test/' } } },
      'valid', { title: 'Good\u202E title', data: { tab: { savedURL: 'https://valid.test' } } },
    ],
  ));
  assert.equal(result.skipped, 5);
  assert.equal(result.spaces[0].pinnedTabs, 1);
  assert.deepEqual(result.spaces[0].pinned[1], { kind: 'tab', title: 'Good  title', host: 'valid.test' });
});

test('reports depth and visit limits without walking the remainder of large graphs', () => {
  const items: unknown[] = [];
  for (let n = 0; n <= 20; n++) items.push(String(n), { childrenIds: [String(n + 1)], data: { list: {} } });
  const deep = review(sidebar(['space', { containerIDs: ['pinned', '0'] }], items));
  assert.equal(deep.limited, true);
  assert.equal(deep.skipped, 0);

  const huge = review(sidebar(
    ['space', { containerIDs: ['pinned', 'root'] }],
    ['root', { childrenIds: Array(2000).fill('broken') }],
  ));
  assert.equal(huge.limited, true);
  assert.equal(huge.skipped, 800);
});

test('distinguishes invalid, unrecognized, oversized, and empty sidebars', () => {
  assert.equal(parseArcSidebar('{"broken":'), 'invalid-json');
  assert.equal(parseArcSidebar('{"tabs":[]}'), 'unrecognized-sidebar');
  assert.equal(parseArcSidebar(' '.repeat(ARC_SIDEBAR_MAX_BYTES + 1)), 'too-large');
  assert.deepEqual(review(sidebar([], [])), { spaces: [], profiles: [], skipped: 0, limited: false });
});

test('keeps the full URL for import while the Settings preview carries hosts only', () => {
  const text = sidebar(
    ['space', { title: 'Work', containerIDs: ['pinned', 'root'] }],
    ['root', { childrenIds: ['tab'] }, 'tab', { data: { tab: { savedURL: 'https://one.test/private?key=secret#part' } } }],
  );
  assert.deepEqual(parsed(text).spaces[0].pinned, [{ kind: 'tab', title: 'one.test', host: 'one.test', url: 'https://one.test/private?key=secret#part' }]);
  assert.doesNotMatch(JSON.stringify(review(text)), /private|secret/);
});
