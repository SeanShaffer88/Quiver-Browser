import type { Input } from 'electron';

export type ShortcutAction =
  | 'command'
  | 'command-new'
  | 'close-tab'
  | 'reopen-tab'
  | 'reload'
  | 'toggle-sidebar'
  | 'preview'
  | 'env'
  | 'next-tab'
  | 'prev-tab'
  | 'move-tab-up'
  | 'move-tab-down'
  | 'back'
  | 'forward'
  | 'devtools'
  | 'boosts'
  | 'downloads'
  | 'find'
  | 'find-next'
  | 'find-prev'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'
  | 'recent-tab'
  | 'recent-tab-back'
  | 'copy-link'
  | 'copy-markdown-link'
  | 'console'
  | 'next-space'
  | 'prev-space'
  | 'split'
  | 'unsplit'
  | 'private-space'
  | `tab-${number}`
  | `space-${number}`;

/**
 * A key binding as stored in settings: modifiers in the fixed order Ctrl, Alt, Shift, then a physical key code,
 * e.g. "Ctrl+Shift+KeyP" or "F3". Physical codes keep bindings independent of the keyboard layout.
 */
export type Binding = string;

/**
 * Actions the user can rebind in Settings → Shortcuts. `pageFirst` actions are offered to web pages first (like
 * Chrome does for keys it doesn't reserve): Ctrl+B is bold in an editor and Ctrl+F is the editor's own find, and
 * Quiver only acts when the page leaves the key alone. Back/forward stay browser-first, as in Chrome.
 */
export const REBINDABLE: readonly { action: ShortcutAction; label: string; defaults: readonly Binding[]; pageFirst: boolean }[] = [
  { action: 'toggle-sidebar', label: 'Collapse / expand sidebar', defaults: ['Ctrl+KeyB'], pageFirst: true },
  { action: 'find', label: 'Find in page', defaults: ['Ctrl+KeyF'], pageFirst: true },
  { action: 'find-next', label: 'Find next', defaults: ['F3'], pageFirst: true },
  { action: 'find-prev', label: 'Find previous', defaults: ['Shift+F3'], pageFirst: true },
  { action: 'zoom-in', label: 'Zoom in', defaults: ['Ctrl+Equal', 'Ctrl+Shift+Equal', 'Ctrl+NumpadAdd', 'Ctrl+Shift+NumpadAdd'], pageFirst: true },
  { action: 'zoom-out', label: 'Zoom out', defaults: ['Ctrl+Minus', 'Ctrl+NumpadSubtract'], pageFirst: true },
  { action: 'zoom-reset', label: 'Reset zoom', defaults: ['Ctrl+Digit0', 'Ctrl+Numpad0'], pageFirst: true },
  { action: 'preview', label: 'Toggle phone preview', defaults: ['Ctrl+Shift+KeyP'], pageFirst: true },
  { action: 'env', label: 'Switch environment', defaults: ['Ctrl+Alt+KeyE', 'Ctrl+Shift+KeyE', 'Ctrl+Alt+Shift+KeyE'], pageFirst: true },
  { action: 'boosts', label: 'Open Boosts', defaults: ['Ctrl+Shift+KeyB'], pageFirst: true },
  { action: 'back', label: 'Go back', defaults: ['Alt+ArrowLeft'], pageFirst: false },
  { action: 'forward', label: 'Go forward', defaults: ['Alt+ArrowRight'], pageFirst: false },
  { action: 'copy-link', label: 'Copy link', defaults: [], pageFirst: true },
  { action: 'copy-markdown-link', label: 'Copy Markdown link', defaults: [], pageFirst: true },
  { action: 'console', label: 'Open the console', defaults: [], pageFirst: true },
  { action: 'next-space', label: 'Next Space', defaults: [], pageFirst: true },
  { action: 'prev-space', label: 'Previous Space', defaults: [], pageFirst: true },
  // Not Ctrl+Shift+=: that is Ctrl+Plus (zoom in) on US layouts.
  { action: 'split', label: 'Open split view', defaults: ['Ctrl+Shift+Backslash'], pageFirst: true },
  { action: 'unsplit', label: 'Exit split view', defaults: ['Ctrl+Shift+Minus'], pageFirst: true },
];

/** Keys every page needs for editing; binding them would take copy/paste/undo away from non-editable selections. */
const EDITING_KEYS = new Set(['Ctrl+KeyA', 'Ctrl+KeyC', 'Ctrl+KeyV', 'Ctrl+KeyX', 'Ctrl+KeyY', 'Ctrl+KeyZ', 'Ctrl+Shift+KeyZ', 'Ctrl+Shift+KeyV']);

