/**
 * Little Quiver: links from other apps open in a small window of their own (see little-quiver.ts). This module holds
 * the parts that need no Electron, so they can be unit tested: sizes, cascading placement and the toolbar label.
 */

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Size {
  x: number;
  y: number;
}

/** Height of the compact toolbar drawn above the page. */
export const LITTLE_TOOLBAR_H = 40;
export const LITTLE_DEFAULT_SIZE: Size = { width: 960, height: 720 };
export const LITTLE_MIN_SIZE: Size = { width: 420, height: 320 };
/** Each further window opens this much lower and to the right of the previous one. */
export const LITTLE_CASCADE_STEP = 28;
/** After this many steps the cascade starts again from the first position. */
export const LITTLE_CASCADE_STEPS = 8;
const MAX_DIMENSION = 16384;

/** A remembered window size from the state file, or undefined when it is missing or not a sensible size. */
export function normalizeLittleSize(raw: unknown): Size | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const { width, height } = raw as Partial<Record<keyof Size, unknown>>;
  const ok = (n: unknown, min: number): n is number => typeof n === 'number' && Number.isInteger(n) && n >= min && n <= MAX_DIMENSION;
  return ok(width, LITTLE_MIN_SIZE.width) && ok(height, LITTLE_MIN_SIZE.height) ? { width, height } : undefined;
}

/**
 * Where the `index`-th open Little Quiver window goes on a display's work area: the remembered size (shrunk to fit
 * the display), centred and shifted down-right by one cascade step per window already open, so new windows never
 * hide the one before. The cascade wraps before it can leave the work area.
 */
export function littleBounds(saved: Size | undefined, workArea: Rect, index: number): Rect {
  const wanted = saved ?? LITTLE_DEFAULT_SIZE;
  const width = Math.max(Math.min(LITTLE_MIN_SIZE.width, workArea.width), Math.min(wanted.width, workArea.width));
  const height = Math.max(Math.min(LITTLE_MIN_SIZE.height, workArea.height), Math.min(wanted.height, workArea.height));
  const steps = Math.max(1, LITTLE_CASCADE_STEPS);
  const slot = ((Math.trunc(index) % steps) + steps) % steps;
  // Start a little up-left of centre so the cascade stays roughly centred as it grows.
  const startX = workArea.x + Math.round((workArea.width - width) / 2) - Math.round((LITTLE_CASCADE_STEP * (steps - 1)) / 4);
  const startY = workArea.y + Math.round((workArea.height - height) / 2) - Math.round((LITTLE_CASCADE_STEP * (steps - 1)) / 4);
  const clampX = (x: number) => Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - width);
  const clampY = (y: number) => Math.min(Math.max(y, workArea.y), workArea.y + workArea.height - height);
  return { x: clampX(startX + slot * LITTLE_CASCADE_STEP), y: clampY(startY + slot * LITTLE_CASCADE_STEP), width, height };
}

/** The toolbar's label: the page title (or the host while it loads) and the host shown beside it. */
export function littleHeading(url: string, title: string): { title: string; host: string } {
  const parsed = URL.parse(url);
  const host = parsed && /^https?:$/.test(parsed.protocol) ? parsed.host : '';
  const clean = title.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
  return { title: clean || host || url.slice(0, 300), host };
}

/** Whether a link from another app opens in Little Quiver (otherwise it becomes a tab, as before). */
export function opensInLittle(enabled: boolean, url: string): boolean {
  return enabled && /^https?:\/\//i.test(url) && URL.canParse(url);
}
