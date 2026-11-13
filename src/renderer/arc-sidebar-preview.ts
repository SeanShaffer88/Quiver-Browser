import { ARC_SIDEBAR_MAX_BYTES, parseArcSidebar } from './arc-sidebar.js';
import type { ArcNode, ArcSidebarPreview } from './arc-sidebar.js';

function quantity(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function nodeList(nodes: ArcNode[]): HTMLUListElement {
  const list = document.createElement('ul');
  for (const node of nodes) {
    const item = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = node.title;
    item.append(label);
    if (node.kind === 'tab') {
      if (node.host !== node.title) {
        const host = document.createElement('span');
        host.className = 'note';
        host.textContent = ` · ${node.host}`;
        item.append(host);
      }
    } else {
      item.append(nodeList(node.children));
    }
    list.append(item);
  }
  return list;
}

function group(label: string, nodes: ArcNode[], empty: string): HTMLDetailsElement {
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = label;
  details.append(summary);
  if (nodes.length) details.append(nodeList(nodes));
  else {
    const note = document.createElement('p');
    note.className = 'note';
    note.textContent = empty;
    details.append(note);
  }
  return details;
}

export function setupArcSidebarPreview(): void {
  const choose = document.querySelector<HTMLButtonElement>('#arc-sidebar-choose')!;
  const picker = document.querySelector<HTMLInputElement>('#arc-sidebar-file')!;
  const clear = document.querySelector<HTMLButtonElement>('#arc-sidebar-clear')!;
  const status = document.querySelector<HTMLParagraphElement>('#arc-sidebar-status')!;
  const review = document.querySelector<HTMLElement>('#arc-sidebar-review')!;
  const heading = document.querySelector<HTMLElement>('#arc-sidebar-heading')!;
  const content = document.querySelector<HTMLElement>('#arc-sidebar-content')!;
  let generation = 0;

  function reset(): void {
    generation++;
    clear.hidden = true;
    status.textContent = '';
    status.className = 'status';
    content.replaceChildren();
    review.hidden = true;
  }

  function render(preview: ArcSidebarPreview): void {
    const pins = preview.spaces.reduce((total, space) => total + space.pinnedTabs, 0);
    const favorites = preview.profiles.reduce((total, profile) => total + profile.favoriteTabs, 0);
    const counts = document.createElement('p');
    counts.textContent = [
      quantity(preview.spaces.length, 'Space'),
      quantity(preview.profiles.length, 'Arc profile'),
      quantity(favorites, 'Favorite'),
      quantity(pins, 'pinned tab'),
    ].join(' · ');
    content.append(counts);
    if (preview.limited || preview.skipped) {
      const note = document.createElement('p');
      note.className = 'note';
      note.textContent = [
        preview.limited ? 'Preview limit reached. Counts cover the entries reviewed.' : '',
        preview.skipped ? `Skipped ${quantity(preview.skipped, 'duplicate, unsupported, or broken entry', 'duplicate, unsupported, or broken entries')}.` : '',
      ].filter(Boolean).join(' ');
      content.append(note);
    }
    for (const space of preview.spaces) {
      const label = `${space.title} · ${preview.profiles[space.profile].label} · ${quantity(space.pinnedTabs, 'pinned tab')} · ${quantity(space.todayTabs, 'Today tab')}`;
      const details = group(label, space.pinned, 'No pinned entries to preview.');
      content.append(details);
    }
    for (const profile of preview.profiles) {
      if (!profile.favoriteTabs) continue;
      content.append(group(`Favorites · ${profile.label} · ${quantity(profile.favoriteTabs, 'tab')}`, profile.favorites, 'No Favorites to preview.'));
    }
    review.hidden = false;
  }

  choose.addEventListener('click', () => picker.click());
  clear.addEventListener('click', () => {
    reset();
    choose.focus();
    status.textContent = 'Arc sidebar preview cleared.';
  });
  picker.addEventListener('change', async () => {
    const file = picker.files?.[0];
    picker.value = '';
    reset();
    if (!file) return;
    const request = generation;
    clear.hidden = false;
    status.textContent = 'Reading the Arc sidebar file…';
    const result = file.size > ARC_SIDEBAR_MAX_BYTES
      ? 'too-large'
      : await file.text().then((text) => request === generation ? parseArcSidebar(text) : undefined)
        .catch(() => 'unreadable' as const);
    if (request !== generation || !result) return;
    if (typeof result === 'string') {
      const messages = {
        'too-large': 'Choose an Arc sidebar file no larger than 16 MiB.',
        'invalid-json': 'This file contains invalid JSON. Choose a copy of StorableSidebar.json.',
        'unrecognized-sidebar': 'Quiver could not recognize this Arc sidebar. Choose a copy of StorableSidebar.json.',
        unreadable: 'Quiver could not read the Arc sidebar file. Try another copy.',
      };
      status.textContent = messages[result];
      status.className = 'status err';
      return;
    }
    render(result);
    status.textContent = 'Arc sidebar preview ready.';
    if (document.hasFocus() && (document.activeElement === choose || document.activeElement === document.body)) heading.focus();
  });
}
