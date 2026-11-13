/** HLS (m3u8) playlists: parsing and choosing what to save. */

export interface HlsVariant { uri: string; bandwidth: number; resolution: string; audioGroup: string | null }
export interface HlsKey { method: 'NONE' | 'AES-128' | 'SAMPLE-AES' | string; uri: string | null; iv: Buffer | null }
export interface HlsSegment {
  uri: string;
  duration: number;
  sequence: number;
  byterange: { length: number; offset: number } | null;
  key: HlsKey | null;
  map: { uri: string; byterange: { length: number; offset: number } | null } | null;
}
export type HlsPlaylist =
  | { kind: 'master'; variants: HlsVariant[] }
  | { kind: 'media'; segments: HlsSegment[]; endList: boolean };

function attributes(list: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of list.matchAll(/([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g)) out[m[1]] = m[3] ?? m[2];
  return out;
}

function resolve(uri: string, base: string): string {
  const url = new URL(uri, base);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`Unsupported address in playlist: ${url.protocol}`);
  return url.href;
}

function byterange(value: string, previousEnd: number): { length: number; offset: number } {
  const [len, off] = value.split('@');
  return { length: Number(len), offset: off === undefined ? previousEnd : Number(off) };
}

export function parseM3u8(text: string, base: string): HlsPlaylist {
  const lines = text.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines[0] !== '#EXTM3U') throw new Error('Not an HLS playlist (missing #EXTM3U).');
  if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
    const variants: HlsVariant[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
      const a = attributes(lines[i].slice(18));
      const uri = lines.slice(i + 1).find((l) => !l.startsWith('#'));
      if (!uri) continue;
      variants.push({ uri: resolve(uri, base), bandwidth: Number(a.BANDWIDTH) || 0, resolution: a.RESOLUTION ?? '', audioGroup: a.AUDIO ?? null });
    }
    return { kind: 'master', variants };
  }
  const segments: HlsSegment[] = [];
  let sequence = 0;
  let duration = 0;
  let key: HlsKey | null = null;
  let map: HlsSegment['map'] = null;
  let range: { length: number; offset: number } | null = null;
  let previousEnd = 0;
  let endList = false;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) sequence = Number(line.slice(22)) || 0;
    else if (line.startsWith('#EXTINF:')) duration = parseFloat(line.slice(8)) || 0;
    else if (line.startsWith('#EXT-X-BYTERANGE:')) range = byterange(line.slice(17), previousEnd);
    else if (line.startsWith('#EXT-X-KEY:')) {
      const a = attributes(line.slice(11));
      key = a.METHOD === 'NONE' ? null : {
        method: a.METHOD, uri: a.URI ? resolve(a.URI, base) : null,
        iv: a.IV ? Buffer.from(a.IV.replace(/^0x/i, '').padStart(32, '0'), 'hex') : null,
      };
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = attributes(line.slice(11));
      map = { uri: resolve(a.URI, base), byterange: a.BYTERANGE ? byterange(a.BYTERANGE, 0) : null };
    } else if (line === '#EXT-X-ENDLIST') endList = true;
    else if (!line.startsWith('#')) {
      segments.push({ uri: resolve(line, base), duration, sequence, byterange: range, key, map });
      if (range) previousEnd = range.offset + range.length;
      sequence++;
      range = null;
    }
  }
  return { kind: 'media', segments, endList };
}

/** The best variant: highest bandwidth, preferring one whose audio is in the same stream (Quiver doesn't mux). */
export function pickVariant(variants: readonly HlsVariant[]): { variant: HlsVariant; separateAudio: boolean } | null {
  if (!variants.length) return null;
  const byBandwidth = [...variants].sort((a, b) => b.bandwidth - a.bandwidth);
  const muxed = byBandwidth.find((v) => !v.audioGroup);
  return muxed ? { variant: muxed, separateAudio: false } : { variant: byBandwidth[0], separateAudio: true };
}

/** AES-128 IV: the EXT-X-KEY IV, or the segment's media sequence number as a 128-bit big-endian value. */
export function segmentIv(segment: HlsSegment): Buffer {
  if (segment.key?.iv) return segment.key.iv;
  const iv = Buffer.alloc(16);
  iv.writeBigUInt64BE(BigInt(segment.sequence), 8);
  return iv;
}
