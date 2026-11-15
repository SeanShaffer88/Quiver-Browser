import { canvasSize, dragged, nudge, type Geometry } from './board-geometry.js';

interface CardBase { id: string; x: number; y: number; w: number; h: number; createdAt: number; label: string }
type Card =
  | (CardBase & { kind: 'text'; text: string; html: string })
  | (CardBase & { kind: 'link'; url: string; title: string; host: string; iconSrc?: string })
  | (CardBase & { kind: 'capture'; src: string; url?: string; title?: string; imageW: number; imageH: number });
interface BoardView { id: string; name: string; spaceId: string; spaceName: string; updatedAt: number; cards: Card[] }
interface Summary { id: string; name: string; spaceId: string; spaceName: string; count: number; updatedAt: number }
interface ListView { spaceId: string; spaceName: string; privateSpace: boolean; boards: Summary[] }

const listEl = document.getElementById('board-list')!;
const main = document.getElementById('board')!;
const announcer = document.getElementById('announce')!;
const form = document.getElementById('new-board') as HTMLFormElement;
const newName = document.getElementById('new-name') as HTMLInputElement;

const params = new URLSearchParams(location.search);
let selected = params.get('board') ?? '';
let view: 'canvas' | 'list' = params.get('view') === 'list' ? 'list' : 'canvas';
try {
  if (!params.get('view') && localStorage.getItem('boards-view') === 'list') view = 'list';
} catch { /* per-page preference only */ }
let board: BoardView | null = null;
/** Set while a card is dragged or a note edited: a refresh would pull the element out from under the person. */
let busy = 0;
let nudging = false;
let pending = false;
let editing: string | null = null;
let message = '';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string | null | false)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === false) continue;
    if (k === 'class') node.className = String(v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k in node && !k.includes('-')) (node as any)[k] = v;
    else node.setAttribute(k, String(v));
  }
  for (const kid of kids) if (kid) node.append(kid);
  return node;
}

function announce(text: string): void {
  // Clearing first makes a repeated message (two moves in a row) announce again.
  announcer.textContent = '';
  requestAnimationFrame(() => { announcer.textContent = text; });
}

function setMessage(text: string): void {
  message = text;
  const status = main.querySelector('.board-status');
  if (status) status.textContent = text;
}

const call = (channel: string, ...args: unknown[]) => quiver.invoke(channel, ...args);

function focusKey(): string | undefined {
  const active = document.activeElement as HTMLElement | null;
  return active?.dataset.focus;
}

function restoreFocus(key: string | undefined): void {
  if (!key) return;
  const target = document.querySelector<HTMLElement>(`[data-focus="${CSS.escape(key)}"]`);
  target?.focus({ preventScroll: false });
}

const blocked = () => busy > 0 || nudging || editing !== null;
let generation = 0;

/** Reload and redraw. Change events wait while a card is dragged or a note is open; `force` is for the page's own steps. */
async function refresh(force = false): Promise<void> {
  if (!force && blocked()) {
    pending = true;
    return;
  }
  pending = false;
  const mine = ++generation;
  const key = focusKey();
  const data = (await call('boards:list')) as ListView;
  const here = data.boards.filter((b) => b.spaceId === data.spaceId);
  const others = data.boards.filter((b) => b.spaceId !== data.spaceId);
  if (!data.boards.some((b) => b.id === selected)) selected = here[0]?.id ?? data.boards[0]?.id ?? '';
  form.hidden = data.privateSpace;
  const item = (b: Summary) => el('li', {}, el('button', {
    class: 'bfile' + (b.id === selected ? ' sel' : ''), 'aria-current': b.id === selected ? 'page' : undefined,
    dataset: { focus: 'nav-' + b.id }, title: `${b.name}\n${b.spaceName} · ${b.count} cards`,
    onClick: () => select(b.id),
  }, el('span', {}, b.name), el('span', { class: 'k' }, String(b.count))));
  listEl.replaceChildren(
    ...(data.privateSpace ? [el('li', { class: 'note' }, 'Boards are not kept in private Spaces.')] : []),
    ...here.map(item),
    ...(others.length ? [el('li', { class: 'note board-nav-group' }, 'Other Spaces'), ...others.map(item)] : []),
  );
  if (!data.boards.length && !data.privateSpace) listEl.append(el('li', { class: 'note' }, 'No boards yet.'));
  const next = selected ? ((await call('boards:get', selected)) as BoardView | null) : null;
  // A newer refresh, or an edit or drag that began meanwhile, wins over this one.
  if (mine !== generation || (!force && blocked())) {
    if (mine === generation) pending = true;
    return;
  }
  board = next;
  renderBoard();
  restoreFocus(key);
}

