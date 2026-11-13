import type { Session, WebContents } from 'electron';
import { internalPage, type InternalPage } from './internal-access';

export function allowsInternalNavigation(target: string, isMainFrame: boolean, current: InternalPage | undefined): boolean {
  return isMainFrame && current !== undefined && internalPage(target) === current;
}

export type InternalTabPage = 'newtab' | 'settings' | 'boosts' | 'research';

export function isInternalTabPage(page: InternalPage | undefined): page is InternalTabPage {
  return page === 'newtab' || page === 'settings' || page === 'boosts' || page === 'research';
}

export function internalTabUrl(assigned: InternalTabPage, initialUrl: string, currentUrl: string): string {
  // History state can change a renderer's URL without a cancellable navigation event.
  return internalPage(currentUrl) === assigned ? currentUrl : initialUrl;
}

function isHttpUrl(url: URL | null): url is URL & { protocol: 'http:' | 'https:' } {
  return url?.protocol === 'http:' || url?.protocol === 'https:';
}

function isLocalFile(url: URL | null): url is URL & { protocol: 'file:' } {
  return url?.protocol === 'file:' && !url.host && url.pathname.startsWith('/') &&
    !url.pathname.startsWith('//') && !/%(?:2f|5c)/i.test(url.pathname);
}

export function allowsWebNavigation(target: string, initiator?: string): boolean {
  const url = URL.parse(target);
  switch (url?.protocol) {
    case 'http:':
    case 'https:':
    case 'data:':
    case 'blob:':
      return true;
    case 'about:':
      return url.pathname === 'blank' || url.pathname === 'srcdoc';
    case 'file:':
      return isLocalFile(url) && !!initiator && isLocalFile(URL.parse(initiator));
    default:
      return false;
  }
}

interface SitePermission {
  permission: string;
  isMainFrame: boolean;
  topLevelUrl?: string;
  requestingUrl?: string;
  requestingOrigin?: string;
}

export function allowsSitePermission(details: SitePermission): boolean {
  const { permission, isMainFrame, topLevelUrl, requestingUrl, requestingOrigin } = details;
  if ((permission !== 'fullscreen' && permission !== 'clipboard-sanitized-write') || !isMainFrame || !topLevelUrl) return false;

  const top = URL.parse(topLevelUrl);
  const origin = requestingOrigin ? URL.parse(requestingOrigin) : null;
  if (!requestingUrl) {
    // Electron may supply only the origin for a permission check.
    return isHttpUrl(top) && isHttpUrl(origin) && origin.origin === top.origin;
  }

  const requester = URL.parse(requestingUrl);
  if (isHttpUrl(top)) {
    return isHttpUrl(requester) && requester.origin === top.origin &&
      (!requestingOrigin || (isHttpUrl(origin) && origin.origin === top.origin));
  }
  return isLocalFile(top) && isLocalFile(requester) && requester.pathname === top.pathname &&
    requester.search === top.search && (!requestingOrigin || isLocalFile(origin));
}

export function configureSitePermissions(ses: Session, webSession: boolean): void {
  const committedUrl = (contents: WebContents | null) => contents && !contents.isDestroyed() ? contents.getURL() : undefined;
  ses.setPermissionRequestHandler((contents, permission, callback, { isMainFrame, requestingUrl }) => {
    callback(webSession && allowsSitePermission({ permission, isMainFrame, requestingUrl, topLevelUrl: committedUrl(contents) }));
  });
  ses.setPermissionCheckHandler((contents, permission, requestingOrigin, { isMainFrame, requestingUrl }) =>
    webSession && allowsSitePermission({ permission, isMainFrame, requestingUrl, requestingOrigin, topLevelUrl: committedUrl(contents) }));
  ses.setDevicePermissionHandler(() => false);
}
