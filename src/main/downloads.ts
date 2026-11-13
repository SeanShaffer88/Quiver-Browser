import { shell, type DownloadItem, type Session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { DownloadInfo, DownloadState } from '../shared/types';

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const RISKY = new Set(['exe', 'msi', 'msix', 'appx', 'appxbundle', 'bat', 'cmd', 'com', 'scr', 'pif', 'ps1', 'psm1', 'vbs', 'vbe',
  'js', 'jse', 'wsf', 'wsh', 'hta', 'lnk', 'url', 'reg', 'jar', 'cpl', 'msc', 'dll', 'sys', 'iso', 'vhd', 'vhdx', 'img']);
export const DOWNLOAD_LIMIT = 100;

/** A file name that is safe to create on Windows: no folders, reserved names, forbidden or trailing characters. */
export function safeFileName(raw: string): string {
  let name = (raw.split(/[\\/]/).pop() ?? '').replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim();
  if (!name || name === '.' || name === '..') name = 'download';
  if (RESERVED.test(name)) name = `_${name}`;
  if (name.length > 200) {
    const ext = path.extname(name).slice(0, 20);
    name = name.slice(0, 200 - ext.length) + ext;
  }
  return name;
}

/** `name`, or `name (n)` before the extension when taken. Double extensions such as .tar.gz stay together. */
export function uniqueName(name: string, exists: (candidate: string) => boolean): string {
  if (!exists(name)) return name;
  const match = /^(.*?)((?:\.tar)?\.[^.]+)?$/i.exec(name)!;
  const stem = match[1] || name;
  const ext = match[2] ?? '';
  for (let i = 1; i < 10_000; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!exists(candidate)) return candidate;
  }
  return `${stem} (${Date.now()})${ext}`;
}

export function isRiskyFile(name: string): boolean {
  return RISKY.has(path.extname(name).slice(1).toLowerCase());
}

interface DownloadRecord extends DownloadInfo {
  partition: string;
  urlChain: string[];
  etag: string;
  lastModified: string;
}

function webUrl(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 8192 && /^(?:https?|ftp):\/\//i.test(value) && URL.canParse(value);
}

export function normalizeDownloads(raw: unknown): DownloadRecord[] {
  if (!Array.isArray(raw)) return [];
  const ids = new Set<string>();
  const out: DownloadRecord[] = [];
  for (const entry of raw.slice(0, DOWNLOAD_LIMIT * 2)) {
    if (!entry || typeof entry !== 'object') continue;
    const r = entry as Record<string, unknown>;
    if (typeof r.id !== 'string' || !/^[\w-]{1,64}$/.test(r.id) || ids.has(r.id) || !webUrl(r.url)) continue;
    if (typeof r.savePath !== 'string' || !path.win32.isAbsolute(r.savePath) && !path.posix.isAbsolute(r.savePath)) continue;
    ids.add(r.id);
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
    const states: DownloadState[] = ['progressing', 'completed', 'cancelled', 'interrupted'];
    let state = states.includes(r.state as DownloadState) ? (r.state as DownloadState) : 'interrupted';
    // Quiver closed while it was running.
    if (state === 'progressing') state = 'interrupted';
    const urlChain = Array.isArray(r.urlChain) ? r.urlChain.filter(webUrl).slice(0, 20) : [];
    const record: DownloadRecord = {
      id: r.id, url: r.url, filename: safeFileName(typeof r.filename === 'string' ? r.filename : ''), savePath: r.savePath,
      partition: typeof r.partition === 'string' && /^persist:[\w-]{1,80}$/.test(r.partition) ? r.partition : 'persist:quiver-shared',
      state, paused: false, received: num(r.received), total: num(r.total), speed: 0, startedAt: num(r.startedAt), endedAt: num(r.endedAt),
      mime: typeof r.mime === 'string' ? r.mime.slice(0, 100) : '', urlChain: urlChain.length ? urlChain : [r.url],
      etag: typeof r.etag === 'string' ? r.etag.slice(0, 200) : '', lastModified: typeof r.lastModified === 'string' ? r.lastModified.slice(0, 100) : '',
      canResume: false, risky: false,
    };
    record.canResume = state === 'interrupted' && record.received > 0 && !!(record.etag || record.lastModified);
    record.risky = isRiskyFile(record.filename);
    out.push(record);
    if (out.length === DOWNLOAD_LIMIT) break;
  }
  return out;
}

