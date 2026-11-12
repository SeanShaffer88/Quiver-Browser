/** Local-only decoders. Nothing here touches the network. */

export interface JwtDecoded {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  hasSignature: boolean;
}

const BEARER_RE = /^(?:authorization:\s*)?bearer(?:\s+|$)/i;
const JWT_RE = /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

export function looksLikeJwt(input: string): boolean {
  const text = input.trim();
  return BEARER_RE.test(text) || /^eyJ[A-Za-z0-9_-]*\./.test(text);
}

export function stripBearer(input: string): string {
  return input.trim().replace(BEARER_RE, '');
}

function b64urlToString(part: string): string {
  const pad = part.length % 4 === 0 ? '' : '='.repeat(4 - (part.length % 4));
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(b64, 'base64').toString('utf8');
}

export function decodeJwt(input: string): JwtDecoded | null {
  const token = stripBearer(input);
  if (!JWT_RE.test(token)) return null;
  const [h, p, s] = token.split('.');
  try {
    const header = JSON.parse(b64urlToString(h)) as unknown;
    const payload = JSON.parse(b64urlToString(p)) as unknown;
    if (!isObject(header) || !isObject(payload)) return null;
    return { header, payload, hasSignature: (s ?? '').length > 0 };
  } catch {
    return null;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function relativeTime(targetMs: number, nowMs: number): string {
  const diff = targetMs - nowMs;
  const abs = Math.abs(diff);
  const units: [number, string][] = [
    [86400000, 'd'],
    [3600000, 'h'],
    [60000, 'm'],
    [1000, 's'],
  ];
  let text = '0s';
  for (const [ms, label] of units) {
    if (abs >= ms) {
      text = `${Math.floor(abs / ms)}${label}`;
      break;
    }
  }
  return diff >= 0 ? `in ${text}` : `${text} ago`;
}

export interface UnixDecoded {
  ms: number;
  iso: string;
  unit: 'seconds' | 'milliseconds';
}

/** 10 digits = seconds, 13 digits = milliseconds. Anything else is not treated as a timestamp. */
export function decodeUnix(input: string): UnixDecoded | null {
  const t = input.trim();
  if (!/^\d{10}$|^\d{13}$/.test(t)) return null;
  const n = Number(t);
  const unit = t.length === 10 ? 'seconds' : 'milliseconds';
  const ms = unit === 'seconds' ? n * 1000 : n;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return { ms, iso: d.toISOString(), unit };
}
