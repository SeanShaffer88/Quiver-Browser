/** Appearance choices. 'system' follows Windows' light/dark app mode. */
export type ThemeSetting = 'system' | 'light' | 'dark';

export const THEME_SETTINGS: readonly ThemeSetting[] = ['system', 'light', 'dark'];

/** Anything unknown (old state files, hand-edited JSON, a newer sync peer) falls back to following the system. */
export function normalizeTheme(value: unknown): ThemeSetting {
  return THEME_SETTINGS.includes(value as ThemeSetting) ? (value as ThemeSetting) : 'system';
}

/** Window background shown before a page paints, so a light theme does not flash dark (and the reverse). */
export function windowBackground(dark: boolean): string {
  return dark ? '#14161a' : '#f6f7f9';
}

/** Settings → Appearance → Reduce motion. 'system' follows Windows' animation setting (prefers-reduced-motion). */
export type MotionSetting = 'system' | 'on' | 'off';

export const MOTION_SETTINGS: readonly MotionSetting[] = ['system', 'on', 'off'];

export function normalizeMotion(value: unknown): MotionSetting {
  return MOTION_SETTINGS.includes(value as MotionSetting) ? (value as MotionSetting) : 'system';
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** A Space colour as stored: lower-case #rrggbb, or undefined when the value is not one. */
export function spaceColor(value: unknown): string | undefined {
  return typeof value === 'string' && HEX_COLOR.test(value) ? value.toLowerCase() : undefined;
}

/** Preset Space colours offered in the Space menu. */
export const SPACE_PRESETS: readonly { name: string; color: string }[] = [
  { name: 'Blue', color: '#5b8cff' },
  { name: 'Coral', color: '#ff7a59' },
  { name: 'Green', color: '#3ecf8e' },
  { name: 'Amber', color: '#f5b73b' },
  { name: 'Violet', color: '#b57bff' },
  { name: 'Pink', color: '#ff5d8f' },
  { name: 'Teal', color: '#2cc5d9' },
  { name: 'Slate', color: '#7c8799' },
];

/** A Space's colours from disk: an invalid main colour falls back to blue, an invalid second colour is dropped. */
export function normalizeSpaceColors<T extends { color?: unknown; color2?: unknown }>(space: T): T & { color: string; color2?: string } {
  const { color2: _second, ...rest } = space;
  const color2 = spaceColor(space.color2);
  return { ...rest, color: spaceColor(space.color) ?? '#5b8cff', ...(color2 ? { color2 } : {}) } as T & { color: string; color2?: string };
}
