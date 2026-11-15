type RecordData = Record<string, unknown>;

export const ARC_SIDEBAR_MAX_BYTES = 16 * 1024 * 1024;
const MAX_INDEX_ENTRIES = 10_000;
const MAX_SPACES = 100;
const MAX_VISITS = 800;
const MAX_DEPTH = 12;

type SidebarNode<Link extends object> =
  | ({ kind: 'tab'; title: string; host: string } & Link)
  | { kind: 'folder' | 'split'; title: string; children: SidebarNode<Link>[] };

export type ArcNode = SidebarNode<object>;
export type ArcImportNode = SidebarNode<{ url: string; customTitle?: string }>;

interface ArcSpace<Node> {
  title: string;
  profile: number;
  pinned: Node[];
  pinnedTabs: number;
  todayTabs: number;
}

interface ArcProfile<Node> {
  label: string;
  favorites: Node[];
  favoriteTabs: number;
}

interface SidebarReview<Node> {
  spaces: ArcSpace<Node>[];
  profiles: ArcProfile<Node>[];
  skipped: number;
  limited: boolean;
}

export type ArcSidebarPreview = SidebarReview<ArcNode>;
export interface ArcSidebarImport extends SidebarReview<ArcImportNode> {
  spaces: (ArcSpace<ArcImportNode> & { today: ArcImportNode[] })[];
}

export type ArcParseError = 'invalid-json' | 'unrecognized-sidebar' | 'too-large';

function record(value: unknown): RecordData | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordData : undefined;
}

function id(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : undefined;
}

function title(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, 200).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').trim() : '';
}

function profileKey(value: unknown): string | undefined {
  const source = record(value);
  if (source?.default === true || record(source?.default)) return 'default';
  const custom = record(record(source?.custom)?._0);
  const directory = id(custom?.directoryBasename);
  const machine = custom?.machineID;
  if (!directory || (machine !== undefined && machine !== null && !id(machine))) return undefined;
  return JSON.stringify([directory, machine ?? null]);
}

function tabUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)
    || !/^https?:\/\//i.test(value)) return undefined;
  try {
    const url = new URL(value);
    return !url.username && !url.password && url.hostname.length <= 253 && url.href.length <= 4096 ? url : undefined;
  } catch {
    return undefined;
  }
}

export function parseArcSidebar(text: string): ArcSidebarPreview | ArcParseError {
  const parsed = parseArcSidebarImport(text);
  return typeof parsed === 'string' ? parsed : projectArcSidebarPreview(parsed);
}

export function projectArcSidebarPreview(parsed: ArcSidebarImport): ArcSidebarPreview {
  function nodePreview(node: ArcImportNode): ArcNode {
    if (node.kind === 'tab') return { kind: 'tab', title: node.title, host: node.host };
    return { kind: node.kind, title: node.title, children: node.children.map(nodePreview) };
  }
  return {
    spaces: parsed.spaces.map(({ title, profile, pinned, pinnedTabs, todayTabs }) =>
      ({ title, profile, pinned: pinned.map(nodePreview), pinnedTabs, todayTabs })),
    profiles: parsed.profiles.map(({ label, favorites, favoriteTabs }) =>
      ({ label, favorites: favorites.map(nodePreview), favoriteTabs })),
    skipped: parsed.skipped,
    limited: parsed.limited,
  };
}