export type DownloadAction = 'pause' | 'resume' | 'cancel' | 'retry' | 'open' | 'show' | 'remove';

/** Tracks every download from web Spaces, persists the list, and runs the actions offered on quiver://downloads. */
export class Downloads {
  private readonly records: DownloadRecord[];
  private readonly live = new Map<string, DownloadItem>();
  private readonly attached = new WeakSet<Session>();
  private readonly lastBytes = new Map<string, { at: number; bytes: number }>();
  private emitTimer: NodeJS.Timeout | null = null;
  private nextId = Date.now();

  constructor(
    stored: unknown,
    private readonly options: {
      directory: () => string;
      askWhereToSave: () => boolean;
      fromPartition: (partition: string) => Session;
      persist: (records: DownloadInfo[]) => void;
      changed: () => void;
    },
  ) {
    this.records = normalizeDownloads(stored);
  }

  list(): DownloadInfo[] {
    return this.records.map(({ partition: _p, urlChain: _u, etag: _e, lastModified: _l, ...info }) => {
      const exists = info.state === 'completed' ? fs.existsSync(info.savePath) : true;
      return { ...info, missing: !exists };
    });
  }

  /** Active download count and overall progress, for the toolbar. */
  summary(): { active: number; progress: number | null } {
    const active = this.records.filter((r) => r.state === 'progressing');
    const total = active.reduce((sum, r) => sum + r.total, 0);
    const received = active.reduce((sum, r) => sum + r.received, 0);
    return { active: active.length, progress: active.length && total > 0 && active.every((r) => r.total > 0) ? received / total : null };
  }

  attach(ses: Session, partition: string): void {
    if (this.attached.has(ses)) return;
    this.attached.add(ses);
    ses.on('will-download', (_event, item) => this.track(item, partition));
  }

  private track(item: DownloadItem, partition: string): void {
    const dir = this.options.directory();
    const name = safeFileName(item.getFilename());
    const existing = this.records.find((r) => r.state === 'interrupted' && r.url === item.getURL() && r.savePath === item.getSavePath());
    if (!item.getSavePath()) {
      if (this.options.askWhereToSave()) {
        // Chromium otherwise prefers the last folder chosen in Save As.
        item.setSaveDialogOptions({ ...item.getSaveDialogOptions(), defaultPath: path.join(dir, name) });
      } else {
        try {
          fs.mkdirSync(dir, { recursive: true });
        } catch {
          /* Chromium reports the failure as an interrupted download */
        }
        item.setSavePath(path.join(dir, uniqueName(name, (n) => fs.existsSync(path.join(dir, n)))));
      }
    }
    const record: DownloadRecord = existing ?? {
      id: `dl-${(this.nextId++).toString(36)}`, url: item.getURL(), filename: name, savePath: item.getSavePath(), partition,
      state: 'progressing', paused: false, received: 0, total: item.getTotalBytes(), speed: 0, startedAt: Date.now(), endedAt: 0,
      mime: item.getMimeType().slice(0, 100), urlChain: item.getURLChain().filter(webUrl), etag: '', lastModified: '', canResume: false,
      risky: isRiskyFile(name),
    };
    if (!existing) this.records.unshift(record);
    record.state = 'progressing';
    this.live.set(record.id, item);
    const update = () => {
      const savePath = item.getSavePath();
      if (savePath) {
        record.savePath = savePath;
        record.filename = safeFileName(path.basename(savePath));
        record.risky = isRiskyFile(record.filename);
      }
      record.received = item.getReceivedBytes();
      record.total = item.getTotalBytes();
      record.paused = item.isPaused();
      record.etag = item.getETag().slice(0, 200);
      record.lastModified = item.getLastModifiedTime().slice(0, 100);
      const now = Date.now();
      const last = this.lastBytes.get(record.id);
      if (last && now > last.at) {
        const instant = ((record.received - last.bytes) * 1000) / (now - last.at);
        record.speed = record.paused ? 0 : Math.max(0, record.speed ? record.speed * 0.7 + instant * 0.3 : instant);
      }
      this.lastBytes.set(record.id, { at: now, bytes: record.received });
    };
    item.on('updated', (_event, state) => {
      update();
      record.state = state === 'interrupted' ? 'interrupted' : 'progressing';
      record.canResume = item.canResume();
      this.queueEmit();
    });
    item.once('done', (_event, state) => {
      update();
      this.live.delete(record.id);
      this.lastBytes.delete(record.id);
      record.speed = 0;
      record.endedAt = Date.now();
      record.state = state;
      record.canResume = state === 'interrupted' && !!(record.etag || record.lastModified) && record.received > 0;
      // A Save As dialog the person cancelled leaves nothing worth listing.
      if (state === 'cancelled' && !record.savePath) this.records.splice(this.records.indexOf(record), 1);
      this.save();
    });
    this.save();
  }

