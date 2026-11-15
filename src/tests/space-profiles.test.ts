import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Bookmark, Space } from '../shared/types';
import {
  bookmarksElsewhere, bookmarksForProfile, localOnlyProfiles, normalizeProfilePermissions, normalizeSpaceBehavior, normalizeSpaceIcon,
  normalizeSpaceProfileFields, patchSpaceBehavior, peekModeFor, profileKind, profileLabel, profileOfPartition, readingProfile,
  rehomeBookmarks, spaceProfile, syncableBookmarks, withLocalOnlyBookmarks, archiveHoursFor,
} from '../main/profiles';
import { normalizeBookmarks, mergeBookmarks } from '../main/bookmarks';
import { BookmarkImports } from '../main/bookmark-import';
import { ProfileHistories } from '../main/history';
import { MediaPermissions, type SiteDecision } from '../main/site-permissions';
import { opensInPeek } from '../main/split';
import { JOIN, normalizeSyncedSpaces } from '../main/sync';
import { Store } from '../main/store';
import { persistableState } from '../main/private-spaces';

const GROUP = '0b6f3c1e-2a4d-4f5e-8a9b-1c2d3e4f5a6b';
const IMPORT = '1b6f3c1e-2a4d-4f5e-8a9b-1c2d3e4f5a6b';
const shared: Space = { id: 'space-main', name: 'Main', color: '#5b8cff', isolated: false };
const work: Space = { id: 'space-work', name: 'Work', color: '#ff7a59', isolated: true };
const arcA: Space = { id: `arc-space-${GROUP.replace('0b', '2b')}`, name: 'Arc A', color: '#22aa66', isolated: true, arcImportId: IMPORT, sessionGroupId: GROUP };
const arcB: Space = { id: `arc-space-${GROUP.replace('0b', '3b')}`, name: 'Arc B', color: '#22aa66', isolated: true, arcImportId: IMPORT, sessionGroupId: GROUP };
const priv: Space = { id: 'private-x', name: 'Private', color: '#8b5cf6', isolated: true, private: true };
const spaces = [shared, work, arcA, arcB, priv];

function tempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiver-profiles-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a profile is the storage partition: shared, separate, imported Arc profile, or none for private Spaces', () => {
  assert.equal(profileOfPartition('persist:quiver-shared'), 'shared');
  assert.equal(profileOfPartition('persist:quiver-space-space-work'), 'space-space-work');
  assert.equal(profileOfPartition('persist:quiver-internal'), null, 'Quiver’s own pages are no profile');
  assert.equal(profileOfPartition('quiver-private-x'), null);
  assert.equal(spaceProfile(shared), 'shared');
  assert.equal(spaceProfile(work), 'space-space-work');
  assert.equal(spaceProfile(arcA), `arc-${GROUP}`);
  assert.equal(spaceProfile(arcB), spaceProfile(arcA), 'Spaces of one Arc profile share it');
  assert.equal(spaceProfile(priv), null);
  assert.equal(readingProfile(priv), 'shared', 'private Spaces read the shared profile');
  assert.deepEqual([shared, work, arcA, priv].map(profileKind), ['shared', 'separate', 'separate', 'private']);
  assert.equal(profileLabel(spaces, 'shared'), 'Shared profile');
  assert.equal(profileLabel(spaces, `arc-${GROUP}`), 'Arc A, Arc B profile');
  assert.deepEqual([...localOnlyProfiles(spaces)], [`arc-${GROUP}`], 'Arc profiles are never synced');
});

test('bookmarks: one URL per profile, untagged ones stay in the shared library', () => {
  const list = normalizeBookmarks([
    { title: 'A', url: 'https://a.example/' },
    { title: 'A work', url: 'https://a.example/', profile: 'space-space-work' },
    { title: 'dupe', url: 'https://a.example/', profile: 'space-space-work' },
    { title: 'bad tag', url: 'https://b.example/', profile: '../x' },
    { title: 'tag shared', url: 'https://c.example/', profile: 'shared' },
  ]);
  assert.deepEqual(list, [
    { title: 'A', url: 'https://a.example/' },
    { title: 'A work', url: 'https://a.example/', profile: 'space-space-work' },
    { title: 'bad tag', url: 'https://b.example/' },
    { title: 'tag shared', url: 'https://c.example/' },
  ]);
  assert.deepEqual(bookmarksForProfile(list, 'shared').map((b) => b.title), ['A', 'bad tag', 'tag shared']);
  assert.deepEqual(bookmarksForProfile(list, 'space-space-work').map((b) => b.title), ['A work']);
  assert.equal(mergeBookmarks(list, [{ title: 'x', url: 'https://a.example/', profile: 'space-other' }]).added, 1);
  assert.equal(bookmarksElsewhere([...list, { title: 'o', url: 'https://o.example/', profile: 'space-gone' }], spaces), 1);
});

