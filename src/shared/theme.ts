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
