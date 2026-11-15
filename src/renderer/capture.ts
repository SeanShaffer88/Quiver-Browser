export {};
// Capture mode: drawn over a web tab while the person picks the area to capture. Quiver's main process takes the
// screenshot of the tab itself; this page only reports the rectangle (in the tab's coordinates).

interface Rect { x: number; y: number; width: number; height: number }

const surface = document.getElementById('surface')!;
const box = document.getElementById('selection')!;
const bar = document.getElementById('bar')!;
const title = document.getElementById('capture-title')!;
const status = document.getElementById('status')!;
const whole = document.getElementById('whole') as HTMLButtonElement;
const cancelButton = document.getElementById('cancel') as HTMLButtonElement;

let selection: Rect | null = null;
let busy = false;
const STEP = 10;

function normalized(r: Rect): Rect {
  const x = Math.max(0, Math.min(r.x, r.x + r.width));
  const y = Math.max(0, Math.min(r.y, r.y + r.height));
  const right = Math.min(innerWidth, Math.max(r.x, r.x + r.width));
  const bottom = Math.min(innerHeight, Math.max(r.y, r.y + r.height));
  return { x, y, width: right - x, height: bottom - y };
}

function show(): void {
  surface.classList.toggle('has-selection', !!selection);
  box.hidden = !selection;
  if (!selection) {
    bar.classList.remove('low');
    return;
  }
  const r = normalized(selection);
  Object.assign(box.style, { left: r.x + 'px', top: r.y + 'px', width: r.width + 'px', height: r.height + 'px' });
  // Keep the instructions out of the way of the area being chosen.
  bar.classList.toggle('low', r.y < bar.offsetHeight + 24);
}

async function done(rect: Rect | null): Promise<void> {
  if (busy) return;
  busy = true;
  status.textContent = '';
  try {
    const problem = (await quiver.invoke('capture:done', rect && normalized(rect))) as string;
    if (problem) status.textContent = problem;
  } catch {
    status.textContent = 'Quiver could not capture this page.';
  } finally {
    busy = false;
  }
}

function cancel(): void {
  void quiver.invoke('capture:cancel');
}

surface.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || bar.contains(e.target as Node)) return;
  e.preventDefault();
  const start = { x: e.clientX, y: e.clientY };
  selection = { ...start, width: 0, height: 0 };
  surface.setPointerCapture(e.pointerId);
  const move = (ev: PointerEvent) => {
    selection = { ...start, width: ev.clientX - start.x, height: ev.clientY - start.y };
    show();
  };
  const up = (ev: PointerEvent) => {
    surface.removeEventListener('pointermove', move);
    surface.removeEventListener('pointerup', up);
    move(ev);
    const r = normalized(selection!);
    // A click without a drag clears the selection rather than capturing a sliver.
    if (r.width < 8 || r.height < 8) {
      selection = null;
      show();
      return;
    }
    selection = r;
    void done(r);
  };
  surface.addEventListener('pointermove', move);
  surface.addEventListener('pointerup', up);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    cancel();
    return;
  }
  if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
    e.preventDefault();
    void done(selection && normalized(selection));
    return;
  }
  const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
  if (!d) return;
  e.preventDefault();
  const step = STEP * (e.ctrlKey ? 5 : 1);
  if (!selection) selection = { x: innerWidth / 4, y: innerHeight / 4, width: innerWidth / 2, height: innerHeight / 2 };
  const r = normalized(selection);
  selection = e.shiftKey
    ? normalized({ ...r, width: Math.max(16, r.width + d[0] * step), height: Math.max(16, r.height + d[1] * step) })
    : normalized({ ...r, x: Math.min(innerWidth - r.width, Math.max(0, r.x + d[0] * step)), y: Math.min(innerHeight - r.height, Math.max(0, r.y + d[1] * step)) });
  show();
  status.textContent = `Selection ${Math.round(selection.width)} by ${Math.round(selection.height)} at ${Math.round(selection.x)}, ${Math.round(selection.y)}`;
});

whole.addEventListener('click', () => void done(null));
cancelButton.addEventListener('click', cancel);

quiver.on('capture:start', (payload: { boardName: string }) => {
  selection = null;
  busy = false;
  status.textContent = '';
  title.textContent = `Capture to “${payload.boardName}”`;
  show();
  whole.focus();
});
