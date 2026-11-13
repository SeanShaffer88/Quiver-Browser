import type { Bookmark, BookmarkLibraryView, BookmarkPreview, BookmarkProfile, EnvGroup, Settings } from '../shared/types';
import { readBookmarkExport } from './bookmark-file.js';
import { currentSection, searchTerms, sectionMatches } from './settings-search.js';
import { setupArcImport } from './arc-import.js';

setupArcImport();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let groups: EnvGroup[] = [];
let saveTimer: number | null = null;

const bookmarkProfile = $<HTMLSelectElement>('bookmark-profile');
const importProfile = $<HTMLButtonElement>('bookmark-import-profile');
const importFile = $<HTMLButtonElement>('bookmark-import-file');
const filePicker = $<HTMLInputElement>('bookmark-file');
const confirmImport = $<HTMLButtonElement>('bookmark-confirm');
const cancelImport = $<HTMLButtonElement>('bookmark-cancel');
const undoImport = $<HTMLButtonElement>('bookmark-undo');
const reviewHeading = $('bookmark-review-heading');
const statusEl = $('bookmark-status');
const pageSize = 40;
let bookmarkProfiles: BookmarkProfile[] = [];
let bookmarks: Bookmark[] = [];
let bookmarkPage = 0;
let bookmarkBusy = false;
let preview: BookmarkPreview | undefined;
let reviewOrigin: HTMLButtonElement = importProfile;
let undo: BookmarkLibraryView['undo'];

function bookmarkStatus(message: string, failed = false): void {
  statusEl.textContent = message;
  statusEl.className = failed ? 'status err' : 'status';
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
  const library = await quiver.invoke('bookmarks:list') as BookmarkLibraryView;
  bookmarks = library.bookmarks;
  undo = library.undo;
  bookmarkPage = Math.min(bookmarkPage, Math.max(0, Math.ceil(bookmarks.length / pageSize) - 1));
  renderBookmarks();
  updateBookmarkButtons();
}

function updateBookmarkButtons(): void {
  bookmarkProfile.disabled = bookmarkBusy || !bookmarkProfiles.length;
  importProfile.disabled = bookmarkBusy || !bookmarkProfile.value;
  importFile.disabled = bookmarkBusy;
  confirmImport.disabled = bookmarkBusy || !preview?.toAdd;
  cancelImport.disabled = bookmarkBusy;
  undoImport.hidden = !undo;
  undoImport.disabled = bookmarkBusy;
}

function bookmarkTotal(count: number): string {
  return `${count} bookmark${count === 1 ? '' : 's'}`;
}

function renderReview(): void {
  $('bookmark-review').hidden = !preview;
  if (preview) {
    $('bookmark-review-source').textContent = `From ${preview.source}`;
    const totals = [
      `${preview.toAdd} to add`,
      `${preview.duplicates} duplicate${preview.duplicates === 1 ? '' : 's'}`,
      `${preview.unsupported} unsupported link${preview.unsupported === 1 ? '' : 's'}`,
      `${preview.overCapacity} over the library limit`,
    ];
    $('bookmark-review-counts').replaceChildren(...totals.map((value) => {
      const item = document.createElement('li');
      item.textContent = value;
      return item;
    }));
    $('bookmark-review-limit').hidden = !preview.scanLimited;
    $('bookmark-review-sample').replaceChildren(...preview.sample.map(({ title, url }) => {
      const item = document.createElement('li');
      const host = document.createElement('span');
      host.className = 'note';
      host.textContent = new URL(url).host;
      item.append(title, host);
      return item;
    }));
    $('bookmark-review-sample').hidden = !preview.sample.length;
    confirmImport.textContent = preview.toAdd ? `Add ${bookmarkTotal(preview.toAdd)}` : 'Add bookmarks';
  }
  updateBookmarkButtons();
}

async function bookmarkTask(action: () => Promise<HTMLElement | void>): Promise<void> {
  if (bookmarkBusy) return;
  bookmarkBusy = true;
  updateBookmarkButtons();
  let focus: HTMLElement | void = undefined;
  try {
    focus = await action();
  } catch {
    bookmarkStatus('Quiver could not complete the bookmark action. Try again.', true);
    focus = statusEl;
  } finally {
    bookmarkBusy = false;
    updateBookmarkButtons();
  }
  focus?.focus();
}

