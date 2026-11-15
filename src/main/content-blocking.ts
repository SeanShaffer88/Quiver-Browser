import { BLOCKED_DOMAINS } from './blocklist';

export const MAX_ALLOWED_SITES = 500;
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** A lowercase hostname with any trailing dot removed, or '' when the value is not a plain hostname. */
export function normalizeSiteHost(value: unknown): string {
  if (typeof value !== 'string') return '';
  const host = value.trim().toLowerCase().replace(/\.$/, '');
  return HOST.test(host) ? host : '';
}

/** Validate a stored allow list: unique hostnames, capped so a damaged file can't slow every request. */
export function normalizeAllowList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const entry of raw) {
    const host = normalizeSiteHost(entry);
    if (host) out.add(host);
    if (out.size >= MAX_ALLOWED_SITES) break;
  }
  return [...out].sort();
}

/**
 * The site key used for "Allow ads on this site". A leading "www." is dropped so the exception covers the site you
 * think of, not one subdomain of it.
 */
export function siteKey(host: string): string {
  const h = normalizeSiteHost(host);
  return h.startsWith('www.') ? h.slice(4) : h;
}

/** True when `host` equals `domain` or is a subdomain of it. */
export function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith('.' + domain);
}

export class DomainList {
  private readonly domains: Set<string>;

  constructor(domains: Iterable<string> = BLOCKED_DOMAINS) {
    this.domains = new Set([...domains].map(normalizeSiteHost).filter(Boolean));
  }

  get size(): number {
    return this.domains.size;
  }

  /**
   * The listed domain that `host` falls under, or null. Walks the host's suffixes (a.b.example.com, b.example.com,
   * example.com, com) so a lookup costs one Set probe per label instead of a scan of the list.
   */
  match(host: string): string | null {
    let h = host.toLowerCase().replace(/\.$/, '');
    for (;;) {
      if (this.domains.has(h)) return h;
      const dot = h.indexOf('.');
      if (dot < 0) return null;
      h = h.slice(dot + 1);
    }
  }
}

function webHost(url: string | undefined): string | null {
  if (!url) return null;
  const u = URL.parse(url);
  return u && (u.protocol === 'http:' || u.protocol === 'https:') ? u.hostname.replace(/^\[|\]$/g, '').toLowerCase() : null;
}

export interface BlockRequest {
  url: string;
  resourceType: string;
  /** The URL of the top-level page that made the request, when known. */
  pageUrl?: string;
}

/**
 * Decide whether to cancel a request. Only subresources are blocked (never a page you navigate to), only when their
 * host is listed, and only when the page itself is not on that listed domain: visiting a listed site directly keeps
 * working, which also makes the check "third-party" without needing a public-suffix list.
 */
export function shouldBlock(req: BlockRequest, list: DomainList, allowList: readonly string[]): boolean {
  if (req.resourceType === 'mainFrame') return false;
  const host = webHost(req.url);
  if (!host) return false;
  const listed = list.match(host);
  if (!listed) return false;
  const pageHost = webHost(req.pageUrl);
  if (pageHost) {
    if (hostMatches(pageHost, listed)) return false;
    if (allowList.some((site) => hostMatches(pageHost, site))) return false;
  }
  return true;
}

/** Whether the page's site is on the allow list. */
export function siteAllowed(pageUrl: string, allowList: readonly string[]): boolean {
  const host = webHost(pageUrl);
  return !!host && allowList.some((site) => hostMatches(host, site));
}

/** Add or remove the page's site from the allow list, returning the new list. */
export function toggleSite(pageUrl: string, allowList: readonly string[]): string[] {
  const host = webHost(pageUrl);
  if (!host) return [...allowList];
  if (siteAllowed(pageUrl, allowList)) return allowList.filter((site) => !hostMatches(host, site));
  const key = siteKey(host);
  return key ? normalizeAllowList([...allowList, key]) : [...allowList];
}
