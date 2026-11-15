import { randomBytes } from 'node:crypto';
import type { WebContents } from 'electron';
import type { ShortcutAction } from './shortcuts';

/**
 * Page-first shortcuts for web tabs.
 *
 * Electron's before-input-event runs before the page sees a key and is the only point where Quiver can stop it
 * (preventDefault there is synchronous). Asking the page "do you want this key?" at that moment isn't possible, so
 * page-first keys work the other way round, the way Chrome does it: Quiver lets the key through, and a small
 * listener in an isolated world (invisible to the page's own scripts) looks at the keydown after the page's
 * handlers have run. If the page called preventDefault or the key landed in an editable element, the page keeps it;
 * otherwise the listener reports the key and Quiver runs its action. Quiver sets no application menu, so a key the
 * page ignores has no Chromium default action that could run twice.
 *
 * The report travels as a console message prefixed with a per-page random token. The page can't read the token, and
 * a report only runs an action the user pressed in the last second, so a page can at most decline a key, which it
 * could anyway. Keys pressed while focus is inside an iframe (Google Docs' editor, embedded players) never reach the
 * top document, so the listener also reports when focus enters or leaves a frame and those keys stay with the page.
 * Until the listener is installed (early in a load), Quiver handles page-first keys itself as before.
 */

/** A world id of Quiver's own, distinct from Electron's preload world (999). */
const WORLD_ID = 1207;
const PENDING_MS = 1000;

function listenerSource(token: string): string {
  return `(() => {
  if (window.__quiverPageKeys) return true;
  window.__quiverPageKeys = true;
  const say = (m) => console.debug(${JSON.stringify(token)} + m);
  const TEXT_INPUT = /^(text|search|url|tel|email|password|number|date|datetime-local|month|week|time|)$/;
  const editable = (el) => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement || (n.getRootNode().host || null)) {
      if (n.isContentEditable) return true;
      if (n.tagName === 'TEXTAREA' || n.tagName === 'SELECT') return true;
      if (n.tagName === 'INPUT') return TEXT_INPUT.test((n.getAttribute('type') || '').toLowerCase());
      if (n.getAttribute && n.getAttribute('role') === 'textbox') return true;
    }
    return false;
  };
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.altKey || e.metaKey || /^F\\d{1,2}$/.test(e.code))) return;
    const target = e.composedPath()[0];
    // After dispatch, defaultPrevented reflects every page handler.
    setTimeout(() => { if (!e.defaultPrevented && !editable(target)) say('k' + e.code); }, 0);
  }, true);
  let inFrame = null;
  const frameCheck = () => {
    const a = document.activeElement;
    const f = !!a && /^(IFRAME|FRAME|EMBED|OBJECT)$/.test(a.tagName);
    if (f !== inFrame) { inFrame = f; say('f' + (f ? 1 : 0)); }
  };
  window.addEventListener('focusin', frameCheck, true);
  window.addEventListener('focus', frameCheck, true);
  window.addEventListener('blur', () => setTimeout(frameCheck, 0), true);
  frameCheck();
  return true;
})()`;
}

export class PageKeys {
  private readonly token = `⁣qk${randomBytes(12).toString('hex')}:`;
  private ready = false;
  private inFrame = false;
  private generation = 0;
  private pending: { action: ShortcutAction; code: string; at: number }[] = [];

  constructor(private readonly wc: WebContents, private readonly enabled: () => boolean, private readonly run: (a: ShortcutAction) => void) {
    // A new document has no listener yet: Quiver handles keys itself until the new one is installed.
    wc.on('did-navigate', () => this.reset());
    wc.on('dom-ready', () => this.install());
    wc.on('console-message', (event) => {
      const message = (event as unknown as { message?: string }).message;
      if (typeof message === 'string' && message.startsWith(this.token)) this.report(message.slice(this.token.length));
    });
  }

  private reset(): void {
    this.generation++;
    this.ready = false;
    this.inFrame = false;
    this.pending = [];
  }

  private install(): void {
    if (!this.enabled() || this.wc.isDestroyed()) return;
    const generation = this.generation;
    this.wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code: listenerSource(this.token) }]).then((ok) => {
      if (ok === true && generation === this.generation) this.ready = true;
    }, () => undefined);
  }

  private report(body: string): void {
    if (body === 'f0' || body === 'f1') {
      this.inFrame = body === 'f1';
      return;
    }
    if (!body.startsWith('k')) return;
    const code = body.slice(1);
    const now = Date.now();
    this.pending = this.pending.filter((p) => now - p.at < PENDING_MS);
    const i = this.pending.findIndex((p) => p.code === code);
    if (i < 0) return;
    const [{ action }] = this.pending.splice(0, i + 1).slice(-1);
    this.run(action);
  }

  /**
   * Called from before-input-event for a page-first action. Returns true when the key should go to the page
   * (Quiver may still act once the page leaves it unhandled); false when Quiver should handle it right away.
   */
  offer(action: ShortcutAction, code: string): boolean {
    if (!this.enabled() || !this.ready) return false;
    if (this.inFrame) return true;
    this.pending.push({ action, code, at: Date.now() });
    if (this.pending.length > 16) this.pending.shift();
    return true;
  }
}
