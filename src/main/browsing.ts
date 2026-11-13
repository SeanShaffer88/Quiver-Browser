/**
 * Electron's default user agent names Electron and the app. Some sites, Google sign-in among them, refuse
 * embedded browsers on that basis, so Quiver presents the plain Chromium user agent it actually runs.
 */
export function cleanUserAgent(ua: string, appName: string): string {
  const app = appName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return ua.replace(new RegExp(`\\s(?:Electron|${app})\\/\\S+`, 'gi'), '').replace(/\s{2,}/g, ' ').trim();
}

/** Chrome's zoom levels. */
export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

/** The next zoom factor in `direction` (+1 in, -1 out, 0 reset). */
export function nextZoom(current: number, direction: -1 | 0 | 1): number {
  if (direction === 0) return 1;
  if (direction > 0) return ZOOM_STEPS.find((z) => z > current + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  return [...ZOOM_STEPS].reverse().find((z) => z < current - 0.001) ?? ZOOM_STEPS[0];
}