export function parseArcSidebarImport(text: string): ArcSidebarImport | ArcParseError {
  if (text.length > ARC_SIDEBAR_MAX_BYTES) return 'too-large';
  let source: unknown;
  try {
    source = JSON.parse(text);
  } catch {
    return 'invalid-json';
  }
  const containers = record(record(source)?.sidebar)?.containers;
  if (!Array.isArray(containers) || containers.length > MAX_SPACES) return 'unrecognized-sidebar';
  const candidates = containers.map(record).filter((item) => Array.isArray(item?.spaces) && Array.isArray(item?.items));
  if (candidates.length !== 1) return 'unrecognized-sidebar';
  const main = candidates[0]!;
  const result: ArcSidebarImport = { spaces: [], profiles: [], skipped: 0, limited: false };
  let visits = 0;

  function index(values: unknown[], limit: number): Map<string, RecordData> {
    const map = new Map<string, RecordData>();
    const end = Math.min(values.length, limit * 2);
    if (values.length > end) result.limited = true;
    for (let i = 0; i < end; i += 2) {
      const key = id(values[i]);
      const value = record(values[i + 1]);
      if (key && value && !map.has(key)) map.set(key, value);
      else result.skipped++;
    }
    return map;
  }

  const items = index(main.items as unknown[], MAX_INDEX_ENTRIES);
  const spaces = index(main.spaces as unknown[], MAX_SPACES);
  const profileIndices = new Map<string, number>();
  function addProfile(key: string | undefined): number {
    const existing = key === undefined ? undefined : profileIndices.get(key);
    if (existing !== undefined) return existing;
    const number = result.profiles.length + 1;
    result.profiles.push({
      label: key === 'default' ? 'Default profile' : key ? `Profile ${number}` : `Unrecognized profile ${number}`,
      favorites: [], favoriteTabs: 0,
    });
    if (key !== undefined) profileIndices.set(key, number - 1);
    return number - 1;
  }

  function walk(root: string | undefined, seen = new Set<string>()): { nodes: ArcImportNode[]; tabs: number } {
    let tabs = 0;
    function visit(key: unknown, depth: number): ArcImportNode | undefined {
      visits++;
      const nodeId = id(key);
      const item = nodeId === undefined || seen.has(nodeId) ? undefined : items.get(nodeId);
      if (!item || nodeId === undefined) {
        result.skipped++;
        return undefined;
      }
      seen.add(nodeId);
      const data = record(item.data);
      const tab = record(data?.tab);
      if (tab) {
        const url = tabUrl(tab.savedURL || tab.url);
        if (url) {
          const host = url.hostname;
          const customTitle = title(item.title);
          const alias = /^https?:\/\//i.test(customTitle) ? '' : customTitle;
          const name = alias || title(tab.savedTitle) || title(tab.title);
          tabs++;
          return {
            kind: 'tab', title: /^https?:\/\//i.test(name) ? host : name || host, host, url: url.href,
            ...(alias ? { customTitle: alias } : {}),
          };
        }
      } else if (record(data?.list) || record(data?.tabGroup) || record(data?.splitView)) {
        const split = record(data?.splitView) !== undefined;
        const label = title(item.title) || title(record(data?.tabGroup)?.title) || (split ? 'Split view' : 'Folder');
        return { kind: split ? 'split' : 'folder', title: label, children: childrenOf(item, depth + 1) };
      }
      result.skipped++;
      return undefined;
    }

    function childrenOf(item: RecordData, depth: number): ArcImportNode[] {
      if (!Array.isArray(item.childrenIds)) {
        if (item.childrenIds !== undefined) result.skipped++;
        return [];
      }
      const nodes: ArcImportNode[] = [];
      for (const child of item.childrenIds) {
        if (visits >= MAX_VISITS || depth > MAX_DEPTH) {
          result.limited = true;
          break;
        }
        const node = visit(child, depth);
        if (node) nodes.push(node);
      }
      return nodes;
    }

    if (root === undefined) return { nodes: [], tabs };
    const item = items.get(root);
    if (!item || seen.has(root)) {
      result.skipped++;
      return { nodes: [], tabs };
    }
    seen.add(root);
    return { nodes: childrenOf(item, 0), tabs };
  }

  const todayRoots: Array<string | undefined> = [];
  for (const space of spaces.values()) {
    const roots = Array.isArray(space.newContainerIDs) && space.newContainerIDs.length
      ? space.newContainerIDs : space.containerIDs;
    let pinned: string | undefined;
    let today: string | undefined;
    if (Array.isArray(roots)) {
      const end = Math.min(roots.length, 32);
      if (roots.length > end) result.limited = true;
      for (let i = 0; i < end; i += 2) {
        const key = id(roots[i + 1]);
        const tag = record(roots[i]);
        if (!key) result.skipped++;
        else if ((roots[i] === 'pinned' || (tag && 'pinned' in tag)) && pinned === undefined) pinned = key;
        else if ((roots[i] === 'unpinned' || (tag && 'unpinned' in tag)) && today === undefined) today = key;
        else result.skipped++;
      }
    }
    const pins = walk(pinned);
    todayRoots.push(today);
    result.spaces.push({
      title: title(space.title) || `Space ${result.spaces.length + 1}`,
      profile: addProfile(profileKey(space.profile)),
      pinned: pins.nodes,
      pinnedTabs: pins.tabs,
      today: [],
      todayTabs: 0,
    });
  }

  const favoriteRoots = new Map<string, string>();
  const declared = main.topAppsContainerIDs;
  if (Array.isArray(declared)) {
    const end = Math.min(declared.length, MAX_SPACES * 2);
    if (declared.length > end) result.limited = true;
    for (let i = 0; i < end; i += 2) {
      const owner = profileKey(declared[i]);
      const root = id(declared[i + 1]);
      if (owner && root && !favoriteRoots.has(root)) favoriteRoots.set(root, owner);
      else result.skipped++;
    }
  }
  for (const [root, item] of items) {
    const container = record(record(item.data)?.itemContainer);
    const topApps = record(record(container?.containerType)?.topApps);
    if (!topApps) continue;
    const owner = profileKey(topApps._0);
    if (owner) {
      if (favoriteRoots.has(root) && favoriteRoots.get(root) !== owner) result.skipped++;
      favoriteRoots.set(root, owner);
    } else if (!favoriteRoots.has(root)) result.skipped++;
  }

  const favoriteSeen = new Map<number, Set<string>>();
  for (const [root, owner] of favoriteRoots) {
    if (result.profiles.length >= MAX_SPACES && !profileIndices.has(owner)) {
      result.limited = true;
      continue;
    }
    const index = addProfile(owner);
    const seen = favoriteSeen.get(index) ?? new Set<string>();
    favoriteSeen.set(index, seen);
    const favorites = walk(root, seen);
    result.profiles[index].favorites.push(...favorites.nodes);
    result.profiles[index].favoriteTabs += favorites.tabs;
  }
  result.spaces.forEach((space, index) => {
    const today = walk(todayRoots[index]);
    space.today = today.nodes;
    space.todayTabs = today.tabs;
  });
  return result;
}
