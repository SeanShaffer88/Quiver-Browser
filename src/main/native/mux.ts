import fs from 'node:fs';

/**
 * Combine a fragmented-MP4 video file and a fragmented-MP4 audio file (as DASH and HLS fMP4 deliver them) into
 * one MP4. Media data is copied in a streaming pass; only the small header boxes are rewritten:
 * - moov gets both tracks (audio renumbered) and both trex entries; mvhd's next track ID is raised;
 * - each moof keeps its bytes (data offsets are relative to the moof) with the audio track ID and a fresh
 *   sequence number; fragments are interleaved by decode time.
 * Index boxes that would point at the wrong bytes (sidx, styp, prft, emsg) are dropped. Anything outside this
 * shape (absolute data offsets, several tracks per file) throws, and the caller keeps separate files.
 */

interface Box { type: string; start: number; size: number; header: number }

function readAt(fd: number, offset: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const n = fs.readSync(fd, buf, done, length - done, offset + done);
    if (!n) throw new Error('Unexpected end of file.');
    done += n;
  }
  return buf;
}

function topBoxes(fd: number, fileSize: number): Box[] {
  const boxes: Box[] = [];
  let pos = 0;
  while (pos + 8 <= fileSize) {
    const head = readAt(fd, pos, Math.min(16, fileSize - pos));
    let size = head.readUInt32BE(0);
    const type = head.toString('latin1', 4, 8);
    let header = 8;
    if (size === 1) { size = Number(head.readBigUInt64BE(8)); header = 16; } else if (size === 0) size = fileSize - pos;
    if (size < header || pos + size > fileSize) throw new Error(`Damaged MP4 box ${type}.`);
    boxes.push({ type, start: pos, size, header });
    pos += size;
  }
  return boxes;
}

function children(buf: Buffer, start = 0, end = buf.length): Box[] {
  const out: Box[] = [];
  let pos = start;
  while (pos + 8 <= end) {
    let size = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    let header = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(pos + 8)); header = 16; } else if (size === 0) size = end - pos;
    if (size < header || pos + size > end) throw new Error(`Damaged MP4 box ${type}.`);
    out.push({ type, start: pos, size, header });
    pos += size;
  }
  return out;
}

function find(buf: Buffer, parent: Box | null, type: string): Box | undefined {
  return children(buf, parent ? parent.start + parent.header : 0, parent ? parent.start + parent.size : buf.length).find((b) => b.type === type);
}

function box(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length + 8, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}

const slice = (buf: Buffer, b: Box) => buf.subarray(b.start, b.start + b.size);

interface Track { trak: Buffer; trex: Buffer; id: number; timescale: number }

/** The single track in a moov: its trak, its trex, track ID and timescale. */
function track(moov: Buffer): Track & { mvhd: Buffer; mehd?: Buffer; others: Buffer[] } {
  const all = children(moov, 8, moov.length);
  const traks = all.filter((b) => b.type === 'trak');
  if (traks.length !== 1) throw new Error('Each file must hold exactly one track.');
  const trak = Buffer.from(slice(moov, traks[0]));
  const trakRoot = { type: 'trak', start: 0, size: trak.length, header: 8 };
  const tkhdBox = find(trak, trakRoot, 'tkhd');
  if (!tkhdBox) throw new Error('No tkhd.');
  const v = trak[tkhdBox.start + tkhdBox.header];
  const id = trak.readUInt32BE(tkhdBox.start + tkhdBox.header + 4 + (v === 1 ? 16 : 8));
  const mdia = find(trak, trakRoot, 'mdia');
  const mdhd = mdia && find(trak, mdia, 'mdhd');
  if (!mdhd) throw new Error('No mdhd.');
  const mv = trak[mdhd.start + mdhd.header];
  const timescale = trak.readUInt32BE(mdhd.start + mdhd.header + 4 + (mv === 1 ? 16 : 8));
  const mvex = all.find((b) => b.type === 'mvex');
  if (!mvex) throw new Error('Not a fragmented MP4 (no mvex).');
  const trexBox = children(moov, mvex.start + mvex.header, mvex.start + mvex.size).find((b) => b.type === 'trex');
  const mehdBox = children(moov, mvex.start + mvex.header, mvex.start + mvex.size).find((b) => b.type === 'mehd');
  if (!trexBox) throw new Error('No trex.');
  const mvhdBox = all.find((b) => b.type === 'mvhd');
  if (!mvhdBox) throw new Error('No mvhd.');
  return {
    trak, id, timescale, trex: Buffer.from(slice(moov, trexBox)), mvhd: Buffer.from(slice(moov, mvhdBox)),
    mehd: mehdBox ? Buffer.from(slice(moov, mehdBox)) : undefined,
    others: all.filter((b) => !['mvhd', 'trak', 'mvex'].includes(b.type)).map((b) => Buffer.from(slice(moov, b))),
  };
}

