export type SiteDecision = 'allow' | 'block';

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

/** The origin that may be asked for camera/microphone: secure (https or loopback http) top-level frames only. */
export function mediaOrigin(topLevelUrl: string | undefined, isMainFrame: boolean): string | undefined {
  if (!isMainFrame || !topLevelUrl) return undefined;
  const url = URL.parse(topLevelUrl);
  if (!url) return undefined;
  if (url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname))) return url.origin;
  return undefined;
}

export function normalizeSitePermissions(raw: unknown): Record<string, SiteDecision> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, SiteDecision> = {};
  for (const [origin, decision] of Object.entries(raw as Record<string, unknown>).slice(0, 500)) {
    if (decision !== 'allow' && decision !== 'block') continue;
    const url = URL.parse(origin);
    if (!url || url.origin !== origin || !mediaOrigin(origin, true)) continue;
    out[origin] = decision;
  }
  return out;
}

export type MediaKind = 'camera' | 'microphone' | 'screen';
export type PromptChoice = 'once' | 'always' | 'block';

export interface PendingPrompt {
  id: number;
  contentsId: number;
  origin: string;
  kinds: MediaKind[];
}

/**
 * Camera, microphone and screen-share decisions. Requests wait for the person to answer a prompt unless the site
 * is already allowed or blocked. "Once" lasts until the tab navigates; "always" and "block" are saved per origin.
 */
export class MediaPermissions {
  private nextId = 1;
  private readonly pending = new Map<number, PendingPrompt & { resolvers: ((ok: boolean) => void)[] }>();
  private readonly once = new Map<number, string>();
  private readonly live = new Set<number>();

  constructor(
    private readonly saved: () => Record<string, SiteDecision>,
    private readonly save: (origin: string, decision: SiteDecision | null) => void,
    private readonly changed: () => void,
    private readonly isMeeting: (url: string) => boolean,
  ) {}

  /** Synchronous permission check (navigator.permissions.query). Known meeting sites read as askable, others denied until allowed. */
  check(contentsId: number, topLevelUrl: string | undefined, isMainFrame: boolean): boolean {
    const origin = mediaOrigin(topLevelUrl, isMainFrame);
    if (!origin) return false;
    const decision = this.saved()[origin];
    if (decision === 'block') return false;
    return decision === 'allow' || this.once.get(contentsId) === origin || this.isMeeting(topLevelUrl!);
  }

  request(contentsId: number, topLevelUrl: string | undefined, requestingUrl: string | undefined, isMainFrame: boolean, kinds: MediaKind[]): Promise<boolean> {
    const origin = mediaOrigin(topLevelUrl, isMainFrame);
    const requester = requestingUrl ? URL.parse(requestingUrl)?.origin : origin;
    if (!origin || requester !== origin || !kinds.length) return Promise.resolve(false);
    const decision = this.saved()[origin];
    if (decision === 'block') return Promise.resolve(false);
    if (decision === 'allow' || this.once.get(contentsId) === origin) {
      this.markLive(contentsId);
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const existing = [...this.pending.values()].find((p) => p.contentsId === contentsId && p.origin === origin);
      if (existing) {
        for (const kind of kinds) if (!existing.kinds.includes(kind)) existing.kinds.push(kind);
        existing.resolvers.push(resolve);
      } else {
        const id = this.nextId++;
        this.pending.set(id, { id, contentsId, origin, kinds: [...kinds], resolvers: [resolve] });
      }
      this.changed();
    });
  }

  /** The prompt to show for a tab, if any. */
  promptFor(contentsId: number): PendingPrompt | undefined {
    for (const p of this.pending.values()) if (p.contentsId === contentsId) return { id: p.id, contentsId, origin: p.origin, kinds: [...p.kinds] };
    return undefined;
  }

  decide(id: number, choice: PromptChoice): void {
    const prompt = this.pending.get(id);
    if (!prompt) return;
    this.pending.delete(id);
    const ok = choice !== 'block';
    if (choice === 'always' || choice === 'block') this.save(prompt.origin, choice === 'always' ? 'allow' : 'block');
    if (ok) {
      this.once.set(prompt.contentsId, prompt.origin);
      this.markLive(prompt.contentsId);
    }
    for (const resolve of prompt.resolvers) resolve(ok);
    this.changed();
  }

  isLive(contentsId: number): boolean {
    return this.live.has(contentsId);
  }

  private markLive(contentsId: number): void {
    if (this.live.has(contentsId)) return;
    this.live.add(contentsId);
    this.changed();
  }

  /** A tab left the page: its one-time grant, live state and open prompts end. */
  reset(contentsId: number): void {
    const had = this.once.delete(contentsId) || this.live.delete(contentsId);
    this.live.delete(contentsId);
    let denied = false;
    for (const [id, p] of this.pending) {
      if (p.contentsId !== contentsId) continue;
      this.pending.delete(id);
      for (const resolve of p.resolvers) resolve(false);
      denied = true;
    }
    if (had || denied) this.changed();
  }

  forget(origin: string): void {
    this.save(origin, null);
    this.changed();
  }
}
