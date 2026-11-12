import type { ShellState, TabInfo, Space } from '../shared/types';

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
let state: ShellState | null = null;
let addingSpace = false;
let renamingSpace: string | null = null;

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
  const b = h('button', { class: 'icon-btn' + (extra.on ? ' on' : ''), title: label, 'aria-label': label, disabled: extra.disabled, onClick });
  b.innerHTML = svg;
  return b;
}

const call = (ch: string, ...a: unknown[]) => quiver.invoke(ch, ...a).catch((e: Error) => console.error(ch, e.message));

function renderSpaces(s: ShellState): HTMLElement {
  const wrap = h('div', { class: 'spaces', role: 'tablist', 'aria-label': 'Spaces' });
  for (const sp of s.spaces) {
    if (renamingSpace === sp.id) {
      const input = h('input', { class: 'space-edit', value: sp.name, 'aria-label': 'Rename space', maxLength: 40 });
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
    }),
  );
  return wrap;
}

function renderAddForm(): HTMLElement {
  const name = h('input', { placeholder: 'Space name', 'aria-label': 'Space name', maxLength: 40 });
  const iso = h('input', { type: 'checkbox', checked: true, id: 'iso' });
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
  queueMicrotask(() => name.focus());
  return h(
    'div',
    { class: 'add-space-form' },
    name,
    h('label', { title: 'Own cookie jar, logins and storage, separate from other Spaces' }, iso, 'Separate cookies & logins'),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', onClick: submit }, 'Create'), h('button', { class: 'btn', onClick: () => { addingSpace = false; render(); } }, 'Cancel')),
  );
}

function renderTab(t: TabInfo, active: boolean): HTMLElement {
  const fav = t.favicon ? h('img', { class: 'fav', src: t.favicon, alt: '' }) : h('span', { class: 'fav' });
  const kids: Child[] = [fav, h('span', { class: 'title' }, t.title)];
  if (t.env) kids.push(h('span', { class: `pill ${t.env}`, title: `Environment: ${t.env}` }, t.env === 'STAGING' ? 'STG' : t.env));
  if (t.local && t.errors > 0) kids.push(h('span', { class: 'err', title: `${t.errors} console error(s) since last navigation` }, String(t.errors > 99 ? '99+' : t.errors)));
  kids.push(h('button', { class: 'close', title: 'Close tab (Ctrl+W)', 'aria-label': 'Close tab', onClick: (e: Event) => { e.stopPropagation(); void call('tab:close', t.id); } }, '×'));
  return h(
    'div',
    {
      class: 'tab' + (active ? ' active' : '') + (t.loading ? ' loading' : ''),
      role: 'tab',
      tabIndex: 0,
      'aria-selected': String(active),
      title: `${t.title}\n${t.url}`,
      onClick: () => call('tab:activate', t.id),
      onKeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') void call('tab:activate', t.id);
      },
      onAuxclick: (e: MouseEvent) => {
        if (e.button === 1) void call('tab:close', t.id);
      },
    },
    ...kids,
  );
}

function renderSidebar(s: ShellState): void {
  const spaceTabs = s.tabs.filter((t) => t.spaceId === s.activeSpaceId);
  const brand = h('div', { class: 'brand' });
  const logo = h('img', { src: 'quiver-icon.png', width: 22, height: 22, alt: '' });
  brand.append(logo, h('span', { class: 'name' }, 'Quiver'), icon(ICON.sidebar, 'Collapse / expand sidebar (Ctrl+B)', () => call('sidebar:toggle')));

  const newtab = h('button', { class: 'newtab', title: 'Open the command bar in a new tab (Ctrl+T)', onClick: () => call('cmd:open', '', 'new') }, h('span', {}, '＋ New tab'), h('kbd', {}, 'Ctrl+T'));

  const tabsEl = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Tabs' }, ...spaceTabs.map((t) => renderTab(t, t.id === s.activeTabId)));

  const servers = h('section', { class: 'servers', 'aria-label': 'Local servers' }, h('h3', {}, h('span', {}, 'Local servers'), h('button', { class: 'icon-btn', style: undefined, title: 'Rescan now', 'aria-label': 'Rescan local servers', onClick: () => call('devserver:refresh') }, '↻')));
  if (!s.settings.devServerScan) servers.append(h('div', { class: 'empty' }, 'Scanning is off (Settings).'));
  else if (s.devServers.length === 0) servers.append(h('div', { class: 'empty' }, 'No HTTP servers found on localhost.'));
  for (const d of s.devServers) {
    servers.append(
      h('button', { class: 'server', title: `${d.title}\n${d.url}`, onClick: () => call('devserver:open', d.url) }, h('span', { class: 'port' }, `:${d.port}`), h('span', { class: 'stitle' }, d.title)),
    );
  }

  sidebar.replaceChildren(brand, renderSpaces(s), ...(addingSpace ? [renderAddForm()] : []), newtab, tabsEl, servers);
}

function activeTab(s: ShellState): TabInfo | undefined {
  return s.tabs.find((t) => t.id === s.activeTabId);
}

function renderToolbar(s: ShellState): void {
  const t = activeTab(s);
  const addr = h('button', { id: 'address', title: 'Search or enter a command (Ctrl+K / Ctrl+L)', 'aria-label': 'Address and command bar', onClick: () => call('cmd:open', undefined, 'current') });
  if (t?.env) addr.append(h('span', { class: `pill ${t.env}`, title: `Environment: ${t.env}` }, t.env));
  addr.append(h('span', { class: 'url' + (t?.url ? '' : ' placeholder') }, t?.url || 'Search, paste a URL, JWT, or type gh / npm / mdn / env / boost…'), h('span', { class: 'hint' }, 'Ctrl+K'));
  toolbar.replaceChildren(
    icon(ICON.back, 'Back (Alt+←)', () => call('tab:back'), { disabled: !t?.canGoBack }),
    icon(ICON.forward, 'Forward (Alt+→)', () => call('tab:forward'), { disabled: !t?.canGoForward }),
    icon(ICON.reload, 'Reload (Ctrl+R)', () => call('tab:reload')),
    addr,
    icon(ICON.env, 'Switch environment: local → staging → prod (Ctrl+Alt+E)', () => call('env:switch'), { disabled: !t?.env }),
    icon(ICON.phone, 'Toggle phone preview, 393 px with touch and mobile UA (Ctrl+Shift+P)', () => call('preview:toggle'), { on: s.preview }),
    icon(ICON.boost, 'Boosts: site CSS / TypeScript (Ctrl+Shift+B)', () => call('cmd:run', { type: 'internal', page: 'boosts' }, 'current')),
    icon(ICON.gear, 'Settings', () => call('cmd:run', { type: 'internal', page: 'settings' }, 'current')),
  );
}

function render(): void {
  if (!state) return;
  document.body.classList.toggle('collapsed', state.settings.sidebarCollapsed);
  document.body.classList.toggle('preview', state.preview);
  document.body.style.setProperty('--sb', state.settings.sidebarCollapsed ? '56px' : '264px');
  const sp: Space | undefined = state.spaces.find((x) => x.id === state!.activeSpaceId);
  document.title = `Quiver — ${sp?.name ?? ''}`;
  renderSidebar(state);
  renderToolbar(state);
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
