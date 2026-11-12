import { decodeJwt, decodeUnix, looksLikeJwt, relativeTime } from './decoders';
import { DEFAULT_SEARCH } from './constants';
import { detectEnv, isLocalHost, switchEnv } from './env';
import type { EnvBadge, ParseContext, Suggestion } from './types';

const enc = encodeURIComponent;

export function searchUrl(template: string, q: string): string {
  const t = template.includes('%s') ? template : DEFAULT_SEARCH;
  return t.replace('%s', enc(q));
}

/** Turn free text into a URL: explicit URL, host-like string, :port, or a web search. */
export function resolveInput(raw: string, searchEngine: string): string {
  const t = raw.trim();
  if (!t) return 'about:blank';
  if (/^quiver:\/\//i.test(t)) return t;
  if (/^(https?|file|about|data):/i.test(t)) return t;
  if (/^:\d{2,5}(\/.*)?$/.test(t)) return `http://localhost${t}`;
  if (!/\s/.test(t)) {
    const host = t.split(/[/?#:]/)[0];
    if (isLocalHost(host)) return `http://${t}`;
    if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#].*)?$/.test(t)) return `http://${t}`;
    if (/^([a-z0-9-]+\.)+[a-z]{2,}(:\d+)?([/?#].*)?$/i.test(t)) return `https://${t}`;
  }
  return searchUrl(searchEngine, t);
}

function nav(kind: string, label: string, url: string, detail?: string): Suggestion {
  return { kind, label, detail: detail ?? url, action: { type: 'navigate', url } };
}

function copy(kind: string, label: string, text: string): Suggestion {
  return { kind, label, detail: text.length > 90 ? text.slice(0, 90) + '…' : text, action: { type: 'copy', text } };
}

function currentHost(ctx: ParseContext): string | null {
  if (!ctx.currentUrl) return null;
  try {
    const u = new URL(ctx.currentUrl);
    return u.protocol.startsWith('http') ? u.hostname.replace(/^www\./, '') : null;
  } catch {
    return null;
  }
}

function jwtDate(value: unknown): Date | null {
  if (typeof value !== 'number') return null;
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date : null;
}

function jwtSuggestions(input: string): Suggestion[] | null {
  if (!looksLikeJwt(input)) return null;
  const d = decodeJwt(input);
  if (!d) return [{ kind: 'jwt', label: 'Token could not be decoded', detail: 'Kept on this device', action: { type: 'noop' } }];
  const now = Date.now();
  const out: Suggestion[] = [];
  const alg = typeof d.header.alg === 'string' ? d.header.alg : '?';
  const bits: string[] = [`JWT ${alg}`];
  const exp = jwtDate(d.payload.exp);
  if (exp) bits.push(`exp ${relativeTime(exp.getTime(), now)}`);
  const iat = jwtDate(d.payload.iat);
  if (iat) bits.push(`iat ${relativeTime(iat.getTime(), now)}`);
  bits.push(d.hasSignature ? 'signature NOT verified' : 'unsigned');
  out.push({ kind: 'jwt', label: bits.join(' · '), detail: 'decoded locally, never sent anywhere', action: { type: 'noop' } });
  out.push(copy('jwt', 'Copy payload', JSON.stringify(d.payload, null, 2)));
  out.push(copy('jwt', 'Copy header', JSON.stringify(d.header, null, 2)));
  for (const [k, v] of Object.entries(d.payload).slice(0, 8)) {
    const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
    const date = k === 'exp' || k === 'iat' || k === 'nbf' ? jwtDate(v) : null;
    const extra = date ? ` (${date.toISOString()})` : '';
    out.push(copy('jwt', `${k}: ${val}${extra}`, val));
  }
  return out;
}

function unixSuggestions(input: string): Suggestion[] | null {
  const d = decodeUnix(input);
  if (!d) return null;
  const now = Date.now();
  return [
    copy('unix', `${d.iso}  (${relativeTime(d.ms, now)})`, d.iso),
    copy('unix', `Local: ${new Date(d.ms).toString()}`, new Date(d.ms).toString()),
    copy('unix', `Unix ${d.unit === 'seconds' ? 'ms' : 's'}: ${d.unit === 'seconds' ? d.ms : Math.floor(d.ms / 1000)}`, String(d.unit === 'seconds' ? d.ms : Math.floor(d.ms / 1000))),
  ];
}

function ghSuggestions(rest: string): Suggestion[] {
  if (!rest) return [nav('gh', 'GitHub', 'https://github.com')];
  const sr = rest.match(/^(?:s|search)\s+(.+)$/i);
  if (sr) return [nav('gh', `Search GitHub: ${sr[1]}`, `https://github.com/search?q=${enc(sr[1])}`)];
  const pr = rest.match(/^([\w.-]+\/[\w.-]+)\s*(?:#|pr\s*|pull\s*|issues?\s*)(\d+)$/i);
  if (pr) return [nav('gh', `PR / issue #${pr[2]} in ${pr[1]}`, `https://github.com/${pr[1]}/pull/${pr[2]}`)];
  const repoPath = rest.match(/^([\w.-]+\/[\w.-]+)(\/\S*)?$/);
  if (repoPath) return [nav('gh', `GitHub repo ${repoPath[1]}`, `https://github.com/${repoPath[1]}${repoPath[2] ?? ''}`)];
  if (/^[\w.-]+$/.test(rest)) return [nav('gh', `GitHub user/org ${rest}`, `https://github.com/${rest}`)];
  return [nav('gh', `Search GitHub: ${rest}`, `https://github.com/search?q=${enc(rest)}`)];
}

function npmSuggestions(rest: string): Suggestion[] {
  if (!rest) return [nav('npm', 'npm', 'https://www.npmjs.com')];
  const sr = rest.match(/^(?:s|search)\s+(.+)$/i);
  if (sr) return [nav('npm', `Search npm: ${sr[1]}`, `https://www.npmjs.com/search?q=${enc(sr[1])}`)];
  if (/^(@[\w.-]+\/)?[\w.-]+$/.test(rest)) {
    return [
      nav('npm', `npm package ${rest}`, `https://www.npmjs.com/package/${rest}`),
      nav('npm', `Search npm: ${rest}`, `https://www.npmjs.com/search?q=${enc(rest)}`),
    ];
  }
  return [nav('npm', `Search npm: ${rest}`, `https://www.npmjs.com/search?q=${enc(rest)}`)];
}

function boostSuggestions(rest: string, ctx: ParseContext): Suggestion[] {
  const host = currentHost(ctx);
  const out: Suggestion[] = [];
  const r = rest.trim();
  if (!r) {
    out.push({ kind: 'boost', label: 'Open Boosts page', action: { type: 'internal', page: 'boosts' } });
    if (host) {
      out.push({ kind: 'boost', label: `Edit ${host}.css`, detail: 'CSS for this site, applied live', action: { type: 'boost', name: `${host}.css` } });
      out.push({ kind: 'boost', label: `Edit ${host}.ts`, detail: 'TypeScript for this site, reloads tabs on save', action: { type: 'boost', name: `${host}.ts` } });
    }
    out.push({ kind: 'boost', label: 'Edit all.css', detail: 'CSS for every site', action: { type: 'boost', name: 'all.css' } });
    return out;
  }
  if (r === 'css' || r === 'ts') {
    if (host) out.push({ kind: 'boost', label: `Edit ${host}.${r}`, action: { type: 'boost', name: `${host}.${r}` } });
    out.push({ kind: 'boost', label: `Edit all.${r}`, action: { type: 'boost', name: `all.${r}` } });
    return out;
  }
  if (r === 'all') return [{ kind: 'boost', label: 'Edit all.css', action: { type: 'boost', name: 'all.css' } }];
  const named = r.match(/^([a-z0-9.-]+?)(?:\.(css|ts))?$/i);
  if (named) {
    const base = named[1].toLowerCase();
    if (named[2]) return [{ kind: 'boost', label: `Edit ${base}.${named[2].toLowerCase()}`, action: { type: 'boost', name: `${base}.${named[2].toLowerCase()}` } }];
    return [
      { kind: 'boost', label: `Edit ${base}.css`, action: { type: 'boost', name: `${base}.css` } },
      { kind: 'boost', label: `Edit ${base}.ts`, action: { type: 'boost', name: `${base}.ts` } },
    ];
  }
  return [{ kind: 'boost', label: 'Open Boosts page', action: { type: 'internal', page: 'boosts' } }];
}

function envSuggestions(rest: string, ctx: ParseContext): Suggestion[] {
  const cur = ctx.currentUrl;
  const m = cur ? detectEnv(cur, ctx.envGroups) : null;
  if (!cur || !m) {
    return [
      { kind: 'env', label: 'Current page is not in an environment group', detail: 'Add origins under Settings → Environments', action: { type: 'internal', page: 'settings' } },
    ];
  }
  const want = rest.trim().toLowerCase();
  const map: Record<string, EnvBadge> = { local: 'LOCAL', localhost: 'LOCAL', dev: 'LOCAL', stage: 'STAGING', staging: 'STAGING', prod: 'PROD', production: 'PROD' };
  const targets: (EnvBadge | undefined)[] = want && map[want] ? [map[want]] : want ? [] : [undefined];
  if (!want) targets.push('LOCAL', 'STAGING', 'PROD');
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  for (const t of targets) {
    const url = switchEnv(cur, ctx.envGroups, t);
    if (!url || seen.has(url) || url === cur) continue;
    seen.add(url);
    out.push({ kind: 'env', label: t ? `Jump to ${t}` : 'Jump to next environment', detail: url, action: { type: 'env', target: t } });
  }
  return out.length ? out : [{ kind: 'env', label: 'No other environment configured for this group', action: { type: 'noop' } }];
}

/** Parse the command bar input into ranked suggestions. Pure and offline. */
export function parseCommand(input: string, ctx: ParseContext): Suggestion[] {
  const text = input.trim();
  if (!text) return [];

  const jwt = jwtSuggestions(text);
  if (jwt) return jwt;
  const unix = unixSuggestions(text);
  if (unix) return unix;

  const m = text.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  const cmd = (m?.[1] ?? '').toLowerCase();
  const rest = (m?.[2] ?? '').trim();

  switch (cmd) {
    case 'gh':
      return ghSuggestions(rest);
    case 'npm':
      return npmSuggestions(rest);
    case 'mdn':
      return rest
        ? [nav('mdn', `MDN: ${rest}`, `https://developer.mozilla.org/en-US/search?q=${enc(rest)}`)]
        : [nav('mdn', 'MDN Web Docs', 'https://developer.mozilla.org')];
    case 'caniuse':
      return rest
        ? [nav('caniuse', `Can I use: ${rest}`, `https://caniuse.com/?search=${enc(rest)}`)]
        : [nav('caniuse', 'Can I use', 'https://caniuse.com')];
    case 'so':
      return rest
        ? [nav('so', `Stack Overflow: ${rest}`, `https://stackoverflow.com/search?q=${enc(rest)}`)]
        : [nav('so', 'Stack Overflow', 'https://stackoverflow.com')];
    case 'env':
      return envSuggestions(rest, ctx);
    case 'boost':
      return boostSuggestions(rest, ctx);
    case 'settings':
      return [{ kind: 'internal', label: 'Open Settings', action: { type: 'internal', page: 'settings' } }];
    default:
      break;
  }

  const url = resolveInput(text, ctx.searchEngine);
  const isSearch = url.startsWith(ctx.searchEngine.split('%s')[0]) && url !== text && !/^https?:\/\//i.test(text);
  return [nav(isSearch ? 'search' : 'url', isSearch ? `Search: ${text}` : `Go to ${url}`, url)];
}