async function clearReview(): Promise<void> {
  preview = undefined;
  renderReview();
  await quiver.invoke('bookmarks:cancel-review');
}

type ReviewResult = BookmarkPreview | { error: string };

function showReview(result: ReviewResult, fromBrowser: boolean): HTMLElement {
  if ('error' in result) {
    bookmarkStatus(fromBrowser ? `${result.error} You can choose an HTML export instead.` : result.error, true);
    return statusEl;
  }
  preview = result;
  renderReview();
  if (result.toAdd) bookmarkStatus('Review ready. Choose Add bookmarks to save the import.');
  else if (result.overCapacity) bookmarkStatus('The bookmark library is full.');
  else bookmarkStatus('No new bookmarks found.');
  return reviewHeading;
}

bookmarkProfile.addEventListener('change', () => void bookmarkTask(async () => {
  await clearReview();
  bookmarkStatus('');
}));
importProfile.addEventListener('click', () => {
  const selected = bookmarkProfiles[Number(bookmarkProfile.value) - 1];
  if (selected) void bookmarkTask(async () => {
    reviewOrigin = importProfile;
    await clearReview();
    bookmarkStatus('Reading the browser profile…');
    return showReview(await quiver.invoke('bookmarks:review-profile', selected.browser, selected.profile) as ReviewResult, true);
  });
});
importFile.addEventListener('click', () => {
  // Open the native picker during the click's user activation. A cancelled picker clears the prior review.
  preview = undefined;
  renderReview();
  bookmarkStatus('');
  void quiver.invoke('bookmarks:cancel-review').catch(() => bookmarkStatus('Quiver could not clear the prior review.', true));
  filePicker.click();
});
filePicker.addEventListener('change', () => {
  const file = filePicker.files?.[0];
  filePicker.value = '';
  if (file) void bookmarkTask(async () => {
    reviewOrigin = importFile;
    bookmarkStatus('Reading the HTML export…');
    let scan: Awaited<ReturnType<typeof readBookmarkExport>>;
    try {
      scan = await readBookmarkExport(file);
    } catch (error) {
      bookmarkStatus(error instanceof Error ? error.message : 'Quiver could not read this HTML file.', true);
      return statusEl;
    }
    return showReview(await quiver.invoke('bookmarks:review-file', file.name, scan.candidates, scan.scanLimited) as ReviewResult, false);
  });
});
cancelImport.addEventListener('click', () => void bookmarkTask(async () => {
  await clearReview();
  bookmarkStatus('Import canceled.');
  return reviewOrigin;
}));
confirmImport.addEventListener('click', () => void bookmarkTask(async () => {
  if (!preview?.toAdd) return;
  const id = preview.id;
  const result = await quiver.invoke('bookmarks:confirm', id) as { added: number } | { error: string };
  preview = undefined;
  renderReview();
  await refreshBookmarks();
  if ('error' in result) bookmarkStatus(result.error, true);
  else bookmarkStatus(`Imported ${bookmarkTotal(result.added)}.`);
  return statusEl;
}));
undoImport.addEventListener('click', () => void bookmarkTask(async () => {
  if (!undo) return;
  const result = await quiver.invoke('bookmarks:undo', undo.id) as { removed: number } | { error: string };
  preview = undefined;
  renderReview();
  await refreshBookmarks();
  if ('error' in result) bookmarkStatus(result.error, true);
  else bookmarkStatus(`Undid the import of ${bookmarkTotal(result.removed)}.`);
  return statusEl;
}));
$('bookmark-prev').addEventListener('click', () => { bookmarkPage--; renderBookmarks(); });
$('bookmark-next').addEventListener('click', () => { bookmarkPage++; renderBookmarks(); });

