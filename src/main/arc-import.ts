import fs from 'node:fs';
import path from 'node:path';
import type { ArcImportCounts, Folder } from '../shared/types';
import type { ArcSidebar, ArcSourceNode } from './arc-sidebar';
import { restorableUrl } from './session-recovery';
import { FOLDER_DEPTH_LIMIT, FOLDER_LIMIT, folderName } from './tab-tree';

/**
 * Every imported tab gets its own (lazy) web view, so a very large Arc sidebar would cost real memory. This cap keeps
 * an import comfortably below what Quiver handles well; the review reports anything left out.
 */
export const ARC_IMPORT_TAB_LIMIT = 500;
export const ARC_IMPORT_SPACE_LIMIT = 50;
const SPACE_NAME_LIMIT = 40;

/** The parts of an existing Quiver Space the plan needs. */
export interface ExistingSpace {
  id: string;
  name: string;
  folders: readonly Folder[];
  /** URLs of tabs already in the Space (current and pinned URLs). */
  urls: ReadonlySet<string>;
}

export interface PlannedTab {
  url: string;
  title: string;
  folderId: string | null;
}

export interface PlannedSpace {
  /** The Quiver Space to merge into, or null to create one. */
  spaceId: string | null;
  name: string;
  /** Folders to add, parents before children. */
  folders: Folder[];
  tabs: PlannedTab[];
}

export interface ArcImportPlan {
  spaces: PlannedSpace[];
  counts: ArcImportCounts;
}

function spaceKey(name: string): string {
  return name.toLocaleLowerCase();
}

function spaceName(value: string, index: number): string {
  // Space names share the folder rules: no control or bidi-override characters, 40 characters at most.
  return folderName(value).slice(0, SPACE_NAME_LIMIT) || `Arc Space ${index + 1}`;
}

/**
 * Turn a parsed Arc sidebar into Quiver Spaces, pinned tabs and folders. Arc Spaces merge into Quiver Spaces with the
 * same name (ignoring case), folders merge into a same-named folder at the same place, and a tab is skipped when its
 * Space already has that URL, so importing the same sidebar twice adds nothing. Arc Favorites become top-level pinned
 * tabs in the first imported Space. Split views have no Quiver equivalent; their tabs join the surrounding folder.
 */
