import type { LocalServerStatus, PeekView, PhoneStatus, ShellState, SidebarRow, SplitView, TabInfo, Space } from '../shared/types';
import { scrollToReveal, visibleRows } from './virtual-list.js';

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, any> = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && k !== 'list') (el as any)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids) if (c) el.append(c);
  return el;
}

const sidebar = document.getElementById('sidebar')!;
const toolbar = document.getElementById('toolbar')!;
const recoveryStatus = document.getElementById('recovery-status')!;
const phoneLabel = document.getElementById('phone-label')!;
const developerStatus = h('div', { class: 'sr-only', role: 'status', 'aria-atomic': 'true' });
document.body.append(developerStatus);
let state: ShellState | null = null;
let addingSpace = false;
let renamingSpace: string | null = null;
let lastShellFocus: string | undefined;

function focusShellControl(key?: string): boolean {
  if (!key) return false;
  const control = document.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(key)}"]`);
  if (!control || !control.getClientRects().length || control.matches(':disabled')) return false;
  control.focus({ preventScroll: true });
  return document.activeElement === control;
}

document.addEventListener('focusin', (event) => {
  if (event.target instanceof HTMLElement && event.target.dataset.focusKey) lastShellFocus = event.target.dataset.focusKey;
});
quiver.on('cmd:restore-focus', (key: unknown) => {
  if (!focusShellControl(typeof key === 'string' ? key : lastShellFocus)) focusShellControl('address');
});

const ICON = {
  back: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3 5 8l5 5"/></svg>',
  forward: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m6 3 5 5-5 5"/></svg>',
  reload: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5V5h-2.5"/></svg>',
  phone: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="1.5" width="7" height="13" rx="1.6"/><path d="M7 12.5h2"/></svg>',
  env: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 5h10l-2.5-2.5M14 11H4l2.5 2.5"/></svg>',
  boost: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z"/></svg>',
  gear: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4"/></svg>',
  sidebar: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2.5" width="12" height="11" rx="2"/><path d="M6 2.5v11"/></svg>',
};

function icon(svg: string, label: string, onClick: () => void, extra: Record<string, any> = {}): HTMLButtonElement {
  const b = h('button', { class: 'icon-btn' + (extra.on ? ' on' : ''), title: label, 'aria-label': label, disabled: extra.disabled, dataset: { focusKey: extra.focusKey ?? label }, onClick });
  b.innerHTML = svg;
  return b;
}

const call = (ch: string, ...a: unknown[]) => quiver.invoke(ch, ...a).catch((e: Error) => console.error(ch, e.message));

function renderSpaces(s: ShellState): HTMLElement {
  const wrap = h('div', { class: 'spaces', role: 'tablist', 'aria-label': 'Spaces' });
  for (const sp of s.spaces) {
    if (renamingSpace === sp.id) {
      const input = h('input', { class: 'space-edit', value: sp.name, 'aria-label': 'Rename space', maxLength: 40, dataset: { focusKey: `rename-${sp.id}` } });
      const finish = (save: boolean) => {
        renamingSpace = null;
        if (save && input.value.trim()) void call('space:rename', sp.id, input.value);
        render();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
      });
      input.addEventListener('blur', () => finish(true));
      wrap.append(input);
      queueMicrotask(() => {
        input.focus();
        input.select();
      });
      continue;
    }
    const dot = h('span', { class: 'dot' });
    dot.style.background = sp.color;
    const chip = h(
      'button',
      {
        class: 'space' + (sp.id === s.activeSpaceId ? ' active' : ''),
        role: 'tab',
        'aria-selected': String(sp.id === s.activeSpaceId),
        dataset: { focusKey: sp.id },
        'aria-label': sp.isolated ? sp.name + ', separate sign-in' : sp.name + ', shared sign-in',
        title: `${sp.name}${sp.isolated ? ' — separate cookies & storage' : ' — shared cookies'}\nRight-click: rename or delete · Double-click: rename`,
        onClick: () => call('space:activate', sp.id),
        onDblclick: () => {
          renamingSpace = sp.id;
          render();
        },
        onContextmenu: (e: Event) => {
          e.preventDefault();
          void call('space:menu', sp.id);
        },
      },
      dot,
      h('span', { class: 'label' }, (sp.isolated ? '🔒 ' : '') + sp.name),
    );
    wrap.append(chip);
  }
  wrap.append(
    icon('+', 'New Space', () => {
      addingSpace = !addingSpace;
      render();
      if (addingSpace) focusShellControl('space-name');
    }),
  );
  return wrap;
}

function renderAddForm(): HTMLElement {
  const name = h('input', { placeholder: 'Space name', 'aria-label': 'Space name', maxLength: 40, dataset: { focusKey: 'space-name' } });
  const iso = h('input', { type: 'checkbox', checked: true, id: 'iso', dataset: { focusKey: 'space-isolated' } });
  const submit = () => {
    void call('space:create', name.value || 'Space', iso.checked);
    addingSpace = false;
    render();
  };
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
    if (e.key === 'Escape') {
      addingSpace = false;
      render();
    }
  });
  return h(
    'div',
    { class: 'add-space-form' },
    name,
    h('label', { title: 'Own cookie jar, logins and storage, separate from other Spaces' }, iso, 'Separate cookies & logins'),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', dataset: { focusKey: 'space-create' }, onClick: submit }, 'Create'), h('button', { class: 'btn', dataset: { focusKey: 'space-cancel' }, onClick: () => { addingSpace = false; render(); } }, 'Cancel')),
  );
}

type Drag = { kind: 'tab'; id: number; row: number } | { kind: 'folder'; id: string; row: number };
let dragging: Drag | null = null;
let renamingFolder: string | null = null;

function clearDropMarks(): void {
  for (const el of sidebar.querySelectorAll('.drop-before, .drop-after, .drop-into')) el.classList.remove('drop-before', 'drop-after', 'drop-into');
}

// The tab list is windowed: only rows near the viewport (plus the active, focused and dragged rows) are in the DOM,
// so Spaces with hundreds of tabs stay cheap to re-render on every state update and to scroll.
const TAB_ROW_H = 32;
const TAB_OVERSCAN = 8;
interface RowMeta { level: number; setsize: number; posinset: number }
let tabList: {
  scroller: HTMLElement; inner: HTMLElement; rows: SidebarRow[]; meta: RowMeta[]; tabs: Map<number, TabInfo>; activeId: number | null;
} | null = null;
let revealedTab = '';
let paintQueued = false;

