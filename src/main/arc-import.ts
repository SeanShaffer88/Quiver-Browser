import { createHash, randomUUID } from 'node:crypto';
import { ARC_SIDEBAR_MAX_BYTES, parseArcSidebarImport, projectArcSidebarPreview, type ArcImportNode } from '../renderer/arc-sidebar';
import type { Folder, Space } from '../shared/types';
import { arcImportId, arcSpaceId } from './space-session';
import type { PersistedState, PersistedTab } from './store';
import { FOLDER_DEPTH_LIMIT, FOLDER_LIMIT, folderName } from './tab-tree';
import { normalizeTabTitle } from './session-recovery';

const MAX_IMPORTED_TABS = 800;
const MAX_IMPORTED_SPACES = 100;
const COLORS = ['#5b8cff', '#ff7a59', '#3ecf8e', '#f5b73b', '#b57bff', '#ff5d8f', '#2cc5d9'];
type ImportError = { error: string };

export interface ArcImportUndo {
  id: string;
  spaceIds: string[];
  fingerprint: string;
}

export interface ArcImportSpace {
  space: Space;
  tabs: PersistedTab[];
}

export function validArcImportUndo(value: unknown): ArcImportUndo | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { id, spaceIds, fingerprint } = value as Partial<ArcImportUndo>;
  if (!arcImportId(id) || !Array.isArray(spaceIds) || !spaceIds.length || spaceIds.length > MAX_IMPORTED_SPACES ||
      !spaceIds.every(arcSpaceId) || new Set(spaceIds).size !== spaceIds.length ||
      typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint)) return undefined;
  return { id, spaceIds, fingerprint };
}

function fingerprint(entries: readonly ArcImportSpace[]): string {
  const hash = createHash('sha256');
  for (const { space, tabs } of entries) {
    hash.update(JSON.stringify([
      space.id, space.name, space.color, space.isolated, space.arcImportId, space.sessionGroupId,
      (space.folders ?? []).map((f) => [f.id, f.name, f.parentId, f.collapsed]),
      tabs.map((tab) => [
        tab.url, tab.title ?? '', tab.customTitle ?? '', tab.pinned === true,
        tab.folderId ?? '', tab.pinnedUrl ?? tab.url, tab.lastActiveAt ?? 0,
      ]),
    ]));
  }
  return hash.digest('hex');
}

type ArcReview = { token: string; preview: ReturnType<typeof projectArcSidebarPreview> & { flattenedFolders?: number } };
type ArcCommit = { importedSpaces: number; importedTabs: number };
type ArcUndo = { removedSpaces: number };
type ArcStatus = { canUndo: boolean; importedSpaces?: number; undoId?: string };

interface ArcRuntime {
  /** Stage lazy views for the candidate state. Returns a rollback for those views. */
  stage(entries: readonly ArcImportSpace[]): () => void;
  /** Remove staged or live views after durable undo. */
  remove(spaces: readonly Space[]): void;
}

export class ArcImports<Owner extends object> {
  private review?: { owner: Owner; token: string; entries: ArcImportSpace[]; undo: ArcImportUndo; importedTabs: number };

  constructor(
    private readonly state: PersistedState,
    private readonly flush: () => boolean,
    private readonly save: () => void,
    private readonly runtime: ArcRuntime,
    private readonly now = () => Date.now(),
  ) {}

  preview(owner: Owner, raw: unknown): ArcReview | ImportError {
    this.review = undefined;
    if (typeof raw !== 'string') return { error: 'Choose a copy of StorableSidebar.json.' };
    if (raw.length > ARC_SIDEBAR_MAX_BYTES || Buffer.byteLength(raw) > ARC_SIDEBAR_MAX_BYTES) {
      return { error: 'Choose an Arc sidebar file no larger than 16 MiB.' };
    }
    const data = parseArcSidebarImport(raw);
    if (typeof data === 'string') return { error: {
      'too-large': 'Choose an Arc sidebar file no larger than 16 MiB.',
      'invalid-json': 'This file contains invalid JSON. Choose a copy of StorableSidebar.json.',
      'unrecognized-sidebar': 'Quiver could not recognize this Arc sidebar. Choose a copy of StorableSidebar.json.',
    }[data] };

    const preview: ArcReview['preview'] = projectArcSidebarPreview(data);
    if (preview.limited || !preview.spaces.length) return { token: '', preview };
    const importedTabs = data.spaces.reduce((total, space) =>
      total + space.pinnedTabs + space.todayTabs + (data.profiles[space.profile]?.favoriteTabs ?? 0), 0);
    if (importedTabs > MAX_IMPORTED_TABS) return { error: 'This Arc sidebar would import more than 800 tabs. Choose a smaller sidebar.' };
    const id = randomUUID();
    const groups = data.profiles.map(() => randomUUID());
    let flattenedFolders = 0;
    const entries: ArcImportSpace[] = data.spaces.map((source, index) => {
      const folders: Folder[] = [];
      const tabs: PersistedTab[] = [];
      function add(nodes: readonly ArcImportNode[], pinned: boolean, parentId: string | null, depth: number, keepFolders = pinned): void {
        for (const node of nodes) {
          if (node.kind === 'tab') {
            const title = normalizeTabTitle(node.title, node.url);
            const customTitle = normalizeTabTitle(node.customTitle, node.url);
            tabs.push({
              url: node.url, ...(title && { title }), ...(customTitle && { customTitle }),
              ...(pinned && { pinned: true }), ...(parentId && { folderId: parentId }),
            });
          } else if (keepFolders && depth < FOLDER_DEPTH_LIMIT && folders.length < FOLDER_LIMIT) {
            const folder = { id: randomUUID(), name: folderName(node.title) || 'Folder', parentId, collapsed: false };
            folders.push(folder);
            add(node.children, pinned, folder.id, depth + 1);
          } else {
            if (keepFolders) flattenedFolders++;
            add(node.children, pinned, parentId, depth, keepFolders);
          }
        }
      }
      add(data.profiles[source.profile]?.favorites ?? [], true, null, 0, false);
      add(source.pinned, true, null, 0);
      add(source.today, false, null, 0);
      return {
        space: {
          id: `arc-space-${randomUUID()}`, name: folderName(source.title) || 'Space',
          color: COLORS[(this.state.spaces.length + index) % COLORS.length],
          isolated: true, folders, arcImportId: id, sessionGroupId: groups[source.profile],
        },
        tabs,
      };
    });
    if (flattenedFolders) preview.flattenedFolders = flattenedFolders;
    const token = randomUUID();
    this.review = {
      owner, token, entries, importedTabs,
      undo: { id, spaceIds: entries.map(({ space }) => space.id), fingerprint: '' },
    };
    return { token, preview };
  }

