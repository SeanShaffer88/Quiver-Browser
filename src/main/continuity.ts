// Continuity: each device publishes the tabs it has open, and tabs sent to other devices, in its own sync file.
// Nothing here touches the disk or Electron, so the privacy rules and the merge logic are tested directly.

/** Devices whose file has not been written for this long are hidden: probably reinstalled, retired or gone. */
export const STALE_AFTER_MS = 30 * 86_400_000;
/** A tab sent to another device is offered there for this long, then dropped by the sender. */
export const HANDOFF_TTL_MS = 7 * 86_400_000;

const MAX_URL = 4096;
const MAX_TITLE = 200;
const MAX_SPACES = 50;
const MAX_TABS_PER_SPACE = 500;
const MAX_TABS = 2000;
const MAX_HANDOFFS = 50;
const ID = /^[\w-]{1,64}$/;

export interface SyncedTab {
  url: string;
  title: string;
  pinned: boolean;
  /** Epoch ms the tab was last selected on its device. */
  lastActiveAt: number;
}

export interface SyncedTabSpace {
  id: string;
  name: string;
  color: string;
  tabs: SyncedTab[];
}

/** What one device has open, as published in its file. */
export interface DeviceTabs {
  activeSpaceId: string | null;
  spaces: SyncedTabSpace[];
}

/** A tab one device sent to another. It sits in the sender's file until the receiver acknowledges it or it expires. */
export interface Handoff {
  id: string;
  /** Receiving device id. */
  to: string;
  url: string;
  title: string;
  sentAt: number;
}

/** A tab as TabManager knows it, before privacy filtering. */
export interface LocalTab {
  spaceId: string;
  url: string;
  title: string;
  pinned: boolean;
  lastActiveAt: number;
  internal: boolean;
}

export interface LocalSpace {
  id: string;
  name: string;
  color: string;
  private?: boolean;
}

function clean(text: unknown, max: number): string {
  return typeof text === 'string' ? text.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/**
 * Whether a tab's address may leave this device. Only plain web pages: never Quiver's own pages, files on this disk,
 * data or blob URLs, or addresses that carry a user name or password.
 */
export function publishableUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > MAX_URL || /[\u0000- \u007f]/.test(value)) return false;
  const url = URL.parse(value);
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) return false;
  if (url.username || url.password || !url.hostname) return false;
  return true;
}

function finiteTime(value: unknown, now: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(value, now) : 0;
}

/** This device's open tabs as they may be published: no private Spaces, no internal pages, no credentials. */
export function collectDeviceTabs(spaces: readonly LocalSpace[], tabs: readonly LocalTab[], activeSpaceId: string | null, now: number): DeviceTabs {
  const out: SyncedTabSpace[] = [];
  let total = 0;
  for (const space of spaces) {
    if (space.private || out.length >= MAX_SPACES) continue;
    const seen = new Set<string>();
    const list: SyncedTab[] = [];
    for (const tab of tabs) {
      if (tab.spaceId !== space.id || tab.internal || !publishableUrl(tab.url) || seen.has(tab.url)) continue;
      if (list.length >= MAX_TABS_PER_SPACE || total >= MAX_TABS) break;
      seen.add(tab.url);
      list.push({ url: tab.url, title: clean(tab.title, MAX_TITLE), pinned: tab.pinned, lastActiveAt: finiteTime(tab.lastActiveAt, now) });
      total++;
    }
    if (list.length) out.push({ id: space.id, name: clean(space.name, 40) || 'Space', color: space.color, tabs: list });
  }
  const active = spaces.find((sp) => sp.id === activeSpaceId);
  return { activeSpaceId: active && !active.private && out.some((sp) => sp.id === active.id) ? active.id : null, spaces: out };
}

