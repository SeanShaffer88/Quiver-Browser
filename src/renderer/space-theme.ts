// Space themes: a Space's colour (or two, for a gradient) tints the sidebar and sets the accent. Every colour here is
// checked with the WCAG 2.x contrast formula so sidebar text stays at 4.5:1 or better in the light and dark palettes.
// Pure functions only: the shell applies the result and the tests check it for many colours.

export type Rgb = readonly [number, number, number];

const HEX = /^#[0-9a-f]{6}$/i;

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX.test(value);
}

export function parseHex(hex: string): Rgb {
  if (!isHexColor(hex)) throw new Error('not a #rrggbb colour: ' + hex);
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function toHex(rgb: Rgb): string {
  return '#' + rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('');
}

/** Straight sRGB mix: amount 0 is `a`, 1 is `b`. */
export function mix(a: string, b: string, amount: number): string {
  const x = parseHex(a);
  const y = parseHex(b);
  return toHex([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * amount) as unknown as Rgb);
}

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const lin = parseHex(hex).map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** WCAG contrast ratio, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export const AA_TEXT = 4.5;

/** The parts of base.css's palettes a Space theme builds on. Keep in sync with base.css. */
export const PALETTE = {
  dark: { bg: '#14161a', panel: '#1b1e24', panel2: '#22262e', text: '#d7dae0', muted: '#8b93a1', onDark: '#0b1020' },
  light: { bg: '#f6f7f9', panel: '#ffffff', panel2: '#e9ecf1', text: '#1b1e24', muted: '#535b69', onDark: '#0b1020' },
} as const;

export interface SpaceTheme {
  /** Sidebar background: one colour, or the two ends of a gradient. */
  sidebar: [string] | [string, string];
  /** Hovered and active rows in the sidebar. */
  row: string;
  accent: string;
  onAccent: string;
  /** Favicon fallback monograms. */
  monogramBg: string;
  monogramText: string;
}

const passes = (fg: readonly string[], bg: readonly string[], target = AA_TEXT) => bg.every((b) => fg.every((f) => contrastRatio(f, b) >= target));

/**
 * The strongest tint of `base` toward `color` (at most `max`) that keeps every `fg` colour at `target` contrast.
 * Tint 0 is the base palette, which meets AA by design, so this always finds an answer.
 */
export function strongestTint(base: string, color: string, fg: readonly string[], max: number, target = AA_TEXT): string {
  for (let a = max; a > 0; a -= 0.01) {
    const tinted = mix(base, color, a);
    if (passes(fg, [tinted], target)) return tinted;
  }
  return base;
}

/** Move `color` toward white (dark theme) or black (light theme) until it reads at `target` on every background. */
export function readableOn(color: string, backgrounds: readonly string[], dark: boolean, target = AA_TEXT): string {
  const toward = dark ? '#ffffff' : '#000000';
  for (let step = 0; step <= 20; step++) {
    const c = mix(color, toward, step / 20);
    if (passes([c], backgrounds, target)) return c;
  }
  return toward;
}

/** The better of near-black and white for text on `bg`. */
export function textOn(bg: string): string {
  return contrastRatio('#ffffff', bg) >= contrastRatio(PALETTE.dark.onDark, bg) ? '#ffffff' : PALETTE.dark.onDark;
}

/**
 * Theme colours for a Space. `color2` (optional) makes the sidebar a gradient from `color` to `color2`.
 * Text and muted text reach 4.5:1 on both ends of the gradient, its midpoint and the row colour; the accent reaches
 * 4.5:1 on all of those and on the toolbar, and the text drawn on the accent reaches 4.5:1 too.
 */
export function spaceTheme(color: string, color2: string | undefined, dark: boolean): SpaceTheme {
  const p = dark ? PALETTE.dark : PALETTE.light;
  const c1 = isHexColor(color) ? color : '#5b8cff';
  const c2 = isHexColor(color2) ? color2 : undefined;
  const fg = [p.text, p.muted];
  // Dark palettes have little luminance headroom, so their tint is lighter.
  const maxTint = dark ? 0.16 : 0.14;
  const top = strongestTint(p.panel, c1, fg, maxTint);
  let bottom = c2 ? strongestTint(p.panel, c2, fg, maxTint) : undefined;
  if (bottom && !passes(fg, [mix(top, bottom, 0.5)])) bottom = undefined;
  const row = strongestTint(p.panel2, c1, fg, maxTint + 0.03);
  const surfaces = [top, row, p.panel, p.bg, ...(bottom ? [bottom, mix(top, bottom, 0.5)] : [])];
  let accent = readableOn(c1, surfaces, dark);
  let onAccent = textOn(accent);
  // Near-impossible with the palettes above, but never hand out an unreadable pair.
  for (let i = 0; contrastRatio(onAccent, accent) < AA_TEXT && i < 20; i++) {
    accent = mix(accent, dark ? '#ffffff' : '#000000', 0.05);
    onAccent = textOn(accent);
  }
  const monogramBg = strongestTint(row, c1, [p.text], dark ? 0.4 : 0.32);
  return { sidebar: bottom ? [top, bottom] : [top], row, accent, onAccent, monogramBg, monogramText: p.text };
}

/** One or two characters for a favicon fallback: the first letter of the site's name, else of the title. */
export function monogram(url: string, title: string): string {
  let host = '';
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') host = u.hostname.replace(/^www\./, '');
  } catch { /* not a URL */ }
  const source = (/^\d+(\.\d+){3}$/.test(host) || host === 'localhost' ? '' : host) || title || host || '?';
  const ch = [...source.trim()].find((c) => /[\p{L}\p{N}]/u.test(c));
  return (ch ?? '?').toLocaleUpperCase();
}

