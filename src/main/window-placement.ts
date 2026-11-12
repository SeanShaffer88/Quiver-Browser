import type { Rectangle } from 'electron';

export const MIN_WINDOW_WIDTH = 760;
export const MIN_WINDOW_HEIGHT = 480;
const DEFAULT_WIDTH = 1360;
const DEFAULT_HEIGHT = 860;

type SavedWindow = Partial<Rectangle> & { maximized?: boolean };

function intersection(a: Rectangle, b: Rectangle): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return Math.max(0, width) * Math.max(0, height);
}

function coordinate(value: unknown): value is number {
  // Native Electron bounds are signed 32-bit integers in device-independent pixels.
  return typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= 0x7fffffff;
}

function dimension(value: unknown, fallback: number): number {
  return coordinate(value) && value > 0 ? value : fallback;
}

export function placeWindow(saved: SavedWindow | undefined, workAreas: readonly Rectangle[], primary: Rectangle) {
  const width = dimension(saved?.width, DEFAULT_WIDTH);
  const height = dimension(saved?.height, DEFAULT_HEIGHT);
  const candidate = coordinate(saved?.x) && coordinate(saved?.y) ? { x: saved.x, y: saved.y, width, height } : null;
  let area = primary;
  let overlap = candidate ? intersection(candidate, primary) : 0;
  if (candidate) {
    for (const workArea of workAreas) {
      const next = intersection(candidate, workArea);
      if (next > overlap) {
        overlap = next;
        area = workArea;
      }
    }
  }
  const minWidth = Math.min(MIN_WINDOW_WIDTH, area.width);
  const minHeight = Math.min(MIN_WINDOW_HEIGHT, area.height);
  const fittedWidth = Math.min(Math.max(width, minWidth), area.width);
  const fittedHeight = Math.min(Math.max(height, minHeight), area.height);
  const right = area.x + area.width - fittedWidth;
  const bottom = area.y + area.height - fittedHeight;
  const visible = candidate && overlap > 0 ? candidate : null;
  return {
    bounds: {
      x: visible ? Math.min(Math.max(visible.x, area.x), right) : Math.floor((area.x + right) / 2),
      y: visible ? Math.min(Math.max(visible.y, area.y), bottom) : Math.floor((area.y + bottom) / 2),
      width: fittedWidth,
      height: fittedHeight,
    },
    minWidth,
    minHeight,
    maximized: saved?.maximized === true,
    relocated: candidate !== null && overlap === 0,
  };
}
