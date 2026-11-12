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
  | 'back'
  | 'forward'
  | 'devtools'
  | 'boosts'
  | `tab-${number}`;

/** Map a key event to a browser shortcut. Uses physical key codes so keyboard layouts (incl. AltGr) don't matter. */
export function shortcutFor(input: Input): ShortcutAction | null {
  if (input.type !== 'keyDown') return null;
  const ctrl = input.control || input.meta;
  const { code, alt, shift } = input;

  if (code === 'F12') return 'devtools';
  if (code === 'F5') return 'reload';
  if (alt && !ctrl && !shift) {
    if (code === 'ArrowLeft') return 'back';
    if (code === 'ArrowRight') return 'forward';
  }
  if (!ctrl) return null;

  if (code === 'KeyE' && (alt || shift)) return 'env';
  if (code === 'KeyP' && shift && !alt) return 'preview';
  if (code === 'KeyT' && shift && !alt) return 'reopen-tab';
  if (code === 'KeyI' && shift && !alt) return 'devtools';
  if (code === 'KeyB' && shift && !alt) return 'boosts';
  if (code === 'Tab' && !alt) return shift ? 'prev-tab' : 'next-tab';
  if (alt || shift) return null;

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
    case 'KeyB':
      return 'toggle-sidebar';
    default:
      break;
  }
  const d = code.match(/^Digit([1-9])$/);
  if (d) return `tab-${Number(d[1])}`;
  return null;
}