function select(id: string): void {
  selected = id;
  editing = null;
  history.replaceState(null, '', `?board=${encodeURIComponent(id)}${view === 'list' ? '&view=list' : ''}`);
  setMessage('');
  void refresh();
}

function setView(next: 'canvas' | 'list'): void {
  view = next;
  try { localStorage.setItem('boards-view', next); } catch { /* not kept */ }
  history.replaceState(null, '', `?board=${encodeURIComponent(selected)}${view === 'list' ? '&view=list' : ''}`);
  renderBoard();
  restoreFocus('view-' + next);
}

function renderBoard(): void {
  if (!board) {
    main.replaceChildren(el('p', { class: 'note' }, 'Create a board to start collecting.'));
    return;
  }
  const b = board;
  const name = el('input', { type: 'text', value: b.name, maxLength: 80, 'aria-label': 'Board name', class: 'name-input', dataset: { focus: 'name' } });
  name.addEventListener('change', () => void call('boards:rename', b.id, name.value));
  const toggle = (which: 'canvas' | 'list', label: string) => el('button', {
    class: 'btn' + (view === which ? ' primary' : ''), 'aria-pressed': String(view === which), dataset: { focus: 'view-' + which }, onClick: () => setView(which),
  }, label);
  const toolbar = el('div', { class: 'toolbar board-toolbar' },
    name,
    el('button', { class: 'btn', dataset: { focus: 'add-note' }, onClick: () => void addNote() }, 'Add note'),
    el('div', { class: 'view-toggle', role: 'group', 'aria-label': 'View' }, toggle('canvas', 'Canvas'), toggle('list', 'List')),
    el('button', { class: 'btn', dataset: { focus: 'export' }, onClick: () => void exportBoard() }, 'Export HTML…'),
    el('button', { class: 'btn danger', dataset: { focus: 'delete-board' }, onClick: () => { if (confirm(`Delete “${b.name}” and everything on it?`)) void call('boards:delete', b.id); } }, 'Delete board'),
  );
  const help = el('p', { class: 'note', id: 'card-help' }, view === 'canvas'
    ? 'Drag a card to move it, or its corner to resize it. With a card focused: arrow keys move it, Ctrl+arrow keys resize it, Shift takes bigger steps, Enter edits a note or opens a link, Delete removes it.'
    : 'Cards in reading order, the same order the canvas uses for the Tab key and screen readers. Move them up or down to reorder.');
  const content = !b.cards.length
    ? el('p', { class: 'note empty-board' }, 'Nothing here yet. Add a note, or use Add page to board… or Capture to board… from a web page.')
    : view === 'canvas' ? renderCanvas(b) : renderList(b);
  main.replaceChildren(el('h2', { class: 'sr-only' }, b.name), toolbar, el('p', { class: 'note' }, `${b.spaceName} · ${b.cards.length} ${b.cards.length === 1 ? 'card' : 'cards'}`),
    el('p', { class: 'status board-status' }, message), help, content);
}

// ───────── canvas ─────────