function setTrackId(trak: Buffer, id: number): void {
  const tkhd = find(trak, { type: 'trak', start: 0, size: trak.length, header: 8 }, 'tkhd')!;
  const v = trak[tkhd.start + tkhd.header];
  trak.writeUInt32BE(id, tkhd.start + tkhd.header + 4 + (v === 1 ? 16 : 8));
}

interface Fragment { fd: number; moof: Box; mdat: Box; time: number; audio: boolean }

function fragments(fd: number, boxes: Box[], timescale: number, audio: boolean): Fragment[] {
  const out: Fragment[] = [];
  for (let i = 0; i < boxes.length; i++) {
    if (boxes[i].type !== 'moof') continue;
    const mdat = boxes.slice(i + 1).find((b) => b.type === 'mdat' || b.type === 'moof');
    if (!mdat || mdat.type !== 'mdat') throw new Error('A fragment has no media data.');
    const moof = readAt(fd, boxes[i].start, boxes[i].size);
    const moofRoot = { type: 'moof', start: 0, size: moof.length, header: boxes[i].header };
    const trafs = children(moof, moofRoot.header, moof.length).filter((b) => b.type === 'traf');
    if (trafs.length !== 1) throw new Error('Each fragment must hold one track.');
    const tfhd = find(moof, trafs[0], 'tfhd');
    if (!tfhd) throw new Error('No tfhd.');
    const flags = moof.readUInt32BE(tfhd.start + tfhd.header) & 0xffffff;
    if (flags & 0x000001) throw new Error('Fragments use absolute data offsets.');
    const tfdt = find(moof, trafs[0], 'tfdt');
    let time = 0;
    if (tfdt) {
      const v = moof[tfdt.start + tfdt.header];
      time = v === 1 ? Number(moof.readBigUInt64BE(tfdt.start + tfdt.header + 4)) : moof.readUInt32BE(tfdt.start + tfdt.header + 4);
    }
    out.push({ fd, moof: boxes[i], mdat, time: time / timescale, audio });
  }
  return out;
}

/** Write `video` and `audio` (fragmented MP4) as one MP4 at `output`. */
export function muxFragmentedMp4(videoPath: string, audioPath: string, output: string): void {
  const vfd = fs.openSync(videoPath, 'r');
  const afd = fs.openSync(audioPath, 'r');
  const out = fs.openSync(output, 'w');
  try {
    const vBoxes = topBoxes(vfd, fs.fstatSync(vfd).size);
    const aBoxes = topBoxes(afd, fs.fstatSync(afd).size);
    const ftyp = vBoxes.find((b) => b.type === 'ftyp');
    const vMoovBox = vBoxes.find((b) => b.type === 'moov');
    const aMoovBox = aBoxes.find((b) => b.type === 'moov');
    if (!ftyp || !vMoovBox || !aMoovBox) throw new Error('Not an MP4 file with a header.');
    const v = track(readAt(vfd, vMoovBox.start, vMoovBox.size));
    const a = track(readAt(afd, aMoovBox.start, aMoovBox.size));
    const audioId = v.id + 1;
    setTrackId(a.trak, audioId);
    a.trex.writeUInt32BE(audioId, 12);
    const mvhd = Buffer.from(v.mvhd);
    mvhd.writeUInt32BE(audioId + 1, mvhd.length - 4);
    const moov = box('moov', mvhd, v.trak, a.trak, ...v.others, box('mvex', ...(v.mehd ? [v.mehd] : []), v.trex, a.trex));
    let pos = 0;
    const write = (buf: Buffer) => { fs.writeSync(out, buf, 0, buf.length, pos); pos += buf.length; };
    write(readAt(vfd, ftyp.start, ftyp.size));
    write(moov);
    const order = [...fragments(vfd, vBoxes, v.timescale, false), ...fragments(afd, aBoxes, a.timescale, true)]
      .sort((x, y) => x.time - y.time || Number(x.audio) - Number(y.audio));
    const chunk = Buffer.alloc(1 << 20);
    order.forEach((f, i) => {
      const moof = readAt(f.fd, f.moof.start, f.moof.size);
      const root = { type: 'moof', start: 0, size: moof.length, header: f.moof.header };
      const mfhd = find(moof, root, 'mfhd');
      if (mfhd) moof.writeUInt32BE(i + 1, mfhd.start + mfhd.header + 4);
      if (f.audio) {
        const traf = find(moof, root, 'traf')!;
        const tfhd = find(moof, traf, 'tfhd')!;
        moof.writeUInt32BE(audioId, tfhd.start + tfhd.header + 4);
      }
      write(moof);
      for (let off = 0; off < f.mdat.size; off += chunk.length) {
        const n = fs.readSync(f.fd, chunk, 0, Math.min(chunk.length, f.mdat.size - off), f.mdat.start + off);
        fs.writeSync(out, chunk, 0, n, pos);
        pos += n;
      }
    });
  } catch (error) {
    fs.closeSync(out);
    fs.rmSync(output, { force: true });
    throw error;
  } finally {
    fs.closeSync(vfd);
    fs.closeSync(afd);
    try { fs.closeSync(out); } catch { /* already closed */ }
  }
}
