import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { hashSection, normalizeDeviceFile, planSync, SYNC_SECTIONS, type DeviceFile, type SyncMemory, type SyncSection } from './sync';

export const SYNC_DIR = 'Quiver Sync';
const FILE_LIMIT = 20 * 1024 * 1024;
const INTERVAL_MS = 60_000;

export interface SyncState {
  folder: string | null;
  deviceId: string;
  deviceName: string;
  include: Record<SyncSection, boolean>;
  memory: SyncMemory;
  last?: { at: number; ok: boolean; message: string; devices: string[] };
}

export interface SyncStatus {
  folder: string | null;
  deviceName: string;
  include: Record<SyncSection, boolean>;
  last?: SyncState['last'];
  syncing: boolean;
}

const DEFAULT_INCLUDE: Record<SyncSection, boolean> = { settings: true, bookmarks: true, spaces: true, research: true, boosts: false };

export function normalizeSyncState(raw: unknown, fallbackName: string): SyncState {
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
  return { folder, deviceId, deviceName, include, memory, ...(last ? { last } : {}) };
}

export interface SectionAdapter {
  get(): unknown;
  set(data: unknown): void;
}

/** Reads other devices' files, applies newer sections, and writes this device's file. One round at a time. */
export class SyncService {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly state: SyncState,
    private readonly sections: Record<SyncSection, SectionAdapter>,
    private readonly save: () => void,
    private readonly changed: () => void,
    private readonly now = () => Date.now(),
  ) {}

  status(): SyncStatus {
    return { folder: this.state.folder, deviceName: this.state.deviceName, include: { ...this.state.include }, last: this.state.last, syncing: !!this.running };
  }

  start(): void {
    this.stop();
    if (!this.state.folder) return;
    void this.syncNow();
    this.timer = setInterval(() => void this.syncNow(), INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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
    delete this.state.last;
    this.save();
    this.changed();
    this.start();
  }

  setOptions(include: Partial<Record<SyncSection, boolean>>, deviceName?: string): void {
    for (const name of SYNC_SECTIONS) if (typeof include[name] === 'boolean') this.state.include[name] = include[name]!;
    if (typeof deviceName === 'string' && deviceName.trim()) this.state.deviceName = deviceName.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60);
    this.save();
    this.changed();
  }

  syncNow(): Promise<void> {
    if (!this.state.folder) return Promise.resolve();
    this.running ??= this.round().finally(() => {
      this.running = null;
      this.changed();
    });
    return this.running;
  }

  private async round(): Promise<void> {
    const folder = this.state.folder!;
    const dir = path.join(folder, SYNC_DIR);
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
      const own: DeviceFile = { version: 1, deviceId: this.state.deviceId, deviceName: this.state.deviceName, writtenAt: this.now(), sections: plan.publish };
      const file = path.join(dir, `${this.state.deviceId}.json`);
      const temp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(temp, JSON.stringify(own));
      await fs.rename(temp, file);
      const applied = Object.keys(plan.apply);
      this.state.last = {
        at: this.now(), ok: errors.length === 0, devices: remotes.map((r) => r.deviceName),
        message: errors.length ? errors.join('; ') : applied.length ? `Updated ${applied.join(', ')} from other devices.` : 'Up to date.',
      };
    } catch (error) {
      this.state.last = { at: this.now(), ok: false, devices: [], message: message(error) };
    }
    this.save();
  }

  private async readRemotes(dir: string, errors: string[]): Promise<DeviceFile[]> {
    const remotes: DeviceFile[] = [];
    for (const name of await fs.readdir(dir)) {
      if (!name.endsWith('.json') || name === `${this.state.deviceId}.json`) continue;
      const file = path.join(dir, name);
      try {
        const stat = await fs.stat(file);
        if (!stat.isFile() || stat.size > FILE_LIMIT) continue;
        const parsed = normalizeDeviceFile(JSON.parse(await fs.readFile(file, 'utf8')));
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