function cardBody(b: BoardView, c: Card): HTMLElement {
  if (c.kind === 'text') {
    if (editing === c.id) return noteEditor(b, c);
    const body = el('div', { class: 'note-body' });
    body.innerHTML = c.html; // Rendered and escaped by Quiver's main process (board-text.ts); fixed tags only.
    if (!c.text.trim()) body.append(el('p', { class: 'note' }, 'Empty note. Press Enter to write.'));
    return body;
  }
  if (c.kind === 'link') {
    const icon = c.iconSrc ? el('img', { src: c.iconSrc, alt: '', width: 16, height: 16, class: 'favicon' }) : el('span', { class: 'monogram', 'aria-hidden': 'true' }, (c.host.replace(/^www\./, '')[0] ?? '?').toUpperCase());
    return el('button', { class: 'link-open', title: c.url, dataset: { focus: 'open-' + c.id }, onClick: () => void open(b, c) },
      icon, el('span', { class: 'link-title' }, c.title), el('span', { class: 'link-host' }, c.host));
  }
  return el('figure', { class: 'capture-body' },
    el('img', { src: c.src, alt: c.title ? `Capture of ${c.title}` : 'Page capture', draggable: false }),
    c.url ? el('figcaption', {}, el('button', { class: 'link', title: c.url, dataset: { focus: 'open-' + c.id }, onClick: () => void open(b, c) }, c.title || new URL(c.url).host)) : null);
}

function placeCard(node: HTMLElement, g: Geometry): void {
  node.style.left = g.x + 'px';
  node.style.top = g.y + 'px';
  node.style.width = g.w + 'px';
  node.style.height = g.h + 'px';
}

function renderCanvas(b: BoardView): HTMLElement {
  const list = el('ol', { class: 'canvas', 'aria-label': 'Cards' });
  const scroller = el('div', { class: 'canvas-scroll' }, list);
  const size = canvasSize(b.cards, 900, 600);
  list.style.width = size.width + 'px';
  list.style.height = size.height + 'px';
  b.cards.forEach((c, index) => {
    const node = el('li', {
      class: `card ${c.kind}`, tabindex: 0, 'aria-label': `${c.label}, card ${index + 1} of ${b.cards.length}`, 'aria-describedby': 'card-help',
      dataset: { focus: 'card-' + c.id, card: c.id },
    },
      el('div', { class: 'grip', 'aria-hidden': 'true' }),
      cardBody(b, c),
      el('button', { class: 'icon-btn card-delete', 'aria-label': `Delete ${c.label}`, title: 'Delete card (Delete)', dataset: { focus: 'delete-' + c.id }, onClick: () => void removeCard(b, c) }, '×'),
      el('div', { class: 'resize', 'aria-hidden': 'true', title: 'Drag to resize' }));
    placeCard(node, c);
    node.addEventListener('keydown', (e) => onCardKey(e, b, c, node));
    node.addEventListener('pointerdown', (e) => onPointerDown(e, b, c, node));
    node.addEventListener('dblclick', (e) => {
      if (c.kind === 'text' && !(e.target as HTMLElement).closest('textarea, a, button')) startEditing(c.id);
    });
    node.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest('a[data-url]') as HTMLAnchorElement | null;
      if (!a) return;
      e.preventDefault();
      void open(b, c, a.dataset.url);
    });
    list.append(node);
  });
  return scroller;
}

let nudgeTimer: number | undefined;
function onCardKey(e: KeyboardEvent, b: BoardView, c: Card, node: HTMLElement): void {
  if (e.target !== node) return;
  const next = nudge(c, e.key, e.shiftKey, e.ctrlKey || e.metaKey);
  if (next) {
    e.preventDefault();
    Object.assign(c, next);
    placeCard(node, next);
    node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    // Save and announce once the keys stop, so holding an arrow does not flood the disk or the screen reader.
    nudging = true;
    clearTimeout(nudgeTimer);
    nudgeTimer = window.setTimeout(() => {
      nudging = false;
      announce(e.ctrlKey || e.metaKey ? `Size ${next.w} by ${next.h}` : `Position ${next.x}, ${next.y}`);
      void call('boards:update', b.id, c.id, next).finally(() => { if (pending) void refresh(); });
    }, 350);
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    void removeCard(b, c);
  } else if (e.key === 'Enter' || e.key === 'F2') {
    e.preventDefault();
    if (c.kind === 'text') startEditing(c.id);
    else void open(b, c);
  }
}

