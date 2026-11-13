import { createHash } from 'node:crypto';

// Folder sync: every device writes only its own file into a folder the user already syncs (OneDrive, Dropbox,
// Syncthing…), so cloud providers never see two writers on one file. Each section is last-writer-wins by the time
// it last changed on any device.

export const SYNC_SECTIONS = ['settings', 'bookmarks', 'spaces', 'research', 'boosts'] as const;
export type SyncSection = (typeof SYNC_SECTIONS)[number];

export interface SectionCopy {
  updatedAt: number;
  data: unknown;
}

export interface DeviceFile {
  version: 1;
  deviceId: string;
  deviceName: string;
  writtenAt: number;
  sections: Partial<Record<SyncSection, SectionCopy>>;
}

/** What this device last published per section, so local edits can be told apart from synced ones. */
export type SyncMemory = Partial<Record<SyncSection, { hash: string; updatedAt: number }>>;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical((value as Record<string, unknown>)[k])]));
  }
  return value;
}

export function hashSection(data: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(data)) ?? 'undefined').digest('hex');
}

export const DEVICE_ID = /^[\w-]{1,64}$/;

export function normalizeDeviceFile(raw: unknown): DeviceFile | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1 || typeof r.deviceId !== 'string' || !DEVICE_ID.test(r.deviceId)) return null;
  const sections: DeviceFile['sections'] = {};
  const given = r.sections && typeof r.sections === 'object' ? (r.sections as Record<string, unknown>) : {};
  for (const name of SYNC_SECTIONS) {
    const copy = given[name] as Record<string, unknown> | undefined;
    if (copy && typeof copy === 'object' && typeof copy.updatedAt === 'number' && Number.isFinite(copy.updatedAt) && 'data' in copy) {
      sections[name] = { updatedAt: copy.updatedAt, data: copy.data };
    }
  }
  const name = typeof r.deviceName === 'string' ? r.deviceName.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60) : '';
  return { version: 1, deviceId: r.deviceId, deviceName: name || r.deviceId, writtenAt: typeof r.writtenAt === 'number' ? r.writtenAt : 0, sections };
}

/**
 * Decide what to apply locally and what to publish. `local` holds the current data of each enabled section;
 * `memory` is updated in place to describe what is published after this round.
 */
export function planSync(
  local: Partial<Record<SyncSection, unknown>>, memory: SyncMemory, remotes: readonly DeviceFile[], now: number,
  join: Partial<Record<SyncSection, (local: unknown, remote: unknown) => unknown>> = JOIN,
): { apply: Partial<Record<SyncSection, unknown>>; publish: DeviceFile['sections'] } {
  const apply: Partial<Record<SyncSection, unknown>> = {};
  const publish: DeviceFile['sections'] = {};
  for (const name of SYNC_SECTIONS) {
    if (!(name in local)) continue;
    const data = local[name];
    const hash = hashSection(data);
    const known = memory[name];
    if (!known) {
      // First sync of this section on this device: merge with the newest copy elsewhere instead of overwriting it.
      const newest = remotes.map((r) => r.sections[name]).filter((c): c is SectionCopy => !!c).sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (newest) {
        const merged = join[name] ? join[name]!(data, newest.data) : newest.data;
        const mergedHash = hashSection(merged);
        if (mergedHash !== hash) apply[name] = merged;
        const updatedAt = mergedHash === hashSection(newest.data) ? newest.updatedAt : Math.max(now, newest.updatedAt + 1);
        memory[name] = { hash: mergedHash, updatedAt };
        publish[name] = { updatedAt, data: merged };
        continue;
      }
    }
    // A section that differs from what we last published was edited here since then.
    const localAt = !known ? now : known.hash === hash ? known.updatedAt : now;
    let newest: SectionCopy | undefined;
    for (const remote of remotes) {
      const copy = remote.sections[name];
      if (copy && copy.updatedAt > localAt && (!newest || copy.updatedAt > newest.updatedAt)) newest = copy;
    }
    if (newest && hashSection(newest.data) !== hash) {
      apply[name] = newest.data;
      memory[name] = { hash: hashSection(newest.data), updatedAt: newest.updatedAt };
      publish[name] = { updatedAt: newest.updatedAt, data: newest.data };
    } else {
      const updatedAt = newest ? Math.max(localAt, newest.updatedAt) : localAt;
      memory[name] = { hash, updatedAt };
      publish[name] = { updatedAt, data };
    }
  }
  return { apply, publish };
}

export interface SyncedPin { url: string; title?: string; folderId?: string }
export interface SyncedSpace {
  id: string;
  name: string;
  color: string;
  isolated: boolean;
  folders: unknown;
  pinned: SyncedPin[];
}

/** Validate the synced Spaces section; folders are validated by the caller with normalizeFolders. */
export function normalizeSyncedSpaces(raw: unknown, restorable: (url: string) => boolean): SyncedSpace[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: SyncedSpace[] = [];
  for (const entry of raw.slice(0, 50)) {
    if (!entry || typeof entry !== 'object') continue;
    const s = entry as Record<string, unknown>;
    if (typeof s.id !== 'string' || !/^[\w-]{1,64}$/.test(s.id) || seen.has(s.id)) continue;
    seen.add(s.id);
    const pinned: SyncedPin[] = [];
    for (const p of Array.isArray(s.pinned) ? s.pinned.slice(0, 500) : []) {
      if (!p || typeof p !== 'object') continue;
      const { url, title, folderId } = p as Record<string, unknown>;
      if (typeof url !== 'string' || !restorable(url)) continue;
      pinned.push({
        url,
        ...(typeof title === 'string' && title.trim() ? { title: title.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200) } : {}),
        ...(typeof folderId === 'string' && /^[\w-]{1,64}$/.test(folderId) ? { folderId } : {}),
      });
    }
    out.push({
      id: s.id,
      name: typeof s.name === 'string' && s.name.trim() ? s.name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 40) : 'Space',
      color: typeof s.color === 'string' && /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : '#5b8cff',
      isolated: s.isolated === true,
      folders: s.folders,
      pinned,
    });
  }
  return out;
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object') : [];
}

/** Remote entries first, then local entries whose key the remote lacks. */
function unionBy(local: unknown, remote: unknown, key: string): Record<string, unknown>[] {
  const theirs = list(remote);
  const seen = new Set(theirs.map((e) => e[key]));
  return [...theirs, ...list(local).filter((e) => !seen.has(e[key]))];
}

/** How a device that has never synced a section combines its own data with what other devices already share. */
export const JOIN: Partial<Record<SyncSection, (local: unknown, remote: unknown) => unknown>> = {
  bookmarks: (local, remote) => unionBy(local, remote, 'url'),
  research: (local, remote) => unionBy(local, remote, 'id'),
  boosts: (local, remote) => ({
    ...(local && typeof local === 'object' ? local : {}),
    ...(remote && typeof remote === 'object' ? remote : {}),
  }),
  spaces: (local, remote) => {
    const mine = new Map(list(local).map((sp) => [sp.id, sp]));
    const merged = list(remote).map((sp) => {
      const own = mine.get(sp.id);
      if (!own) return sp;
      return { ...sp, folders: unionBy(own.folders, sp.folders, 'id'), pinned: unionBy(own.pinned, sp.pinned, 'url') };
    });
    const theirs = new Set(merged.map((sp) => sp.id));
    return [...merged, ...list(local).filter((sp) => !theirs.has(sp.id))];
  },
};
