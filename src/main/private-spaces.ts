import type { Space } from '../shared/types';
import type { PersistedState } from './store';

/**
 * Private Spaces use an Electron partition without the "persist:" prefix, which Electron keeps in memory only:
 * cookies, storage and cache never reach the disk and are gone when Quiver quits.
 */
export const PRIVATE_PARTITION_PREFIX = 'quiver-private-';

export function privatePartition(spaceId: string): string {
  return PRIVATE_PARTITION_PREFIX + spaceId;
}

export function isPrivatePartition(partition: unknown): boolean {
  return typeof partition === 'string' && partition.startsWith(PRIVATE_PARTITION_PREFIX);
}

export function isPrivateSpace(spaces: readonly Space[], id: string): boolean {
  return spaces.some((sp) => sp.id === id && sp.private === true);
}

/** Spaces that may leave this Quiver session (saved to disk or published to sync). */
export function publicSpaces(spaces: readonly Space[]): Space[] {
  return spaces.filter((sp) => !sp.private);
}

export function newPrivateSpace(now = Date.now(), random = Math.random()): Space {
  return {
    id: `private-${now.toString(36)}${Math.floor(random * 1e6).toString(36)}`,
    name: 'Private',
    color: '#8b5cf6',
    isolated: true,
    private: true,
  };
}

/**
 * The state as written to quiver-state.json: private Spaces and everything that belongs to them (tabs, recently
 * closed tabs, archived tabs, research topics and downloads) are left out, so nothing from them survives a restart.
 */
export function persistableState(state: PersistedState): PersistedState {
  const hidden = new Set(state.spaces.filter((sp) => sp.private).map((sp) => sp.id));
  const downloads = state.downloads?.filter((d) => !isPrivatePartition((d as { partition?: unknown } | null)?.partition));
  if (!hidden.size && downloads?.length === state.downloads?.length) return state;
  const keep = <T>(record: Record<string, T> | undefined) =>
    record && Object.fromEntries(Object.entries(record).filter(([id]) => !hidden.has(id)));
  let spaces = state.spaces.filter((sp) => !hidden.has(sp.id));
  // A saved state needs at least one Space; Quiver never lets the last regular Space go, but don't rely on that here.
  if (!spaces.length) spaces = [{ id: 'space-main', name: 'Main', color: '#5b8cff', isolated: false }];
  return {
    ...state,
    spaces,
    activeSpaceId: hidden.has(state.activeSpaceId) || !spaces.some((sp) => sp.id === state.activeSpaceId) ? spaces[0].id : state.activeSpaceId,
    tabsBySpace: keep(state.tabsBySpace) ?? {},
    activeIndexBySpace: keep(state.activeIndexBySpace) ?? {},
    recentlyClosed: state.recentlyClosed.filter((t) => !hidden.has(t.spaceId)),
    ...(state.archive ? { archive: state.archive.filter((t) => !hidden.has(t.spaceId)) } : {}),
    ...(state.topics ? { topics: state.topics.filter((t) => !hidden.has(t.spaceId)) } : {}),
    ...(state.activeTopicBySpace ? { activeTopicBySpace: keep(state.activeTopicBySpace) } : {}),
    ...(downloads ? { downloads } : {}),
  };
}