function onPointerDown(e: PointerEvent, b: BoardView, c: Card, node: HTMLElement): void {
  const target = e.target as HTMLElement;
  if (e.button !== 0 || target.closest('textarea, button, a, input')) return;
  const mode = target.classList.contains('resize') ? 'resize' : 'move';
  const start = { x: e.clientX, y: e.clientY };
  const from: Geometry = { x: c.x, y: c.y, w: c.w, h: c.h };
  let moved = false;
  let last = from;
  node.setPointerCapture(e.pointerId);
  node.classList.add('dragging');
  busy++;
  const move = (ev: PointerEvent) => {
    const dx = ev.clientX - start.x;
    const dy = ev.clientY - start.y;
    if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    moved = true;
    last = dragged(from, mode, dx, dy);
    placeCard(node, last);
  };
  const end = () => {
    node.removeEventListener('pointermove', move);
    node.removeEventListener('pointerup', end);
    node.removeEventListener('pointercancel', end);
    node.classList.remove('dragging');
    busy = Math.max(0, busy - 1);
    if (moved) {
      Object.assign(c, last);
      void call('boards:update', b.id, c.id, last).finally(() => { if (pending) void refresh(); });
    } else if (pending) void refresh();
    node.focus({ preventScroll: true });
  };
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerup', end);
  node.addEventListener('pointercancel', end);
}

// ───────── notes ─────────

function startEditing(id: string): void {
  // Finish (and save) any note already open before its editor is replaced.
  if (document.activeElement instanceof HTMLTextAreaElement) document.activeElement.blur();
  editing = id;
  renderBoard();
  const area = document.querySelector<HTMLTextAreaElement>(`[data-focus="edit-${CSS.escape(id)}"]`);
  area?.focus();
}

function noteEditor(b: BoardView, c: Extract<Card, { kind: 'text' }>): HTMLElement {
  const area = el('textarea', {
    class: 'note-editor', value: c.text, maxLength: 10000, 'aria-label': 'Note text. Markdown-lite: # heading, - list, **bold**, *italic*, `code`, [link](https://…). Escape or Ctrl+Enter to finish.',
    dataset: { focus: 'edit-' + c.id }, spellcheck: true,
  });
  let done = false;
  const finish = (refocus: boolean) => {
    if (done || editing !== c.id) return;
    done = true;
    editing = null;
    const text = area.value;
    void call('boards:update', b.id, c.id, { text }).then(async () => {
      await refresh(true);
      if (refocus) restoreFocus('card-' + c.id);
    });
  };
  area.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      finish(true);
    }
  });
  area.addEventListener('blur', () => finish(false));
  return area;
}

async function addNote(): Promise<void> {
  if (!board) return;
  const scroller = main.querySelector<HTMLElement>('.canvas-scroll');
  // In the canvas, a new note lands where the person is looking.
  const at = view === 'canvas' && scroller && board.cards.length ? { x: scroller.scrollLeft + 24, y: scroller.scrollTop + 24 } : undefined;
  const result = (await call('boards:add-note', board.id, at)) as { id?: string; error?: string };
  if (result.error) return setMessage(result.error);
  editing = view === 'canvas' ? result.id ?? null : null;
  await refresh(true);
  if (editing) restoreFocus('edit-' + editing);
  else restoreFocus('card-' + result.id);
  announce('Note added');
}

