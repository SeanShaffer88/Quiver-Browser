import type { BoostFileInfo } from '../shared/types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const filesEl = $('files');
const editor = $<HTMLTextAreaElement>('editor');
const curName = $('curname');
const statusEl = $('status');
const newName = $<HTMLInputElement>('newname');
const suggest = $<HTMLDataListElement>('suggest');

let current: string | null = null;
let dirty = false;

function status(msg: string, kind: '' | 'ok' | 'err' = ''): void {
  statusEl.textContent = msg;
  statusEl.className = 'status ' + kind;
}

async function loadList(): Promise<BoostFileInfo[]> {
  const list = (await quiver.invoke('boost:list')) as BoostFileInfo[];
  filesEl.replaceChildren();
  if (list.length === 0) {
    const d = document.createElement('div');
    d.className = 'note';
    d.textContent = 'No boosts yet. Create one above.';
    filesEl.append(d);
  }
  for (const f of list) {
    const b = document.createElement('button');
    b.className = 'bfile' + (f.name === current ? ' sel' : '');
    b.setAttribute('role', 'option');
    b.title = `${f.name} — ${f.size} bytes`;
    const n = document.createElement('span');
    n.textContent = f.name;
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = f.kind;
    b.append(n, k);
    b.addEventListener('click', () => void open(f.name));
    filesEl.append(b);
  }
  return list;
}

async function open(name: string): Promise<void> {
  if (dirty && !window.confirm(`Discard unsaved changes to ${current}?`)) return;
  try {
    editor.value = (await quiver.invoke('boost:read', name)) as string;
    editor.disabled = false;
    current = name;
    dirty = false;
    curName.textContent = name;
    status('');
    await loadList();
    editor.focus();
  } catch (e) {
    status((e as Error).message, 'err');
  }
}

async function save(): Promise<void> {
  if (!current) return;
  try {
    await quiver.invoke('boost:save', current, editor.value);
    dirty = false;
    status(current.endsWith('.ts') ? 'Saved. Matching tabs reloaded.' : 'Saved. CSS applied live.', 'ok');
    await loadList();
  } catch (e) {
    status((e as Error).message, 'err');
  }
}

async function create(): Promise<void> {
  const name = newName.value.trim().toLowerCase();
  if (!name) return;
  try {
    await quiver.invoke('boost:create', name);
    newName.value = '';
    dirty = false;
    await open(name);
  } catch (e) {
    status((e as Error).message, 'err');
  }
}

editor.addEventListener('input', () => {
  dirty = true;
  status('Unsaved changes');
});
editor.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && !e.ctrlKey) {
    e.preventDefault();
    const s = editor.selectionStart;
    editor.setRangeText('  ', s, editor.selectionEnd, 'end');
    dirty = true;
  }
});
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    void save();
  }
});
$('save').addEventListener('click', () => void save());
$('create').addEventListener('click', () => void create());
newName.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') void create();
});
$('reload').addEventListener('click', () => {
  if (!current) return;
  dirty = false;
  void open(current);
});
$('delete').addEventListener('click', async () => {
  if (!current || !window.confirm(`Delete ${current}? This cannot be undone.`)) return;
  try {
    await quiver.invoke('boost:delete', current);
    current = null;
    dirty = false;
    editor.value = '';
    editor.disabled = true;
    curName.textContent = 'No file selected';
    status('Deleted.', 'ok');
    await loadList();
  } catch (e) {
    status((e as Error).message, 'err');
  }
});

(async () => {
  const dir = (await quiver.invoke('boost:dir')) as string;
  $('dir').textContent = `Stored in: ${dir}`;
  for (const n of ['all.css', 'all.ts']) {
    const o = document.createElement('option');
    o.value = n;
    suggest.append(o);
  }
  await loadList();
  const wanted = new URLSearchParams(location.search).get('file');
  if (wanted) await open(wanted);
})();