test('a deleted profile’s bookmarks move to the shared library without duplicates', () => {
  const list: Bookmark[] = [
    { title: 'A', url: 'https://a.example/' },
    { title: 'A work', url: 'https://a.example/', profile: 'space-work' },
    { title: 'W', url: 'https://w.example/', profile: 'space-work' },
    { title: 'Other', url: 'https://o.example/', profile: 'space-other' },
  ];
  assert.deepEqual(rehomeBookmarks(list, 'space-work'), [
    { title: 'A', url: 'https://a.example/' },
    { title: 'W', url: 'https://w.example/' },
    { title: 'Other', url: 'https://o.example/', profile: 'space-other' },
  ]);
});

test('sync leaves Arc-profile bookmarks on this device and keeps them when bookmarks arrive', () => {
  const arc = new Set([`arc-${GROUP}`]);
  const local: Bookmark[] = [{ title: 'S', url: 'https://s.example/' }, { title: 'Arc', url: 'https://arc.example/', profile: `arc-${GROUP}` }];
  assert.deepEqual(syncableBookmarks(local, arc), [local[0]]);
  const remote: Bookmark[] = [{ title: 'R', url: 'https://r.example/' }, { title: 'W', url: 'https://w.example/', profile: 'space-work' }];
  assert.deepEqual(withLocalOnlyBookmarks(remote, local, arc), [...remote, local[1]]);
  const joined = JOIN.bookmarks!([{ url: 'https://a.example/', profile: 'space-work' }], [{ url: 'https://a.example/' }]) as unknown[];
  assert.equal(joined.length, 2, 'the same URL in two profiles is two bookmarks');
});

test('bookmark imports go to the importing profile and only skip that profile’s duplicates', () => {
  const state = { bookmarks: [{ title: 'A', url: 'https://a.example/' }] as Bookmark[] };
  const imports = new BookmarkImports<object>(state, () => true);
  const owner = {};
  const generation = imports.begin(owner);
  const preview = imports.finish(owner, generation, 'file', [{ title: 'A', url: 'https://a.example/' }, { title: 'B', url: 'https://b.example/' }], false, 'space-work');
  assert.ok('toAdd' in preview);
  assert.equal(preview.toAdd, 2);
  assert.deepEqual(imports.commit(owner, preview.id), { added: 2 });
  assert.deepEqual(state.bookmarks.slice(1).map((b) => b.profile), ['space-work', 'space-work']);
  assert.ok(imports.getUndo(), 'the import can still be undone');
});

test('Space icons are one emoji', () => {
  for (const ok of ['🚀', '👩🏽‍💻', '🇳🇱', '❤️', '1️⃣']) assert.equal(normalizeSpaceIcon(ok), ok, ok);
  for (const bad of ['', 'A', 'ab', '🚀🚀', '🚀 x', '‮🚀', 7, null, '<b>']) assert.equal(normalizeSpaceIcon(bad), undefined, String(bad));
  assert.equal(normalizeSpaceIcon(' 🚀 '), '🚀');
});

