import { createDecipheriv, createHash } from 'node:crypto';
import fs from 'node:fs';
import { parseMpd } from './dash';
import { muxFragmentedMp4 } from './mux';
import { ftpDownload } from './ftp';
import { parseM3u8, pickVariant, segmentIv, type HlsSegment } from './hls';
import { fetchBytes, fetchOk, fetchText, type JobContext } from './job';
import { parseMetalink, strongestHash } from './metalink';

/** Gives the final path for a file name (unique in the downloads folder). */
export type Place = (filename: string) => string;

function rangeHeader(range: { length: number; offset: number } | null): Record<string, string> | undefined {
  return range ? { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` } : undefined;
}

/** Some servers ignore Range and send the whole file: cut the requested bytes out. */
function sliceRange(bytes: Buffer, range: { length: number; offset: number } | null): Buffer {
  return range && bytes.length > range.length ? bytes.subarray(range.offset, range.offset + range.length) : bytes;
}

async function finish(stream: fs.WriteStream, part: string, final: string): Promise<void> {
  await new Promise<void>((resolve, reject) => stream.end((e?: Error | null) => (e ? reject(e) : resolve())));
  fs.renameSync(part, final);
}

/** Download a list of parts in order, fetching up to four ahead, appending each to `stream`. */
async function fetchInOrder(ctx: JobContext, count: number, get: (i: number) => Promise<Buffer>, write: (i: number, data: Buffer) => Promise<void>): Promise<void> {
  const ahead = new Map<number, Promise<Buffer>>();
  let next = 0;
  const fill = () => { while (next < count && ahead.size < 4) { const i = next++; const p = get(i); p.catch(() => undefined); ahead.set(i, p); } };
  for (let i = 0; i < count; i++) {
    await ctx.control.ready();
    fill();
    const data = await ahead.get(i)!;
    ahead.delete(i);
    await write(i, data);
  }
}

function writeChunk(stream: fs.WriteStream, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => stream.write(data, (e) => (e ? reject(e) : resolve())));
}

/** Fetch and check a media playlist that is about to be saved. */
async function mediaSegments(ctx: JobContext, uri: string): Promise<HlsSegment[]> {
  const playlist = parseM3u8(await fetchText(ctx, uri), uri);
  if (playlist.kind !== 'media') throw new Error('Unexpected nested playlist.');
  return checkedSegments(playlist);
}

function checkedSegments(playlist: { segments: HlsSegment[]; endList: boolean }): HlsSegment[] {
  if (!playlist.endList) throw new Error('Live streams cannot be saved.');
  const segments = playlist.segments;
  if (!segments.length) throw new Error('The playlist has no segments.');
  if (segments.some((s) => s.key && s.key.method !== 'AES-128')) throw new Error('This stream is protected (DRM) and cannot be saved.');
  return segments;
}

/** fMP4 playlists carry an init section (#EXT-X-MAP); only those can be combined with muxFragmentedMp4. */
const isFmp4 = (segments: readonly HlsSegment[]) => segments.every((s) => s.map);

function audioExtension(segments: readonly HlsSegment[]): string {
  if (isFmp4(segments)) return '.m4a';
  const ext = new URL(segments[0].uri).pathname.match(/\.(aac|ac3|ec3|mp3|ts)$/i)?.[1];
  return `.${(ext ?? 'ts').toLowerCase()}`;
}

/**
 * Save an on-demand HLS stream, decrypting AES-128 segments. A master playlist's best variant is used; when its
 * audio is a separate playlist and both are fragmented MP4, the two are combined into one .mp4.
 */
export async function runHls(url: string, name: string, ctx: JobContext, place: Place): Promise<string[]> {
  const top = parseM3u8(await fetchText(ctx, url), url);
  if (top.kind === 'media') return saveHls(checkedSegments(top), name, ctx, place);
  const pick = pickVariant(top.variants, top.renditions);
  if (!pick) throw new Error('The playlist has no streams.');
  if (!pick.audio) return saveHls(await mediaSegments(ctx, pick.variant.uri), name, ctx, place, pick.separateAudio ? ' · video only (audio is a separate stream)' : '');
  const video = await mediaSegments(ctx, pick.variant.uri);
  const audio = await mediaSegments(ctx, pick.audio.uri!);
  // Combining needs both halves as fMP4; a muxed variant (even a lower one) beats two loose files.
  if (!(isFmp4(video) && isFmp4(audio)) && pick.fallback) return saveHls(await mediaSegments(ctx, pick.fallback.uri), name, ctx, place);
  const progress = { received: 0, done: 0, total: video.length + audio.length };
  if (!(isFmp4(video) && isFmp4(audio))) {
    const files = [await saveHls(video, name, ctx, place, ' · video', progress)];
    try {
      files.push(await saveHls(audio, name, ctx, place, ' · audio', progress, audioExtension(audio)));
    } catch (error) { for (const f of files.flat()) fs.rmSync(f, { force: true }); throw error; }
    return files.flat();
  }
  const final = place(`${name}.mp4`);
  const videoPart = `${final}.video.part`;
  const audioPart = `${final}.audio.part`;
  try {
    await saveHlsTo(video, videoPart, ctx, ' · video', progress);
    await saveHlsTo(audio, audioPart, ctx, ' · audio', progress);
  } catch (error) {
    for (const f of [videoPart, audioPart]) fs.rmSync(f, { force: true });
    throw error;
  }
  try {
    ctx.progress({ received: progress.received, total: progress.received, detail: 'Combining video and audio' });
    muxFragmentedMp4(videoPart, audioPart, `${final}.part`);
    fs.renameSync(`${final}.part`, final);
    for (const f of [videoPart, audioPart]) fs.rmSync(f, { force: true });
    return [final];
  } catch {
    // Not a shape Quiver can combine: keep the video and hand the audio over as its own file.
    fs.rmSync(`${final}.part`, { force: true });
    fs.renameSync(videoPart, final);
    const audioFile = place(`${name}.m4a`);
    fs.renameSync(audioPart, audioFile);
    ctx.progress({ received: progress.received, total: progress.received, detail: 'Saved video and audio as separate files (they could not be combined)' });
    return [final, audioFile];
  }
}

interface HlsProgress { received: number; done: number; total: number }

async function saveHls(segments: HlsSegment[], name: string, ctx: JobContext, place: Place, note = '', progress?: HlsProgress, ext?: string): Promise<string[]> {
  const final = place(`${name}${ext ?? (segments[0].map ? '.mp4' : '.ts')}`);
  const part = `${final}.part`;
  try {
    await saveHlsTo(segments, part, ctx, note, progress ?? { received: 0, done: 0, total: segments.length });
  } catch (error) {
    fs.rmSync(part, { force: true });
    throw error;
  }
  fs.renameSync(part, final);
  return [final];
}

/** Write a media playlist's segments (with their init sections) to `file`, in order. */
async function saveHlsTo(segments: HlsSegment[], file: string, ctx: JobContext, note: string, progress: HlsProgress): Promise<void> {
  const stream = fs.createWriteStream(file);
  const keys = new Map<string, Promise<Buffer>>();
  const key = (uri: string) => {
    if (!keys.has(uri)) keys.set(uri, fetchBytes(ctx, uri, undefined, 1024).then((k) => { if (k.length !== 16) throw new Error('The stream key is not valid.'); return k; }));
    return keys.get(uri)!;
  };
  let lastMap = '';
  try {
    await fetchInOrder(ctx, segments.length, async (i) => {
      const s: HlsSegment = segments[i];
      let data = sliceRange(await fetchBytes(ctx, s.uri, rangeHeader(s.byterange)), s.byterange);
      if (s.key) {
        if (!s.key.uri) throw new Error('The stream key is missing.');
        const decipher = createDecipheriv('aes-128-cbc', await key(s.key.uri), segmentIv(s));
        data = Buffer.concat([decipher.update(data), decipher.final()]);
      }
      return data;
    }, async (i, data) => {
      const s = segments[i];
      const mapId = s.map ? `${s.map.uri}#${s.map.byterange?.offset ?? ''}` : '';
      if (s.map && mapId !== lastMap) {
        await writeChunk(stream, sliceRange(await fetchBytes(ctx, s.map.uri, rangeHeader(s.map.byterange)), s.map.byterange));
        lastMap = mapId;
      }
      await writeChunk(stream, data);
      progress.received += data.length;
      progress.done++;
      const { received, done, total } = progress;
      ctx.progress({ received, total: done >= 3 ? Math.round((received / done) * total) : 0, detail: `${done} of ${total} segments${note}` });
    });
    await new Promise<void>((resolve, reject) => stream.end((e?: Error | null) => (e ? reject(e) : resolve())));
  } catch (error) {
    stream.destroy();
    throw error;
  }
}