export function planArcImport(sidebar: ArcSidebar, existing: readonly ExistingSpace[], newId: () => string): ArcImportPlan {
  const counts: ArcImportCounts = { spaces: 0, newSpaces: 0, mergedSpaces: 0, pinned: 0, favorites: 0, folders: 0, duplicates: 0, dropped: 0 };
  interface Target { plan: PlannedSpace; folders: Folder[]; urls: Set<string> }
  const targets = new Map<string, Target>();
  const order: Target[] = [];
  let tabs = 0;

  const targetFor = (name: string): Target | undefined => {
    const key = spaceKey(name);
    const known = targets.get(key);
    if (known) return known;
    const match = existing.find((space) => spaceKey(space.name.trim()) === key);
    if (!match && order.filter((t) => t.plan.spaceId === null).length >= ARC_IMPORT_SPACE_LIMIT) return undefined;
    const target: Target = {
      plan: { spaceId: match?.id ?? null, name: match?.name ?? name, folders: [], tabs: [] },
      folders: [...(match?.folders ?? [])],
      urls: new Set(match?.urls ?? []),
    };
    targets.set(key, target);
    order.push(target);
    return target;
  };

  const depthOf = (folders: readonly Folder[], id: string | null): number => {
    let depth = 0;
    for (let at = id; at !== null && depth <= FOLDER_DEPTH_LIMIT; at = folders.find((f) => f.id === at)?.parentId ?? null) depth++;
    return depth;
  };

  const countTabs = (nodes: readonly ArcSourceNode[]): number =>
    nodes.reduce((total, node) => total + (node.kind === 'tab' ? 1 : countTabs(node.children)), 0);

  /** A same-named folder under the same parent, or a new one; null when Quiver's folder limits would be exceeded. */
  const folderFor = (target: Target, title: string, parentId: string | null): string | null => {
    const name = folderName(title) || 'Folder';
    const same = target.folders.find((f) => f.parentId === parentId && f.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (same) return same.id;
    if (target.folders.length >= FOLDER_LIMIT || depthOf(target.folders, parentId) >= FOLDER_DEPTH_LIMIT) return null;
    const folder: Folder = { id: newId(), name, parentId, collapsed: false };
    target.folders.push(folder);
    target.plan.folders.push(folder);
    counts.folders++;
    return folder.id;
  };

  const add = (target: Target, nodes: readonly ArcSourceNode[], parentId: string | null, favorite: boolean): void => {
    for (const node of nodes) {
      if (node.kind !== 'tab') {
        const id = node.kind === 'folder' ? folderFor(target, node.title, parentId) : parentId;
        // Past the folder limits the tabs still come in, one level up, instead of being lost.
        if (node.kind === 'folder' && id === null) counts.dropped++;
        add(target, node.children, id ?? parentId, favorite);
        continue;
      }
      if (!restorableUrl(node.url)) {
        counts.dropped++;
      } else if (target.urls.has(node.url)) {
        counts.duplicates++;
      } else if (tabs >= ARC_IMPORT_TAB_LIMIT) {
        counts.dropped++;
      } else {
        tabs++;
        target.urls.add(node.url);
        target.plan.tabs.push({ url: node.url, title: node.title, folderId: parentId });
        if (favorite) counts.favorites++;
        else counts.pinned++;
      }
    }
  };

  // Favorites go first so they sit above the first Space's own pins, as they sit above the Space in Arc.
  const favorites = sidebar.profiles.flatMap((profile) => profile.favorites);
  const first = sidebar.spaces.length
    ? targetFor(spaceName(sidebar.spaces[0].title, 0))
    : existing[0] && targetFor(existing[0].name.trim());
  if (first) add(first, favorites, null, true);
  else counts.dropped += countTabs(favorites);

  sidebar.spaces.forEach((space, index) => {
    const target = targetFor(spaceName(space.title, index));
    if (target) add(target, space.pinned, null, false);
    else counts.dropped += countTabs(space.pinned) || 1;
  });

  const spaces = order.map((t) => t.plan).filter((plan) => plan.tabs.length || plan.folders.length || plan.spaceId === null);
  counts.spaces = spaces.length;
  counts.newSpaces = spaces.filter((plan) => plan.spaceId === null).length;
  counts.mergedSpaces = counts.spaces - counts.newSpaces;
  return { spaces, counts };
}

/** Undo information for the last import: what it added, so undo removes only that. */
export interface ArcImportUndo {
  id: number;
  createdSpaceIds: string[];
  folders: Array<{ spaceId: string; ids: string[] }>;
  tabIds: number[];
}

/** Arc for Windows is an MSIX package; its sidebar lives in the package's local cache. */
const ARC_PACKAGE = /^TheBrowserCompany\.Arc_[\w.-]+$/;

/** Find StorableSidebar.json under %LOCALAPPDATA%\Packages. Returns the newest one when several packages exist. */
export function findArcSidebar(localAppData: string, fileSystem: Pick<typeof fs, 'readdirSync' | 'statSync'> = fs): string | undefined {
  if (!localAppData || !path.isAbsolute(localAppData)) return undefined;
  let found: { file: string; mtime: number } | undefined;
  try {
    const packages = path.join(localAppData, 'Packages');
    for (const entry of fileSystem.readdirSync(packages).slice(0, 2000)) {
      if (!ARC_PACKAGE.test(entry)) continue;
      const file = path.join(packages, entry, 'LocalCache', 'Local', 'Arc', 'StorableSidebar.json');
      try {
        const stat = fileSystem.statSync(file);
        if (stat.isFile() && (!found || stat.mtimeMs > found.mtime)) found = { file, mtime: stat.mtimeMs };
      } catch {
        /* this package has no sidebar */
      }
    }
  } catch {
    return undefined;
  }
  return found?.file;
}
