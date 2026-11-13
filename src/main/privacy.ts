import type { Session, WebContents } from 'electron';
import type { PrivacySettings } from '../shared/types';

const DOH_LIMIT = 300;

function validDohTemplate(value: unknown): string {
  if (typeof value !== 'string') return '';
  const template = value.trim();
  if (!template || template.length > DOH_LIMIT || /\s/.test(template)) return '';
  const url = URL.parse(template.replace(/\{\?dns\}$/, ''));
  return url?.protocol === 'https:' && !url.username && !url.password && url.hostname ? template : '';
}

/** Validate stored or submitted privacy settings, filling defaults that favour privacy. */
export function normalizePrivacy(raw: unknown, platform: NodeJS.Platform): PrivacySettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
  const dohTemplate = validDohTemplate(r.dohTemplate);
  let secureDns: PrivacySettings['secureDns'] = r.secureDns === 'off' || r.secureDns === 'custom' ? r.secureDns : 'automatic';
  if (secureDns === 'custom' && !dohTemplate) secureDns = 'automatic';
  return {
    gpc: bool(r.gpc, true),
    hideLocalIp: bool(r.hideLocalIp, true),
    secureDns,
    dohTemplate,
    // Windows and macOS use the system spell checker; elsewhere Chromium downloads dictionaries from Google.
    spellcheck: bool(r.spellcheck, platform === 'win32' || platform === 'darwin'),
    clearOnExit: bool(r.clearOnExit, false),
  };
}

export function privacyHeaders(headers: Record<string, string>, gpc: boolean): Record<string, string> {
  return gpc ? { ...headers, 'Sec-GPC': '1', DNT: '1' } : headers;
}

export function hostResolverOptions(p: PrivacySettings): { secureDnsMode: 'off' | 'automatic' | 'secure'; secureDnsServers?: string[] } {
  if (p.secureDns === 'custom' && p.dohTemplate) return { secureDnsMode: 'secure', secureDnsServers: [p.dohTemplate] };
  return { secureDnsMode: p.secureDns === 'off' ? 'off' : 'automatic' };
}

/** Applies privacy settings to every session and page, and reapplies them when settings change. */
export class PrivacyController {
  private readonly sessions = new Set<Session>();
  private readonly contents = new Set<WebContents>();

  constructor(
    private readonly settings: () => PrivacySettings,
    private readonly configureDns: (options: ReturnType<typeof hostResolverOptions>) => void,
  ) {}

  private applySpellcheck(ses: Session): void {
    const on = this.settings().spellcheck;
    ses.setSpellCheckerEnabled(on);
    // With no languages Chromium has no dictionary to fetch; on Windows and macOS the OS checker ignores this list.
    if (process.platform === 'win32' || process.platform === 'darwin') return;
    try {
      if (!on) ses.setSpellCheckerLanguages?.([]);
      else if (ses.getSpellCheckerLanguages?.().length === 0) {
        const available = ses.availableSpellCheckerLanguages ?? [];
        const locale = Intl.DateTimeFormat().resolvedOptions().locale;
        const language = available.find((l) => l === locale) ?? available.find((l) => l.startsWith(locale.split('-')[0])) ?? available.find((l) => l === 'en-US');
        if (language) ses.setSpellCheckerLanguages([language]);
      }
    } catch (error) {
      console.warn('[quiver] could not update spell check languages:', error instanceof Error ? error.message : error);
    }
  }

  configureSession(ses: Session): void {
    if (this.sessions.has(ses)) return;
    this.sessions.add(ses);
    this.applySpellcheck(ses);
    // Read the setting per request so a change applies without reloading.
    ses.webRequest.onBeforeSendHeaders({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      callback({ requestHeaders: privacyHeaders(details.requestHeaders, this.settings().gpc) });
    });
  }

  configureContents(wc: WebContents): void {
    this.contents.add(wc);
    this.applyContents(wc);
    (wc as Partial<Pick<WebContents, 'once'>>).once?.('destroyed', () => this.contents.delete(wc));
  }

  private applyContents(wc: WebContents): void {
    if (wc.isDestroyed()) return;
    try {
      wc.setWebRTCIPHandlingPolicy(this.settings().hideLocalIp ? 'default_public_interface_only' : 'default');
    } catch (error) {
      console.warn('[quiver] could not set WebRTC policy:', error instanceof Error ? error.message : error);
    }
  }

  apply(): void {
    const p = this.settings();
    for (const ses of this.sessions) this.applySpellcheck(ses);
    for (const wc of this.contents) this.applyContents(wc);
    try {
      this.configureDns(hostResolverOptions(p));
    } catch (error) {
      console.warn('[quiver] could not configure Secure DNS:', error instanceof Error ? error.message : error);
    }
  }
}

/** Clear cookies, storage and cache for the given sessions, giving up after `timeoutMs`. */
export async function clearSessions(sessions: readonly Session[], timeoutMs = 5000): Promise<void> {
  const work = Promise.allSettled(sessions.flatMap((ses) => [ses.clearStorageData(), ses.clearCache(), ses.clearAuthCache()]));
  await Promise.race([work, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
}
