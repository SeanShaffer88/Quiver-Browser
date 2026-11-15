import type { Rectangle } from 'electron';

/** Each pane keeps at least this share of the split area, so neither page can be dragged out of sight. */
export const MIN_SPLIT_RATIO = 0.2;
export const MAX_SPLIT_RATIO = 0.8;
/** Width of the gap between the two panes, where the shell draws the draggable divider. */
export const SPLIT_DIVIDER_W = 8;
/** Height of the strip above each pane, where the shell marks the active pane. */
export const SPLIT_STRIP_H = 3;
/** Share of the page area a Peek covers. */
export const PEEK_SCALE = 0.85;
/** Height of the shell-drawn bar above a Peek (host name, Open as tab, Close). */
export const PEEK_HEADER_H = 36;

export function clampSplitRatio(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 0.5;
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, n));
}

/** Ratios are remembered per pair, whichever side each tab is on. */
export function splitPairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export interface SplitRects {
  left: Rectangle;
  right: Rectangle;
  divider: Rectangle;
}

/** Lay out two panes and the divider gap between them inside the page area. */
export function splitRects(area: Rectangle, ratio: number): SplitRects {
  const usable = Math.max(0, area.width - SPLIT_DIVIDER_W);
  const leftW = Math.round(usable * clampSplitRatio(ratio));
  const rightW = usable - leftW;
  const y = area.y + SPLIT_STRIP_H;
  const height = Math.max(0, area.height - SPLIT_STRIP_H);
  return {
    left: { x: area.x, y, width: leftW, height },
    divider: { x: area.x + leftW, y: area.y, width: SPLIT_DIVIDER_W, height: area.height },
    right: { x: area.x + leftW + SPLIT_DIVIDER_W, y, width: rightW, height },
  };
}

/** The ratio for a pointer at `clientX` (window coordinates) dragging the divider across `area`. */
export function ratioAt(area: Pick<Rectangle, 'x' | 'width'>, clientX: number): number {
  const usable = area.width - SPLIT_DIVIDER_W;
  if (!(usable > 0) || !Number.isFinite(clientX)) return 0.5;
  return clampSplitRatio((clientX - area.x - SPLIT_DIVIDER_W / 2) / usable);
}

/**
 * Pick the tab to split with: the next tab in sidebar order in the same Space, else the previous one.
 * Returns null when the Space has no other tab (the caller opens a new one).
 */
export function splitPartner(order: readonly { id: number }[], activeId: number): number | null {
  const i = order.findIndex((t) => t.id === activeId);
  if (i < 0) return null;
  return order[i + 1]?.id ?? order[i - 1]?.id ?? null;
}

/** Whether a new-window request from a tab opens in Peek instead of a new tab. */
export function opensInPeek(source: { pinned: boolean; internal: boolean }, enabled: boolean, url: string): boolean {
  return enabled && source.pinned && !source.internal && /^https?:\/\//i.test(url) && URL.canParse(url);
}

export interface PeekRects {
  /** The whole floating card: header plus page. */
  frame: Rectangle;
  header: Rectangle;
  view: Rectangle;
}

/** A centred card covering PEEK_SCALE of the page area, with the header on top. */
export function peekRects(area: Rectangle): PeekRects {
  const width = Math.max(200, Math.round(area.width * PEEK_SCALE));
  const height = Math.max(PEEK_HEADER_H + 100, Math.round(area.height * PEEK_SCALE));
  const x = area.x + Math.round((area.width - width) / 2);
  const y = area.y + Math.round((area.height - height) / 2);
  return {
    frame: { x, y, width, height },
    header: { x, y, width, height: PEEK_HEADER_H },
    view: { x, y: y + PEEK_HEADER_H, width, height: height - PEEK_HEADER_H },
  };
}

/** Move a window-space rectangle into the coordinates of the shell's page area (#content). */
export function relativeTo(rect: Rectangle, origin: { x: number; y: number }): Rectangle {
  return { x: rect.x - origin.x, y: rect.y - origin.y, width: rect.width, height: rect.height };
}