function rowKey(row: SidebarRow): string {
  return row.kind === 'tab' ? 'tab-' + row.tabId : row.kind === 'folder' ? 'folder:' + row.id : 'divider';
}

/** Tree position for each row (aria-level / setsize / posinset), computed for the whole list since most rows are not in the DOM. */
function rowMeta(rows: readonly SidebarRow[]): RowMeta[] {
  const parentOf: string[] = [];
  const stack: string[] = [];
  for (const row of rows) {
    if (row.kind === 'divider') { parentOf.push(''); stack.length = 0; continue; }
    const depth = row.depth;
    stack.length = depth;
    const parent = row.kind === 'tab' && !row.pinned ? 'temporary' : depth ? stack[depth - 1] ?? 'root' : 'root';
    parentOf.push(parent);
    if (row.kind === 'folder') stack[depth] = row.id;
  }
  const sizes = new Map<string, number>();
  for (const parent of parentOf) sizes.set(parent, (sizes.get(parent) ?? 0) + 1);
  const seen = new Map<string, number>();
  return rows.map((row, i) => {
    const parent = parentOf[i];
    const pos = (seen.get(parent) ?? 0) + 1;
    seen.set(parent, pos);
    return { level: row.kind === 'divider' ? 0 : row.depth + 1, setsize: sizes.get(parent) ?? 1, posinset: pos };
  });
}

function focusedRowKey(): string | undefined {
  const m = lastShellFocus?.match(/^(?:close-)?(tab-\d+)$/);
  return m ? m[1] : lastShellFocus?.startsWith('folder:') || lastShellFocus?.startsWith('rename-folder:') ? 'folder:' + lastShellFocus.split(':').slice(1).join(':') : undefined;
}

function paintTabs(): void {
  if (!tabList) return;
  const { scroller, inner, rows, activeId } = tabList;
  const indexOfKey = (key: string | undefined) => (key ? rows.findIndex((r) => rowKey(r) === key) : -1);
  const visible = visibleRows({
    count: rows.length, rowHeight: TAB_ROW_H, scrollTop: scroller.scrollTop, viewport: scroller.clientHeight || window.innerHeight,
    overscan: TAB_OVERSCAN, keep: [indexOfKey(activeId == null ? undefined : 'tab-' + activeId), indexOfKey(focusedRowKey()), dragging?.row ?? -1],
  });
  const existing = new Map<string, HTMLElement>();
  for (const el of [...inner.children] as HTMLElement[]) existing.set(el.dataset.rowKey ?? '', el);
  const wanted = new Set(visible.map((i) => rowKey(rows[i])));
  for (const [key, el] of existing) if (!wanted.has(key)) el.remove();
  // Kept rows never move in the DOM (moving a node would drop its focus); new rows are inserted around them.
  let previous: HTMLElement | null = null;
  for (const i of visible) {
    let el = existing.get(rowKey(rows[i]));
    if (!el || !el.isConnected) {
      el = renderRow(i);
      if (previous) previous.after(el);
      else inner.prepend(el);
    }
    el.style.top = i * TAB_ROW_H + 'px';
    previous = el;
  }
}

window.addEventListener('resize', () => queuePaintTabs());

function queuePaintTabs(): void {
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(() => {
    paintQueued = false;
    paintTabs();
  });
}

function revealRow(index: number): void {
  if (!tabList) return;
  const { scroller } = tabList;
  const top = scrollToReveal(index, TAB_ROW_H, scroller.scrollTop, scroller.clientHeight);
  if (top !== scroller.scrollTop) scroller.scrollTop = top;
}

function focusRow(index: number): void {
  if (!tabList) return;
  const row = tabList.rows[index];
  if (!row || row.kind === 'divider') return;
  revealRow(index);
  lastShellFocus = rowKey(row);
  paintTabs();
  focusShellControl(lastShellFocus);
}

function moveRowFocus(e: KeyboardEvent, index: number): void {
  if (!tabList || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const rows = tabList.rows;
  const focusable = rows.flatMap((r, i) => (r.kind === 'divider' ? [] : [i]));
  const at = focusable.indexOf(index);
  const row = rows[index];
  let next = -1;
  if (e.key === 'ArrowDown') next = focusable[Math.min(at + 1, focusable.length - 1)];
  else if (e.key === 'ArrowUp') next = focusable[Math.max(at - 1, 0)];
  else if (e.key === 'Home') next = focusable[0];
  else if (e.key === 'End') next = focusable[focusable.length - 1];
  else if (row.kind === 'folder' && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
    const collapse = e.key === 'ArrowLeft';
    e.preventDefault();
    if (row.collapsed !== collapse) void call('folder:toggle', row.id, collapse);
    else if (!collapse) next = index + 1 < rows.length && rows[index + 1].kind !== 'divider' && 'depth' in rows[index + 1] && (rows[index + 1] as { depth: number }).depth > row.depth ? index + 1 : -1;
    else next = parentRow(index);
  } else if (row.kind === 'tab' && row.pinned && e.key === 'ArrowLeft') next = parentRow(index);
  if (next === undefined || next < 0) return;
  e.preventDefault();
  focusRow(next);
}

function parentRow(index: number): number {
  if (!tabList) return -1;
  const row = tabList.rows[index];
  if (row.kind === 'divider' || row.depth === 0) return -1;
  for (let i = index - 1; i >= 0; i--) {
    const r = tabList.rows[i];
    if (r.kind === 'folder' && r.depth === row.depth - 1) return i;
  }
  return -1;
}

const lowerHalf = (e: DragEvent) => {
  const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
  return e.clientY > box.top + box.height / 2;
};

/** Drag-and-drop wiring shared by every row; `drop` decides what a drop on this row means. */
function dropTarget(mark: (e: DragEvent) => 'drop-before' | 'drop-after' | 'drop-into' | null, drop: (drag: Drag, e: DragEvent) => void) {
  return {
    onDragover: (e: DragEvent) => {
      if (!dragging) return;
      const cls = mark(e);
      clearDropMarks();
      if (!cls) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      (e.currentTarget as HTMLElement).classList.add(cls);
    },
    onDragleave: (e: DragEvent) => (e.currentTarget as HTMLElement).classList.remove('drop-before', 'drop-after', 'drop-into'),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      clearDropMarks();
      const drag = dragging;
      dragging = null;
      if (drag) drop(drag, e);
    },
    onDragend: () => {
      dragging = null;
      clearDropMarks();
    },
  };
}

