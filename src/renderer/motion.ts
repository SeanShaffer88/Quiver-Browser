// Motion for Quiver's own pages. Every animation is short, moves only transform and opacity, and is skipped when
// motion is reduced: by Settings → Appearance → Reduce motion, or by the system setting when that is 'system'.

export type MotionSetting = 'system' | 'on' | 'off';

/** Whether animations are skipped, given the setting and the system's prefers-reduced-motion. */
export function motionReduced(setting: unknown, systemReduces: boolean): boolean {
  if (setting === 'on') return true;
  if (setting === 'off') return false;
  return systemReduces;
}

const systemQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
let current: unknown = 'system';

/** Apply the setting to this page: base.css reads data-motion, and animate() below checks it. */
export function setMotion(setting: unknown): void {
  current = setting;
  document.documentElement.dataset.motion = motionReduced(setting, !!systemQuery?.matches) ? 'reduce' : 'full';
}
systemQuery?.addEventListener('change', () => setMotion(current));

export function reduced(): boolean {
  return motionReduced(current, !!systemQuery?.matches);
}

/** Timings shared by the shell and the command bar. */
export const DURATION = { fast: 120, base: 160, slow: 220 } as const;
export const EASE_OUT = 'cubic-bezier(.2, .8, .2, 1)';
export const EASE_IN = 'cubic-bezier(.4, 0, 1, 1)';

/** Element.animate, or nothing when motion is reduced. Returns the animation so callers can await `finished`. */
export function animate(el: Element, frames: Keyframe[], options: KeyframeAnimationOptions): Animation | null {
  if (reduced() || typeof el.animate !== 'function') return null;
  return el.animate(frames, { easing: EASE_OUT, ...options });
}
