import { researchUrl } from './research';

// Markdown-lite for Board notes: headings, lists, quotes, paragraphs, **bold**, *italic*, `code` and web links.
// Everything is escaped and only these fixed tags are produced, so the result is safe to insert as HTML in
// Quiver's Boards page and in an exported board.

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

const INLINE = new RegExp([
  '(`[^`\\n]+`)',
  '\\[([^\\]\\n]{1,300})\\]\\((https?:\\/\\/[^\\s)]+)\\)',
  '(https?:\\/\\/[^\\s<>()]*[^\\s<>().,;:!?\'"])',
  '\\*\\*([^*\\n]+)\\*\\*',
  '(?<![\\w*])\\*([^*\\n]+)\\*(?![\\w*])',
  '(?<![\\w_])_([^_\\n]+)_(?![\\w_])',
].join('|'), 'g');

function link(url: string, text: string): string {
  const href = researchUrl(url);
  return href ? `<a href="${escapeHtml(href)}" data-url="${escapeHtml(href)}">${escapeHtml(text)}</a>` : escapeHtml(text);
}

function inline(text: string, depth = 0): string {
  if (depth > 3) return escapeHtml(text);
  let out = '';
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    out += escapeHtml(text.slice(at, m.index));
    at = m.index! + m[0].length;
    if (m[1]) out += `<code>${escapeHtml(m[1].slice(1, -1))}</code>`;
    else if (m[2] !== undefined) out += link(m[3], m[2]);
    else if (m[4]) out += link(m[4], m[4]);
    else if (m[5]) out += `<strong>${inline(m[5], depth + 1)}</strong>`;
    else out += `<em>${inline(m[6] ?? m[7], depth + 1)}</em>`;
  }
  return out + escapeHtml(text.slice(at));
}

type Block = { kind: 'p' | 'ul' | 'ol' | 'quote'; lines: string[] } | { kind: 'h'; level: number; text: string };

/** Render a note to HTML. Headings start at h3 so they sit below the page and board headings. */
export function renderNote(text: string): string {
  const blocks: Block[] = [];
  let open: Extract<Block, { lines: string[] }> | null = null;
  const add = (kind: 'p' | 'ul' | 'ol' | 'quote', line: string) => {
    if (open?.kind !== kind) blocks.push(open = { kind, lines: [] });
    open.lines.push(line);
  };
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    let m: RegExpExecArray | null;
    if (!line.trim()) open = null;
    else if ((m = /^\s*(#{1,3})\s+(.*)$/.exec(line))) {
      blocks.push({ kind: 'h', level: m[1].length + 2, text: m[2] });
      open = null;
    } else if ((m = /^\s*[-*+]\s+(.*)$/.exec(line))) add('ul', m[1]);
    else if ((m = /^\s*\d{1,3}[.)]\s+(.*)$/.exec(line))) add('ol', m[1]);
    else if ((m = /^\s*>\s?(.*)$/.exec(line))) add('quote', m[1]);
    else add('p', line.trim());
  }
  return blocks.map((b) => {
    if (b.kind === 'h') return `<h${b.level}>${inline(b.text)}</h${b.level}>`;
    if (b.kind === 'ul' || b.kind === 'ol') return `<${b.kind}>${b.lines.map((l) => `<li>${inline(l)}</li>`).join('')}</${b.kind}>`;
    const body = b.lines.map((l) => inline(l)).join('<br>');
    return b.kind === 'quote' ? `<blockquote><p>${body}</p></blockquote>` : `<p>${body}</p>`;
  }).join('');
}

/** Web links in a note, as they render (for checking what the Boards page may open). */
export function noteLinks(text: string): string[] {
  const urls = new Set<string>();
  for (const m of renderNote(text).matchAll(/data-url="([^"]+)"/g)) {
    urls.add(m[1].replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e] as string));
  }
  return [...urls];
}

/** A one-line plain summary of a note, for accessible names and the list view. */
export function noteSummary(text: string, limit = 80): string {
  const line = text.split('\n').map((l) => l.replace(/^\s*(?:#{1,3}|[-*+>]|\d{1,3}[.)])\s+/, '').replace(/[*_`]/g, '').trim()).find(Boolean) ?? '';
  return line.length > limit ? line.slice(0, limit - 1) + '…' : line;
}