function dragSource(start: () => Drag) {
  return {
    draggable: true,
    onDragstart: (e: DragEvent) => {
      dragging = start();
      e.dataTransfer?.setData('application/x-quiver-' + dragging.kind, String(dragging.id));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    },
  };
}

function renderRow(index: number): HTMLElement {
  const { rows, meta, tabs, activeId } = tabList!;
  const row = rows[index];
  const el = row.kind === 'tab' ? renderTab(tabs.get(row.tabId)!, row, row.tabId === activeId, index, meta[index])
    : row.kind === 'folder' ? renderFolder(row, index, meta[index]) : renderDivider(index);
  el.dataset.rowKey = rowKey(row);
  el.style.setProperty('--depth', String(row.kind === 'divider' ? 0 : row.depth));
  return el;
}

function renderDivider(index: number): HTMLElement {
  const next = tabList!.rows[index + 1];
  return h('div', {
    class: 'tab-divider', 'aria-hidden': 'true',
    ...dropTarget(() => 'drop-after', (drag) => {
      if (drag.kind === 'folder') void call('folder:move', drag.id, null);
      else void call('tab:place', drag.id, { pinned: false, folderId: null, targetId: next?.kind === 'tab' ? next.tabId : null, after: false });
    }),
  }, h('span', {}, 'Tabs'));
}