  cancel(owner: Owner): void {
    if (this.review?.owner === owner) this.review = undefined;
  }

  commit(owner: Owner, token: unknown): ArcCommit | ImportError {
    const review = this.review;
    if (!review || review.owner !== owner || review.token !== token) return { error: 'Review the Arc sidebar again before importing.' };
    this.review = undefined;
    if (this.state.spaces.some((space) => review.undo.spaceIds.includes(space.id) || space.arcImportId === review.undo.id)) {
      return { error: 'Quiver could not allocate new Spaces. Review the Arc sidebar again.' };
    }
    const at = this.now();
    for (const { tabs } of review.entries) for (const tab of tabs) tab.lastActiveAt = at;
    review.undo.fingerprint = fingerprint(review.entries);
    const previous = this.snapshot();
    this.state.spaces = [...previous.spaces, ...review.entries.map(({ space }) => space)];
    this.state.tabsBySpace = { ...previous.tabsBySpace, ...Object.fromEntries(review.entries.map(({ space, tabs }) => [space.id, tabs])) };
    this.state.activeIndexBySpace = { ...previous.activeIndexBySpace, ...Object.fromEntries(review.undo.spaceIds.map((id) => [id, 0])) };
    this.state.arcImportUndo = review.undo;
    let rollback: (() => void) | undefined;
    try {
      rollback = this.runtime.stage(review.entries);
      if (this.flush()) return { importedSpaces: review.entries.length, importedTabs: review.importedTabs };
    } catch {
      // A staging failure must leave the saved and live sessions as they were.
    }
    Object.assign(this.state, previous);
    rollback?.();
    this.save();
    return { error: 'Quiver could not save the Arc import. Review the file again to retry.' };
  }

  status(): ArcStatus {
    const undo = this.state.arcImportUndo;
    if (!undo) return { canUndo: false };
    const canUndo = this.canUndo(undo);
    return { canUndo, importedSpaces: undo.spaceIds.length, ...(canUndo && { undoId: undo.id }) };
  }

  undo(expectedId: unknown): ArcUndo | ImportError {
    const undo = this.state.arcImportUndo;
    if (!undo || undo.id !== expectedId || !this.canUndo(undo)) return { error: 'This Arc import can no longer be undone.' };
    const ids = new Set(undo.spaceIds);
    const previous = this.snapshot();
    const spaces = previous.spaces.filter((space) => ids.has(space.id));
    this.state.spaces = previous.spaces.filter((space) => !ids.has(space.id));
    this.state.tabsBySpace = Object.fromEntries(Object.entries(previous.tabsBySpace).filter(([id]) => !ids.has(id)));
    this.state.activeIndexBySpace = Object.fromEntries(Object.entries(previous.activeIndexBySpace).filter(([id]) => !ids.has(id)));
    this.state.arcImportUndo = undefined;
    if (!this.flush()) {
      Object.assign(this.state, previous);
      this.save();
      return { error: 'Quiver could not undo the Arc import. Try again.' };
    }
    this.runtime.remove(spaces);
    return { removedSpaces: spaces.length };
  }

  private canUndo(undo: ArcImportUndo): boolean {
    const spaces = this.state.spaces.filter((space) => space.arcImportId === undo.id);
    if (spaces.length !== undo.spaceIds.length || spaces.some((space, index) => space.id !== undo.spaceIds[index]) ||
        undo.spaceIds.includes(this.state.activeSpaceId) || this.state.spaces.length === spaces.length) return false;
    return fingerprint(spaces.map((space) => ({ space, tabs: this.state.tabsBySpace[space.id] ?? [] }))) === undo.fingerprint;
  }

  private snapshot() {
    const { spaces, tabsBySpace, activeIndexBySpace, arcImportUndo } = this.state;
    return { spaces, tabsBySpace, activeIndexBySpace, arcImportUndo };
  }
}
