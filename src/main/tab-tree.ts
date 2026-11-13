import type { Folder, SidebarRow } from '../shared/types';

/** The parts of a tab that decide where it appears in the sidebar. */
export interface TreeTab {
  id: number;
  pinned: boolean;
  folderId: string | null;
}

export const FOLDER_LIMIT = 200;
export const FOLDER_DEPTH_LIMIT = 8;
export const FOLDER_NAME_LIMIT = 40;

export function folderName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, ' ').trim().slice(0, FOLDER_NAME_LIMIT);
}

function depthOf(parents: Map<string, string | null>, id: string | null): number {
  let depth = 0;
  for (let at = id; at !== null && depth <= FOLDER_DEPTH_LIMIT; at = parents.get(at) ?? null) depth++;
  return depth;
}

/** Validate persisted folders: drop malformed and duplicate entries, re-root orphans, break cycles, cap depth. */
export function normalizeFolders(raw: unknown): Folder[] {
  if (!Array.isArray(raw)) return [];
  const valid: Folder[] = [];
  const ids = new Set<string>();
  for (const entry of raw.slice(0, FOLDER_LIMIT * 2)) {
    if (!entry || typeof entry !== 'object') continue;
    const { id, name, parentId, collapsed } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id) || ids.has(id)) continue;
    ids.add(id);
    valid.push({ id, name: folderName(name) || 'Folder', parentId: typeof parentId === 'string' ? parentId : null, collapsed: collapsed === true });
    if (valid.length === FOLDER_LIMIT) break;
  }
  // Accept parent links in order, refusing any that would close a cycle or exceed the depth limit.
  const parents = new Map<string, string | null>();
  for (const folder of valid) {
    let parent = folder.parentId !== null && ids.has(folder.parentId) ? folder.parentId : null;
    if (parent !== null) {
      for (let at: string | null = parent; at !== null; at = parents.get(at) ?? null) {
        if (at === folder.id) { parent = null; break; }
      }
    }
    if (parent !== null && depthOf(parents, parent) >= FOLDER_DEPTH_LIMIT) parent = null;
    folder.parentId = parent;
    parents.set(folder.id, parent);
  }
  return valid;
}

/** True when `id` may move under `parentId` without nesting inside itself or exceeding the depth limit. */
export function canNest(folders: readonly Folder[], id: string, parentId: string | null): boolean {
  if (parentId === null) return true;
  const parents = new Map(folders.map((f) => [f.id, f.parentId]));
  if (!parents.has(parentId)) return false;
  for (let at: string | null = parentId; at !== null; at = parents.get(at) ?? null) if (at === id) return false;
  const height = (folderId: string): number =>
    1 + Math.max(0, ...folders.filter((f) => f.parentId === folderId).map((f) => height(f.id)));
  return depthOf(parents, parentId) + height(id) <= FOLDER_DEPTH_LIMIT;
}

export function deleteFolder<T extends TreeTab>(folders: readonly Folder[], tabs: readonly T[], id: string) {
  const target = folders.find((f) => f.id === id);
  const parent = target?.parentId ?? null;
  return {
    folders: folders.filter((f) => f.id !== id).map((f) => (f.parentId === id ? { ...f, parentId: parent } : f)),
    tabs: tabs.map((t) => (t.folderId === id ? { ...t, folderId: parent } : t)),
  };
}

function walk(tabs: readonly TreeTab[], folders: readonly Folder[], respectCollapse: boolean): SidebarRow[] {
  const known = new Set(folders.map((f) => f.id));
  const folderOf = (t: TreeTab) => (t.folderId !== null && known.has(t.folderId) ? t.folderId : null);
  const pinned = tabs.filter((t) => t.pinned);
  const counts = new Map<string, number>();
  const parentOf = new Map(folders.map((f) => [f.id, f.parentId]));
  for (const t of pinned) {
    for (let at = folderOf(t); at !== null; at = parentOf.get(at) ?? null) counts.set(at, (counts.get(at) ?? 0) + 1);
  }
  const rows: SidebarRow[] = [];
  const visit = (parentId: string | null, depth: number) => {
    for (const f of folders) {
      if (f.parentId !== parentId) continue;
      rows.push({ kind: 'folder', id: f.id, name: f.name, depth, collapsed: f.collapsed, count: counts.get(f.id) ?? 0 });
      if (!respectCollapse || !f.collapsed) visit(f.id, depth + 1);
    }
    for (const t of pinned) {
      if (folderOf(t) === parentId) rows.push({ kind: 'tab', tabId: t.id, depth, pinned: true, folderId: parentId });
    }
  };
  visit(null, 0);
  if (rows.length) rows.push({ kind: 'divider' });
  for (const t of tabs) if (!t.pinned) rows.push({ kind: 'tab', tabId: t.id, depth: 0, pinned: false, folderId: null });
  return rows;
}

/** Rows the sidebar draws for one Space: pinned folders and tabs, a divider, then temporary tabs. */
export function sidebarRows(tabs: readonly TreeTab[], folders: readonly Folder[]): SidebarRow[] {
  return walk(tabs, folders, true);
}

/** Tab ids in the order the sidebar shows them, including tabs inside collapsed folders. */
export function displayOrder(tabs: readonly TreeTab[], folders: readonly Folder[]): number[] {
  return walk(tabs, folders, false).flatMap((r) => (r.kind === 'tab' ? [r.tabId] : []));
}

/** Move entry `id` directly before or after `targetId` (to the end when the target is unknown). */
export function placeRelative<T extends { id: number }>(entries: readonly T[], id: number, targetId: number | null, after: boolean): T[] {
  const moving = entries.find((e) => e.id === id);
  if (!moving) return [...entries];
  const rest = entries.filter((e) => e !== moving);
  const at = targetId === null ? -1 : rest.findIndex((e) => e.id === targetId);
  if (at < 0) return [...rest, moving];
  rest.splice(after ? at + 1 : at, 0, moving);
  return rest;
}