test('Space behavior is validated; spell check only for separate profiles', () => {
  assert.equal(normalizeSpaceBehavior({}, 'shared'), undefined);
  assert.deepEqual(normalizeSpaceBehavior({ archiveAfterHours: 24, newTabPosition: 'top', peekLinks: 'all', spellcheck: false, junk: 1 }, 'separate'),
    { archiveAfterHours: 24, newTabPosition: 'top', peekLinks: 'all', spellcheck: false });
  assert.deepEqual(normalizeSpaceBehavior({ archiveAfterHours: 5, newTabPosition: 'left', peekLinks: true, spellcheck: true }, 'shared'), undefined);
  assert.deepEqual(normalizeSpaceBehavior({ archiveAfterHours: 0 }, 'shared'), { archiveAfterHours: 0 }, 'never archive is a real choice');
  const patched = patchSpaceBehavior({ archiveAfterHours: 24, peekLinks: 'off' }, { archiveAfterHours: null, newTabPosition: 'top', bogus: 1 }, 'shared');
  assert.deepEqual(patched, { peekLinks: 'off', newTabPosition: 'top' });
  assert.equal(patchSpaceBehavior({ peekLinks: 'off' }, { peekLinks: null }, 'shared'), undefined);
  assert.equal(archiveHoursFor({ ...shared, behavior: { archiveAfterHours: 0 } }, 12), 0);
  assert.equal(archiveHoursFor(shared, 12), 12);
  const normalized = normalizeSpaceProfileFields({ ...shared, color: '#ABCDEF', icon: 'nope', behavior: { spellcheck: true, newTabPosition: 'top' } });
  assert.deepEqual(normalized, { ...shared, color: '#abcdef', behavior: { newTabPosition: 'top' } });
});

test('Peek follows the Space’s choice, else the pinned-tab setting', () => {
  const pinned = { pinned: true, internal: false };
  const temporary = { pinned: false, internal: false };
  const url = 'https://x.example/';
  assert.equal(peekModeFor(shared, true), 'pinned');
  assert.equal(peekModeFor(shared, false), 'off');
  assert.equal(peekModeFor({ ...shared, behavior: { peekLinks: 'all' } }, false), 'all');
  assert.equal(opensInPeek(temporary, 'all', url), true);
  assert.equal(opensInPeek(temporary, 'pinned', url), false);
  assert.equal(opensInPeek(pinned, 'off', url), false);
  assert.equal(opensInPeek(pinned, true, url), true, 'the boolean form still works');
  assert.equal(opensInPeek({ pinned: false, internal: true }, 'all', url), false);
  assert.equal(opensInPeek(temporary, 'all', 'quiver://settings'), false);
});

test('each profile has its own history file; the shared one stays history.json', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify([{ url: 'https://old.example/', title: 'Old', visits: 3, lastVisit: 1 }]));
  const histories = new ProfileHistories(dir, () => true, () => 5);
  assert.deepEqual(histories.list('shared').map((e) => e.url), ['https://old.example/'], 'existing history stays in the shared profile');
  assert.deepEqual(histories.list('space-work'), []);
  histories.visit('space-work', 'https://work.example/', 'Work');
  assert.deepEqual(histories.list('shared').map((e) => e.url), ['https://old.example/']);
  histories.flush();
  const workFile = path.join(dir, 'history-profiles', 'space-work.json');
  assert.equal(JSON.parse(fs.readFileSync(workFile, 'utf8'))[0].url, 'https://work.example/');
  histories.list('space-idle');
  histories.flush();
  assert.equal(fs.existsSync(path.join(dir, 'history-profiles', 'space-idle.json')), false, 'looking does not create a file');
  assert.equal(histories.get('../evil'), null);
  histories.remove('space-work');
  assert.equal(fs.existsSync(workFile), false);
  histories.remove('shared');
  assert.ok(fs.existsSync(path.join(dir, 'history.json')), 'the shared history is never removed');
  histories.visit('space-a', 'https://a.example/', 'A');
  histories.clearAll(['space-a']);
  assert.deepEqual(histories.list('space-a'), []);
  assert.deepEqual(histories.list('shared'), []);
});

