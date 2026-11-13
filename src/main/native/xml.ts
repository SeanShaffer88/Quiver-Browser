/** A small XML reader for MPD and Metalink files. DOCTYPE is refused, so entity tricks (XXE, billion laughs) cannot apply. */
export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const MAX_NODES = 200_000;

function decode(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1].toLowerCase() === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[ref.toLowerCase()] ?? whole;
  });
}

/** Local name without a namespace prefix (`mpd:Period` → `Period`). */
function local(name: string): string {
  const i = name.indexOf(':');
  return i >= 0 ? name.slice(i + 1) : name;
}

export function parseXml(source: string): XmlNode {
  if (/<!DOCTYPE/i.test(source)) throw new Error('XML with a DOCTYPE is not accepted.');
  const root: XmlNode = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  const tag = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let count = 0;
  for (const m of source.matchAll(tag)) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2] !== undefined) {
      if (stack.length < 2 || top.name !== local(m[2])) throw new Error(`Unexpected </${m[2]}>.`);
      stack.pop();
    } else if (m[3] !== undefined) {
      if (++count > MAX_NODES) throw new Error('The XML file is too large.');
      const attrs: Record<string, string> = {};
      for (const a of (m[4] ?? '').matchAll(/([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) attrs[local(a[1])] = decode(a[3] ?? a[4] ?? '');
      const node: XmlNode = { name: local(m[3]), attrs, children: [], text: '' };
      top.children.push(node);
      if (m[5] !== '/') stack.push(node);
    } else if (m[6] !== undefined) top.text += decode(m[6]);
  }
  if (stack.length !== 1) throw new Error('The XML file is incomplete.');
  if (root.children.length !== 1) throw new Error('The XML file has no single root element.');
  return root.children[0];
}

export function child(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((c) => c.name === name);
}

export function children(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((c) => c.name === name);
}
