// Card movement on the Boards canvas, without the DOM so it can be tested. Quiver's main process clamps again
// when it saves; these limits match src/main/boards.ts.

export interface Geometry { x: number; y: number; w: number; h: number }

export const STEP = 8;
export const BIG_STEP = 48;
const CANVAS_MAX = 10_000;
const MIN_W = 140;
const MIN_H = 72;
const MAX_SIZE = 1600;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)));

export function clampCard(g: Geometry): Geometry {
  const w = clamp(g.w, MIN_W, MAX_SIZE);
  const h = clamp(g.h, MIN_H, MAX_SIZE);
  return { x: clamp(g.x, 0, CANVAS_MAX - w), y: clamp(g.y, 0, CANVAS_MAX - h), w, h };
}

/**
 * The card after an arrow key: arrows move it, Ctrl+arrows resize it, Shift takes bigger steps.
 * Returns null for any other key.
 */
export function nudge(g: Geometry, key: string, shift: boolean, ctrl: boolean): Geometry | null {
  const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[key];
  if (!d) return null;
  const step = shift ? BIG_STEP : STEP;
  return clampCard(ctrl
    ? { ...g, w: g.w + d[0] * step, h: g.h + d[1] * step }
    : { ...g, x: g.x + d[0] * step, y: g.y + d[1] * step });
}

/** The card after dragging its body (move) or its corner (resize) by dx, dy. */
export function dragged(g: Geometry, mode: 'move' | 'resize', dx: number, dy: number): Geometry {
  return clampCard(mode === 'move' ? { ...g, x: g.x + dx, y: g.y + dy } : { ...g, w: g.w + dx, h: g.h + dy });
}

/** The canvas size that fits every card with room to drag further. */
export function canvasSize(cards: readonly Geometry[], minW: number, minH: number): { width: number; height: number } {
  return {
    width: Math.min(CANVAS_MAX, Math.max(minW, ...cards.map((c) => c.x + c.w + 240))),
    height: Math.min(CANVAS_MAX, Math.max(minH, ...cards.map((c) => c.y + c.h + 240))),
  };
}
