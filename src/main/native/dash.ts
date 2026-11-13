import { child, children, parseXml, type XmlNode } from './xml';

/** One stream to save from an MPEG-DASH manifest. */
export interface DashTrack {
  kind: 'video' | 'audio';
  id: string;
  bandwidth: number;
  mime: string;
  init: string | null;
  segments: string[];
}

/** ISO 8601 durations such as PT1H2M3.5S. */
export function isoDuration(value: string | undefined): number {
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value ?? '');
  if (!m) return 0;
  return (Number(m[1] ?? 0) * 86400) + (Number(m[2] ?? 0) * 3600) + (Number(m[3] ?? 0) * 60) + Number(m[4] ?? 0);
}

function fill(template: string, vars: { id: string; bandwidth: number; number?: number; time?: number }): string {
  return template.replace(/\$(RepresentationID|Number|Bandwidth|Time)(?:%0(\d+)d)?\$|\$\$/g, (whole, name: string, width: string) => {
    if (whole === '$$') return '$';
    const value = name === 'RepresentationID' ? vars.id : name === 'Bandwidth' ? vars.bandwidth : name === 'Number' ? vars.number : vars.time;
    if (value === undefined) throw new Error(`The manifest uses $${name}$ where it has no value.`);
    const text = String(value);
    return width ? text.padStart(Number(width), '0') : text;
  });
}

function baseOf(node: XmlNode | undefined, parent: string): string {
  const base = node && child(node, 'BaseURL')?.text.trim();
  return base ? new URL(base, parent).href : parent;
}

function web(url: string): string {
  const u = new URL(url);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`Unsupported address in manifest: ${u.protocol}`);
  return u.href;
}

function segmentsFor(rep: XmlNode, set: XmlNode, base: string, periodSeconds: number, id: string, bandwidth: number): { init: string | null; segments: string[] } {
  const template = child(rep, 'SegmentTemplate') ?? child(set, 'SegmentTemplate');
  if (template) {
    const a = { ...(child(set, 'SegmentTemplate')?.attrs ?? {}), ...(child(rep, 'SegmentTemplate')?.attrs ?? {}) };
    const timescale = Number(a.timescale ?? 1) || 1;
    const start = Number(a.startNumber ?? 1);
    const init = a.initialization ? web(new URL(fill(a.initialization, { id, bandwidth }), base).href) : null;
    const segments: string[] = [];
    const timeline = child(template, 'SegmentTimeline');
    if (timeline) {
      let time = 0;
      let number = start;
      for (const s of children(timeline, 'S')) {
        if (s.attrs.t !== undefined) time = Number(s.attrs.t);
        const d = Number(s.attrs.d);
        const repeat = Number(s.attrs.r ?? 0);
        if (repeat < 0) throw new Error('Open-ended segment timelines are not supported.');
        for (let i = 0; i <= repeat; i++) {
          segments.push(web(new URL(fill(a.media, { id, bandwidth, number, time }), base).href));
          time += d;
          number++;
        }
      }
    } else {
      const duration = Number(a.duration) / timescale;
      if (!duration || !periodSeconds) throw new Error('The manifest does not say how many segments there are.');
      const count = Math.ceil(periodSeconds / duration - 1e-9);
      if (count > 100_000) throw new Error('The manifest lists too many segments.');
      for (let i = 0; i < count; i++) segments.push(web(new URL(fill(a.media, { id, bandwidth, number: start + i }), base).href));
    }
    return { init, segments };
  }
  const list = child(rep, 'SegmentList') ?? child(set, 'SegmentList');
  if (list) {
    const initNode = child(list, 'Initialization');
    return {
      init: initNode?.attrs.sourceURL ? web(new URL(initNode.attrs.sourceURL, base).href) : null,
      segments: children(list, 'SegmentURL').map((s) => web(new URL(s.attrs.media, base).href)),
    };
  }
  // A single file (SegmentBase or a bare BaseURL).
  return { init: null, segments: [web(base)] };
}

/** Pick the best video and best audio track of the first period of a static (on-demand) MPD. */
export function parseMpd(source: string, manifestUrl: string): DashTrack[] {
  const mpd = parseXml(source);
  if (mpd.name !== 'MPD') throw new Error('Not an MPEG-DASH manifest.');
  if (mpd.attrs.type === 'dynamic') throw new Error('Live streams cannot be saved.');
  const period = child(mpd, 'Period');
  if (!period) throw new Error('The manifest has no Period.');
  const mpdBase = baseOf(mpd, manifestUrl);
  const periodBase = baseOf(period, mpdBase);
  const seconds = isoDuration(period.attrs.duration) || isoDuration(mpd.attrs.mediaPresentationDuration);
  const best = new Map<'video' | 'audio', DashTrack>();
  for (const set of children(period, 'AdaptationSet')) {
    const setBase = baseOf(set, periodBase);
    for (const rep of children(set, 'Representation')) {
      const mime = rep.attrs.mimeType ?? set.attrs.mimeType ?? '';
      const type = (set.attrs.contentType ?? mime.split('/')[0]) as string;
      if (type !== 'video' && type !== 'audio') continue;
      const bandwidth = Number(rep.attrs.bandwidth) || 0;
      if ((best.get(type)?.bandwidth ?? -1) >= bandwidth) continue;
      const id = rep.attrs.id ?? '';
      const { init, segments } = segmentsFor(rep, set, baseOf(rep, setBase), seconds, id, bandwidth);
      best.set(type, { kind: type, id, bandwidth, mime, init, segments });
    }
  }
  if (!best.size) throw new Error('The manifest has no audio or video to save.');
  return [...best.values()].sort((a) => (a.kind === 'video' ? -1 : 1));
}