function renderFolder(row: Extract<SidebarRow, { kind: 'folder' }>, index: number, m: RowMeta): HTMLElement {
  if (renamingFolder === row.id) {
    const input = h('input', { class: 'space-edit', value: row.name, 'aria-label': 'Rename folder', maxLength: 40, dataset: { focusKey: 'rename-folder:' + row.id } });
    const finish = (save: boolean) => {
      if (renamingFolder !== row.id) return;
      renamingFolder = null;
      if (save && input.value.trim()) void call('folder:rename', row.id, input.value);
      lastShellFocus = 'folder:' + row.id;
      render();
      focusShellControl(lastShellFocus);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    return h('div', { class: 'folder renaming' }, input);
  }
  const select = h('button', {
    class: 'tab-select',
    role: 'treeitem',
    'aria-label': `${row.name}, folder, ${row.count} ${row.count === 1 ? 'tab' : 'tabs'}`,
    'aria-expanded': String(!row.collapsed),
    'aria-level': String(m.level), 'aria-setsize': String(m.setsize), 'aria-posinset': String(m.posinset),
    dataset: { focusKey: 'folder:' + row.id },
    title: row.name + '\nClick to ' + (row.collapsed ? 'expand' : 'collapse') + ' · right-click for options · drop tabs here to pin',
    onClick: () => call('folder:toggle', row.id),
    onDblclick: () => { renamingFolder = row.id; render(); focusShellControl('rename-folder:' + row.id); },
    onKeydown: (e: KeyboardEvent) => {
      if (e.key === 'F2') { e.preventDefault(); renamingFolder = row.id; render(); focusShellControl('rename-folder:' + row.id); return; }
      moveRowFocus(e, index);
    },
  }, h('span', { class: 'chev', 'aria-hidden': 'true' }, row.collapsed ? '▸' : '▾'), h('span', { class: 'title' }, row.name), h('span', { class: 'count' }, String(row.count)));
  return h('div', {
    class: 'folder',
    onContextmenu: (e: Event) => { e.preventDefault(); void call('folder:menu', row.id); },
    ...dragSource(() => ({ kind: 'folder', id: row.id, row: index })),
    ...dropTarget((e) => (dragging?.kind === 'folder' && dragging.id === row.id ? null : 'drop-into'), (drag) => {
      if (drag.kind === 'folder') void call('folder:move', drag.id, row.id);
      else void call('tab:place', drag.id, { pinned: true, folderId: row.id, targetId: null, after: true });
    }),
  }, select);
}

function renderTab(t: TabInfo, row: Extract<SidebarRow, { kind: 'tab' }>, active: boolean, index: number, m: RowMeta): HTMLElement {
  const fav = t.favicon ? h('img', { class: 'fav', src: t.favicon, alt: '' }) : h('span', { class: 'fav' });
  const kids: Child[] = [fav, h('span', { class: 'title' }, t.title)];
  if (t.env) kids.push(h('span', { class: `pill ${t.env}`, title: `Environment: ${t.env}` }, t.env === 'STAGING' ? 'STG' : t.env));
  if (t.split) kids.push(h('span', { class: 'split-mark', title: `In split view (${t.split} pane)`, 'aria-hidden': 'true' }, t.split === 'left' ? '◧' : '◨'));
  if (t.live) kids.push(h('span', { class: 'live', title: 'Using camera, microphone or screen sharing', 'aria-label': 'live' }, '●'));
  if (t.local && t.errors > 0) {
    kids.push(h('span', {
      class: 'err', title: `${t.errors} console error(s) since last navigation. Click to open the console`,
      // Not a nested button: the tab row is the control; this is a mouse shortcut, also in the tab's right-click menu.
      onClick: (e: MouseEvent) => { e.stopPropagation(); void call('tab:console', t.id); },
    }, String(t.errors > 99 ? '99+' : t.errors)));
  }
  const select = h('button', {
    class: 'tab-select',
    role: 'treeitem',
    'aria-label': t.title + (t.pinned ? ', pinned' : '') + (t.split ? `, in split view, ${t.split} pane` : '') + (t.live ? ', using camera or microphone' : ''),
    'aria-selected': String(active),
    'aria-level': String(m.level), 'aria-setsize': String(m.setsize), 'aria-posinset': String(m.posinset),
    dataset: { focusKey: 'tab-' + t.id },
    onKeydown: (e: KeyboardEvent) => moveRowFocus(e, index),
    title: t.title + '\n' + t.url + '\nDrag or press Ctrl+Shift+PageUp/PageDown to move · right-click to pin or file in a folder',
    onClick: () => call('tab:activate', t.id),
  }, ...kids);
  const close = h('button', {
    class: 'close',
    title: t.pinned ? 'Back to the pinned page (Ctrl+W). Right-click to remove the pinned tab' : 'Close tab (Ctrl+W)',
    'aria-label': (t.pinned ? 'Return to pinned page: ' : 'Close ') + t.title,
    dataset: { focusKey: 'close-tab-' + t.id },
    onClick: () => call('tab:close', t.id),
  }, '×');
  return h('div', {
    class: 'tab' + (active ? ' active' : '') + (t.loading ? ' loading' : '') + (t.pinned ? ' pinned' : '') + (t.split ? ' split' : ''),
    dataset: { tabId: String(t.id) },
    onAuxclick: (e: MouseEvent) => {
      if (e.button === 1) void call('tab:close', t.id);
    },
    onContextmenu: (e: Event) => { e.preventDefault(); void call('tab:menu', t.id); },
    ...dragSource(() => ({ kind: 'tab', id: t.id, row: index })),
    ...dropTarget((e) => (dragging?.kind === 'tab' && dragging.id === t.id ? null : lowerHalf(e) ? 'drop-after' : 'drop-before'), (drag, e) => {
      if (drag.kind === 'folder') void call('folder:move', drag.id, row.pinned ? row.folderId : null);
      else void call('tab:place', drag.id, { pinned: row.pinned, folderId: row.folderId, targetId: t.id, after: lowerHalf(e) });
    }),
  }, select, close);
}

function recoveryMessage(s: ShellState): string {
  const restored = s.recoveryNotice?.session;
  const parts: string[] = [];
  if (restored) {
    const tabs = restored.tabs === 1 ? '1 tab' : restored.tabs + ' tabs';
    const spaces = restored.spaces === 1 ? '1 Space' : restored.spaces + ' Spaces';
    parts.push('Restored ' + tabs + ' across ' + spaces + ' from the last saved session.');
  }
  if (s.recoveryNotice?.movedToVisibleDisplay) parts.push('Quiver moved to an available display.');
  return parts.join(' ');
}

function renderRecovery(s: ShellState): HTMLElement[] {
  const cards: HTMLElement[] = [];
  const message = recoveryMessage(s);
  if (message) {
    cards.push(h('div', { class: 'recovery-card recovery-notice' },
      h('p', { class: 'recovery-copy' }, message),
      h('button', {
        class: 'icon-btn recovery-expanded',
        'aria-label': 'Dismiss recovery notice',
        title: message + ' Dismiss notice',
        dataset: { focusKey: 'recovery-dismiss' },
        onClick: () => call('recovery:dismiss'),
      }, '×'),
      h('button', {
        class: 'icon-btn recovery-compact',
        'aria-label': 'Show recovery notice',
        title: message,
        dataset: { focusKey: 'recovery-dismiss' },
        onClick: () => call('sidebar:toggle'),
      }, 'ⓘ'),
    ));
  }
  if (s.arcImportOffer) {
    cards.push(h('div', { class: 'recovery-card arc-offer' },
      h('p', { class: 'recovery-copy' }, 'Bring your Arc Spaces, pins and folders into Quiver.'),
      h('button', {
        class: 'btn',
        'aria-label': 'Review Arc import',
        title: 'Review your Arc sidebar in Settings before importing it',
        dataset: { focusKey: 'arc-offer-open' },
        onClick: () => call('arc:offer-open'),
      }, h('span', { class: 'recovery-expanded' }, 'Review import'), h('span', { class: 'recovery-compact', 'aria-hidden': 'true' }, 'A')),
      h('button', {
        class: 'icon-btn recovery-expanded',
        'aria-label': 'Dismiss Arc import',
        title: 'Not now. Import from Arc stays available in Settings.',
        dataset: { focusKey: 'arc-offer-dismiss' },
        onClick: () => call('arc:offer-dismiss'),
      }, '×'),
    ));
  }
  const closed = s.recentlyClosed;
  const original = closed && s.spaces.find(({ id }) => id === closed.spaceId);
  if (closed && original) {
    const signIn = original.isolated ? 'Separate sign-in' : 'Shared sign-in';
    const description = 'Reopen ' + closed.title + ' in ' + original.name;
    cards.push(h('div', { class: 'recovery-card recovery-closed' },
      h('p', { class: 'recovery-copy', title: closed.title }, 'Closed ' + closed.title),
      h('button', {
        class: 'btn',
        'aria-label': description,
        title: description + ' (Ctrl+Shift+T) · ' + signIn,
        dataset: { focusKey: 'reopen-tab' },
        onClick: () => call('tab:reopen', closed.id),
      }, h('span', { class: 'recovery-expanded' }, 'Reopen in ' + original.name), h('span', { class: 'recovery-compact', 'aria-hidden': 'true' }, '↶')),
      h('kbd', { class: 'recovery-expanded' }, 'Ctrl+Shift+T'),
    ));
  }
  const crashed = s.tabs.find((t) => t.id === s.activeTabId && t.canRetryCrash);
  if (crashed) {
    cards.push(h('div', { class: 'recovery-card recovery-crash' },
      h('p', { class: 'recovery-copy' }, 'This page stopped.'),
      h('button', {
        class: 'btn',
        'aria-label': 'Retry stopped page',
        title: 'Retry stopped page (Ctrl+R)',
        dataset: { focusKey: 'retry-crashed-tab' },
        onClick: () => call('tab:retry-crash', crashed.id),
      }, h('span', { class: 'recovery-expanded' }, 'Retry page'), h('span', { class: 'recovery-compact', 'aria-hidden': 'true' }, '↻')),
    ));
  }
  return cards;
}

// The whole sidebar is rebuilt from state, so rebuilding it when nothing it shows changed only costs CPU, resets
// hover and moves screen-reader and UI Automation elements out from under people and tests. Skip those rebuilds.
let lastSidebarKey = '';

function sidebarKey(s: ShellState): string {
  const { tabs: _tabs, devServers, ...rest } = s;
  return JSON.stringify([
    s.tabs.filter((t) => t.spaceId === s.activeSpaceId),
    devServers,
    rest.spaces, rest.activeSpaceId, rest.activeTabId, rest.sidebar, rest.recentlyClosed, rest.recoveryNotice, rest.arcImportOffer, rest.localServerStatus,
    rest.settings.sidebarCollapsed, rest.settings.devServerScan, addingSpace, renamingSpace, renamingFolder,
  ]);
}

function renderSidebar(s: ShellState): void {
  const key = sidebarKey(s);
  if (key === lastSidebarKey && sidebar.childElementCount) return;
  lastSidebarKey = key;
  const spaceTabs = s.tabs.filter((t) => t.spaceId === s.activeSpaceId);
  const brand = h('div', { class: 'brand' });
  const logo = h('img', { src: 'quiver-icon.png', width: 22, height: 22, alt: '' });
  brand.append(logo, h('span', { class: 'name' }, 'Quiver'), icon(ICON.sidebar, 'Collapse / expand sidebar (Ctrl+B)', () => call('sidebar:toggle')));

  const newtab = h('button', { class: 'newtab', title: 'Open the command bar in a new tab (Ctrl+T)', dataset: { focusKey: 'new-tab' }, onClick: () => call('cmd:open', '', 'new', 'new-tab') }, h('span', {}, '＋ New tab'), h('kbd', {}, 'Ctrl+T'));

  const previousTabs = sidebar.querySelector<HTMLElement>('.tabs');
  const previousScroll = previousTabs?.dataset.spaceId === s.activeSpaceId ? previousTabs.scrollTop : 0;
  const inner = h('div', { class: 'tabs-window' });
  inner.style.height = s.sidebar.length * TAB_ROW_H + 'px';
  const tabsEl = h('div', { class: 'tabs', role: 'tree', 'aria-label': 'Tabs', dataset: { spaceId: s.activeSpaceId }, onScroll: queuePaintTabs }, inner);

  const servers = h('section', { class: 'servers', 'aria-label': 'Local servers' }, h('h3', {}, h('span', {}, 'Local servers'), h('button', { class: 'icon-btn', disabled: !s.settings.devServerScan, title: 'Rescan now', 'aria-label': 'Rescan local servers', dataset: { focusKey: 'rescan' }, onClick: () => call('devserver:refresh') }, '↻')));
  if (!s.settings.devServerScan) servers.append(h('div', { class: 'empty' }, 'Scanning is off (Settings).'));
  else if (s.devServers.length === 0) servers.append(h('div', { class: 'empty' }, 'No HTTP servers found on localhost.'));
  for (const d of s.devServers) {
    servers.append(
      h('button', { class: 'server', title: `${d.label}\n${d.url}`, dataset: { focusKey: d.url }, onClick: () => call('devserver:open', d.url) }, h('span', { class: 'port' }, `:${d.port}`), h('span', { class: 'stitle' }, d.label)),
    );
  }

  const active = s.spaces.find(({ id }) => id === s.activeSpaceId);
  const isolation = active && h('p', {
    class: 'space-isolation',
    title: active.name + (active.isolated ? ' has separate cookies and sign-ins' : ' shares cookies and sign-ins with other shared Spaces'),
  },
    h('span', { class: 'recovery-expanded' }, active.isolated ? 'Separate sign-in' : 'Shared sign-in'),
    h('span', { class: 'recovery-compact' }, active.isolated ? 'Separate' : 'Shared'),
  );
  sidebar.replaceChildren(brand, renderSpaces(s), ...(isolation ? [isolation] : []),
    ...(addingSpace ? [renderAddForm()] : []), newtab, ...renderRecovery(s),
    ...(s.localServerStatus ? [renderLocalServerStatus(s.localServerStatus)] : []), tabsEl, servers);
  tabsEl.scrollTop = previousScroll;
  tabList = { scroller: tabsEl, inner, rows: s.sidebar, meta: rowMeta(s.sidebar), tabs: new Map(spaceTabs.map((t) => [t.id, t])), activeId: s.activeTabId };
  const reveal = s.activeSpaceId + ':' + s.activeTabId;
  if (reveal !== revealedTab) {
    revealedTab = reveal;
    const index = s.sidebar.findIndex((r) => r.kind === 'tab' && r.tabId === s.activeTabId);
    if (index >= 0) revealRow(index);
  }
  paintTabs();
}

function activeTab(s: ShellState): TabInfo | undefined {
  return s.tabs.find((t) => t.id === s.activeTabId);
}

const PHONE_LABELS: Record<PhoneStatus, { label: string; compact: string }> = {
  off: { label: 'Phone preview off', compact: '' },
  paused: { label: 'Phone preview paused. Open an HTTP or HTTPS page to resume.', compact: 'Paused' },
  narrow: { label: 'Phone preview paused. Widen the window to resume.', compact: 'Widen' },
  starting: { label: 'Starting phone preview', compact: 'Starting' },
  active: { label: 'Phone preview shares this tab’s sign-in', compact: '' },
  unavailable: { label: 'Phone preview unavailable. Turn it off and on to retry.', compact: 'Unavailable' },
};

function renderLocalServerStatus(status: LocalServerStatus): HTMLElement {
  const recovered = status.state === 'recovered';
  const label = recovered ? 'Local server is back' : 'Local server unavailable';
  const card = h('div', { class: 'local-status', title: label, dataset: { state: status.state } },
    h('span', { class: 'recovery-expanded' }, label));
  if (recovered) {
    card.append(h('button', {
      class: 'btn', title: 'Retry the failed local page', 'aria-label': 'Retry local page',
      dataset: { focusKey: 'retry-local-page' },
      onClick: async () => {
        try {
          if (!await quiver.invoke('devserver:retry', status.tabId, status.url)) {
            developerStatus.textContent = 'The local page changed. Review the active tab before retrying.';
          }
        } catch {
          developerStatus.textContent = 'Could not retry the local page. Press Ctrl+R to try again.';
        }
      },
    }, h('span', { class: 'recovery-expanded' }, 'Retry page'), h('span', { class: 'recovery-compact', 'aria-hidden': 'true' }, '↻')));
  } else {
    card.append(h('span', { class: 'recovery-compact', 'aria-label': label }, '!'));
  }
  return card;
}

function findCount(f: NonNullable<ShellState['find']>): string {
  if (!f.text) return '';
  return f.matches ? `${f.active} of ${f.matches}` : 'No matches';
}

function renderFindBar(f: NonNullable<ShellState['find']>): HTMLElement {
  const input = h('input', {
    type: 'search', value: f.text, placeholder: 'Find in page', 'aria-label': 'Find in page', spellcheck: false,
    dataset: { focusKey: 'find-input' },
    onInput: () => call('find:query', input.value, true, false),
    onKeydown: (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); void call('find:query', input.value, !e.shiftKey, true); }
      if (e.key === 'Escape') { e.preventDefault(); void call('find:close'); }
    },
  });
  const count = h('span', { class: 'find-count', role: 'status', 'aria-live': 'polite' }, findCount(f));
  return h('div', { class: 'find-bar' },
    input, count,
    h('button', { class: 'icon-btn', title: 'Previous match (Shift+Enter, Shift+F3)', 'aria-label': 'Previous match', onClick: () => call('find:query', input.value, false, true) }, '↑'),
    h('button', { class: 'icon-btn', title: 'Next match (Enter, F3)', 'aria-label': 'Next match', onClick: () => call('find:query', input.value, true, true) }, '↓'),
    h('button', { class: 'icon-btn', title: 'Close (Esc)', 'aria-label': 'Close find', onClick: () => call('find:close') }, '×'));
}

