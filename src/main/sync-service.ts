import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  HANDOFF_TTL_MS, incomingHandoffs, normalizeHandoffs, otherDevices, pruneOutbox, pruneSeen, publishableUrl,
  type DeviceTabs, type Handoff, type IncomingHandoff, type OtherDevice, type SyncedTab, type SyncedTabSpace,
} from './continuity';
import { hashSection, normalizeDeviceFile, planSync, SYNC_SECTIONS, type DeviceFile, type SyncMemory, type SyncSection } from './sync';

export const SYNC_DIR = 'Quiver Sync';
const FILE_LIMIT = 20 * 1024 * 1024;
const INTERVAL_MS = 60_000;
/** Open tabs are published this long after they change. */
export const TABS_DELAY_MS = 2_000;
/** Other devices' files are read this long after the folder reports a change (sync clients write in bursts). */
const WATCH_DELAY_MS = 500;
/** How often the folder is checked for changed files: often when it cannot be watched, rarely as a backstop. */
const POLL_MS = 5_000;
const WATCHED_POLL_MS = 30_000;
/** An unchanged device file is still rewritten this often, so other devices can tell when it was last seen. */
const HEARTBEAT_MS = 5 * 60_000;

export interface SyncState {
  folder: string | null;
  deviceId: string;
  deviceName: string;
  include: Record<SyncSection, boolean>;
  memory: SyncMemory;
  /** Publish this device's open tabs and show other devices' tabs. */
  openTabs: boolean;
  /** Tabs sent to other devices that they have not acknowledged yet. */
  outbox: Handoff[];
  /** Handoffs this device opened or dismissed, by id, with when. */
  handoffSeen: Record<string, number>;
  last?: { at: number; ok: boolean; message: string; devices: string[] };
}

export interface SyncStatus {
  folder: string | null;
  deviceName: string;
  include: Record<SyncSection, boolean>;
  openTabs: boolean;
  last?: SyncState['last'];
  syncing: boolean;
}

const DEFAULT_INCLUDE: Record<SyncSection, boolean> = { settings: true, bookmarks: true, spaces: true, research: true, boosts: false };

export function normalizeSyncState(raw: unknown, fallbackName: string, now = Date.now()): SyncState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const include = { ...DEFAULT_INCLUDE };
  const given = (r.include && typeof r.include === 'object' ? r.include : {}) as Record<string, unknown>;
  for (const name of SYNC_SECTIONS) if (typeof given[name] === 'boolean') include[name] = given[name] as boolean;
  const memory: SyncMemory = {};
  const m = (r.memory && typeof r.memory === 'object' ? r.memory : {}) as Record<string, unknown>;
  for (const name of SYNC_SECTIONS) {
    const entry = m[name] as Record<string, unknown> | undefined;
    if (entry && typeof entry.hash === 'string' && typeof entry.updatedAt === 'number') memory[name] = { hash: entry.hash, updatedAt: entry.updatedAt };
  }
  const folder = typeof r.folder === 'string' && path.isAbsolute(r.folder) ? path.resolve(r.folder) : null;
  const deviceId = typeof r.deviceId === 'string' && /^[\w-]{1,64}$/.test(r.deviceId) ? r.deviceId : randomUUID();
  const deviceName = typeof r.deviceName === 'string' && r.deviceName.trim() ? r.deviceName.trim().slice(0, 60) : fallbackName.slice(0, 60);
  const last = r.last && typeof r.last === 'object' ? r.last as SyncState['last'] : undefined;
  // Open tabs are on for sync set up from now on; a folder already syncing before this existed keeps them off
  // until the person turns them on, so no device starts publishing its tabs without being asked.
  const openTabs = typeof r.openTabs === 'boolean' ? r.openTabs : folder === null;
  const outbox = normalizeHandoffs(r.outbox, now);
  const seen = r.handoffSeen && typeof r.handoffSeen === 'object' ? pruneSeen(r.handoffSeen as Record<string, number>, now) : {};
  return { folder, deviceId, deviceName, include, memory, openTabs, outbox, handoffSeen: seen, ...(last ? { last } : {}) };
}

export interface SectionAdapter {
  get(): unknown;
  set(data: unknown): void;
}

export interface ContinuityAdapter {
  /** This device's open tabs, already filtered for publishing. */
  tabs(): DeviceTabs;
  /** Other devices or tabs sent here may have changed. */
  changed(): void;
}

type Job = 'round' | 'publish';

/**
 * Reads other devices' files, applies newer sections, and writes this device's file. One job at a time: a full
 * round, or a quick publish of open tabs and sent tabs that does not read other devices.
 */
