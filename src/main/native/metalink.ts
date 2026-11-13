import { safeFileName } from '../downloads';
import { child, children, parseXml } from './xml';

export interface MetalinkFile {
  name: string;
  size: number | null;
  /** Lower-case algorithm name (sha-256, sha-1, md5) → hex digest. */
  hashes: Record<string, string>;
  /** Mirrors, best first. */
  urls: string[];
}

const ALGORITHMS: Record<string, string> = { 'sha-512': 'sha512', 'sha-384': 'sha384', 'sha-256': 'sha256', sha256: 'sha256', 'sha-1': 'sha1', sha1: 'sha1', md5: 'md5' };

/** The strongest checksum to verify, as a Node hash name and hex digest. */
export function strongestHash(hashes: Record<string, string>): { algorithm: string; hex: string } | null {
  for (const name of ['sha-512', 'sha-384', 'sha-256', 'sha256', 'sha-1', 'sha1', 'md5']) {
    const hex = hashes[name];
    if (hex && /^[0-9a-f]+$/i.test(hex)) return { algorithm: ALGORITHMS[name], hex: hex.toLowerCase() };
  }
  return null;
}

function mirror(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'ftp:' ? url.href : null;
  } catch {
    return null;
  }
}

/** Metalink 4 (RFC 5854, .meta4) and Metalink 3 (.metalink). */
export function parseMetalink(source: string): MetalinkFile[] {
  const root = parseXml(source);
  if (root.name !== 'metalink') throw new Error('Not a Metalink file.');
  const v3 = child(root, 'files');
  const nodes = v3 ? children(v3, 'file') : children(root, 'file');
  const files: MetalinkFile[] = [];
  for (const file of nodes.slice(0, 1000)) {
    const hashes: Record<string, string> = {};
    const hashNodes = v3 ? children(child(file, 'verification') ?? file, 'hash') : children(file, 'hash');
    for (const h of hashNodes) if (h.attrs.type) hashes[h.attrs.type.toLowerCase()] = h.text.trim();
    const urlNodes = v3 ? children(child(file, 'resources') ?? file, 'url') : children(file, 'url');
    const ranked = urlNodes
      .map((u) => ({ url: mirror(u.text), rank: v3 ? -(Number(u.attrs.preference) || 0) : Number(u.attrs.priority) || 999_999 }))
      .filter((u): u is { url: string; rank: number } => !!u.url)
      .sort((a, b) => a.rank - b.rank);
    const size = Number(child(file, 'size')?.text);
    files.push({ name: safeFileName(file.attrs.name ?? ''), size: Number.isFinite(size) && size >= 0 ? size : null, hashes, urls: ranked.map((u) => u.url) });
  }
  if (!files.length) throw new Error('The Metalink file lists no files.');
  return files;
}