/**
 * Save an on-demand MPEG-DASH stream: the best video and best audio. When both are fragmented MP4, they are
 * combined into one .mp4; otherwise (or if combining fails) each is saved as its own file.
 */
export async function runDash(url: string, name: string, ctx: JobContext, place: Place): Promise<string[]> {
  const tracks = parseMpd(await fetchText(ctx, url), url);
  const totalParts = tracks.reduce((n, t) => n + t.segments.length + (t.init ? 1 : 0), 0);
  let done = 0;
  let received = 0;
  const saved: string[] = [];
  for (const track of tracks) {
    const suffix = tracks.length > 1 ? `.${track.kind}` : '';
    const ext = track.kind === 'audio' ? (track.mime.includes('webm') ? '.webm' : '.m4a') : track.mime.includes('webm') ? '.webm' : '.mp4';
    const final = place(`${name}${suffix}${ext}`);
    const part = `${final}.part`;
    const stream = fs.createWriteStream(part);
    const urls = [...(track.init ? [track.init] : []), ...track.segments];
    try {
      await fetchInOrder(ctx, urls.length, (i) => fetchBytes(ctx, urls[i]), async (_i, data) => {
        await writeChunk(stream, data);
        received += data.length;
        done++;
        ctx.progress({ received, total: done >= 3 ? Math.round((received / done) * totalParts) : 0, detail: `${track.kind}: ${done} of ${totalParts} parts` });
      });
      await finish(stream, part, final);
      saved.push(final);
    } catch (error) {
      stream.destroy();
      fs.rmSync(part, { force: true });
      for (const f of saved) fs.rmSync(f, { force: true });
      throw error;
    }
  }
  const [video, audio] = tracks;
  if (saved.length === 2 && video.kind === 'video' && audio.kind === 'audio' && !video.mime.includes('webm') && !audio.mime.includes('webm')) {
    const combined = place(`${name}.mp4`);
    try {
      ctx.progress({ received, total: received, detail: 'Combining video and audio' });
      muxFragmentedMp4(saved[0], saved[1], combined);
      for (const f of saved) fs.rmSync(f, { force: true });
      return [combined];
    } catch {
      // Not a shape Quiver can combine: keep the two files.
    }
  }
  return saved;
}

