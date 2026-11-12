import type { Suggestion } from '../shared/types';

const input = document.getElementById('input') as HTMLInputElement;
const list = document.getElementById('list')!;
const modeEl = document.getElementById('mode')!;
const backdrop = document.getElementById('backdrop')!;
let items: Suggestion[] = [];
let sel = 0;
let mode: 'new' | 'current' = 'current';
let seq = 0;

const ACTION_HINT: Record<string, string> = { navigate: '↵ open', copy: '↵ copy', boost: '↵ edit', env: '↵ jump', internal: '↵ open', noop: '' };

function render(): void {
  list.replaceChildren();
  if (!input.value.trim()) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = 'Try: gh facebook/react · npm vite · mdn flex gap · env · boost · a JWT · 1700000000';
    list.append(d);
    return;
  }
  items.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'item' + (i === sel ? ' sel' : '');
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(i === sel));
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = s.kind;
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = s.label;
    row.append(kind, label);
    if (s.detail && s.detail !== s.label) {
      const d = document.createElement('span');
      d.className = 'detail';
      d.textContent = s.detail;
      row.append(d);
    }
    const a = document.createElement('span');
    a.className = 'act';
    a.textContent = i === sel ? ACTION_HINT[s.action.type] : '';
    row.append(a);
    row.addEventListener('mousemove', () => {
      if (sel !== i) {
        sel = i;
        render();
      }
    });
    row.addEventListener('click', () => run(i, false));
    list.append(row);
  });
  list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
}

async function refresh(): Promise<void> {
  const mine = ++seq;
  const res = (await quiver.invoke('cmd:suggest', input.value)) as Suggestion[];
  if (mine !== seq) return;
  items = res;
  sel = 0;
  render();
}

function run(i: number, forceNew: boolean): void {
  const s = items[i];
  if (!s) return;
  void quiver.invoke('cmd:run', s.action, forceNew ? 'new' : mode);
}

function close(): void {
  void quiver.invoke('cmd:close');
}

input.addEventListener('input', () => void refresh());
input.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    close();
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (items.length) sel = (sel + 1) % items.length;
    render();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (items.length) sel = (sel - 1 + items.length) % items.length;
    render();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    run(sel, e.altKey);
  }
});
backdrop.addEventListener('mousedown', (e) => {
  if (e.target === backdrop) close();
});

quiver.on('cmd:opened', (p: { text: string; mode: 'new' | 'current' }) => {
  mode = p.mode;
  modeEl.textContent = mode === 'new' ? 'New tab' : 'Current tab';
  input.value = p.text;
  items = [];
  render();
  input.focus();
  input.select();
  if (p.text) void refresh();
});
render();
