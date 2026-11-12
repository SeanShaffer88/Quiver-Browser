import type { EnvGroup, ShellState } from '../shared/types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let groups: EnvGroup[] = [];
let saveTimer: number | null = null;

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