/** Validate another device's published tabs; anything that would not have been published is dropped again. */
export function normalizeDeviceTabs(raw: unknown, now: number): DeviceTabs | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const spaces: SyncedTabSpace[] = [];
  const ids = new Set<string>();
  let total = 0;
  for (const entry of Array.isArray(r.spaces) ? r.spaces.slice(0, MAX_SPACES) : []) {
    if (!entry || typeof entry !== 'object') continue;
    const s = entry as Record<string, unknown>;
    if (typeof s.id !== 'string' || !ID.test(s.id) || ids.has(s.id) || s.private === true) continue;
    ids.add(s.id);
    const seen = new Set<string>();
    const tabs: SyncedTab[] = [];
    for (const t of Array.isArray(s.tabs) ? s.tabs.slice(0, MAX_TABS_PER_SPACE) : []) {
      if (total >= MAX_TABS) break;
      if (!t || typeof t !== 'object') continue;
      const { url, title, pinned, lastActiveAt } = t as Record<string, unknown>;
      if (!publishableUrl(url) || seen.has(url)) continue;
      seen.add(url);
      tabs.push({ url, title: clean(title, MAX_TITLE), pinned: pinned === true, lastActiveAt: finiteTime(lastActiveAt, now) });
      total++;
    }
    if (!tabs.length) continue;
    spaces.push({
      id: s.id,
      name: clean(s.name, 40) || 'Space',
      color: typeof s.color === 'string' && /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : '#5b8cff',
      tabs,
    });
  }
  const activeSpaceId = typeof r.activeSpaceId === 'string' && ids.has(r.activeSpaceId) && spaces.some((sp) => sp.id === r.activeSpaceId) ? r.activeSpaceId : null;
  return { activeSpaceId, spaces };
}

export function normalizeHandoffs(raw: unknown, now: number): Handoff[] {
  const out: Handoff[] = [];
  const ids = new Set<string>();
  for (const entry of Array.isArray(raw) ? raw.slice(0, MAX_HANDOFFS) : []) {
    if (!entry || typeof entry !== 'object') continue;
    const h = entry as Record<string, unknown>;
    if (typeof h.id !== 'string' || !ID.test(h.id) || ids.has(h.id) || typeof h.to !== 'string' || !ID.test(h.to)) continue;
    if (!publishableUrl(h.url) || typeof h.sentAt !== 'number' || !Number.isFinite(h.sentAt)) continue;
    // Expired, or stamped implausibly far in the future by a device with a wrong clock.
    if (now - h.sentAt > HANDOFF_TTL_MS || h.sentAt - now > 86_400_000) continue;
    ids.add(h.id);
    out.push({ id: h.id, to: h.to, url: h.url, title: clean(h.title, MAX_TITLE), sentAt: h.sentAt });
  }
  return out;
}

export function normalizeIds(raw: unknown, limit = 200): string[] {
  return Array.isArray(raw) ? [...new Set(raw.filter((id): id is string => typeof id === 'string' && ID.test(id)))].slice(0, limit) : [];
}

/** The parts of another device's file that continuity reads. */
export interface ContinuityRemote {
  deviceId: string;
  deviceName: string;
  writtenAt: number;
  acceptsHandoff?: boolean;
  tabs?: DeviceTabs;
  handoffs?: Handoff[];
  handoffAck?: string[];
}

export interface OtherDevice {
  id: string;
  name: string;
  lastSeen: number;
  acceptsHandoff: boolean;
  /** Absent when that device does not publish its open tabs. */
  tabs?: DeviceTabs;
}

/**
 * Other devices to show, most recently seen first. Devices not seen for 30 days are hidden; when one device appears
 * under two ids (Quiver reinstalled with the same name), only the newer file is shown.
 */