const MODS = ['Ctrl', 'Alt', 'Shift'] as const;
const CODE = /^(Key[A-Z]|Digit[0-9]|Numpad[0-9]|NumpadAdd|NumpadSubtract|NumpadMultiply|NumpadDivide|NumpadDecimal|F([1-9]|1[0-9]|2[0-4])|Arrow(Left|Right|Up|Down)|Equal|Minus|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|Backquote|Home|End|Insert|Delete|PageUp|PageDown|Space|Enter|Backspace|Escape|Tab)$/;
const FKEY = /^F([1-9]|1[0-9]|2[0-4])$/;

/** The binding string for a key event (Meta counts as Ctrl, as everywhere else in Quiver). */
export function bindingOf(input: Pick<Input, 'code' | 'control' | 'meta' | 'alt' | 'shift'>): Binding {
  const parts: string[] = [];
  if (input.control || input.meta) parts.push('Ctrl');
  if (input.alt) parts.push('Alt');
  if (input.shift) parts.push('Shift');
  parts.push(input.code);
  return parts.join('+');
}

/** Parse and canonicalize a binding; null when it is not one a user may bind. */
export function parseBinding(raw: unknown): Binding | null {
  if (typeof raw !== 'string' || raw.length > 40) return null;
  const parts = raw.split('+');
  const code = parts.pop()!;
  if (!CODE.test(code)) return null;
  const mods = new Set(parts);
  if (mods.size !== parts.length || parts.some((p) => !(MODS as readonly string[]).includes(p))) return null;
  // Without Ctrl or Alt the key would type (or edit) text, so only function keys may stand alone.
  if (!mods.has('Ctrl') && !mods.has('Alt') && !FKEY.test(code)) return null;
  return [...MODS.filter((m) => mods.has(m)), code].join('+');
}

/** Keys Quiver always handles, even when a page has focus: tab/window management that a page must never trap. */
function reservedAction(binding: Binding): ShortcutAction | null {
  const parts = binding.split('+');
  const code = parts.pop()!;
  const mods = new Set(parts);
  const ctrl = mods.has('Ctrl');
  const alt = mods.has('Alt');
  const shift = mods.has('Shift');
  if (code === 'F12') return 'devtools';
  if (code === 'F5') return 'reload';
  if (alt && !ctrl && !shift) {
    // Alt alone: Ctrl+Alt is AltGr on many layouts, where it types characters such as { and [.
    const space = code.match(/^Digit([1-9])$/);
    if (space) return `space-${Number(space[1])}`;
  }
  if (!ctrl) return null;

  if (!ctrl || alt) return null;
  if (code === 'Tab') return shift ? 'recent-tab-back' : 'recent-tab';
  if (code === 'PageUp' || code === 'PageDown') {
    if (shift) return code === 'PageUp' ? 'move-tab-up' : 'move-tab-down';
    return code === 'PageUp' ? 'prev-tab' : 'next-tab';
  }
  if (shift) {
    if (code === 'KeyT') return 'reopen-tab';
    if (code === 'KeyI') return 'devtools';
    if (code === 'KeyN') return 'private-space';
    return null;
  }
  switch (code) {
    case 'KeyT':
      return 'command-new';
    case 'KeyK':
    case 'KeyL':
      return 'command';
    case 'KeyW':
      return 'close-tab';
    case 'KeyR':
      return 'reload';
    case 'KeyJ':
      return 'downloads';
    default:
      break;
  }
  const d = code.match(/^Digit([1-9])$/);
  if (d) return `tab-${Number(d[1])}`;
  return null;
}

/** True for a binding that belongs to Quiver's reserved set and so can't be reassigned. */
export function isReservedBinding(binding: Binding): boolean {
  return reservedAction(binding) !== null;
}

export type ShortcutOverrides = Partial<Record<ShortcutAction, Binding>>;

const REBINDABLE_ACTIONS = new Map(REBINDABLE.map((r) => [r.action as string, r]));

export function isRebindable(action: string): action is ShortcutAction {
  return REBINDABLE_ACTIONS.has(action);
}

/** Why a binding can't be used for an action, or null if it can. */
export function bindingProblem(action: ShortcutAction, binding: Binding, overrides: ShortcutOverrides): string | null {
  if (isReservedBinding(binding)) return `${formatBinding(binding)} is reserved for Quiver`;
  if (EDITING_KEYS.has(binding)) return `${formatBinding(binding)} is used for editing`;
  for (const r of REBINDABLE) {
    if (r.action === action) continue;
    if (effectiveBindings(r.action, overrides).includes(binding)) return `${formatBinding(binding)} is already used by ${r.label}`;
  }
  return null;
}

