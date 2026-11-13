import type { LocalServerStatus, PhoneStatus, ShellState, TabInfo, Space } from '../shared/types';
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

let draggingTab: { id: number; from: number } | null = null;

function clearDropMarks(): void {
  for (const el of sidebar.querySelectorAll('.drop-before, .drop-after')) el.classList.remove('drop-before', 'drop-after');
}

/** Final index for a tab dropped before or after the tab at `over`, once the moving tab leaves its slot. */
function dropIndex(from: number, over: number, after: boolean): number {
  if (from < over) return after ? over : over - 1;
  return after ? over + 1 : over;
}

// The tab list is windowed: only rows near the viewport (plus the active, focused and dragged rows) are in the DOM,
// so Spaces with hundreds of tabs stay cheap to re-render on every state update and to scroll.
const TAB_ROW_H = 32;
const TAB_OVERSCAN = 8;
let tabList: { scroller: HTMLElement; inner: HTMLElement; tabs: TabInfo[]; activeId: number | null } | null = null;
let revealedTab = '';
let paintQueued = false;

function focusedTabId(): number | undefined {
  const m = lastShellFocus?.match(/^(?:close-)?tab-(\d+)$/);
  return m ? Number(m[1]) : undefined;
}

function paintTabs(): void {
  if (!tabList) return;
  const { scroller, inner, tabs, activeId } = tabList;
  const indexOf = (id: number | null | undefined) => (id == null ? -1 : tabs.findIndex((t) => t.id === id));
  const rows = visibleRows({
    count: tabs.length, rowHeight: TAB_ROW_H, scrollTop: scroller.scrollTop, viewport: scroller.clientHeight || window.innerHeight,
    overscan: TAB_OVERSCAN, keep: [indexOf(activeId), indexOf(focusedTabId()), draggingTab?.from ?? -1],
  });
  const existing = new Map<string, HTMLElement>();
  for (const el of [...inner.children] as HTMLElement[]) existing.set(el.dataset.tabId ?? '', el);
  const wanted = new Set(rows.map((i) => String(tabs[i].id)));
  for (const [id, el] of existing) if (!wanted.has(id)) el.remove();
  // Kept rows never move in the DOM (moving a node would drop its focus); new rows are inserted around them.
  let previous: HTMLElement | null = null;
  for (const i of rows) {
    const t = tabs[i];
    let el = existing.get(String(t.id));
    if (!el || !el.isConnected) {
      el = renderTab(t, t.id === activeId, i, tabs.length);
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

function revealTab(index: number): void {
  if (!tabList) return;
  const { scroller } = tabList;
  const top = scrollToReveal(index, TAB_ROW_H, scroller.scrollTop, scroller.clientHeight);
  if (top !== scroller.scrollTop) scroller.scrollTop = top;
}

function moveTabFocus(e: KeyboardEvent, index: number): void {
  if (!tabList || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const last = tabList.tabs.length - 1;
  const next = e.key === 'ArrowDown' ? Math.min(index + 1, last) : e.key === 'ArrowUp' ? Math.max(index - 1, 0)
    : e.key === 'Home' ? 0 : e.key === 'End' ? last : -1;
  if (next < 0) return;
  e.preventDefault();
  revealTab(next);
  lastShellFocus = 'tab-' + tabList.tabs[next].id;
  paintTabs();
  focusShellControl(lastShellFocus);
}

function renderTab(t: TabInfo, active: boolean, index: number, total: number): HTMLElement {
  const fav = t.favicon ? h('img', { class: 'fav', src: t.favicon, alt: '' }) : h('span', { class: 'fav' });
  const kids: Child[] = [fav, h('span', { class: 'title' }, t.title)];
  if (t.env) kids.push(h('span', { class: `pill ${t.env}`, title: `Environment: ${t.env}` }, t.env === 'STAGING' ? 'STG' : t.env));
  if (t.local && t.errors > 0) kids.push(h('span', { class: 'err', title: `${t.errors} console error(s) since last navigation` }, String(t.errors > 99 ? '99+' : t.errors)));
  const select = h('button', {
    class: 'tab-select',
    role: 'tab',
    'aria-label': t.title,
    'aria-selected': String(active),
    'aria-setsize': String(total),
    'aria-posinset': String(index + 1),
    dataset: { focusKey: 'tab-' + t.id },
    onKeydown: (e: KeyboardEvent) => moveTabFocus(e, index),
    title: t.title + '\n' + t.url + '\nDrag or press Ctrl+Shift+PageUp/PageDown to move',
    onClick: () => call('tab:activate', t.id),
  }, ...kids);
  const close = h('button', {
    class: 'close',
    title: 'Close tab (Ctrl+W)',
    'aria-label': 'Close ' + t.title,
    dataset: { focusKey: 'close-tab-' + t.id },
    onClick: () => call('tab:close', t.id),
  }, '×');
  const lowerHalf = (e: DragEvent) => {
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return e.clientY > box.top + box.height / 2;
  };
  return h('div', {
    class: 'tab' + (active ? ' active' : '') + (t.loading ? ' loading' : ''),
    dataset: { tabId: String(t.id) },
    draggable: true,
    onAuxclick: (e: MouseEvent) => {
      if (e.button === 1) void call('tab:close', t.id);
    },
    onDragstart: (e: DragEvent) => {
      draggingTab = { id: t.id, from: index };
      e.dataTransfer?.setData('application/x-quiver-tab', String(t.id));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    },
    onDragover: (e: DragEvent) => {
      if (!draggingTab) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      clearDropMarks();
      if (draggingTab.id !== t.id) (e.currentTarget as HTMLElement).classList.add(lowerHalf(e) ? 'drop-after' : 'drop-before');
    },
    onDragleave: (e: DragEvent) => (e.currentTarget as HTMLElement).classList.remove('drop-before', 'drop-after'),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      clearDropMarks();
      const drag = draggingTab;
      draggingTab = null;
      if (drag && drag.id !== t.id) void call('tab:move', drag.id, dropIndex(drag.from, index, lowerHalf(e)));
    },
    onDragend: () => {
      draggingTab = null;
      clearDropMarks();
    },
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

function renderSidebar(s: ShellState): void {
  const spaceTabs = s.tabs.filter((t) => t.spaceId === s.activeSpaceId);
  const brand = h('div', { class: 'brand' });
  const logo = h('img', { src: 'quiver-icon.png', width: 22, height: 22, alt: '' });
  brand.append(logo, h('span', { class: 'name' }, 'Quiver'), icon(ICON.sidebar, 'Collapse / expand sidebar (Ctrl+B)', () => call('sidebar:toggle')));

  const newtab = h('button', { class: 'newtab', title: 'Open the command bar in a new tab (Ctrl+T)', dataset: { focusKey: 'new-tab' }, onClick: () => call('cmd:open', '', 'new', 'new-tab') }, h('span', {}, '＋ New tab'), h('kbd', {}, 'Ctrl+T'));

  const previousTabs = sidebar.querySelector<HTMLElement>('.tabs');
  const previousScroll = previousTabs?.dataset.spaceId === s.activeSpaceId ? previousTabs.scrollTop : 0;
  const inner = h('div', { class: 'tabs-window' });
  inner.style.height = spaceTabs.length * TAB_ROW_H + 'px';
  const tabsEl = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Tabs', dataset: { spaceId: s.activeSpaceId }, onScroll: queuePaintTabs }, inner);

  const servers = h('section', { class: 'servers', 'aria-label': 'Local servers' }, h('h3', {}, h('span', {}, 'Local servers'), h('button', { class: 'icon-btn', disabled: !s.settings.devServerScan, title: 'Rescan now', 'aria-label': 'Rescan local servers', dataset: { focusKey: 'rescan' }, onClick: () => call('devserver:refresh') }, '↻')));
  if (!s.settings.devServerScan) servers.append(h('div', { class: 'empty' }, 'Scanning is off (Settings).'));
  else if (s.devServers.length === 0) servers.append(h('div', { class: 'empty' }, 'No HTTP servers found on localhost.'));
  for (const d of s.devServers) {
    servers.append(
      h('button', { class: 'server', title: `${d.title}\n${d.url}`, dataset: { focusKey: d.url }, onClick: () => call('devserver:open', d.url) }, h('span', { class: 'port' }, `:${d.port}`), h('span', { class: 'stitle' }, d.title)),
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
  tabList = { scroller: tabsEl, inner, tabs: spaceTabs, activeId: s.activeTabId };
  const reveal = s.activeSpaceId + ':' + s.activeTabId;
  if (reveal !== revealedTab) {
    revealedTab = reveal;
    const index = spaceTabs.findIndex((t) => t.id === s.activeTabId);
    if (index >= 0) revealTab(index);
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

function renderToolbar(s: ShellState): void {
  const t = activeTab(s);
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
  toolbar.replaceChildren(
    icon(ICON.back, 'Back (Alt+←)', () => call('tab:back'), { disabled: !t?.canGoBack }),
    icon(ICON.forward, 'Forward (Alt+→)', () => call('tab:forward'), { disabled: !t?.canGoForward }),
    icon(ICON.reload, 'Reload (Ctrl+R)', () => call('tab:reload')),
    addr,
    ...(research ? [research] : []),
    icon(ICON.env, 'Switch environment: local → staging → prod (Ctrl+Alt+E)', () => call('env:switch'), { disabled: !t?.env }),
    phone,
    boost,
    icon(ICON.gear, 'Settings', () => call('cmd:run', { type: 'internal', page: 'settings' })),
  );
}

function render(): void {
  if (!state) return;
  const focused = document.hasFocus() && document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.body.classList.toggle('collapsed', state.settings.sidebarCollapsed);
  document.body.classList.toggle('preview', ['starting', 'active', 'unavailable'].includes(state.phoneStatus));
  const phoneMessage = PHONE_LABELS[state.phoneStatus].label;
  if (phoneLabel.textContent !== phoneMessage) phoneLabel.textContent = phoneMessage;
  document.body.style.setProperty('--sb', state.settings.sidebarCollapsed ? '56px' : '264px');
  const sp: Space | undefined = state.spaces.find((x) => x.id === state!.activeSpaceId);
  document.title = `Quiver — ${sp?.name ?? ''}`;
  renderSidebar(state);
  renderToolbar(state);
  const message = recoveryMessage(state);
  if (recoveryStatus.textContent !== message) recoveryStatus.textContent = message;
  const devMessage = state.localServerStatus?.state === 'recovered' ? 'Local server is back. Retry the failed page.' :
    state.localServerStatus?.state === 'missing' ? 'Local server unavailable.' : '';
  if (developerStatus.textContent !== devMessage) developerStatus.textContent = devMessage;
  if (focused?.dataset.focusKey && !focused.isConnected && !focusShellControl(focused.dataset.focusKey)) {
    if (!focusShellControl('tab-' + state.activeTabId)) focusShellControl('address');
  }
}

quiver.on('state', (s: ShellState) => {
  // Don't clobber an inline editor the user is typing in.
  const typing = document.activeElement instanceof HTMLInputElement && sidebar.contains(document.activeElement);
  state = s;
  if (!typing) render();
  else renderToolbar(s);
});
quiver.on('space:rename-start', (id: string) => {
  renamingSpace = id;
  render();
});
quiver.invoke('state:get').then((s: ShellState) => {
  state = s;
  render();
});