export class SyncService {
  private timer: NodeJS.Timeout | null = null;
  private poller: NodeJS.Timeout | null = null;
  private watcher: FSWatcher | null = null;
  private watchDelay: NodeJS.Timeout | null = null;
  private tabsDelay: NodeJS.Timeout | null = null;
  private pollSignature: string | null = null;
  private running: Promise<void> | null = null;
  private queued: { job: Job; promise: Promise<void> } | null = null;
  private remotes: DeviceFile[] = [];
  /** Sections as last published, reused by quick publishes. */
  private published: DeviceFile['sections'] | null = null;
  private written: { body: string; at: number } | null = null;
  private tabsHash = '';

  constructor(
    private readonly state: SyncState,
    private readonly sections: Record<SyncSection, SectionAdapter>,
    private readonly save: () => void,
    private readonly changed: () => void,
    private readonly now = () => Date.now(),
    private readonly continuity?: ContinuityAdapter,
  ) {}

  private get dir(): string | null {
    return this.state.folder && path.join(this.state.folder, SYNC_DIR);
  }

  status(): SyncStatus {
    return {
      folder: this.state.folder, deviceName: this.state.deviceName, include: { ...this.state.include }, openTabs: this.state.openTabs,
      last: this.state.last, syncing: !!this.running,
    };
  }

  start(): void {
    this.stop();
    if (!this.state.folder) return;
    void this.syncNow().then(() => this.watch());
    this.timer = setInterval(() => void this.syncNow(), INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.poller) clearInterval(this.poller);
    if (this.watchDelay) clearTimeout(this.watchDelay);
    if (this.tabsDelay) clearTimeout(this.tabsDelay);
    this.watcher?.close();
    this.timer = this.poller = this.watchDelay = this.tabsDelay = null;
    this.watcher = null;
    this.pollSignature = null;
  }

  async setFolder(folder: string | null): Promise<void> {
    if (folder !== null) {
      if (!path.isAbsolute(folder)) throw new Error('Choose a full folder path.');
      const stat = await fs.stat(folder);
      if (!stat.isDirectory()) throw new Error('That is not a folder.');
    }
    this.state.folder = folder === null ? null : path.resolve(folder);
    // A new folder starts fresh: what was published elsewhere says nothing about it.
    this.state.memory = {};
    this.state.outbox = [];
    delete this.state.last;
    this.remotes = [];
    this.published = null;
    this.written = null;
    this.save();
    this.changed();
    this.continuity?.changed();
    this.start();
  }