function renderToolbar(s: ShellState): void {
  const t = activeTab(s);
  // Typing in the find box must not rebuild it (that would drop the caret); only its count changes.
  const findInput = toolbar.querySelector<HTMLInputElement>('.find-bar input');
  if (s.find && findInput && document.activeElement === findInput && !s.permissionPrompt) {
    const count = toolbar.querySelector('.find-count');
    if (count) count.textContent = findCount(s.find);
    return;
  }
  const addr = h('button', { id: 'address', title: 'Search or enter a command (Ctrl+K / Ctrl+L)', 'aria-label': 'Address and command bar', dataset: { focusKey: 'address' }, onClick: () => call('cmd:open', undefined, 'current', 'address') });
  if (t?.env) addr.append(h('span', { class: `pill ${t.env}`, title: `Environment: ${t.env}` }, t.env));
  addr.append(h('span', { class: 'url' + (t?.url ? '' : ' placeholder') }, t?.url || 'Search, paste a URL, JWT, or type gh / npm / mdn / env / boost…'), h('span', { class: 'hint' }, 'Ctrl+K'));
  const phoneStatus = PHONE_LABELS[s.phoneStatus];
  const phone = icon(ICON.phone, 'Phone preview (Ctrl+Shift+P)', () => call('preview:toggle'), { on: s.preview, focusKey: 'phone-preview' });
  phone.title = `${phoneStatus.label} (Ctrl+Shift+P)`;
  phone.setAttribute('aria-describedby', 'phone-label');
  phone.setAttribute('aria-pressed', String(s.preview));
  if (phoneStatus.compact) {
    phone.classList.add('tool-status');
    phone.append(h('span', { class: 'tool-label', 'aria-hidden': 'true' }, phoneStatus.compact));
  }
  const activeBoosts = t?.activeBoosts ?? [];
  const count = activeBoosts.length;
  const boostLabel = count ? `Boosts: ${count} active on this page` : 'Boosts: none active on this page';
  const boost = icon(ICON.boost, `${boostLabel} (Ctrl+Shift+B)`, () => call('cmd:run', { type: 'internal', page: 'boosts' }), { on: count > 0, focusKey: 'boosts' });
  if (count) {
    boost.title = `${boostLabel}: ${activeBoosts.join(', ')} (Ctrl+Shift+B)`;
    boost.classList.add('tool-status');
    boost.append(h('span', { class: 'tool-count', 'aria-hidden': 'true' }, String(count)));
  }
  const research = s.research && h('button', {
    class: 'research-chip',
    title: `Researching “${s.research.name}”: ${s.research.count} items recorded in this Space. Open notes`,
    'aria-label': `Researching ${s.research.name}, ${s.research.count} items. Open research notes`,
    dataset: { focusKey: 'research' },
    onClick: () => call('cmd:run', { type: 'internal', page: 'research', topic: s.research!.id }),
  }, h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', { class: 'research-name' }, s.research.name), h('span', { class: 'tool-count', 'aria-hidden': 'true' }, String(s.research.count)));
  const prompt = s.permissionPrompt;
  const devices = prompt ? (['camera', 'microphone'] as const).filter((k) => prompt.kinds.includes(k)) : [];
  const askFor = prompt && [devices.length ? 'use your ' + devices.join(' and ') : '', prompt.kinds.includes('screen') ? 'share your screen' : '']
    .filter(Boolean).join(' and ');
  const permissionBar = prompt && h('div', { class: 'permission-bar', role: 'alertdialog', 'aria-label': `${prompt.host} wants to ${askFor}` },
    h('span', { class: 'permission-text' }, h('strong', {}, prompt.host), ` wants to ${askFor}`),
    h('button', { class: 'btn primary', dataset: { focusKey: 'permission-once' }, onClick: () => call('permission:decide', prompt.id, 'once') }, 'Allow this time'),
    h('button', { class: 'btn', dataset: { focusKey: 'permission-always' }, title: `Always allow on ${prompt.host} (change in Settings)`, onClick: () => call('permission:decide', prompt.id, 'always') }, 'Always allow'),
    h('button', { class: 'btn', dataset: { focusKey: 'permission-block' }, title: `Block on ${prompt.host} (change in Settings)`, onClick: () => call('permission:decide', prompt.id, 'block') }, 'Block'));
  const dl = s.downloads;
  const downloadsButton = dl && dl.active > 0 && h('button', {
    class: 'downloads-chip',
    title: `${dl.active} download${dl.active === 1 ? '' : 's'} in progress (Ctrl+J)`,
    'aria-label': `${dl.active} download${dl.active === 1 ? '' : 's'} in progress${dl.progress === null ? '' : `, ${Math.floor(dl.progress * 100)} percent`}. Open downloads`,
    dataset: { focusKey: 'downloads' },
    onClick: () => call('cmd:run', { type: 'internal', page: 'downloads' }),
  }, h('span', { 'aria-hidden': 'true' }, '↓'), h('span', {}, dl.progress === null ? String(dl.active) : `${Math.floor(dl.progress * 100)}%`));
  toolbar.replaceChildren(
    icon(ICON.back, 'Back (Alt+←)', () => call('tab:back'), { disabled: !t?.canGoBack }),
    icon(ICON.forward, 'Forward (Alt+→)', () => call('tab:forward'), { disabled: !t?.canGoForward }),
    icon(ICON.reload, 'Reload (Ctrl+R)', () => call('tab:reload')),
    permissionBar || (s.find ? renderFindBar(s.find) : null) || addr,
    ...(s.zoom !== 1 && Number.isFinite(s.zoom) ? [h('button', { class: 'zoom-chip', title: 'Reset zoom (Ctrl+0)', 'aria-label': `Zoom ${Math.round(s.zoom * 100)} percent. Reset zoom`, dataset: { focusKey: 'zoom' }, onClick: () => call('zoom:reset') }, `${Math.round(s.zoom * 100)}%`)] : []),
    ...(research ? [research] : []),
    ...(downloadsButton ? [downloadsButton] : []),
    icon(ICON.env, 'Switch environment: local → staging → prod (Ctrl+Alt+E)', () => call('env:switch'), { disabled: !t?.env }),
    phone,
    boost,
    icon(ICON.gear, 'Settings', () => call('cmd:run', { type: 'internal', page: 'settings' })),
  );
  if (focusFindPending && s.find) focusFindPending = !focusFind();
}

function render(): void {
  if (!state) return;
  const focused = document.hasFocus() && document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (!state.settings.sidebarCollapsed && peek !== 'off') resetPeek();
  // While peeking the sidebar draws expanded (no .collapsed) but the grid keeps the collapsed width below.
  document.body.classList.toggle('collapsed', state.settings.sidebarCollapsed && peek === 'off');
  document.body.classList.toggle('preview', ['starting', 'active', 'unavailable'].includes(state.phoneStatus));
  const phoneMessage = PHONE_LABELS[state.phoneStatus].label;
  if (phoneLabel.textContent !== phoneMessage) phoneLabel.textContent = phoneMessage;
  document.body.style.setProperty('--sb', state.settings.sidebarCollapsed ? '56px' : '264px');
  const sp: Space | undefined = state.spaces.find((x) => x.id === state!.activeSpaceId);
  document.title = `Quiver — ${sp?.name ?? ''}`;
  renderSidebar(state);
  renderToolbar(state);
  renderSplit(state.split, state.activeTabId);
  renderPeek(state.peek);
  const message = recoveryMessage(state);
  if (recoveryStatus.textContent !== message) recoveryStatus.textContent = message;
  const devMessage = state.localServerStatus?.state === 'recovered' ? 'Local server is back. Retry the failed page.' :
    state.localServerStatus?.state === 'missing' ? 'Local server unavailable.' : '';
  if (developerStatus.textContent !== devMessage) developerStatus.textContent = devMessage;
  if (focused?.dataset.focusKey && !focused.isConnected && !focusShellControl(focused.dataset.focusKey)) {
    if (!focusShellControl('tab-' + state.activeTabId)) focusShellControl('address');
  }
}

// ───────── split view ─────────
// The two panes are native views; the shell only draws in the gap between them (the divider) and in a thin strip
// above them that marks the active pane. Dragging works because the shell view keeps pointer capture while the
// button is held, even when the pointer is over a page.
const content = document.getElementById('content')!;
const splitLayer = h('div', { class: 'split-layer', hidden: true });
const leftStrip = h('div', { class: 'split-strip' });
const rightStrip = h('div', { class: 'split-strip' });
const divider = h('div', {
  class: 'split-divider', role: 'separator', tabindex: 0, 'aria-orientation': 'vertical',
  'aria-label': 'Split view divider', 'aria-valuemin': '20', 'aria-valuemax': '80',
  title: 'Drag to resize the split view · double-click to reset · Ctrl+Shift+- exits split view',
});
splitLayer.append(leftStrip, rightStrip, divider);
content.append(splitLayer);
let splitNow: SplitView | undefined;
let pendingRatio: number | null = null;

function sendRatio(ratio: number): void {
  const first = pendingRatio === null;
  pendingRatio = Math.min(0.8, Math.max(0.2, ratio));
  // One update per frame keeps the main process from re-laying out the panes for every pointer event.
  if (first) requestAnimationFrame(() => {
    const value = pendingRatio;
    pendingRatio = null;
    if (value !== null) void call('split:ratio', value);
  });
}

function ratioFor(clientX: number): number | null {
  if (!splitNow) return null;
  const usable = splitNow.area.width - splitNow.divider.width;
  if (usable <= 0) return null;
  const x = clientX - content.getBoundingClientRect().left - splitNow.area.x - splitNow.divider.width / 2;
  return x / usable;
}

divider.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  divider.setPointerCapture(e.pointerId);
  divider.classList.add('dragging');
});
divider.addEventListener('pointermove', (e) => {
  if (!divider.hasPointerCapture(e.pointerId)) return;
  const ratio = ratioFor(e.clientX);
  if (ratio !== null) sendRatio(ratio);
});
const endDrag = (e: PointerEvent) => {
  if (divider.hasPointerCapture(e.pointerId)) divider.releasePointerCapture(e.pointerId);
  divider.classList.remove('dragging');
};
divider.addEventListener('pointerup', endDrag);
divider.addEventListener('pointercancel', endDrag);
divider.addEventListener('dblclick', () => sendRatio(0.5));
divider.addEventListener('keydown', (e) => {
  if (!splitNow) return;
  const step = e.shiftKey ? 0.1 : 0.05;
  const next = e.key === 'ArrowLeft' ? splitNow.ratio - step : e.key === 'ArrowRight' ? splitNow.ratio + step :
    e.key === 'Home' ? 0.2 : e.key === 'End' ? 0.8 : null;
  if (next === null) return;
  e.preventDefault();
  sendRatio(next);
});

