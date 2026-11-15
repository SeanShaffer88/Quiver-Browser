import { nativeImage, session, type BaseWindow, type NativeImage, type Rectangle, type WebContents, type WebContentsView } from 'electron';

/** Captures wider or taller than this are scaled down before they are stored. */
export const CAPTURE_MAX_SIDE = 4096;
const MIN_SIDE = 8;
const ICON_BYTES_LIMIT = 256 * 1024;

/** The selection the capture page sent, clamped to the page area, or null for "the whole visible page". */
export function captureRect(raw: unknown, width: number, height: number): Rectangle | null | undefined {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const vals = [r.x, r.y, r.width, r.height];
  if (!vals.every((v) => typeof v === 'number' && Number.isFinite(v))) return undefined;
  let [x, y, w, h] = vals as number[];
  if (w < 0) { x += w; w = -w; }
  if (h < 0) { y += h; h = -h; }
  const left = Math.max(0, Math.floor(x));
  const top = Math.max(0, Math.floor(y));
  const right = Math.min(width, Math.ceil(x + w));
  const bottom = Math.min(height, Math.ceil(y + h));
  if (right - left < MIN_SIDE || bottom - top < MIN_SIDE) return undefined;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Scale a capture so neither side exceeds CAPTURE_MAX_SIDE. */
export function fitSize(width: number, height: number, max = CAPTURE_MAX_SIDE): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** A tab's favicon as a small PNG, fetched through the tab's own session (so it usually comes from cache). */
export async function faviconPng(url: string, partition: string): Promise<Buffer | null> {
  try {
    let image: NativeImage;
    if (url.startsWith('data:image/')) {
      if (url.length > ICON_BYTES_LIMIT * 1.4) return null;
      image = nativeImage.createFromDataURL(url);
    } else {
      const parsed = URL.parse(url);
      if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) return null;
      const response = await session.fromPartition(partition).fetch(parsed.href, { signal: AbortSignal.timeout(4000), credentials: 'omit' } as RequestInit);
      if (!response.ok) return null;
      const body = Buffer.from(await response.arrayBuffer());
      if (body.length > ICON_BYTES_LIMIT) return null;
      image = nativeImage.createFromBuffer(body);
    }
    if (image.isEmpty()) return null;
    return image.resize({ width: 32, height: 32, quality: 'best' }).toPNG();
  } catch {
    return null;
  }
}

export interface CaptureTarget {
  tabId: number;
  boardId: string;
  boardName: string;
  contents: WebContents;
  bounds: Rectangle;
}

export interface CaptureResult { png: Buffer; width: number; height: number }

/**
 * Capture mode: a transparent Quiver page laid over the tab, where the person drags a rectangle (or presses Enter
 * for the whole visible page). Esc cancels. Only one capture runs at a time.
 */
export class CaptureMode {
  private target: CaptureTarget | null = null;

  constructor(private readonly win: BaseWindow, readonly view: WebContentsView, private readonly stillValid: (target: CaptureTarget) => boolean) {
    view.setVisible(false);
  }

  get active(): boolean {
    return this.target !== null;
  }

  start(target: CaptureTarget): boolean {
    if (this.win.isDestroyed() || target.contents.isDestroyed() || this.view.webContents.isDestroyed()) return false;
    this.target = target;
    this.view.setBounds(target.bounds);
    this.win.contentView.addChildView(this.view);
    this.view.setVisible(true);
    this.view.webContents.focus();
    this.view.webContents.send('capture:start', { boardName: target.boardName, width: target.bounds.width, height: target.bounds.height });
    return true;
  }

  cancel(): void {
    const target = this.target;
    this.target = null;
    if (!this.view.webContents.isDestroyed()) this.view.setVisible(false);
    if (target && !target.contents.isDestroyed()) target.contents.focus();
  }

  /** Take the capture. Resolves the target and image, undefined when cancelled, or a message when it failed. */
  async finish(raw: unknown): Promise<{ target: CaptureTarget; image: CaptureResult } | string | undefined> {
    const target = this.target;
    if (!target) return undefined;
    const rect = captureRect(raw, target.bounds.width, target.bounds.height);
    if (rect === undefined) return 'Drag a larger area, or press Enter to capture the whole page.';
    this.cancel();
    if (target.contents.isDestroyed() || !this.stillValid(target)) return 'The page changed before it could be captured.';
    let image = await target.contents.capturePage(rect ?? undefined);
    if (image.isEmpty()) return 'Quiver could not capture this page.';
    const size = image.getSize();
    const fitted = fitSize(size.width, size.height);
    if (fitted.width !== size.width) image = image.resize({ ...fitted, quality: 'best' });
    const out = image.getSize();
    return { target, image: { png: image.toPNG(), width: out.width, height: out.height } };
  }
}