  setOptions(include: Partial<Record<SyncSection | 'openTabs', boolean>>, deviceName?: string): void {
    for (const name of SYNC_SECTIONS) if (typeof include[name] === 'boolean') this.state.include[name] = include[name]!;
    const tabsChanged = typeof include.openTabs === 'boolean' && include.openTabs !== this.state.openTabs;
    if (typeof include.openTabs === 'boolean') this.state.openTabs = include.openTabs;
    if (typeof deviceName === 'string' && deviceName.trim()) this.state.deviceName = deviceName.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60);
    this.save();
    this.changed();
    if (tabsChanged) {
      // Turning it off removes the tabs from this device's file right away.
      void this.run('publish');
      this.continuity?.changed();
    }
  }

  syncNow(): Promise<void> {
    return this.run('round');
  }

  /** TabManager calls this whenever its state changes; open tabs are published shortly after they really change. */
  tabsChanged(): void {
    if (!this.state.folder || !this.state.openTabs || !this.continuity || this.tabsDelay) return;
    if (hashSection(this.continuity.tabs()) === this.tabsHash) return;
    this.tabsDelay = setTimeout(() => {
      this.tabsDelay = null;
      void this.run('publish');
    }, TABS_DELAY_MS);
    this.tabsDelay.unref?.();
  }

  /** Other devices seen in the last 30 days, most recent first. Their tabs are included when open tabs are on. */
  devices(): OtherDevice[] {
    if (!this.state.folder) return [];
    const list = otherDevices(this.remotes, this.state.deviceId, this.now());
    return this.state.openTabs ? list : list.map(({ tabs: _tabs, ...device }) => device);
  }

  /** Devices a tab can be sent to. */
  sendTargets(): OtherDevice[] {
    return this.devices().filter((d) => d.acceptsHandoff);
  }

  remoteSpace(deviceId: string, spaceId?: string): SyncedTabSpace | undefined {
    const tabs = this.devices().find((d) => d.id === deviceId)?.tabs;
    const id = spaceId ?? tabs?.activeSpaceId;
    return tabs?.spaces.find((sp) => sp.id === id);
  }

  remoteTab(deviceId: string, url: string): SyncedTab | undefined {
    for (const space of this.devices().find((d) => d.id === deviceId)?.tabs?.spaces ?? []) {
      const tab = space.tabs.find((t) => t.url === url);
      if (tab) return tab;
    }
    return undefined;
  }

  /** Queue a tab for another device. Only web addresses without credentials can be sent. */
  sendTab(deviceId: string, url: string, title: string): boolean {
    const target = this.sendTargets().find((d) => d.id === deviceId);
    if (!target || !publishableUrl(url)) return false;
    const [handoff] = normalizeHandoffs([{ id: randomUUID(), to: target.id, url, title, sentAt: this.now() }], this.now());
    if (!handoff) return false;
    this.state.outbox = [...this.state.outbox, handoff].slice(-50);
    this.save();
    void this.run('publish');
    return true;
  }

  /** Tabs other devices sent here that are waiting for Open or Dismiss. */
  pendingHandoffs(): IncomingHandoff[] {
    if (!this.state.folder) return [];
    return incomingHandoffs(this.remotes, this.state.deviceId, this.state.handoffSeen, this.now());
  }

  /** Mark a waiting handoff as handled and return it, so its sender can drop it. */
  takeHandoff(id: string): IncomingHandoff | undefined {
    const handoff = this.pendingHandoffs().find((h) => h.id === id);
    if (!handoff) return undefined;
    this.state.handoffSeen = { ...this.state.handoffSeen, [id]: this.now() };
    this.save();
    void this.run('publish');
    this.continuity?.changed();
    return handoff;
  }

  /** Run a job after the current one; a waiting publish is upgraded when a round is asked for. */
  private run(job: Job): Promise<void> {
    if (!this.state.folder) return Promise.resolve();
    if (this.queued) {
      if (job === 'round') this.queued.job = 'round';
      return this.queued.promise;
    }
    const entry: { job: Job; promise: Promise<void> } = { job, promise: Promise.resolve() };
    entry.promise = (this.running ?? Promise.resolve()).then(async () => {
      if (this.queued === entry) this.queued = null;
      this.running = entry.promise;
      if (!this.state.folder) return;
      if (entry.job === 'round' || !this.published) await this.round();
      else await this.publish();
    }).finally(() => {
      if (this.running === entry.promise) this.running = null;
      if (entry.job === 'round') this.changed();
    });
    this.queued = entry;
    return entry.promise;
  }

  private async round(): Promise<void> {
    const dir = this.dir!;
    const errors: string[] = [];
    try {
      await fs.mkdir(dir, { recursive: true });
      const remotes = await this.readRemotes(dir, errors);
      const local: Partial<Record<SyncSection, unknown>> = {};
      for (const name of SYNC_SECTIONS) {
        if (!this.state.include[name]) continue;
        try {
          local[name] = this.sections[name].get();
        } catch (error) {
          errors.push(`${name}: ${message(error)}`);
        }
      }
      const plan = planSync(local, this.state.memory, remotes, this.now());
      for (const [name, data] of Object.entries(plan.apply) as [SyncSection, unknown][]) {
        try {
          this.sections[name].set(data);
          // Remember the data as it reads back after validation, so normalization is not mistaken for an edit.
          const applied = this.sections[name].get();
          this.state.memory[name] = { hash: hashSection(applied), updatedAt: this.state.memory[name]!.updatedAt };
          plan.publish[name] = { updatedAt: this.state.memory[name]!.updatedAt, data: applied };
        } catch (error) {
          errors.push(`${name}: ${message(error)}`);
        }
      }
      this.remotes = remotes;
      this.state.outbox = pruneOutbox(this.state.outbox, remotes, this.now());
      this.state.handoffSeen = pruneSeen(this.state.handoffSeen, this.now());
      this.published = plan.publish;
      await this.writeOwn(dir, plan.publish);
      const applied = Object.keys(plan.apply);
      this.state.last = {
        at: this.now(), ok: errors.length === 0, devices: otherDevices(remotes, this.state.deviceId, this.now()).map((r) => r.name),
        message: errors.length ? errors.join('; ') : applied.length ? `Updated ${applied.join(', ')} from other devices.` : 'Up to date.',
      };
    } catch (error) {
      this.state.last = { at: this.now(), ok: false, devices: [], message: message(error) };
    }
    this.save();
    this.continuity?.changed();
  }

  /** Rewrite this device's file with the sections from the last round and the current tabs and handoffs. */
  private async publish(): Promise<void> {
    try {
      await fs.mkdir(this.dir!, { recursive: true });
      await this.writeOwn(this.dir!, this.published!);
    } catch {
      // The next round reports the folder's problem.
    }
  }

  private async writeOwn(dir: string, sections: DeviceFile['sections']): Promise<void> {
    const tabs = this.state.openTabs && this.continuity ? this.continuity.tabs() : undefined;
    const now = this.now();
    const ack = Object.entries(this.state.handoffSeen).filter(([, at]) => now - at <= HANDOFF_TTL_MS * 2).map(([id]) => id);
    const content: Omit<DeviceFile, 'writtenAt'> = {
      version: 1, deviceId: this.state.deviceId, deviceName: this.state.deviceName, sections, acceptsHandoff: true,
      ...(tabs ? { tabs } : {}),
      ...(this.state.outbox.length ? { handoffs: this.state.outbox } : {}),
      ...(ack.length ? { handoffAck: ack } : {}),
    };
    this.tabsHash = tabs ? hashSection(tabs) : '';
    const body = JSON.stringify(content);
    // Unchanged files are left alone between heartbeats, so the sync client is not kept busy uploading them.
    if (this.written && this.written.body === body && now - this.written.at < HEARTBEAT_MS) return;
    const own: DeviceFile = { ...content, writtenAt: now };
    const file = path.join(dir, `${this.state.deviceId}.json`);
    const temp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(own));
    await fs.rename(temp, file);
    this.written = { body, at: now };
  }

  private isRemoteFile(name: string | null | undefined): boolean {
    return !!name && name.endsWith('.json') && name !== `${this.state.deviceId}.json`;
  }

  /** Watch the folder so other devices' changes are read within seconds of the sync client delivering them. */
  private watch(): void {
    const dir = this.dir;
    if (!dir || this.watcher || !this.timer) return;
    try {
      this.watcher = watch(dir, { persistent: false }, (_event, filename) => {
        // Some platforms leave out the name; then any change may be another device's.
        if (filename === null || this.isRemoteFile(filename.toString())) this.remoteChanged();
      });
      this.watcher.on('error', () => {
        this.watcher?.close();
        this.watcher = null;
        this.startPolling(POLL_MS);
      });
      this.startPolling(WATCHED_POLL_MS);
    } catch {
      // Network drives and some sync clients' virtual folders cannot be watched.
      this.watcher = null;
      this.startPolling(POLL_MS);
    }
  }

  private startPolling(ms: number): void {
    if (this.poller) clearInterval(this.poller);
    this.poller = setInterval(() => void this.poll(), ms);
    this.poller.unref?.();
  }

  /** Compare names, sizes and modification times of other devices' files with the last check. */
  private async poll(): Promise<void> {
    const dir = this.dir;
    if (!dir) return;
    try {
      const parts: string[] = [];
      for (const name of (await fs.readdir(dir)).sort()) {
        if (!this.isRemoteFile(name)) continue;
        const stat = await fs.stat(path.join(dir, name)).catch(() => null);
        if (stat) parts.push(`${name}:${stat.size}:${stat.mtimeMs}`);
      }
      const signature = parts.join('|');
      if (this.pollSignature !== null && signature !== this.pollSignature) this.remoteChanged();
      this.pollSignature = signature;
    } catch {
      // The folder may be offline; the regular round reports it.
    }
  }

  private remoteChanged(): void {
    if (this.watchDelay) return;
    this.watchDelay = setTimeout(() => {
      this.watchDelay = null;
      void this.syncNow();
    }, WATCH_DELAY_MS);
    this.watchDelay.unref?.();
  }

  private async readRemotes(dir: string, errors: string[]): Promise<DeviceFile[]> {
    const remotes: DeviceFile[] = [];
    for (const name of await fs.readdir(dir)) {
      if (!this.isRemoteFile(name)) continue;
      const file = path.join(dir, name);
      try {
        const stat = await fs.stat(file);
        if (!stat.isFile() || stat.size > FILE_LIMIT) continue;
        const parsed = normalizeDeviceFile(JSON.parse(await fs.readFile(file, 'utf8')), this.now());
        if (parsed && parsed.deviceId !== this.state.deviceId && `${parsed.deviceId}.json` === name) remotes.push(parsed);
      } catch (error) {
        // A file mid-download by the sync client is skipped this round.
        errors.push(`${name}: ${message(error)}`);
      }
    }
    return remotes;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