/**
 * Validate overrides from settings or IPC: only rebindable actions, canonical bindings ('' = no key), nothing reserved
 * or used for editing, and no binding shared by two actions (the first action in table order keeps it).
 */
export function normalizeShortcutOverrides(raw: unknown): ShortcutOverrides {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const input = raw as Record<string, unknown>;
  const out: ShortcutOverrides = {};
  for (const r of REBINDABLE) {
    if (!Object.hasOwn(input, r.action)) continue;
    const value = input[r.action];
    if (value === '') {
      out[r.action] = '';
      continue;
    }
    const binding = parseBinding(value);
    if (!binding || isReservedBinding(binding) || EDITING_KEYS.has(binding)) continue;
    // A default equal to the override is no override at all; keep settings minimal.
    if (r.defaults.length === 1 && r.defaults[0] === binding) continue;
    out[r.action] = binding;
  }
  // Drop overrides that collide with another action's effective binding; earlier actions win.
  for (const r of REBINDABLE) {
    const mine = out[r.action];
    if (!mine) continue;
    const clash = REBINDABLE.some((o) => o.action !== r.action && effectiveBindings(o.action, out).includes(mine) &&
      (REBINDABLE.indexOf(o) < REBINDABLE.indexOf(r) || out[o.action] === undefined));
    if (clash) delete out[r.action];
  }
  return out;
}

/** The bindings an action currently has: its override (none if '') or its defaults. */
export function effectiveBindings(action: ShortcutAction, overrides: ShortcutOverrides): Binding[] {
  const o = overrides[action];
  if (o !== undefined) return o ? [o] : [];
  return [...(REBINDABLE_ACTIONS.get(action)?.defaults ?? [])];
}

const KEY_NAMES: Record<string, string> = {
  Equal: '=', Minus: '-', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',',
  Period: '.', Slash: '/', Backquote: '`', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
  NumpadAdd: 'Num+', NumpadSubtract: 'Num-', NumpadMultiply: 'Num*', NumpadDivide: 'Num/', NumpadDecimal: 'Num.', Escape: 'Esc',
};

/** Human label for a binding: "Ctrl+KeyB" → "Ctrl+B", "Alt+ArrowLeft" → "Alt+←". */
export function formatBinding(binding: Binding): string {
  const parts = binding.split('+');
  const code = parts.pop()!;
  const key = KEY_NAMES[code] ?? code.replace(/^Key|^Digit/, '').replace(/^Numpad(\d)$/, 'Num$1');
  return [...parts, key].join('+');
}

/** The label of an action's first binding ('' when unbound), for menus and tooltips. */
export function shortcutLabel(action: ShortcutAction, overrides: ShortcutOverrides = activeOverrides): string {
  const first = effectiveBindings(action, overrides)[0];
  return first ? formatBinding(first) : '';
}

let activeOverrides: ShortcutOverrides = {};
let activeMap = buildMap(activeOverrides);

function buildMap(overrides: ShortcutOverrides): Map<Binding, ShortcutAction> {
  const map = new Map<Binding, ShortcutAction>();
  for (const r of REBINDABLE) for (const b of effectiveBindings(r.action, overrides)) if (!map.has(b)) map.set(b, r.action);
  return map;
}

/** Install the user's overrides (already normalized) so shortcutFor and labels follow them. */
export function setShortcutOverrides(overrides: ShortcutOverrides): void {
  activeOverrides = overrides;
  activeMap = buildMap(overrides);
}

export function currentShortcutOverrides(): ShortcutOverrides {
  return activeOverrides;
}

/** Map a key event to a browser shortcut. Uses physical key codes so keyboard layouts (incl. AltGr) don't matter. */
export function shortcutFor(input: Input, overrides?: ShortcutOverrides): ShortcutAction | null {
  if (input.type !== 'keyDown' || !input.code) return null;
  const binding = bindingOf(input);
  const reserved = reservedAction(binding);
  if (reserved) return reserved;
  return (overrides ? buildMap(overrides) : activeMap).get(binding) ?? null;
}

/** Whether an action is offered to the page first (see REBINDABLE). Reserved actions never are. */
export function isPageFirst(action: ShortcutAction): boolean {
  return REBINDABLE_ACTIONS.get(action)?.pageFirst === true;
}
