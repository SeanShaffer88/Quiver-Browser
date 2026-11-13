import type { UpdateNotice, UpdateStatus } from '../shared/types';

/**
 * Opt-in "new version available" notice. Quiver promises no automatic network connections, so this is off by
 * default. When on, Quiver asks GitHub's public API for the latest release at most once a day (or when the user
 * clicks Check now), compares versions, and shows a notice linking to the release page. It never downloads or
 * installs anything.
 */

export const RELEASES_API = 'https://api.github.com/repos/SeanShaffer88/Quiver-Browser/releases/latest';
const RELEASE_PAGE_PREFIX = 'https://github.com/SeanShaffer88/Quiver-Browser/releases/';
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 10_000;
const MAX_BODY = 512 * 1024;

export interface UpdateState {
  /** Epoch ms of the last completed check. */
  lastCheckedAt: number;
  /** The newest release seen, if it was newer than this build. */
  latest?: UpdateNotice;
  /** A version the user dismissed; its notice stays hidden. */
  dismissed?: string;
}

// Semantic version with an optional prerelease (build metadata is accepted and ignored, as SemVer says).
const SEMVER = /^v?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export interface Version {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

export function parseVersion(raw: unknown): Version | null {
  if (typeof raw !== 'string' || raw.length > 64) return null;
  const m = SEMVER.exec(raw);
  if (!m) return null;
  const prerelease = m[4] ? m[4].split('.') : [];
  // SemVer forbids leading zeros in numeric prerelease identifiers.
  if (prerelease.some((id) => /^\d+$/.test(id) && id.length > 1 && id.startsWith('0'))) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease };
}

/** SemVer 2.0 precedence: <0 if a < b, 0 if equal, >0 if a > b. A prerelease sorts before its release. */
export function compareVersions(a: Version, b: Version): number {
  for (const k of ['major', 'minor', 'patch'] as const) if (a[k] !== b[k]) return a[k] - b[k];
  const pa = a.prerelease;
  const pb = b.prerelease;
  if (!pa.length || !pb.length) return pb.length - pa.length;
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) - Number(y);
    if (xn !== yn) return xn ? -1 : 1; // numeric identifiers sort before alphanumeric ones
    return x < y ? -1 : 1;
  }
  return pa.length - pb.length;
}

export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  return !!a && !!b && compareVersions(a, b) > 0;
}

/**
 * Accept only a well-formed release of this repository: a semver tag, an https html_url under its releases page on
 * github.com, and not a draft. Anything else is ignored, so a broken or spoofed response can't put an arbitrary link
 * in front of the user.
 */
export function validateRelease(body: unknown): UpdateNotice | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const r = body as Record<string, unknown>;
  if (r.draft === true) return null;
  const tag = r.tag_name;
  if (typeof tag !== 'string' || !parseVersion(tag)) return null;
  const url = typeof r.html_url === 'string' ? URL.parse(r.html_url) : null;
  if (!url || url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port) return null;
  if (!url.href.startsWith(RELEASE_PAGE_PREFIX) || url.search || url.hash) return null;
  return { version: tag.replace(/^v/, ''), url: url.href };
}

export function normalizeUpdateState(raw: unknown): UpdateState {
  const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const lastCheckedAt = typeof r.lastCheckedAt === 'number' && Number.isFinite(r.lastCheckedAt) && r.lastCheckedAt >= 0 ? r.lastCheckedAt : 0;
  const latest = r.latest && typeof r.latest === 'object'
    ? validateRelease({ tag_name: (r.latest as UpdateNotice).version, html_url: (r.latest as UpdateNotice).url }) ?? undefined
    : undefined;
  const dismissed = typeof r.dismissed === 'string' && parseVersion(r.dismissed) ? r.dismissed : undefined;
  return { lastCheckedAt, ...(latest ? { latest } : {}), ...(dismissed ? { dismissed } : {}) };
}

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal; redirect: 'error' }) =>
  Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** Fetch and validate the latest release. Throws a short, user-facing message on failure. */
export async function fetchLatestRelease(fetchFn: FetchLike, timeoutMs = TIMEOUT_MS): Promise<UpdateNotice> {
  const signal = AbortSignal.timeout(timeoutMs);
  let res;
  try {
    res = await fetchFn(RELEASES_API, {
      headers: { 'User-Agent': 'Quiver', Accept: 'application/vnd.github+json' },
      signal,
      redirect: 'error',
    });
  } catch {
    throw new Error('Could not reach GitHub');
  }
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_BODY) throw new Error('Unexpected answer from GitHub');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error('Unexpected answer from GitHub');
  }
  const release = validateRelease(body);
  if (!release) throw new Error('Unexpected answer from GitHub');
  return release;
}

export class UpdateChecker {
  private busy: Promise<UpdateStatus> | null = null;
  private error: string | undefined;

  constructor(
    private readonly state: () => UpdateState,
    private readonly setState: (s: UpdateState) => void,
    private readonly enabled: () => boolean,
    private readonly currentVersion: string,
    private readonly fetchFn: FetchLike,
    private readonly now: () => number = Date.now,
  ) {}

  /** The notice to show: a newer release than this build that the user hasn't dismissed. Only while enabled. */
  notice(): UpdateNotice | undefined {
    const { latest, dismissed } = this.state();
    if (!this.enabled() || !latest || !isNewer(latest.version, this.currentVersion)) return undefined;
    if (dismissed && !isNewer(latest.version, dismissed)) return undefined;
    return latest;
  }

  status(): UpdateStatus {
    const s = this.state();
    const notice = this.notice();
    return {
      enabled: this.enabled(),
      lastCheckedAt: s.lastCheckedAt,
      current: this.currentVersion,
      ...(s.latest ? { latest: s.latest.version } : {}),
      ...(notice ? { notice } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  /** Check if enabled and a day has passed since the last check (a clock moved backwards counts as due). */
  due(): boolean {
    const last = this.state().lastCheckedAt;
    const now = this.now();
    return this.enabled() && (now - last >= CHECK_INTERVAL_MS || now < last);
  }

  async maybeCheck(): Promise<UpdateStatus | null> {
    return this.due() ? this.check() : null;
  }

  /** Check now (only while enabled). Concurrent calls share one request. */
  check(): Promise<UpdateStatus> {
    if (!this.enabled()) return Promise.resolve(this.status());
    this.busy ??= (async () => {
      try {
        const release = await fetchLatestRelease(this.fetchFn);
        this.error = undefined;
        const prev = this.state();
        this.setState({ ...prev, lastCheckedAt: this.now(), latest: isNewer(release.version, this.currentVersion) ? release : undefined });
      } catch (e) {
        this.error = e instanceof Error ? e.message : 'Check failed';
        // A failed check also counts, so an offline machine isn't retried on every timer tick.
        this.setState({ ...this.state(), lastCheckedAt: this.now() });
      } finally {
        this.busy = null;
      }
      return this.status();
    })();
    return this.busy;
  }

  dismiss(): void {
    const s = this.state();
    if (s.latest) this.setState({ ...s, dismissed: s.latest.version });
  }
}