test('camera and microphone decisions are kept per profile', async () => {
  const saved: Record<string, Record<string, SiteDecision>> = {};
  const scopes: Record<number, string> = { 1: 'persist:quiver-shared', 2: 'persist:quiver-space-work' };
  const m = new MediaPermissions(
    (scope) => (saved[scope] ??= {}),
    (origin, decision, scope) => { if (decision) (saved[scope] ??= {})[origin] = decision; else delete saved[scope]?.[origin]; },
    () => {}, () => false, (id) => scopes[id],
  );
  const page = 'https://calls.example/room';
  const asked = m.request(1, page, page, true, ['camera']);
  m.decide(m.promptFor(1)!.id, 'always');
  assert.equal(await asked, true);
  assert.deepEqual(saved['persist:quiver-shared'], { 'https://calls.example': 'allow' });
  assert.equal(m.check(2, page, true), false, 'the separate profile was not asked yet');
  const other = m.request(2, page, page, true, ['microphone']);
  assert.equal(m.promptFor(2)?.scope, 'persist:quiver-space-work');
  m.decide(m.promptFor(2)!.id, 'block');
  assert.equal(await other, false);
  assert.equal(m.check(1, page, true), true, 'blocking in one profile leaves the other allowed');
  m.forget('https://calls.example', 'persist:quiver-space-work');
  assert.deepEqual(m.savedFor('persist:quiver-space-work'), {});
  assert.deepEqual(m.savedFor('persist:quiver-shared'), { 'https://calls.example': 'allow' });
});

test('saved profile permissions keep only separate profiles that exist', () => {
  const known = new Set(['space-work']);
  assert.deepEqual(normalizeProfilePermissions({
    'space-work': { 'https://a.example': 'allow', 'http://b.example': 'allow' },
    'space-gone': { 'https://a.example': 'block' },
    shared: { 'https://a.example': 'block' },
  }, known), { 'space-work': { 'https://a.example': 'allow' } });
  assert.deepEqual(normalizeProfilePermissions([], known), {});
});

test('synced Spaces carry a valid icon, never behavior', () => {
  const [space] = normalizeSyncedSpaces([{ id: 'space-a', name: 'A', color: '#123456', isolated: true, icon: '🚀', behavior: { newTabPosition: 'top' }, pinned: [] }], () => true, normalizeSpaceIcon);
  assert.equal(space.icon, '🚀');
  assert.equal('behavior' in space, false);
  const [plain] = normalizeSyncedSpaces([{ id: 'space-a', name: 'A', icon: 'not an emoji', pinned: [] }], () => true, normalizeSpaceIcon);
  assert.equal('icon' in plain, false);
});

test('older state migrates without losing anything: untagged data stays shared', (t) => {
  const file = path.join(tempDir(t), 'state.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    spaces: [
      { id: 'space-main', name: 'Main', color: '#5b8cff', isolated: false },
      { id: 'space-work', name: 'Work', color: '#FF7A59', isolated: true, icon: '💼', behavior: { archiveAfterHours: 168, spellcheck: false, bogus: true } },
    ],
    activeSpaceId: 'space-main', tabsBySpace: {}, activeIndexBySpace: {}, recentlyClosed: [],
    settings: { sitePermissions: { 'https://meet.example': 'allow' } },
    bookmarks: [{ title: 'A', url: 'https://a.example/' }, { title: 'W', url: 'https://w.example/', profile: 'space-space-work' }],
    profilePermissions: { 'space-space-work': { 'https://cam.example': 'block' }, 'space-gone': { 'https://x.example': 'allow' } },
  }));
  const store = new Store(file);
  assert.deepEqual(store.state.spaces[1], { id: 'space-work', name: 'Work', color: '#ff7a59', isolated: true, folders: [], icon: '💼', behavior: { archiveAfterHours: 168, spellcheck: false } });
  assert.deepEqual(store.state.settings.sitePermissions, { 'https://meet.example': 'allow' });
  assert.deepEqual(store.state.profilePermissions, { 'space-space-work': { 'https://cam.example': 'block' } });
  assert.equal(store.state.bookmarks.length, 2);
  assert.deepEqual(bookmarksForProfile(store.state.bookmarks, 'shared'), [{ title: 'A', url: 'https://a.example/' }]);
});

test('private Spaces stay out of the saved state with their profile data', () => {
  const state = {
    version: 1 as const, spaces: [shared, priv], activeSpaceId: priv.id, tabsBySpace: {}, activeIndexBySpace: {}, recentlyClosed: [],
    settings: {} as never, bookmarks: [], profilePermissions: {},
  };
  const saved = persistableState(state);
  assert.deepEqual(saved.spaces, [shared]);
  assert.equal(saved.activeSpaceId, shared.id);
});
