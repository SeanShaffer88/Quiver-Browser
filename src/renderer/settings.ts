import type { Bookmark, BookmarkImportResult, BookmarkProfile, EnvGroup, ShellState } from '../shared/types';
import { readBookmarkExport } from './bookmark-file.js';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let groups: EnvGroup[] = [];
let saveTimer: number | null = null;

const bookmarkProfile = $<HTMLSelectElement>('bookmark-profile');
const importProfile = $<HTMLButtonElement>('bookmark-import-profile');
const importFile = $<HTMLButtonElement>('bookmark-import-file');
const filePicker = $<HTMLInputElement>('bookmark-file');
const pageSize = 40;
let bookmarkProfiles: BookmarkProfile[] = [];
let bookmarks: Bookmark[] = [];
let bookmarkPage = 0;
let importing = false;

function bookmarkStatus(message: string, failed = false): void {
  const status = $('bookmark-status');
  status.textContent = message;
  status.className = failed ? 'status err' : 'status';
}

function renderBookmarks(): void {
  const start = bookmarkPage * pageSize;
  const rows = bookmarks.slice(start, start + pageSize).map(({ title, url }) => {
    const button = document.createElement('button');
    button.className = 'bfile';
    button.textContent = title;
    button.title = url;
    button.addEventListener('click', () => {
      void quiver.invoke('bookmarks:open', url).catch(() => bookmarkStatus('Could not open the bookmark.', true));
    });
    const row = document.createElement('li');
    row.append(button);
    return row;
  });
  $('bookmark-list').replaceChildren(...rows);
  $('bookmark-pages').hidden = bookmarks.length <= pageSize;
  $('bookmark-page').textContent = bookmarks.length ? `${start + 1}–${start + rows.length} of ${bookmarks.length}` : '';
  $<HTMLButtonElement>('bookmark-prev').disabled = bookmarkPage === 0;
  $<HTMLButtonElement>('bookmark-next').disabled = start + pageSize >= bookmarks.length;
}

async function refreshBookmarks(): Promise<void> {
  bookmarks = await quiver.invoke('bookmarks:list') as Bookmark[];
  renderBookmarks();
}

function updateBookmarkButtons(): void {
  importProfile.disabled = importing || !bookmarkProfile.value;
  importFile.disabled = importing;
}

async function runBookmarkImport(action: () => Promise<BookmarkImportResult>): Promise<void> {
  if (importing) return;
  importing = true;
  updateBookmarkButtons();
  bookmarkStatus('Importing bookmarks…');
  try {
    const result = await action();
    if ('error' in result) bookmarkStatus(result.error, true);
    else {
      await refreshBookmarks();
      const summary = result.added ? `Imported ${result.added} bookmark${result.added === 1 ? '' : 's'}.` : 'No new bookmarks found.';
      bookmarkStatus(result.full ? `${summary} The bookmark library is full.` : summary);
    }
  } catch (error) {
    bookmarkStatus((error as Error).message, true);
  } finally {
    importing = false;
    updateBookmarkButtons();
  }
}

bookmarkProfile.addEventListener('change', updateBookmarkButtons);
importProfile.addEventListener('click', () => {
  const selected = bookmarkProfiles[Number(bookmarkProfile.value) - 1];
  if (selected) void runBookmarkImport(async () => await quiver.invoke('bookmarks:import-profile', selected.browser, selected.profile) as BookmarkImportResult);
});
importFile.addEventListener('click', () => filePicker.click());
filePicker.addEventListener('change', () => {
  const file = filePicker.files?.[0];
  filePicker.value = '';
  if (file) void runBookmarkImport(async () => {
    const entries = await readBookmarkExport(file);
    return await quiver.invoke('bookmarks:import-file', entries) as BookmarkImportResult;
  });
});
$('bookmark-prev').addEventListener('click', () => { bookmarkPage--; renderBookmarks(); });
$('bookmark-next').addEventListener('click', () => { bookmarkPage++; renderBookmarks(); });

void quiver.invoke('bookmarks:profiles').then((profiles) => {
  bookmarkProfiles = profiles as BookmarkProfile[];
  const defaultLabel = bookmarkProfiles.length ? 'Choose a browser profile' : 'No browser profiles found';
  bookmarkProfile.replaceChildren(new Option(defaultLabel, ''));
  bookmarkProfiles.forEach(({ label }, index) => bookmarkProfile.add(new Option(label, String(index + 1))));
  bookmarkProfile.disabled = !bookmarkProfiles.length;
}).catch(() => {
  bookmarkProfile.replaceChildren(new Option('Could not find browser profiles', ''));
  bookmarkProfile.disabled = true;
});
void refreshBookmarks().catch(() => bookmarkStatus('Could not load bookmarks.', true));
if (new URLSearchParams(location.search).get('import') === 'bookmarks') $('bookmarks-heading').focus();

function flash(el: HTMLElement, msg: string, kind: 'ok' | 'err' = 'ok'): void {
  el.textContent = msg;
  el.className = 'status ' + kind;
  window.setTimeout(() => {
    el.textContent = '';
  }, 2500);
}

function saveGroups(): void {
  if (saveTimer) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    try {
      await quiver.invoke('settings:set', { envGroups: groups });
      flash($('envstatus'), 'Saved');
    } catch (e) {
      flash($('envstatus'), (e as Error).message, 'err');
    }
  }, 300);
}

function renderGroups(): void {
  const root = $('groups');
  root.replaceChildren();
  groups.forEach((g, i) => {
    const box = document.createElement('div');
    box.className = 'group';
    const grid = document.createElement('div');
    grid.className = 'grid';
    const fields: [keyof EnvGroup, string, string][] = [
      ['name', 'Name', 'My app'],
      ['local', 'LOCAL', 'localhost:3000'],
      ['staging', 'STAGING', 'https://staging.example.com'],
      ['prod', 'PROD', 'https://example.com'],
    ];
    for (const [key, label, ph] of fields) {
      const l = document.createElement('label');
      l.textContent = label;
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.value = g[key];
      inp.placeholder = ph;
      inp.spellcheck = false;
      inp.setAttribute('aria-label', `${label} for group ${i + 1}`);
      inp.addEventListener('input', () => {
        g[key] = inp.value;
        saveGroups();
      });
      grid.append(l, inp);
    }
    const del = document.createElement('button');
    del.className = 'btn danger';
    del.textContent = 'Remove group';
    del.addEventListener('click', () => {
      groups.splice(i, 1);
      renderGroups();
      saveGroups();
    });
    box.append(grid, del);
    root.append(box);
  });
  if (groups.length === 0) {
    const n = document.createElement('p');
    n.className = 'note';
    n.textContent = 'No groups yet.';
    root.append(n);
  }
}

(async () => {
  const s = (await quiver.invoke('state:get')) as ShellState;
  groups = s.settings.envGroups.map((g) => ({ ...g }));
  renderGroups();
  $<HTMLInputElement>('engine').value = s.settings.searchEngine;
  $<HTMLInputElement>('scan').checked = s.settings.devServerScan;
})();

$('addgroup').addEventListener('click', () => {
  groups.push({ name: 'My app', local: '', staging: '', prod: '' });
  renderGroups();
});
$<HTMLInputElement>('engine').addEventListener('change', async (e) => {
  await quiver.invoke('settings:set', { searchEngine: (e.target as HTMLInputElement).value.trim() });
});
$<HTMLInputElement>('scan').addEventListener('change', (e) => void quiver.invoke('settings:set', { devServerScan: (e.target as HTMLInputElement).checked }));