  private queueEmit(): void {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.options.changed();
    }, 400);
  }

  private save(): void {
    if (this.records.length > DOWNLOAD_LIMIT) {
      for (let i = this.records.length - 1; i >= 0 && this.records.length > DOWNLOAD_LIMIT; i--) {
        if (!this.live.has(this.records[i].id)) this.records.splice(i, 1);
      }
    }
    this.options.persist(this.records);
    this.options.changed();
  }

  /** Run an action from the downloads page. Returns an error message for the page, or '' on success. */
  async act(id: string, action: DownloadAction, confirmedRisky = false): Promise<string> {
    const record = this.records.find((r) => r.id === id);
    if (!record) return 'This download is no longer listed.';
    const item = this.live.get(id);
    switch (action) {
      case 'pause':
        // Pausing a live download holds its connection; Chromium resumes it in place.
        if (item && !item.isPaused()) item.pause();
        break;
      case 'resume':
        if (item) {
          if (item.isPaused() || item.canResume()) item.resume();
        } else if (record.state === 'interrupted' && record.canResume) {
          this.options.fromPartition(record.partition).createInterruptedDownload({
            path: record.savePath, urlChain: record.urlChain, mimeType: record.mime, offset: record.received,
            length: record.total, lastModified: record.lastModified, eTag: record.etag, startTime: record.startedAt / 1000,
          });
        } else {
          return 'This download cannot resume. Retry it instead.';
        }
        break;
      case 'cancel':
        item?.cancel();
        break;
      case 'retry': {
        if (item) return '';
        this.records.splice(this.records.indexOf(record), 1);
        this.options.fromPartition(record.partition).downloadURL(record.url);
        break;
      }
      case 'open': {
        if (record.state !== 'completed') return 'The download has not finished.';
        if (!fs.existsSync(record.savePath)) return 'The file was moved or deleted.';
        if (record.risky && !confirmedRisky) return 'confirm';
        const error = await shell.openPath(record.savePath);
        return error;
      }
      case 'show':
        if (fs.existsSync(record.savePath)) shell.showItemInFolder(record.savePath);
        else shell.openPath(path.dirname(record.savePath)).catch(() => undefined);
        break;
      case 'remove':
        if (item) return 'Cancel the download first.';
        this.records.splice(this.records.indexOf(record), 1);
        break;
    }
    this.save();
    return '';
  }

  clearFinished(): void {
    for (let i = this.records.length - 1; i >= 0; i--) if (!this.live.has(this.records[i].id)) this.records.splice(i, 1);
    this.save();
  }
}
