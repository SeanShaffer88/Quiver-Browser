import { INTERNAL_ORIGIN, INTERNAL_SCHEME } from '../shared/constants';

export type InternalRole = 'shell' | 'commandbar' | 'settings' | 'boosts';
export type InternalPage = InternalRole | 'newtab';
type SenderKind = 'shell' | 'overlay' | 'tab' | undefined;

export function internalPage(url: string): InternalPage | undefined {
  if (!url.startsWith(INTERNAL_ORIGIN)) return undefined;
  const document = URL.parse(url);
  if (document?.protocol !== INTERNAL_SCHEME + ':' || document.host !== 'app' ||
      document.username || document.password || url.split(/[?#]/, 1)[0] !== INTERNAL_ORIGIN + document.pathname.slice(1)) {
    return undefined;
  }

  switch (document.pathname) {
    case '/shell.html': return 'shell';
    case '/commandbar.html': return 'commandbar';
    case '/settings.html': return 'settings';
    case '/boosts.html': return 'boosts';
    case '/newtab.html': return 'newtab';
    default: return undefined;
  }
}

export function internalRole(url: string, sender: SenderKind, isMainFrame: boolean): InternalRole | undefined {
  if (!sender || !isMainFrame) return undefined;
  const page = internalPage(url);
  switch (page) {
    case 'shell': return sender === 'shell' ? page : undefined;
    case 'commandbar': return sender === 'overlay' ? page : undefined;
    case 'settings':
    case 'boosts': return sender === 'tab' ? page : undefined;
    default: return undefined;
  }
}
