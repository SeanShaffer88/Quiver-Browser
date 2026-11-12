import type { CommandChoice, CommandCommitResult, CommandOpen } from '../shared/types';

const input = document.getElementById('input') as HTMLInputElement;
const list = document.getElementById('list')!;
const mode = document.getElementById('mode')!;
const backdrop = document.getElementById('backdrop')!;
const message = document.getElementById('message')!;
const preview = document.getElementById('preview')!;
const action = document.getElementById('action')!;
const destination = document.getElementById('destination')!;
const context = document.getElementById('context')!;
const enter = document.getElementById('enter')!;
const alternate = document.getElementById('alternate')!;
const announcement = document.getElementById('announcement')!;
const examples = 'Try a URL, gh facebook/react, env, a JWT, or 1700000000.';

let id: number | null = null;
let request = 0;
let items: CommandChoice[] = [];
let selected = 0;
let showAlternate = false;
let committing = false;
let maxInputLength = 0;

function announce(text: string): void {
  if (announcement.textContent !== text) announcement.textContent = text;
}

function updatePreview(): void {
  const item = items[selected];
  const choice = showAlternate && item?.alternative ? item.alternative : item?.preview;
  const tab = choice?.tab === 'new' ? 'New tab' : choice?.tab === 'current' ? 'Current tab' : '';
  preview.hidden = !choice;
  enter.hidden = !choice?.canRun;
  alternate.hidden = !item?.alternative;
  if (!choice) return;
  action.textContent = choice.title;
  action.dataset.environment = choice.environment ?? '';
  destination.textContent = choice.destination ?? '';
  destination.title = choice.destination ?? '';
  destination.hidden = !choice.destination;
  context.textContent = [tab, choice.space && `Space: ${choice.space}`, choice.source && `From ${choice.source}`].filter(Boolean).join(' · ');
  context.hidden = !context.textContent;
  announce([choice.title, tab, choice.space && `Space: ${choice.space}`].filter(Boolean).join('. '));
}

function choose(index: number, scroll = false): void {
  const old = list.children[selected];
  old?.classList.remove('sel');
  old?.setAttribute('aria-selected', 'false');
  selected = index;
  const row = list.children[selected];
  if (row) {
    row.classList.add('sel');
    row.setAttribute('aria-selected', 'true');
    input.setAttribute('aria-activedescendant', row.id);
    if (scroll) row.scrollIntoView({ block: 'nearest' });
  } else {
    input.removeAttribute('aria-activedescendant');
  }
  updatePreview();
}

function render(): void {
  list.replaceChildren();
  list.hidden = items.length === 0;
  input.setAttribute('aria-expanded', String(!list.hidden));
  items.forEach((item, index) => {
    const row = document.createElement('div');
    row.id = `command-option-${index}`;
    row.className = 'item';
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', 'false');
    row.setAttribute('aria-label', item.accessibleLabel);
    if (!item.preview.canRun) row.setAttribute('aria-disabled', 'true');
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = item.kind;
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = item.label;
    label.dir = 'auto';
    row.append(kind, label);
    if (item.detail && item.detail !== item.label) {
      const detail = document.createElement('span');
      detail.className = 'detail';
      detail.textContent = item.detail;
      detail.dir = 'auto';
      row.append(detail);
    }
    row.addEventListener('pointermove', () => {
      if (selected !== index) choose(index);
    });
    row.addEventListener('mousedown', (event) => event.preventDefault());
    row.addEventListener('click', () => void run(index, false));
    list.append(row);
  });
  choose(0);
}

function setMessage(text: string): void {
  message.textContent = text;
  message.hidden = !text;
  announce(text);
}

async function refresh(reason?: string): Promise<void> {
  if (id === null) return;
  const openId = id;
  const query = input.value;
  const mine = ++request;
  items = [];
  render();
  if (query.length > maxInputLength) {
    input.removeAttribute('aria-busy');
    setMessage('This command is too long. Shorten it before continuing.');
    return;
  }
  if (!query.trim()) {
    input.removeAttribute('aria-busy');
    setMessage(reason ?? examples);
    return;
  }
  input.setAttribute('aria-busy', 'true');
  setMessage(reason ?? 'Finding matches…');
  try {
    const choices = await quiver.invoke('cmd:suggest', openId, mine, query) as CommandChoice[];
    if (id !== openId || mine !== request) return;
    items = choices;
    setMessage(choices.length ? reason ?? '' : 'No matches. Try another command or address.');
    render();
  } catch {
    if (id === openId && mine === request) setMessage('Suggestions are unavailable. Edit the command to retry.');
  } finally {
    if (id === openId && mine === request) input.removeAttribute('aria-busy');
  }
}

async function run(index: number, forceNew: boolean): Promise<void> {
  const item = items[index];
  if (id === null || committing || !item?.preview.canRun || (forceNew && !item.alternative)) return;
  const openId = id;
  const mine = request;
  committing = true;
  try {
    const result = await quiver.invoke('cmd:commit', openId, mine, index, forceNew) as CommandCommitResult;
    if (id !== openId) return;
    if (result === 'done') clear();
    else if (request === mine) {
      if (result === 'stale') await refresh('The tab or Space changed. Review the updated action.');
      else setMessage('This action is unavailable. Select another result or edit the command.');
    }
  } catch {
    if (id === openId && request === mine) setMessage('Could not run the command. Try again.');
  } finally {
    if (id === openId) committing = false;
  }
}

function clear(): void {
  id = null;
  request++;
  committing = false;
  items = [];
  input.value = '';
  input.removeAttribute('aria-busy');
  setMessage('');
  render();
}

async function close(): Promise<void> {
  if (id === null) return;
  const openId = id;
  try {
    await quiver.invoke('cmd:close', openId);
    if (id === openId) clear();
  } catch {
    if (id === openId) setMessage('Could not close the command bar. Press Escape to retry.');
  }
}

input.addEventListener('input', (event) => {
  if (!(event as InputEvent).isComposing) void refresh();
});
input.addEventListener('compositionstart', () => {
  request++;
  items = [];
  render();
  setMessage('');
});
input.addEventListener('compositionend', () => void refresh());
input.addEventListener('keydown', (event) => {
  if (event.isComposing || event.keyCode === 229) return;
  switch (event.key) {
    case 'Escape':
      event.preventDefault();
      void close();
      break;
    case 'ArrowDown':
    case 'ArrowUp': {
      if (!items.length || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) break;
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      choose((selected + step + items.length) % items.length, true);
      break;
    }
    case 'Tab':
      event.preventDefault();
      break;
    case 'Alt':
      showAlternate = true;
      updatePreview();
      break;
    case 'Enter':
      event.preventDefault();
      if (!event.repeat) void run(selected, event.altKey);
      break;
  }
});
input.addEventListener('keyup', (event) => {
  if (event.key === 'Alt') {
    showAlternate = false;
    updatePreview();
  }
});
input.addEventListener('blur', () => {
  showAlternate = false;
  updatePreview();
});
backdrop.addEventListener('mousedown', (event) => {
  if (event.target === backdrop) void close();
});
backdrop.addEventListener('keydown', (event) => {
  if (event.target !== input && event.key === 'Escape' && !event.isComposing) void close();
});

quiver.on('cmd:opened', (payload: CommandOpen) => {
  clear();
  id = payload.id;
  maxInputLength = payload.maxInputLength;
  mode.textContent = payload.mode === 'new' ? 'New tab' : 'Current tab';
  input.value = payload.text;
  input.focus();
  input.select();
  void refresh(payload.message);
});
