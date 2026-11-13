// Fixed-height list windowing for the sidebar. Kept free of DOM access so it can be unit tested.

export interface Viewport {
  count: number;
  rowHeight: number;
  scrollTop: number;
  viewport: number;
  overscan: number;
  /** Indexes that must stay rendered even when scrolled out of view (active, focused or dragged rows). */
  keep?: readonly number[];
}

/** Sorted indexes of the rows to render. */
export function visibleRows({ count, rowHeight, scrollTop, viewport, overscan, keep = [] }: Viewport): number[] {
  if (count <= 0 || rowHeight <= 0) return [];
  const maxTop = Math.max(0, count * rowHeight - viewport);
  const top = Math.min(Math.max(0, scrollTop), maxTop);
  const first = Math.max(0, Math.floor(top / rowHeight) - overscan);
  const last = Math.min(count - 1, Math.ceil((top + Math.max(viewport, rowHeight)) / rowHeight) - 1 + overscan);
  const rows = new Set<number>();
  for (let i = first; i <= last; i++) rows.add(i);
  for (const i of keep) if (Number.isInteger(i) && i >= 0 && i < count) rows.add(i);
  return [...rows].sort((a, b) => a - b);
}

/** The scrollTop that brings row `index` fully into view with the least movement. */
export function scrollToReveal(index: number, rowHeight: number, scrollTop: number, viewport: number): number {
  const top = index * rowHeight;
  if (top < scrollTop) return top;
  if (top + rowHeight > scrollTop + viewport) return top + rowHeight - viewport;
  return scrollTop;
}
