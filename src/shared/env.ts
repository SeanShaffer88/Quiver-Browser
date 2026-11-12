import type { EnvBadge, EnvGroup } from './types';

const ORDER: EnvBadge[] = ['LOCAL', 'STAGING', 'PROD'];

export function normalizeOrigin(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `${isLocalHost(t.split(/[/:]/)[0]) ? 'http' : 'https'}://${t}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    return null;
  }
}

export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || /^127(?:\.\d{1,3}){3}$/.test(h) || h === '::1' || h.endsWith('.localhost');
}

function groupOrigin(g: EnvGroup, env: EnvBadge): string | null {
  const raw = env === 'LOCAL' ? g.local : env === 'STAGING' ? g.staging : g.prod;
  return normalizeOrigin(raw);
}

export interface EnvMatch {
  group: EnvGroup;
  env: EnvBadge;
}

export function detectEnv(url: string, groups: EnvGroup[]): EnvMatch | null {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return null;
  }
  for (const g of groups) {
    for (const env of ORDER) {
      if (groupOrigin(g, env) === origin) return { group: g, env };
    }
  }
  return null;
}

/** Badge for the address bar: configured groups first, bare localhost falls back to LOCAL. */
export function badgeFor(url: string, groups: EnvGroup[]): EnvBadge | null {
  const m = detectEnv(url, groups);
  if (m) return m.env;
  try {
    const u = new URL(url);
    if ((u.protocol === 'http:' || u.protocol === 'https:') && isLocalHost(u.hostname)) return 'LOCAL';
  } catch {
    /* not a URL */
  }
  return null;
}

/**
 * Jump to the next (or a named) environment of the matching group, keeping path + query + hash.
 * Environments with an empty origin are skipped. Returns null when the URL is in no group.
 */
export function switchEnv(url: string, groups: EnvGroup[], target?: EnvBadge): string | null {
  const m = detectEnv(url, groups);
  if (!m) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const available = ORDER.filter((e) => groupOrigin(m.group, e) !== null);
  if (available.length < 2 && !target) return null;
  let next: EnvBadge | undefined = target;
  if (!next) {
    const idx = available.indexOf(m.env);
    next = available[(idx + 1) % available.length];
  }
  const origin = groupOrigin(m.group, next);
  if (!origin) return null;
  return origin + u.pathname + u.search + u.hash;
}
