interface TopicItem { kind: 'search' | 'page'; url: string; title: string; at: number; note?: string }
interface Topic { id: string; name: string; spaceId: string; createdAt: number; updatedAt: number; notes: string; items: TopicItem[] }
interface TopicSummary { id: string; name: string; spaceId: string; spaceName: string; count: number; updatedAt: number; active: boolean }

const topicsEl = document.getElementById('topics')!;
const main = document.getElementById('topic')!;
let selected = new URLSearchParams(location.search).get('topic') ?? '';
let editing = false;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = String(v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k in node) (node as any)[k] = v;
    else node.setAttribute(k, String(v));
  }
  node.append(...kids);
  return node;
}

function when(at: number): string {
  return at ? new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
}

/** Save a textarea's value after typing pauses and when it loses focus. */
function autosave(area: HTMLTextAreaElement, save: (value: string) => Promise<unknown>): void {
  let timer: number | undefined;
  let saved = area.value;
  const flush = () => {
    clearTimeout(timer);
    if (area.value === saved) return;
    saved = area.value;
    void save(saved);
  };
  area.addEventListener('focus', () => { editing = true; });
  area.addEventListener('input', () => { clearTimeout(timer); timer = window.setTimeout(flush, 600); });
  area.addEventListener('blur', () => { editing = false; flush(); });
}

async function refresh(): Promise<void> {
  if (editing) return;
  const list = (await quiver.invoke('research:list')) as TopicSummary[];
  if (!list.some((t) => t.id === selected)) selected = list[0]?.id ?? '';
  topicsEl.replaceChildren(...list.map((t) => el('button', {
    class: 'bfile' + (t.id === selected ? ' sel' : ''), role: 'option', 'aria-selected': String(t.id === selected),
    title: `${t.name}\n${t.spaceName} · ${t.count} items · updated ${when(t.updatedAt)}`,
    onClick: () => { selected = t.id; history.replaceState(null, '', `?topic=${encodeURIComponent(t.id)}`); void refresh(); },
  }, el('span', {}, (t.active ? '● ' : '') + t.name), el('span', { class: 'k' }, `${t.count} · ${t.spaceName}`))));
  if (!list.length) topicsEl.replaceChildren(el('p', { class: 'note' }, 'No topics yet.'));
  await renderTopic(list.find((t) => t.id === selected));
}

async function renderTopic(summary: TopicSummary | undefined): Promise<void> {
  const topic = summary && ((await quiver.invoke('research:get', summary.id)) as Topic | null);
  if (!summary || !topic) {
    main.replaceChildren(el('p', { class: 'note' }, 'No topic selected.'));
    return;
  }
  const status = el('span', { class: 'status', role: 'status' });
  const name = el('input', { type: 'text', value: topic.name, maxLength: 80, 'aria-label': 'Topic name', class: 'name-input' });
  name.addEventListener('change', () => void quiver.invoke('research:rename', topic.id, name.value));
  const recording = summary.active
    ? el('button', { class: 'btn', onClick: () => quiver.invoke('research:stop', topic.id) }, 'Stop recording')
    : el('button', { class: 'btn primary', onClick: () => quiver.invoke('research:resume', topic.id), title: 'Record new searches and pages in ' + summary.spaceName }, 'Continue recording');
  const copy = el('button', {
    class: 'btn', onClick: async () => { status.textContent = (await quiver.invoke('research:export', topic.id)) ? 'Copied as Markdown.' : 'Could not copy.'; },
  }, 'Copy as Markdown');
  const remove = el('button', {
    class: 'btn danger', onClick: () => { if (confirm(`Delete “${topic.name}” and its notes?`)) void quiver.invoke('research:delete', topic.id); },
  }, 'Delete topic');
  const notes = el('textarea', { value: topic.notes, rows: 6, 'aria-label': 'Topic notes', placeholder: 'Notes for this topic…', class: 'topic-notes' });
  autosave(notes, (v) => quiver.invoke('research:notes', topic.id, v));

  const trail = el('ol', { class: 'trail', 'aria-label': 'Trail' });
  for (const item of [...topic.items].reverse()) {
    const open = el('button', { class: 'link', title: item.url, onClick: () => quiver.invoke('research:open', topic.id, item.url) }, item.title);
    const host = URL.parse(item.url)?.host ?? '';
    const note = el('textarea', { value: item.note ?? '', rows: item.note ? 2 : 1, placeholder: 'Add a note…', 'aria-label': 'Note for ' + item.title, class: 'item-note' });
    autosave(note, (v) => quiver.invoke('research:item-note', topic.id, item.kind, item.url, v));
    const drop = el('button', { class: 'icon-btn', 'aria-label': 'Remove ' + item.title, title: 'Remove from trail', onClick: () => quiver.invoke('research:item-remove', topic.id, item.kind, item.url) }, '×');
    trail.append(el('li', { class: 'trail-item ' + item.kind },
      el('div', { class: 'trail-head' }, el('span', { class: 'k' }, item.kind === 'search' ? 'search' : 'page'), open, drop),
      el('div', { class: 'note' }, [host, when(item.at)].filter(Boolean).join(' · ')),
      note));
  }
  main.replaceChildren(
    el('div', { class: 'toolbar' }, name, recording, copy, remove),
    el('p', { class: 'note' }, `${summary.spaceName} · ${topic.items.length} items · ${summary.active ? 'recording searches and pages' : 'not recording'}`), status,
    notes,
    el('h2', {}, 'Trail'),
    topic.items.length ? trail : el('p', { class: 'note' }, 'Searches from the command bar and pages you visit in this Space will appear here while the topic records.'),
  );
}

quiver.on('research:changed', () => void refresh());
window.addEventListener('focus', () => void refresh());
void refresh();