function place(el: HTMLElement, r: { x: number; y: number; width: number; height: number }): void {
  el.style.left = `${r.x}px`;
  el.style.top = `${r.y}px`;
  el.style.width = `${r.width}px`;
  el.style.height = `${r.height}px`;
}

function renderSplit(split: SplitView | undefined, activeTabId: number | null): void {
  splitNow = split;
  splitLayer.hidden = !split;
  if (!split) return;
  place(divider, split.divider);
  place(leftStrip, { x: split.leftPane.x, y: split.area.y, width: split.leftPane.width, height: split.leftPane.y - split.area.y });
  place(rightStrip, { x: split.rightPane.x, y: split.area.y, width: split.rightPane.width, height: split.rightPane.y - split.area.y });
  leftStrip.classList.toggle('active', activeTabId === split.left);
  rightStrip.classList.toggle('active', activeTabId === split.right);
  const percent = String(Math.round(split.ratio * 100));
  divider.setAttribute('aria-valuenow', percent);
  divider.setAttribute('aria-valuetext', `Left pane ${percent}%`);
}

// ───────── Peek ─────────
// While a Peek is open the main process hides the page and sends a still image of it, so the shell can dim it and
// draw the Peek's header bar (the live Peek page sits just below the header).
const peekLayer = h('div', { class: 'peek-layer', hidden: true, onClick: (e: MouseEvent) => { if (e.target === peekLayer || (e.target as HTMLElement).closest('.peek-backdrop')) void call('peek:close'); } });
const peekBackdrop = h('div', { class: 'peek-backdrop' });
const peekHost = h('span', { class: 'peek-host' });
const peekHeader = h('div', { class: 'peek-header', role: 'toolbar', 'aria-label': 'Peek' },
  peekHost,
  h('button', { class: 'peek-btn', title: 'Keep this page as a tab', onClick: () => call('peek:open-tab') }, 'Open as tab'),
  h('button', { class: 'peek-btn', title: 'Close the Peek (Esc)', 'aria-label': 'Close Peek (Esc)', onClick: () => call('peek:close') }, 'Close'),
);
peekLayer.append(peekBackdrop, peekHeader);
content.append(peekLayer);