void quiver.invoke('bookmarks:profiles').then((profiles) => {
  bookmarkProfiles = profiles as BookmarkProfile[];
  const defaultLabel = bookmarkProfiles.length ? 'Choose a browser profile' : 'No browser profiles found';
  bookmarkProfile.replaceChildren(new Option(defaultLabel, ''));
  bookmarkProfiles.forEach(({ label }, index) => bookmarkProfile.add(new Option(label, String(index + 1))));
  updateBookmarkButtons();
}).catch(() => {
  bookmarkProfile.replaceChildren(new Option('Could not find browser profiles', ''));
  updateBookmarkButtons();
});
void refreshBookmarks().then(() => {
  if (undo && !statusEl.textContent) bookmarkStatus(`Last import added ${bookmarkTotal(undo.count)}.`);
}).catch(() => bookmarkStatus('Could not load bookmarks.', true));
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
  const settings = (await quiver.invoke('settings:get')) as Settings;
  groups = settings.envGroups.map((g) => ({ ...g }));
  renderGroups();
  $<HTMLInputElement>('engine').value = settings.searchEngine;
  $<HTMLInputElement>('scan').checked = settings.devServerScan;
  renderSitePermissions(settings.sitePermissions);
  $<HTMLInputElement>('history-on').checked = settings.rememberHistory;
  void showHistoryCount();
  $<HTMLInputElement>('ask-save').checked = settings.askWhereToSave;
  $<HTMLSelectElement>('archive-after').value = String(settings.archiveAfterHours);
  $<HTMLInputElement>('peek-pinned').checked = settings.peekPinnedLinks;
  renderPrivacy(settings.privacy);
  $<HTMLSelectElement>('theme').value = settings.theme;
})();

$('addgroup').addEventListener('click', () => {
  groups.push({ name: 'My app', local: '', staging: '', prod: '' });
  renderGroups();
});
$<HTMLInputElement>('engine').addEventListener('change', async (e) => {
  await quiver.invoke('settings:set', { searchEngine: (e.target as HTMLInputElement).value.trim() });
});
$<HTMLInputElement>('scan').addEventListener('change', (e) => void quiver.invoke('settings:set', { devServerScan: (e.target as HTMLInputElement).checked }));

function renderSitePermissions(saved: Record<string, 'allow' | 'block'>): void {
  const list = $('site-permissions');
  const entries = Object.entries(saved).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) {
    const empty = document.createElement('li');
    empty.className = 'note';
    empty.textContent = 'None yet.';
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...entries.map(([origin, decision]) => {
    const item = document.createElement('li');
    const label = document.createElement('span');
    label.className = 'mono';
    label.textContent = origin;
    const state = document.createElement('span');
    state.className = 'note';
    state.textContent = decision === 'allow' ? 'Allowed' : 'Blocked';
    const forget = document.createElement('button');
    forget.className = 'btn';
    forget.textContent = 'Forget';
    forget.setAttribute('aria-label', `Forget the choice for ${origin}`);
    forget.addEventListener('click', async () => renderSitePermissions(await quiver.invoke('sitepermissions:forget', origin) as Record<string, 'allow' | 'block'>));
    item.append(label, state, forget);
    return item;
  }));
}
interface SyncStatus {
  folder: string | null;
  deviceName: string;
  include: Record<string, boolean>;
  last?: { at: number; ok: boolean; message: string; devices: string[] };
  syncing: boolean;
}

function renderSync(status: SyncStatus): void {
  $('sync-folder').textContent = status.folder ?? 'Not syncing';
  $('sync-choose').textContent = status.folder ? 'Change folder…' : 'Choose folder…';
  $('sync-now').hidden = !status.folder;
  $('sync-disconnect').hidden = !status.folder;
  const device = $<HTMLInputElement>('sync-device');
  if (document.activeElement !== device) device.value = status.deviceName;
  for (const box of document.querySelectorAll<HTMLInputElement>('[data-sync]')) box.checked = !!status.include[box.dataset.sync!];
  const el = $('sync-status');
  if (status.syncing) el.textContent = 'Syncing…';
  else if (!status.folder) el.textContent = '';
  else if (status.last) {
    const others = status.last.devices.length ? ` Other devices: ${status.last.devices.join(', ')}.` : ' No other devices yet.';
    el.textContent = `${new Date(status.last.at).toLocaleTimeString()}: ${status.last.message}${others}`;
  }
  el.className = 'status' + (status.last && !status.last.ok ? ' err' : '');
}

async function syncCall(channel: string, ...args: unknown[]): Promise<void> {
  try {
    renderSync((await quiver.invoke(channel, ...args)) as SyncStatus);
  } catch (e) {
    flash($('sync-status'), (e as Error).message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''), 'err');
  }
}

