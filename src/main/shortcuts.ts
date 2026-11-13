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
  | 'private-space'
  | `tab-${number}`
  | `space-${number}`;

/** Map a key event to a browser shortcut. Uses physical key codes so keyboard layouts (incl. AltGr) don't matter. */
export function shortcutFor(input: Input): ShortcutAction | null {
  if (input.type !== 'keyDown') return null;
  const ctrl = input.control || input.meta;
  const { code, alt, shift } = input;

  if (code === 'F12') return 'devtools';
  if (code === 'F5') return 'reload';
  if (code === 'F3' && !ctrl && !alt) return shift ? 'find-prev' : 'find-next';
  if (alt && !ctrl && !shift) {
    if (code === 'ArrowLeft') return 'back';
    if (code === 'ArrowRight') return 'forward';
    // Alt alone: Ctrl+Alt is AltGr on many layouts, where it types characters such as { and [.
    const space = code.match(/^Digit([1-9])$/);
    if (space) return `space-${Number(space[1])}`;
  }
  if (!ctrl) return null;

  if (code === 'KeyE' && (alt || shift)) return 'env';
  if (code === 'KeyP' && shift && !alt) return 'preview';
  if (code === 'KeyT' && shift && !alt) return 'reopen-tab';
  if (code === 'KeyI' && shift && !alt) return 'devtools';
  if (code === 'KeyB' && shift && !alt) return 'boosts';
  if (code === 'KeyN' && shift && !alt) return 'private-space';
  if (code === 'Tab' && !alt) return shift ? 'recent-tab-back' : 'recent-tab';
  if (!alt && (code === 'Equal' || code === 'NumpadAdd')) return 'zoom-in';
  if (!alt && !shift && (code === 'Minus' || code === 'NumpadSubtract')) return 'zoom-out';
  if (!alt && !shift && (code === 'Digit0' || code === 'Numpad0')) return 'zoom-reset';
  if ((code === 'PageUp' || code === 'PageDown') && !alt) {
    if (shift) return code === 'PageUp' ? 'move-tab-up' : 'move-tab-down';
    return code === 'PageUp' ? 'prev-tab' : 'next-tab';
  }
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
    case 'KeyJ':
      return 'downloads';
    case 'KeyF':
      return 'find';
    default:
      break;
  }
  const d = code.match(/^Digit([1-9])$/);
  if (d) return `tab-${Number(d[1])}`;
  return null;
}
