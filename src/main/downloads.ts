import { shell, type DownloadItem, type Session } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DownloadInfo, DownloadState, NativeKind } from '../shared/types';
import { JobControl, type Fetcher } from './native/job';
import { ftpDownload } from './native/ftp';
import { nativeKind, runDash, runHls, runMetalink } from './native/runners';
import { runWebDav } from './native/webdav';

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
  partialKey?: string;
  partialBytes?: number;
}

const PARTIAL_KEY = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const RESUME_START_TIMEOUT_MS = 10_000;

function hasResumeMetadata(record: DownloadRecord): boolean {
  return !record.kind && /^https?:\/\//i.test(record.url) && Number.isSafeInteger(record.received)
    && Number.isSafeInteger(record.total) && record.received > 0 && record.received < record.total
    && (!!record.etag && !record.etag.startsWith('W/') || !!record.lastModified);
}

async function regularFile(file: string): Promise<fs.Stats | undefined> {
  const stat = await fs.promises.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (stat && (!stat.isFile() || stat.nlink !== 1)) throw new Error('The download path must be a regular file with one link.');
  return stat;
}

function samePath(first: string, second: string): boolean {
  if (!first || !second) return false;
  return path.relative(first, second) === '';
}

/** Copy only the recorded contiguous bytes and never replace an existing file. */
async function copyPartial(source: string, destination: string, bytes: number): Promise<void> {
  const expected = await regularFile(source);
  const input = await fs.promises.open(source, 'r');
  try {
    const observed = await input.stat();
    if (!expected || !observed.isFile() || observed.nlink !== 1 || observed.ino !== expected.ino
      || observed.dev !== expected.dev || observed.size < bytes) {
      throw new Error('The partial download changed or is shorter than its saved progress.');
    }
    const output = await fs.promises.open(destination, 'wx');
    try {
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let offset = 0;
      while (offset < bytes) {
        const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, bytes - offset), offset);
        if (bytesRead === 0) throw new Error('The partial download copy is incomplete.');
        let written = 0;
        while (written < bytesRead) {
          const { bytesWritten } = await output.write(buffer, written, bytesRead - written, offset + written);
          if (bytesWritten === 0) throw new Error('The partial download copy could not be written.');
          written += bytesWritten;
        }
        offset += bytesRead;
      }
      await output.sync();
      await output.close();
    } catch (error) {
      await output.close().catch(() => undefined);
      await fs.promises.unlink(destination).catch(() => undefined);
      throw error;
    }
  } finally {
    await input.close();
  }
}