$('sync-choose').addEventListener('click', () => void syncCall('sync:choose'));
$('sync-now').addEventListener('click', () => void syncCall('sync:now'));
$('sync-disconnect').addEventListener('click', () => void syncCall('sync:disconnect'));
$<HTMLInputElement>('sync-device').addEventListener('change', (e) => void syncCall('sync:options', {}, (e.target as HTMLInputElement).value));
for (const box of document.querySelectorAll<HTMLInputElement>('[data-sync]')) {
  box.addEventListener('change', () => void syncCall('sync:options', { [box.dataset.sync!]: box.checked }));
}
quiver.on('sync:changed', () => void syncCall('sync:status'));
void syncCall('sync:status');
async function showHistoryCount(): Promise<void> {
  const count = (await quiver.invoke('history:count')) as number;
  $('history-count').textContent = count === 1 ? '1 page' : `${count.toLocaleString()} pages`;
}
$<HTMLInputElement>('history-on').addEventListener('change', (e) => void quiver.invoke('settings:set', { rememberHistory: (e.target as HTMLInputElement).checked }));
$('history-clear').addEventListener('click', async () => {
  if (!confirm('Clear all saved history on this device?')) return;
  await quiver.invoke('history:clear');
  await showHistoryCount();
});
function renderPrivacy(p: Settings['privacy']): void {
  $<HTMLInputElement>('privacy-gpc').checked = p.gpc;
  $<HTMLInputElement>('privacy-webrtc').checked = p.hideLocalIp;
  $<HTMLSelectElement>('privacy-dns').value = p.secureDns;
  $<HTMLInputElement>('privacy-doh').value = p.dohTemplate;
  $('privacy-doh-row').hidden = p.secureDns !== 'custom';
  $<HTMLInputElement>('privacy-spell').checked = p.spellcheck;
  $<HTMLInputElement>('privacy-clear').checked = p.clearOnExit;
  if (!navigator.userAgent.includes('Windows')) {
    $('privacy-spell-note').textContent = 'On this system Chromium downloads spelling dictionaries from Google when spell check is on.';
  }
}

async function savePrivacy(patch: Partial<Settings['privacy']>, message = 'Saved'): Promise<void> {
  try {
    await quiver.invoke('settings:set', { privacy: patch });
    const settings = (await quiver.invoke('settings:get')) as Settings;
    renderPrivacy(settings.privacy);
    const rejected = Object.entries(patch).some(([key, value]) => settings.privacy[key as keyof Settings['privacy']] !== value);
    flash($('privacy-status'), rejected ? 'Not saved: enter an https:// DNS-over-HTTPS address.' : message, rejected ? 'err' : undefined);
  } catch (e) {
    flash($('privacy-status'), (e as Error).message, 'err');
  }
}

const checkbox = (id: string, key: 'gpc' | 'hideLocalIp' | 'spellcheck' | 'clearOnExit') =>
  $<HTMLInputElement>(id).addEventListener('change', (e) => void savePrivacy({ [key]: (e.target as HTMLInputElement).checked }));
checkbox('privacy-gpc', 'gpc');
checkbox('privacy-webrtc', 'hideLocalIp');
checkbox('privacy-spell', 'spellcheck');
checkbox('privacy-clear', 'clearOnExit');
$<HTMLSelectElement>('privacy-dns').addEventListener('change', (e) => {
  const mode = (e.target as HTMLSelectElement).value as Settings['privacy']['secureDns'];
  $('privacy-doh-row').hidden = mode !== 'custom';
  if (mode === 'custom') $<HTMLInputElement>('privacy-doh').focus();
  else void savePrivacy({ secureDns: mode });
});
$('privacy-doh-save').addEventListener('click', () => void savePrivacy({ secureDns: 'custom', dohTemplate: $<HTMLInputElement>('privacy-doh').value }));