export function otherDevices(remotes: readonly ContinuityRemote[], selfId: string, now: number): OtherDevice[] {
  const byName = new Map<string, OtherDevice>();
  for (const r of remotes) {
    if (r.deviceId === selfId) continue;
    const lastSeen = Math.min(r.writtenAt, now);
    if (!(lastSeen > 0) || now - lastSeen > STALE_AFTER_MS) continue;
    const device: OtherDevice = { id: r.deviceId, name: r.deviceName, lastSeen, acceptsHandoff: r.acceptsHandoff === true, ...(r.tabs ? { tabs: r.tabs } : {}) };
    const key = r.deviceName.toLowerCase();
    const known = byName.get(key);
    if (!known || known.lastSeen < lastSeen) byName.set(key, device);
  }
  return [...byName.values()].sort((a, b) => b.lastSeen - a.lastSeen || a.name.localeCompare(b.name));
}

export interface IncomingHandoff extends Handoff {
  fromId: string;
  from: string;
}

/** Tabs other devices sent here that this device has not opened or dismissed yet, newest first. */
export function incomingHandoffs(remotes: readonly ContinuityRemote[], selfId: string, seen: Readonly<Record<string, number>>, now: number): IncomingHandoff[] {
  const out: IncomingHandoff[] = [];
  for (const r of remotes) {
    if (r.deviceId === selfId || now - r.writtenAt > STALE_AFTER_MS) continue;
    for (const h of r.handoffs ?? []) {
      if (h.to === selfId && !(h.id in seen) && now - h.sentAt <= HANDOFF_TTL_MS) out.push({ ...h, fromId: r.deviceId, from: r.deviceName });
    }
  }
  return out.sort((a, b) => b.sentAt - a.sentAt);
}

/** The sender's outbox after this round: acknowledged and expired handoffs are dropped. */
export function pruneOutbox(outbox: readonly Handoff[], remotes: readonly ContinuityRemote[], now: number): Handoff[] {
  const acked = new Map(remotes.map((r) => [r.deviceId, new Set(r.handoffAck ?? [])]));
  return outbox.filter((h) => now - h.sentAt <= HANDOFF_TTL_MS && !acked.get(h.to)?.has(h.id)).slice(-MAX_HANDOFFS);
}

/** Forget handoffs that were opened or dismissed long enough ago that no sender still offers them. */
export function pruneSeen(seen: Readonly<Record<string, number>>, now: number): Record<string, number> {
  return Object.fromEntries(Object.entries(seen).filter(([id, at]) => ID.test(id) && typeof at === 'number' && now - at <= 2 * HANDOFF_TTL_MS).slice(-500));
}

export interface ContinuePlan {
  /** The local Space to open the tabs in, or null to create one named after the other device's Space. */
  spaceId: string | null;
  name: string;
  color: string;
  /** Addresses to open, in the other device's order, minus those already open in the target Space. */
  urls: { url: string; title: string }[];
  /** The tab to select afterwards: the one most recently used on the other device. */
  focusUrl: string | null;
}

/**
 * Plan "Continue here" for one of another device's Spaces: use the same Space here (same id, as Spaces sync keeps
 * them, else the same name), never a private one, and skip what is already open there.
 */
export function planContinue(remote: SyncedTabSpace, local: readonly LocalSpace[], openUrls: (spaceId: string) => Iterable<string>): ContinuePlan {
  const usable = local.filter((sp) => !sp.private);
  const target = usable.find((sp) => sp.id === remote.id) ?? usable.find((sp) => sp.name.trim().toLowerCase() === remote.name.trim().toLowerCase());
  const open = new Set(target ? openUrls(target.id) : []);
  const urls: ContinuePlan['urls'] = [];
  for (const tab of remote.tabs) {
    if (!publishableUrl(tab.url) || open.has(tab.url)) continue;
    open.add(tab.url);
    urls.push({ url: tab.url, title: tab.title });
  }
  const recent = [...remote.tabs].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
  return { spaceId: target?.id ?? null, name: remote.name, color: remote.color, urls, focusUrl: recent?.url ?? null };
}

/** "5 min ago"-style text for when a device was last seen. */
export function lastSeenLabel(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return h === 1 ? '1 hour ago' : `${h} hours ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}
