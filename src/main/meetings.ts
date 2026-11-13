import type { Suggestion } from '../shared/types';

const PROVIDERS: { name: string; match: (host: string, path: string) => boolean }[] = [
  { name: 'Google Meet', match: (h) => h === 'meet.google.com' },
  { name: 'Zoom', match: (h, p) => (h === 'zoom.us' || h.endsWith('.zoom.us')) && /^\/(?:j|s|w|my|wc)\//.test(p) },
  { name: 'Microsoft Teams', match: (h, p) => (h === 'teams.microsoft.com' && /^\/(?:l\/meetup-join|v2|_#\/)/.test(p)) || (h === 'teams.live.com' && p.startsWith('/meet/')) },
  { name: 'Webex', match: (h) => h.endsWith('.webex.com') },
  { name: 'Jitsi Meet', match: (h) => h === 'meet.jit.si' },
  { name: 'Whereby', match: (h) => h === 'whereby.com' },
];

/** The meeting service a URL belongs to, or undefined. Only https links count. */
export function meetingProvider(raw: string): string | undefined {
  const url = URL.parse(raw);
  if (!url || url.protocol !== 'https:') return undefined;
  const host = url.hostname.toLowerCase();
  return PROVIDERS.find((p) => p.match(host, url.pathname))?.name;
}

/** Where to go to join: a meeting link, a Google Meet code, or a Zoom meeting ID. Zoom opens in its web client. */
export function joinTarget(input: string): { provider: string; url: string } | undefined {
  const text = input.trim();
  if (/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(text)) return { provider: 'Google Meet', url: `https://meet.google.com/${text.toLowerCase()}` };
  const digits = text.replace(/[\s-]/g, '');
  if (/^\d{9,11}$/.test(digits) && /^[\d\s-]+$/.test(text)) return { provider: 'Zoom', url: `https://app.zoom.us/wc/join/${digits}` };
  const raw = /^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  const provider = meetingProvider(raw);
  if (!provider) return undefined;
  const url = new URL(raw);
  if (provider === 'Zoom') {
    const id = /^\/(?:j|s|w)\/(\d{9,11})/.exec(url.pathname)?.[1];
    if (id) {
      const pwd = url.searchParams.get('pwd');
      return { provider, url: `https://app.zoom.us/wc/join/${id}${pwd ? `?pwd=${encodeURIComponent(pwd)}` : ''}` };
    }
  }
  url.username = '';
  url.password = '';
  return { provider, url: url.href };
}

export function meetSuggestions(text: string): Suggestion[] | undefined {
  const m = /^meet(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return undefined;
  const arg = (m[1] ?? '').trim();
  if (!arg) {
    return [
      { kind: 'meet', label: 'Start a Google Meet', detail: 'meet.new', action: { type: 'navigate', url: 'https://meet.new' } },
      { kind: 'meet', label: 'Start a Jitsi Meet room', detail: 'meet.jit.si', action: { type: 'navigate', url: `https://meet.jit.si/Quiver-${Math.random().toString(36).slice(2, 10)}` } },
    ];
  }
  const target = joinTarget(arg);
  if (!target) return [{ kind: 'meet', label: 'Paste a meeting link, a Meet code or a Zoom meeting ID', action: { type: 'noop' } }];
  const url = new URL(target.url);
  return [{ kind: 'meet', label: `Join ${target.provider}`, detail: url.host + url.pathname, action: { type: 'navigate', url: target.url } }];
}