function renderPeek(peek: PeekView | undefined): void {
  peekLayer.hidden = !peek;
  if (!peek) {
    peekBackdrop.replaceChildren();
    return;
  }
  place(peekHeader, peek.header);
  peekHost.textContent = peek.host || peek.url;
  peekHost.title = peek.url;
}

quiver.on('peek:backdrop', (images: unknown) => {
  const list = Array.isArray(images) ? images : [];
  peekBackdrop.replaceChildren(...list.filter((i) => typeof i?.src === 'string' && i.src.startsWith('data:image/') && i.rect).map((i) => {
    const img = h('img', { src: i.src, alt: '' });
    place(img, i.rect);
    return img;
  }));
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state?.peek && !e.defaultPrevented) {
    e.preventDefault();
    void call('peek:close');
  }
});
// ───────── sidebar peek ─────────
// Hovering the collapsed sidebar opens it over the page (main raises the shell view above the tab views) and it
// closes again shortly after the pointer leaves. The delays stop it flickering open when the pointer only crosses
// the window's left edge, and closed when the pointer briefly overshoots the sidebar's edge.
const PEEK_OPEN_MS = 150;
const PEEK_CLOSE_MS = 300;
let peek: 'off' | 'opening' | 'on' = 'off';
let peekOpenTimer: number | undefined;
let peekCloseTimer: number | undefined;