async function hashFile(file: string, algorithm: string): Promise<string> {
  const hash = createHash(algorithm);
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Stream an HTTP(S) response into `file`, reporting progress. */
async function httpToFile(ctx: JobContext, url: string, file: string, onBytes: (n: number) => void): Promise<void> {
  const response = await fetchOk(ctx, url);
  if (!response.body) throw new Error('Empty response.');
  const stream = fs.createWriteStream(file);
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      await ctx.control.ready();
      await writeChunk(stream, Buffer.from(chunk));
      onBytes(chunk.length);
    }
  } finally {
    await new Promise<void>((resolve) => stream.end(() => resolve()));
  }
}

/**
 * Download every file a Metalink lists, trying mirrors best first and moving to the next when one fails or the
 * size or checksum doesn't match. A file without a checksum is accepted on size alone and the result says so.
 */
export async function runMetalink(url: string, ctx: JobContext, place: Place): Promise<string[]> {
  const files = parseMetalink(await fetchText(ctx, url));
  const total = files.reduce((n, f) => n + (f.size ?? 0), 0);
  let received = 0;
  const saved: string[] = [];
  for (const [index, file] of files.entries()) {
    if (!file.urls.length) throw new Error(`No usable mirror for ${file.name}.`);
    const final = place(file.name);
    const part = `${final}.part`;
    const hash = strongestHash(file.hashes);
    let lastError: unknown = null;
    let ok = false;
    for (const [m, mirror] of file.urls.entries()) {
      const before = received;
      const detail = `${files.length > 1 ? `file ${index + 1} of ${files.length} · ` : ''}mirror ${m + 1} of ${file.urls.length}${hash ? '' : ' · no checksum to verify'}`;
      const onBytes = (n: number) => { received += n; ctx.progress({ received, total, detail }); };
      try {
        fs.rmSync(part, { force: true });
        if (mirror.startsWith('ftp:')) {
          let last = 0;
          await ftpDownload(mirror, part, { ...ctx, progress: (p) => { onBytes(p.received - last); last = p.received; } });
        } else {
          await httpToFile(ctx, mirror, part, onBytes);
        }
        const size = fs.statSync(part).size;
        if (file.size !== null && size !== file.size) throw new Error(`size ${size} instead of ${file.size}`);
        if (hash && (await hashFile(part, hash.algorithm)) !== hash.hex) throw new Error(`${hash.algorithm} checksum does not match`);
        ok = true;
        break;
      } catch (error) {
        if (ctx.control.cancelled) { fs.rmSync(part, { force: true }); throw error; }
        lastError = error;
        received = before;
      }
    }
    if (!ok) {
      fs.rmSync(part, { force: true });
      throw new Error(`Every mirror failed for ${file.name}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    }
    fs.renameSync(part, final);
    saved.push(final);
  }
  return saved;
}

/** Which of Quiver's own downloaders handles an address, judged by scheme and file extension. */
export function nativeKind(url: string, mime = ''): 'ftp' | 'hls' | 'dash' | 'metalink' | 'webdav' | null {
  const parsed = URL.parse(url);
  if (!parsed) return null;
  if (['dav:', 'davs:', 'webdav:', 'webdavs:'].includes(parsed.protocol)) return 'webdav';
  if (parsed.protocol === 'ftp:' || parsed.protocol === 'ftps:') return 'ftp';
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const path = parsed.pathname.toLowerCase();
  const type = mime.toLowerCase().split(';')[0].trim();
  if (path.endsWith('.m3u8') || ['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl'].includes(type)) return 'hls';
  if (path.endsWith('.mpd') || type === 'application/dash+xml') return 'dash';
  if (path.endsWith('.meta4') || path.endsWith('.metalink') || type === 'application/metalink4+xml' || type === 'application/metalink+xml') return 'metalink';
  return null;
}
