import { ARC_SIDEBAR_MAX_BYTES } from './arc-sidebar.js';
import type { ArcNode, ArcSidebarPreview } from './arc-sidebar.js';

type ImportPreview = ArcSidebarPreview & { flattenedFolders?: number };
type ArcError = { error: string };
type ArcUndoStatus = { canUndo: boolean; importedSpaces?: number; undoId?: string };

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
  const commit = document.querySelector<HTMLButtonElement>('#arc-sidebar-commit')!;
  const undo = document.querySelector<HTMLButtonElement>('#arc-sidebar-undo')!;
  const undoPanel = document.querySelector<HTMLElement>('#arc-sidebar-undo-panel')!;
  const undoDescription = document.querySelector<HTMLElement>('#arc-sidebar-undo-description')!;
  const confirmUndo = document.querySelector<HTMLButtonElement>('#arc-sidebar-undo-confirm')!;
  const cancelUndo = document.querySelector<HTMLButtonElement>('#arc-sidebar-undo-cancel')!;
  let generation = 0;
  let token = '';
  let mutating = false;
  let undoState: ArcUndoStatus = { canUndo: false };
  let confirmedUndoId: string | undefined;

  function announce(message: string, failed = false): void {
    status.textContent = message;
    status.className = failed ? 'status err' : 'status';
  }

  function updateControls(): void {
    choose.disabled = mutating;
    clear.disabled = mutating;
    commit.disabled = mutating || !token;
    undo.disabled = mutating;
    undo.hidden = !undoState.importedSpaces || !undoPanel.hidden;
    confirmUndo.disabled = mutating;
    cancelUndo.disabled = mutating;
    review.setAttribute('aria-busy', String(mutating));
    undoPanel.setAttribute('aria-busy', String(mutating));
  }

  async function refreshUndo(): Promise<void> {
    try {
      undoState = await quiver.invoke('arc:status') as ArcUndoStatus;
    } catch {
      undoState = { canUndo: false };
    }
    updateControls();
  }

  function reset(): void {
    generation++;
    token = '';
    clear.hidden = true;
    announce('');
    content.replaceChildren();
    review.hidden = true;
    updateControls();
  }

  function render(preview: ImportPreview): void {
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
    const tabs = preview.spaces.reduce((total, space) =>
      total + space.pinnedTabs + space.todayTabs + preview.profiles[space.profile].favoriteTabs, 0);
    const plan = document.createElement('p');
    plan.className = 'note';
    if (preview.limited) plan.textContent = 'The file exceeds the review limits. Choose a smaller Arc sidebar to import.';
    else if (!preview.spaces.length) plan.textContent = 'There are no Spaces to import from this file.';
    else if (token) {
      plan.textContent = `Quiver will create ${quantity(preview.spaces.length, 'new Space')} with ${quantity(tabs, 'tab')}. Favorites are pinned in each matching Space. Today tabs become regular tabs. Spaces from the same Arc profile share a fresh sign-in. Links load when selected.`;
    }
    if (plan.textContent) content.append(plan);
    if (preview.flattenedFolders) {
      const flattened = document.createElement('p');
      flattened.className = 'note';
      flattened.textContent = `Quiver will flatten ${quantity(preview.flattenedFolders, 'folder')} to fit its folder limits and retain the supported tabs.`;
      content.append(flattened);
    }
    commit.textContent = `Import ${quantity(preview.spaces.length, 'Space')}`;
    updateControls();
    review.hidden = false;
  }

  async function mutate(action: () => Promise<void>): Promise<void> {
    if (mutating) return;
    mutating = true;
    updateControls();
    try {
      await action();
    } catch {
      announce('Quiver could not complete the Arc import action. Try again.', true);
    } finally {
      await refreshUndo();
      mutating = false;
      updateControls();
      status.focus();
    }
  }

  choose.addEventListener('click', () => picker.click());
  clear.addEventListener('click', () => {
    reset();
    choose.focus();
    announce('Arc sidebar preview cleared.');
    void quiver.invoke('arc:cancel').catch(() => {});
  });
  picker.addEventListener('change', async () => {
    const file = picker.files?.[0];
    picker.value = '';
    if (!file || mutating) return;
    reset();
    const request = generation;
    // Invalidate the previous review before starting a new asynchronous file read.
    void quiver.invoke('arc:cancel').catch(() => {});
    clear.hidden = false;
    if (file.size > ARC_SIDEBAR_MAX_BYTES) {
      announce('Choose an Arc sidebar file no larger than 16 MiB.', true);
      return;
    }
    announce('Reading the Arc sidebar file…');
    try {
      const text = await file.text();
      if (request !== generation) return;
      const result = await quiver.invoke('arc:preview', text) as { token: string; preview: ImportPreview } | ArcError;
      if (request !== generation) return;
      if ('error' in result) {
        announce(result.error, true);
        return;
      }
      token = result.token;
      render(result.preview);
      announce('Arc sidebar preview ready.');
      if (document.hasFocus() && (document.activeElement === choose || document.activeElement === document.body)) heading.focus();
    } catch {
      if (request === generation) announce('Quiver could not read the Arc sidebar file. Try another copy.', true);
    }
  });
  commit.addEventListener('click', () => {
    if (!token || mutating) return;
    const confirmedToken = token;
    token = '';
    void mutate(async () => {
      announce('Importing Arc Spaces…');
      const result = await quiver.invoke('arc:commit', confirmedToken) as { importedSpaces: number; importedTabs: number } | ArcError;
      if ('error' in result) {
        announce(result.error, true);
        return;
      }
      reset();
      announce(`Imported ${quantity(result.importedSpaces, 'Space')} and ${quantity(result.importedTabs, 'tab')}.`);
    });
  });
  undo.addEventListener('click', () => {
    void (async () => {
      await refreshUndo();
      if (mutating) return;
      if (!undoState.canUndo || !undoState.importedSpaces || !undoState.undoId) {
        announce('The last Arc import can no longer be undone. You can remove its Spaces individually.', true);
        status.focus();
        return;
      }
      const count = quantity(undoState.importedSpaces, 'imported Space');
      confirmedUndoId = undoState.undoId;
      undoDescription.textContent = `Remove ${count} and their tabs? Undo is available until you open or change an imported Space.`;
      confirmUndo.textContent = `Remove ${count}`;
      undoPanel.hidden = false;
      updateControls();
      cancelUndo.focus();
    })();
  });
  cancelUndo.addEventListener('click', () => {
    confirmedUndoId = undefined;
    undoPanel.hidden = true;
    updateControls();
    undo.focus();
  });
  confirmUndo.addEventListener('click', () => void mutate(async () => {
    const expectedUndoId = confirmedUndoId;
    if (!expectedUndoId) return;
    confirmedUndoId = undefined;
    undoPanel.hidden = true;
    announce('Removing imported Arc Spaces…');
    const result = await quiver.invoke('arc:undo', expectedUndoId) as { removedSpaces: number } | ArcError;
    if ('error' in result) announce(result.error, true);
    else announce(`Removed ${quantity(result.removedSpaces, 'imported Space')}.`);
  }));
  void refreshUndo();
}