function clearPeekTimers(): void {
  clearTimeout(peekOpenTimer);
  clearTimeout(peekCloseTimer);
  peekOpenTimer = peekCloseTimer = undefined;
}

function resetPeek(): void {
  clearPeekTimers();
  peek = 'off';
  document.body.classList.remove('peek');
}

function startPeek(): void {
  if (!state?.settings.sidebarCollapsed || peek !== 'off') return;
  peek = 'opening';
  document.body.classList.add('peek');
  render();
  // Paint the transparent content area before main raises the shell, so the page never blinks out.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (peek !== 'opening') return;
    peek = 'on';
    void call('sidebar:peek', true);
  }));
}

async function endPeek(): Promise<void> {
  clearPeekTimers();
  if (peek === 'off') return;
  const wasRaised = peek === 'on';
  peek = 'off';
  // Lower the shell first, then collapse: the page covers the content area again before it repaints.
  if (wasRaised) await call('sidebar:peek', false);
  if (peek === 'off') {
    document.body.classList.remove('peek');
    render();
  }
}

function scheduleEndPeek(): void {
  if (peek === 'off' || peekCloseTimer !== undefined) return;
  // Keep it open while someone is typing in a sidebar editor (renaming a Space or folder).
  if (document.activeElement instanceof HTMLInputElement && sidebar.contains(document.activeElement)) return;
  peekCloseTimer = window.setTimeout(() => void endPeek(), PEEK_CLOSE_MS);
}

sidebar.addEventListener('pointerenter', () => {
  clearTimeout(peekCloseTimer);
  peekCloseTimer = undefined;
  if (peek === 'off' && state?.settings.sidebarCollapsed && peekOpenTimer === undefined) {
    peekOpenTimer = window.setTimeout(() => { peekOpenTimer = undefined; startPeek(); }, PEEK_OPEN_MS);
  }
});
sidebar.addEventListener('pointerleave', () => {
  clearTimeout(peekOpenTimer);
  peekOpenTimer = undefined;
  scheduleEndPeek();
});
// While raised the shell covers the whole window, so pointer movement over the page area arrives here too.
document.addEventListener('pointermove', (e) => {
  if (peek === 'off') return;
  if (e.target instanceof Node && sidebar.contains(e.target)) {
    clearTimeout(peekCloseTimer);
    peekCloseTimer = undefined;
  } else scheduleEndPeek();
});
document.documentElement.addEventListener('pointerleave', scheduleEndPeek);
// A click on the page area closes at once instead of being swallowed by the transparent shell for 300 ms.
document.addEventListener('pointerdown', (e) => {
  if (peek !== 'off' && !(e.target instanceof Node && sidebar.contains(e.target))) void endPeek();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && peek !== 'off') void endPeek();
});

quiver.on('state', (s: ShellState) => {
  // Don't clobber an inline editor the user is typing in.
  const typing = document.activeElement instanceof HTMLInputElement && sidebar.contains(document.activeElement);
  state = s;
  if (!typing) render();
  else renderToolbar(s);
});
quiver.on('folder:rename-start', (id: string) => {
  renamingFolder = id;
  render();
  const index = tabList?.rows.findIndex((r) => r.kind === 'folder' && r.id === id) ?? -1;
  if (index >= 0) revealRow(index);
  paintTabs();
  focusShellControl('rename-folder:' + id);
});
let focusFindPending = false;
function focusFind(): boolean {
  const input = toolbar.querySelector<HTMLInputElement>('.find-bar input');
  if (!input) return false;
  input.focus();
  input.select();
  return true;
}
// The bar may not exist yet: the state that opens it can arrive just after this message.
quiver.on('find:focus', () => {
  focusFindPending = !focusFind();
});
quiver.on('space:rename-start', (id: string) => {
  renamingSpace = id;
  render();
});
quiver.invoke('state:get').then((s: ShellState) => {
  state = s;
  render();
});