async function removeCard(b: BoardView, c: Card): Promise<void> {
  const kind = c.kind === 'text' ? 'note' : c.kind === 'link' ? 'link' : 'capture';
  if (!(c.kind === 'text' && !c.text.trim()) && !confirm(`Delete this ${kind}?`)) return;
  const index = b.cards.indexOf(c);
  await call('boards:remove', b.id, c.id);
  const next = b.cards[index + 1] ?? b.cards[index - 1];
  await refresh(true);
  restoreFocus(next ? (view === 'canvas' ? 'card-' : 'item-') + next.id : 'add-note');
  announce(`Deleted ${kind}`);
}

async function open(b: BoardView, c: Card, url?: string): Promise<void> {
  if (!(await call('boards:open', b.id, c.id, url))) setMessage('That link can no longer be opened.');
}

async function exportBoard(): Promise<void> {
  if (!board) return;
  setMessage('Exporting…');
  const result = (await call('boards:export', board.id)) as { saved?: string; error?: string; cancelled?: boolean };
  setMessage(result.saved ? `Saved ${result.saved}.` : result.error ?? '');
  if (result.saved || result.error) announce(result.saved ? `Saved ${result.saved}` : result.error!);
}

// ───────── list view ─────────

function renderList(b: BoardView): HTMLElement {
  const list = el('ol', { class: 'card-list', 'aria-label': 'Cards in reading order' });
  b.cards.forEach((c, index) => {
    const move = async (to: number, label: string) => {
      await call('boards:reorder', b.id, c.id, to);
      await refresh(true);
      restoreFocus(`${label}-${c.id}`);
      if (!document.activeElement || document.activeElement === document.body) restoreFocus('item-' + c.id);
      announce(`${c.label} moved to position ${to + 1} of ${b.cards.length}`);
    };
    const action = c.kind === 'text'
      ? el('button', { class: 'btn', dataset: { focus: 'edit-btn-' + c.id }, onClick: () => { setView('canvas'); startEditing(c.id); } }, 'Edit')
      : (c.kind === 'link' || c.url) ? el('button', { class: 'btn', dataset: { focus: 'open-' + c.id }, onClick: () => void open(b, c) }, 'Open') : null;
    const preview = c.kind === 'text' ? el('div', { class: 'note-body' }) : c.kind === 'capture' ? el('img', { src: c.src, alt: c.title ? `Capture of ${c.title}` : 'Page capture', class: 'list-thumb' }) : el('span', { class: 'note' }, c.host);
    if (c.kind === 'text') {
      preview.innerHTML = c.html; // Rendered and escaped by the main process.
      preview.addEventListener('click', (e) => {
        const a = (e.target as HTMLElement).closest('a[data-url]') as HTMLAnchorElement | null;
        if (a) { e.preventDefault(); void open(b, c, a.dataset.url); }
      });
    }
    list.append(el('li', { class: 'card-item' },
      el('div', { class: 'card-item-head' },
        el('span', { class: 'k' }, `${index + 1}`),
        el('strong', { tabindex: -1, dataset: { focus: 'item-' + c.id } }, c.label),
        el('span', { class: 'card-item-actions' },
          el('button', { class: 'btn', disabled: index === 0, 'aria-label': `Move ${c.label} up`, dataset: { focus: 'up-' + c.id }, onClick: () => void move(index - 1, 'up') }, 'Move up'),
          el('button', { class: 'btn', disabled: index === b.cards.length - 1, 'aria-label': `Move ${c.label} down`, dataset: { focus: 'down-' + c.id }, onClick: () => void move(index + 1, 'down') }, 'Move down'),
          action,
          el('button', { class: 'btn danger', 'aria-label': `Delete ${c.label}`, dataset: { focus: 'delete-' + c.id }, onClick: () => void removeCard(b, c) }, 'Delete'))),
      preview));
  });
  return list;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = newName.value.trim();
  if (!name) return newName.focus();
  const id = (await call('boards:create', name)) as string | null;
  if (!id) return setMessage('Quiver could not create another board here.');
  newName.value = '';
  select(id);
  announce(`Created board ${name}`);
});

quiver.on('boards:changed', () => void refresh());
window.addEventListener('focus', () => void refresh());
void refresh();