async function fileDigest(file: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

function webUrl(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 8192 && /^(?:https?|ftps?|(?:web)?davs?):\/\//i.test(value) && URL.canParse(value);
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
    const kinds = ['ftp', 'hls', 'dash', 'metalink', 'webdav'];
    if (typeof r.kind === 'string' && kinds.includes(r.kind)) record.kind = r.kind as NativeKind;
    if (typeof r.detail === 'string') record.detail = r.detail.slice(0, 200);
    if (typeof r.error === 'string') record.error = r.error.slice(0, 300);
    // Quiver's own downloaders restart with Retry; Chromium's can resume from a validator.
    if (typeof r.partialKey === 'string' && PARTIAL_KEY.test(r.partialKey) && r.partialBytes === record.received) {
      record.partialKey = r.partialKey;
      record.partialBytes = record.received;
    }
    record.canResume = state === 'interrupted' && hasResumeMetadata(record);
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
  private readonly jobs = new Map<string, JobControl>();
  private readonly attached = new WeakSet<Session>();
  private readonly resuming = new Map<DownloadRecord, NodeJS.Timeout | undefined>();
  private checkpointing = false;
  private readonly lastBytes = new Map<string, { at: number; bytes: number }>();
  private emitTimer: NodeJS.Timeout | null = null;
  private nextId = Date.now();

  constructor(
    stored: unknown,
    private readonly options: {
      directory: () => string;
      partialDirectory: string;
      askWhereToSave: () => boolean;
      fromPartition: (partition: string) => Session;
      persist: (records: DownloadInfo[]) => void;
      changed: () => void;
    },
  ) {
    this.records = normalizeDownloads(stored);
  }

  list(): DownloadInfo[] {
    return this.records.map(({ partition: _p, urlChain: _u, etag: _e, lastModified: _l, partialKey: _k, partialBytes: _b, ...info }) => {
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
    ses.on('will-download', (event, item) => {
      // A playlist, manifest or Metalink link means the media or files it describes, not the small text file itself.
      const kind = nativeKind(item.getURL(), item.getMimeType());
      if (kind && kind !== 'ftp') {
        event.preventDefault();
        this.startNative(kind, item.getURL(), partition);
        return;
      }
      this.track(item, partition);
    });
  }

  private async partialPath(key: string, createDirectory = false): Promise<string> {
    const directory = this.options.partialDirectory;
    if (createDirectory) await fs.promises.mkdir(directory, { recursive: true });
    const [entry, resolved] = await Promise.all([fs.promises.lstat(directory), fs.promises.realpath(directory)]);
    if (!entry.isDirectory() || entry.isSymbolicLink() || !samePath(directory, resolved)) {
      throw new Error('The download checkpoint directory was redirected.');
    }
    return path.join(directory, key);
  }

  private discardPartial(record: DownloadRecord): void {
    const key = record.partialKey;
    if (!key) return;
    delete record.partialKey;
    delete record.partialBytes;
    void this.partialPath(key).then((file) => fs.promises.unlink(file)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') console.warn('[quiver] could not remove a download checkpoint:', error.code);
    });
  }

  checkpointOnClose(): Promise<void> | undefined {
    const candidates = this.records.filter((record) => record.state === 'progressing' || record.state === 'interrupted')
      .filter((record) => hasResumeMetadata(record) && this.live.has(record.id));
    if (!candidates.length) return;
    this.checkpointing = true;
    for (const record of candidates) this.live.get(record.id)?.pause();
    return this.checkpointPartials(candidates);
  }

  private async checkpointPartials(records: DownloadRecord[]): Promise<void> {
    for (const record of records) {
      const { savePath, received } = record;
      const key = randomUUID();
      try {
        if (!this.live.has(record.id) || !hasResumeMetadata(record) || !await regularFile(savePath)) continue;
        const checkpoint = await this.partialPath(key, true);
        await copyPartial(savePath, checkpoint, received);
        if (!this.live.has(record.id)) {
          await fs.promises.unlink(checkpoint);
          continue;
        }
        this.discardPartial(record);
        record.partialKey = key;
        record.partialBytes = received;
        record.received = received;
      } catch (error) {
        console.warn('[quiver] could not preserve a partial download:', (error as NodeJS.ErrnoException).code ?? 'copy failed');
      }
    }
    this.save();
  }

  private pathInUse(file: string, except?: DownloadRecord): boolean {
    return this.records.some((record) => record !== except && samePath(file, record.savePath)
      && (this.live.has(record.id) || this.resuming.has(record)));
  }

  private async prepareResume(record: DownloadRecord): Promise<string> {
    if (this.pathInUse(record.savePath, record)) return 'Another download is already using this destination.';
    this.resuming.set(record, undefined);
    try {
      const existing = await regularFile(record.savePath);
      if (record.partialKey) {
        const partial = await this.partialPath(record.partialKey);
        if ((await regularFile(partial))?.size !== record.received) throw new Error('The download checkpoint is incomplete.');
        if (existing) {
          if (existing.size !== record.received || await fileDigest(record.savePath) !== await fileDigest(partial)) {
            throw new Error('The download destination changed.');
          }
        } else {
          await copyPartial(partial, record.savePath, record.received);
        }
      } else if (existing?.size !== record.received) {
        throw new Error('The partial download is missing or changed.');
      }
      const ses = this.options.fromPartition(record.partition);
      this.attach(ses, record.partition);
      const timeout = setTimeout(() => {
        this.resuming.delete(record);
        record.error = 'Could not start the saved download. Try Resume or Retry.';
        this.save();
      }, RESUME_START_TIMEOUT_MS);
      this.resuming.set(record, timeout);
      ses.createInterruptedDownload({
        path: record.savePath, urlChain: record.urlChain, mimeType: record.mime, offset: record.received,
        length: record.total, lastModified: record.lastModified, eTag: record.etag, startTime: record.startedAt / 1000,
      });
      return '';
    } catch {
      this.finishStartingResume(record);
      record.canResume = false;
      record.error = 'The saved download could not be resumed. Retry it instead.';
      this.save();
      return record.error;
    }
  }

  private finishStartingResume(record: DownloadRecord): void {
    clearTimeout(this.resuming.get(record));
    this.resuming.delete(record);
  }

  /** Start one of Quiver's own downloaders (FTP, HLS, DASH, Metalink). Files go to the downloads folder. */
  startNative(kind: NativeKind, url: string, partition: string): string {
    const parsed = new URL(url);
    const leaf = safeFileName(decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? parsed.host));
    const base = kind === 'hls' || kind === 'dash' ? leaf.replace(/\.(m3u8|mpd)$/i, '') || parsed.host : leaf;
    const id = `dl-${(this.nextId++).toString(36)}`;
    const record: DownloadRecord = {
      id, url: parsed.href.replace(/\/\/[^/@]*@/, '//'), filename: kind === 'metalink' ? base : kind === 'ftp' ? base : `${base} (${kind.toUpperCase()})`,
      savePath: path.join(this.options.directory(), base), partition, state: 'progressing', paused: false, received: 0, total: 0, speed: 0,
      startedAt: Date.now(), endedAt: 0, mime: '', urlChain: [], etag: '', lastModified: '', canResume: false, risky: isRiskyFile(base), kind, detail: 'Starting…',
    };
    this.records.unshift(record);
    const control = new JobControl();
    this.jobs.set(id, control);
    const dir = this.options.directory();
    const place = (name: string) => {
      fs.mkdirSync(dir, { recursive: true });
      const unique = uniqueName(safeFileName(name), (n) => fs.existsSync(path.join(dir, n)) || fs.existsSync(path.join(dir, `${n}.part`)));
      return path.join(dir, unique);
    };
    const ses = this.options.fromPartition(partition);
    const fetcher: Fetcher = (u, init) => ses.fetch(u, { ...init, credentials: 'include' } as RequestInit);
    let lastAt = Date.now();
    let lastBytes = 0;
    const ctx = {
      fetch: fetcher, control,
      progress: (p: { received: number; total: number; detail: string }) => {
        const now = Date.now();
        if (now - lastAt >= 500) {
          const instant = ((p.received - lastBytes) * 1000) / (now - lastAt);
          record.speed = control.paused ? 0 : record.speed ? record.speed * 0.7 + instant * 0.3 : instant;
          lastAt = now;
          lastBytes = p.received;
        }
        record.received = p.received;
        record.total = p.total;
        if (p.detail) record.detail = p.detail;
        this.queueEmit();
      },
    };
    const run = async (): Promise<string[]> => {
      if (kind === 'hls') return runHls(url, base, ctx, place);
      if (kind === 'dash') return runDash(url, base, ctx, place);
      if (kind === 'metalink') return runMetalink(url, ctx, place);
      if (kind === 'webdav') return runWebDav(url, ctx, place);
      const final = place(base);
      record.savePath = final;
      // Pausing FTP closes the data connection; resuming reconnects and continues with REST.
      for (;;) {
        try {
          await ftpDownload(url, `${final}.part`, ctx);
          break;
        } catch (error) {
          if (!control.paused) throw error;
          await control.ready();
        }
      }
      fs.renameSync(`${final}.part`, final);
      return [final];
    };
    void run().then((files) => {
      record.state = 'completed';
      record.savePath = files[0];
      record.filename = path.basename(files[0]) + (files.length > 1 ? ` and ${files.length - 1} more` : '');
      record.risky = files.some((f) => isRiskyFile(f));
      if (record.total === 0 || record.received > record.total) record.total = record.received;
      record.detail = kind === 'dash' ? (files.length > 1 ? 'Video and audio saved as separate files' : 'Video and audio in one file') : record.detail?.replace(/^\d+ of \d+ (segments|parts)/, '').replace(/^ · /, '') || '';
    }, (error: unknown) => {
      if (control.cancelled) {
        record.state = 'cancelled';
        if (kind === 'ftp') fs.rmSync(`${record.savePath}.part`, { force: true });
      } else {
        record.state = 'interrupted';
        record.error = error instanceof Error ? error.message : String(error);
      }
    }).finally(() => {
      this.jobs.delete(id);
      record.speed = 0;
      record.paused = false;
      record.endedAt = Date.now();
      this.save();
    });
    this.save();
    return id;
  }

  private track(item: DownloadItem, partition: string): void {
    const dir = this.options.directory();
    const name = safeFileName(item.getFilename());
    const initiallyInterrupted = item.getState() === 'interrupted';
    const existing = initiallyInterrupted ? [...this.resuming.keys()].find((record) =>
      record.partition === partition && record.url === item.getURL() && samePath(record.savePath, item.getSavePath())) : undefined;
    if (existing) {
      this.finishStartingResume(existing);
      delete existing.error;
    }
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
        item.setSavePath(path.join(dir, uniqueName(name, (candidate) => {
          const file = path.join(dir, candidate);
          return fs.existsSync(file) || this.pathInUse(file);
        })));
      }
    }
    const record: DownloadRecord = existing ?? {
      id: `dl-${(this.nextId++).toString(36)}`, url: item.getURL(), filename: name, savePath: item.getSavePath(), partition,
      state: 'progressing', paused: false, received: 0, total: item.getTotalBytes(), speed: 0, startedAt: Date.now(), endedAt: 0,
      mime: item.getMimeType().slice(0, 100), urlChain: item.getURLChain().filter(webUrl), etag: '', lastModified: '', canResume: false,
      risky: isRiskyFile(name),
    };
    if (!existing) this.records.unshift(record);
    record.state = initiallyInterrupted ? 'interrupted' : 'progressing';
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
      if (this.checkpointing && record.partialKey && item.getState() === 'cancelled') return;
      update();
      record.state = state === 'interrupted' ? 'interrupted' : 'progressing';
      record.canResume = item.canResume();
      this.queueEmit();
    });
    item.once('done', (_event, state) => {
      this.live.delete(record.id);
      this.lastBytes.delete(record.id);
      // Chromium cancels live items and removes their target files during shutdown.
      // The independent checkpoint becomes the resume source for the next launch.
      if (this.checkpointing && record.partialKey && state === 'cancelled') return;
      update();
      record.speed = 0;
      record.endedAt = Date.now();
      record.state = state;
      record.canResume = state === 'interrupted' && hasResumeMetadata(record);
      if (state !== 'interrupted' || record.received !== record.partialBytes) this.discardPartial(record);
      // A Save As dialog the person cancelled leaves nothing worth listing.
      if (state === 'cancelled' && !record.savePath) this.records.splice(this.records.indexOf(record), 1);
      this.save();
    });
    this.save();
    if (existing) setImmediate(() => {
      if (this.live.get(record.id) === item) item.resume();
    });
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
        const record = this.records[i];
        if (!this.live.has(record.id) && !this.jobs.has(record.id) && !this.resuming.has(record)) {
          this.discardPartial(record);
          this.records.splice(i, 1);
        }
      }
    }
    this.options.persist(this.records);
    this.options.changed();
  }

  /** Run an action from the downloads page. Returns an error message for the page, or '' on success. */
  async act(id: string, action: DownloadAction, confirmedRisky = false): Promise<string> {
    const record = this.records.find((r) => r.id === id);
    if (!record) return 'This download is no longer listed.';
    if (this.checkpointing) return 'Quiver is preserving downloads before closing.';
    if (this.resuming.has(record)) return 'This download is already resuming.';
    const job = this.jobs.get(id);
    if (record.kind && record.kind !== 'chromium') {
      const kind = record.kind;
      switch (action) {
        case 'pause': job?.pause(); record.paused = !!job; record.speed = 0; break;
        case 'resume': job?.resume(); record.paused = false; break;
        case 'cancel': job?.cancel(); break;
        case 'retry':
          if (job) return '';
          this.records.splice(this.records.indexOf(record), 1);
          this.startNative(kind, record.url, record.partition);
          return '';
        case 'remove':
          if (job) return 'Cancel the download first.';
          this.records.splice(this.records.indexOf(record), 1);
          break;
        default:
          break;
      }
      if (action === 'pause' || action === 'resume' || action === 'cancel' || action === 'remove') { this.save(); return ''; }
    }
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
          return this.prepareResume(record);
        } else {
          return 'This download cannot resume. Retry it instead.';
        }
        break;
      case 'cancel':
        item?.cancel();
        break;
      case 'retry': {
        if (item) return '';
        this.discardPartial(record);
        this.records.splice(this.records.indexOf(record), 1);
        const ses = this.options.fromPartition(record.partition);
        this.attach(ses, record.partition);
        ses.downloadURL(record.url);
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
        this.discardPartial(record);
        this.records.splice(this.records.indexOf(record), 1);
        break;
    }
    this.save();
    return '';
  }

  clearFinished(): void {
    if (this.checkpointing) return;
    for (let i = this.records.length - 1; i >= 0; i--) {
      const record = this.records[i];
      if (!this.live.has(record.id) && !this.jobs.has(record.id) && !this.resuming.has(record)) {
        this.discardPartial(record);
        this.records.splice(i, 1);
      }
    }
    this.save();
  }
}