$<HTMLInputElement>('peek-pinned').addEventListener('change', (e) => void quiver.invoke('settings:set', { peekPinnedLinks: (e.target as HTMLInputElement).checked }));
$<HTMLInputElement>('ask-save').addEventListener('change', (e) => void quiver.invoke('settings:set', { askWhereToSave: (e.target as HTMLInputElement).checked }));
$<HTMLSelectElement>('archive-after').addEventListener('change', (e) => void quiver.invoke('settings:set', { archiveAfterHours: Number((e.target as HTMLSelectElement).value) }));
$<HTMLSelectElement>('theme').addEventListener('change', (e) => void quiver.invoke('settings:set', { theme: (e.target as HTMLSelectElement).value }));

// ───────── section list and search ─────────
const sections = [...document.querySelectorAll<HTMLElement>('.settings-section')];
const toc = $('settings-toc');
const search = $<HTMLInputElement>('settings-search');
const searchStatus = $('settings-search-status');
const links = new Map<HTMLElement, HTMLAnchorElement>();
for (const section of sections) {
  const heading = section.querySelector<HTMLElement>('h2')!;
  const link = document.createElement('a');
  link.href = '#' + section.id;
  link.textContent = heading.textContent;
  link.addEventListener('click', (e) => {
    // Move focus to the heading as well as scrolling, so keyboard and screen-reader users continue from there.
    e.preventDefault();
    heading.scrollIntoView({ block: 'start' });
    heading.focus({ preventScroll: true });
    jumped = section;
    markCurrent(section);
  });
  const item = document.createElement('li');
  item.append(link);
  toc.append(item);
  links.set(section, link);
}

function visibleSections(): HTMLElement[] {
  return sections.filter((section) => !section.hidden);
}

function markCurrent(current: HTMLElement | undefined): void {
  for (const [section, link] of links) {
    if (section === current) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
}

// Reading line a little below the top, so the section whose heading just passed under the sticky list counts.
const READING_LINE = 96;
// The section a link jumped to stays current while it is still near the top. Otherwise jumping to a section near
// the end, which can only scroll as far as the bottom of the page, would highlight the last section instead.
let jumped: HTMLElement | undefined;
function updateCurrent(): void {
  const shown = visibleSections();
  if (!shown.length) return markCurrent(undefined);
  if (jumped && !jumped.hidden) {
    const top = jumped.getBoundingClientRect().top;
    if (top > -8 && top < window.innerHeight / 2) return markCurrent(jumped);
  }
  jumped = undefined;
  const scrolled = document.body.scrollTop + document.documentElement.scrollTop > 0;
  const atBottom = scrolled && shown[shown.length - 1].getBoundingClientRect().bottom <= window.innerHeight + 2;
  // Near the end the last short sections can never reach the reading line; mark the last one at the bottom.
  const index = atBottom ? shown.length - 1 : currentSection(shown.map((s) => s.getBoundingClientRect().top), READING_LINE);
  markCurrent(shown[index]);
}
let scrollFrame = 0;
// Capture: the page scrolls inside <body> (base.css fixes html and body to the window height), and element
// scroll events do not reach window listeners.
document.addEventListener('scroll', () => {
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => { scrollFrame = 0; updateCurrent(); });
}, { passive: true, capture: true });
window.addEventListener('resize', updateCurrent);

function sectionText(section: HTMLElement): string {
  // Placeholders and accessible names are part of what people search for, not only the visible text.
  const extra = [...section.querySelectorAll<HTMLElement>('[placeholder], [aria-label]')]
    .map((el) => `${el.getAttribute('placeholder') ?? ''} ${el.getAttribute('aria-label') ?? ''}`);
  return `${section.textContent ?? ''} ${extra.join(' ')}`;
}

function applySearch(): void {
  const terms = searchTerms(search.value);
  let shown = 0;
  for (const section of sections) {
    const match = sectionMatches(sectionText(section), terms);
    section.hidden = !match;
    links.get(section)!.parentElement!.hidden = !match;
    if (match) shown++;
  }
  searchStatus.textContent = !terms.length ? '' : shown ? `${shown} of ${sections.length} sections` : 'No settings match.';
  updateCurrent();
}
search.addEventListener('input', applySearch);
search.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && search.value) {
    search.value = '';
    applySearch();
  } else if (e.key === 'Enter') {
    // Enter jumps to the first matching section.
    const first = visibleSections()[0];
    if (first) links.get(first)!.click();
  }
});
updateCurrent();
