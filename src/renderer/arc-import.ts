import type { ArcImportCounts, ArcImportStatus, ArcNode, ArcReview } from '../shared/types';

// Matches the main process limit, so an oversized file is refused before it is read.
const ARC_SIDEBAR_MAX_BYTES = 16 * 1024 * 1024;

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

export function setupArcImport(): void {
  const detected = document.querySelector<HTMLButtonElement>('#arc-sidebar-detected')!;
  const choose = document.querySelector<HTMLButtonElement>('#arc-sidebar-choose')!;
  const picker = document.querySelector<HTMLInputElement>('#arc-sidebar-file')!;
  const clear = document.querySelector<HTMLButtonElement>('#arc-sidebar-clear')!;
  const undoButton = document.querySelector<HTMLButtonElement>('#arc-sidebar-undo')!;
  const importButton = document.querySelector<HTMLButtonElement>('#arc-sidebar-import')!;
  const status = document.querySelector<HTMLParagraphElement>('#arc-sidebar-status')!;
  const review = document.querySelector<HTMLElement>('#arc-sidebar-review')!;
  const heading = document.querySelector<HTMLElement>('#arc-sidebar-heading')!;
  const summary = document.querySelector<HTMLElement>('#arc-sidebar-summary')!;
  const content = document.querySelector<HTMLElement>('#arc-sidebar-content')!;
  // Each review or import bumps the generation so a slow answer for an earlier request is ignored.
  let generation = 0;
  let reviewId: number | undefined;
  let undoId: number | undefined;

  function say(message: string, failed = false): void {
    status.textContent = message;
    status.className = failed ? 'status err' : 'status';
  }

  function reset(): void {
    generation++;
    if (reviewId !== undefined) void quiver.invoke('arc:cancel-review');
    reviewId = undefined;
    clear.hidden = true;
    say('');
    summary.textContent = '';
    content.replaceChildren();
    review.hidden = true;
  }

  function countsText(counts: ArcImportCounts): string {
    const spaces = counts.mergedSpaces
      ? `${quantity(counts.spaces, 'Space')} (${counts.newSpaces} new, ${counts.mergedSpaces} merged)`
      : quantity(counts.spaces, 'Space');
    return [spaces, quantity(counts.pinned, 'pinned tab'), quantity(counts.folders, 'folder'), quantity(counts.favorites, 'Favorite')].join(' · ');
  }

  function render(result: ArcReview): void {
    const { preview, counts } = result;
    summary.textContent = `Import ${countsText(counts)}.`;
    const skipped = [
      counts.duplicates ? `${quantity(counts.duplicates, 'tab')} already in Quiver will be skipped.` : '',
      counts.dropped ? `${quantity(counts.dropped, 'entry', 'entries')} cannot be imported (unsupported address or Quiver’s limits).` : '',
      preview.limited ? 'Arc sidebar limit reached. Counts cover the entries reviewed.' : '',
      preview.skipped ? `Skipped ${quantity(preview.skipped, 'duplicate, unsupported, or broken entry', 'duplicate, unsupported, or broken entries')}.` : '',
    ].filter(Boolean).join(' ');
    if (skipped) {
      const note = document.createElement('p');
      note.className = 'note';
      note.textContent = skipped;
      content.append(note);
    }
    for (const space of preview.spaces) {
      const label = `${space.title} · ${preview.profiles[space.profile].label} · ${quantity(space.pinnedTabs, 'pinned tab')} · ${quantity(space.todayTabs, 'Today tab')} (not imported)`;
      content.append(group(label, space.pinned, 'No pinned entries.'));
    }
    for (const profile of preview.profiles) {
      if (!profile.favoriteTabs) continue;
      content.append(group(`Favorites · ${profile.label} · ${quantity(profile.favoriteTabs, 'tab')}`, profile.favorites, 'No Favorites.'));
    }
    importButton.disabled = counts.pinned + counts.favorites + counts.folders + counts.newSpaces === 0;
    review.hidden = false;
  }

  function showUndo(id: number | undefined): void {
    undoId = id;
    undoButton.hidden = undoId === undefined;
  }

  async function runReview(load: () => Promise<ArcReview | { error: string }>, focusReview: boolean): Promise<void> {
    reset();
    const request = generation;
    clear.hidden = false;
    say('Reading the Arc sidebar…');
    const result = await load().catch(() => ({ error: 'Quiver could not read the Arc sidebar file. Try another copy.' }));
    if (request !== generation) return;
    if ('error' in result) {
      say(result.error, true);
      return;
    }
    reviewId = result.id;
    render(result);
    say(`Arc sidebar from ${result.source} ready to review.`);
    if (focusReview) heading.focus();
  }

  detected.addEventListener('click', () => void runReview(() => quiver.invoke('arc:review-detected'), true));
  choose.addEventListener('click', () => picker.click());
  clear.addEventListener('click', () => {
    reset();
    choose.focus();
    say('Arc review cancelled.');
  });
  picker.addEventListener('change', () => {
    const file = picker.files?.[0];
    picker.value = '';
    if (!file) return;
    void runReview(async () => {
      if (file.size > ARC_SIDEBAR_MAX_BYTES) return { error: 'Choose an Arc sidebar file no larger than 16 MiB.' };
      return quiver.invoke('arc:review-file', file.name, await file.text());
    }, true);
  });
  importButton.addEventListener('click', async () => {
    if (reviewId === undefined) return;
    const id = reviewId;
    reviewId = undefined;
    reset();
    const result = await quiver.invoke('arc:import', id) as { counts: ArcImportCounts; undoId: number } | { error: string };
    if ('error' in result) {
      say(result.error, true);
      return;
    }
    say(`Imported ${countsText(result.counts)}.`);
    showUndo(result.undoId);
    undoButton.focus();
  });
  undoButton.addEventListener('click', async () => {
    if (undoId === undefined) return;
    const result = await quiver.invoke('arc:undo', undoId) as { removed: { tabs: number; spaces: number } } | { error: string };
    showUndo(undefined);
    choose.focus();
    if ('error' in result) say(result.error, true);
    else say(`Undid the Arc import: removed ${quantity(result.removed.tabs, 'tab')} and ${quantity(result.removed.spaces, 'Space')}.`);
  });

  void quiver.invoke('arc:status').then((state: ArcImportStatus) => {
    detected.hidden = !state.detected;
    showUndo(state.undo?.id);
    // Opened from the first-launch card: have the review ready rather than asking for a second click.
    if (new URLSearchParams(location.search).get('import') === 'arc') {
      document.getElementById('arc-import-title')?.focus();
      if (state.detected) void runReview(() => quiver.invoke('arc:review-detected'), true);
    }
  });
}
