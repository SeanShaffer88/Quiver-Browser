import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { cleanText, researchUrl } from './research';
import { escapeHtml, noteLinks, noteSummary, renderNote } from './board-text';
import { writeFileAtomic } from './store';

// Boards: freeform canvases of notes, links and page captures, kept per Space in boards.json. Capture images live
// as PNG files under boards/<board id>/ next to it, never inside the JSON.

interface CardBase {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  createdAt: number;
}
export interface TextCard extends CardBase { kind: 'text'; text: string }
export interface LinkCard extends CardBase { kind: 'link'; url: string; title: string; host: string; icon?: string }
export interface CaptureCard extends CardBase { kind: 'capture'; file: string; url?: string; title?: string; imageW: number; imageH: number }
export type BoardCard = TextCard | LinkCard | CaptureCard;

export interface Board {
  id: string;
  name: string;
  spaceId: string;
  createdAt: number;
  updatedAt: number;
  /** Reading order: the list view, screen readers and paint order (later cards draw on top). */
  cards: BoardCard[];
}

export interface BoardSummary { id: string; name: string; spaceId: string; count: number; updatedAt: number }

export const BOARD_LIMIT = 100;
export const CARD_LIMIT = 200;
export const TEXT_LIMIT = 10_000;
export const NAME_LIMIT = 80;
const TITLE_LIMIT = 200;
export const CANVAS_MAX = 10_000;
export const MIN_W = 140;
export const MIN_H = 72;
export const MAX_SIZE = 1600;
/** Largest stored capture or icon file. */
export const MEDIA_BYTES_LIMIT = 12 * 1024 * 1024;
const FILE_BYTES_LIMIT = 16 * 1024 * 1024;
const SAVE_DELAY_MS = 400;
const ID = /^[\w-]{1,64}$/;
const MEDIA_FILE = /^[\w-]{1,80}\.png$/;
const DEFAULT_SIZE = { text: { w: 240, h: 160 }, link: { w: 260, h: 96 } } as const;

export function isBoardId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

export function isMediaFile(value: unknown): value is string {
  return typeof value === 'string' && MEDIA_FILE.test(value);
}

function line(value: unknown, limit: number): string {
  return cleanText(value, limit * 2).replace(/\s+/g, ' ').trim().slice(0, limit);
}

function num(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}

function newId(prefix: string, at: number): string {
  return `${prefix}-${at.toString(36)}${randomBytes(4).toString('hex')}`;
}

/** Clamp a card's position and size into the canvas. */
export function clampGeometry(g: { x?: unknown; y?: unknown; w?: unknown; h?: unknown }, base: { x: number; y: number; w: number; h: number }) {
  const w = num(g.w, MIN_W, MAX_SIZE, base.w);
  const h = num(g.h, MIN_H, MAX_SIZE, base.h);
  return { x: num(g.x, 0, CANVAS_MAX - w, base.x), y: num(g.y, 0, CANVAS_MAX - h, base.y), w, h };
}

/** The first free spot for a new card of this size, scanning rows from `origin` (the top left by default). */
export function placeCard(cards: readonly { x: number; y: number; w: number; h: number }[], w: number, h: number, origin = { x: 24, y: 24 }): { x: number; y: number } {
  const gap = 16;
  const step = 24;
  const free = (x: number, y: number) => cards.every((c) => x + w + gap <= c.x || c.x + c.w + gap <= x || y + h + gap <= c.y || c.y + c.h + gap <= y);
  const left = Math.max(0, Math.min(CANVAS_MAX - w, Math.round(origin.x)));
  const top = Math.max(0, Math.min(CANVAS_MAX - h, Math.round(origin.y)));
  for (let y = top; y < top + 2400 && y + h <= CANVAS_MAX; y += step) {
    for (let x = left; x + w <= Math.min(CANVAS_MAX, left + Math.max(1200, w + 48)); x += step) if (free(x, y)) return { x, y };
  }
  return { x: 24, y: Math.min(CANVAS_MAX - h, Math.max(24, ...cards.map((c) => c.y + c.h + gap))) };
}

function normalizeCard(raw: unknown, ids: Set<string>): BoardCard | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  if (!isBoardId(c.id) || ids.has(c.id)) return null;
  const createdAt = num(c.createdAt, 0, Number.MAX_SAFE_INTEGER, 0);
  const geometry = clampGeometry(c, { x: 24, y: 24, w: 240, h: 160 });
  const base = { id: c.id, ...geometry, createdAt };
  let card: BoardCard | null = null;
  if (c.kind === 'text') card = { ...base, kind: 'text', text: cleanText(c.text, TEXT_LIMIT) };
  else if (c.kind === 'link') {
    const url = typeof c.url === 'string' ? researchUrl(c.url) : null;
    if (!url) return null;
    card = { ...base, kind: 'link', url, title: line(c.title, TITLE_LIMIT) || new URL(url).host, host: new URL(url).host, ...(isMediaFile(c.icon) ? { icon: c.icon } : {}) };
  } else if (c.kind === 'capture' && isMediaFile(c.file)) {
    const url = typeof c.url === 'string' ? researchUrl(c.url) : null;
    const title = line(c.title, TITLE_LIMIT);
    card = {
      ...base, kind: 'capture', file: c.file, imageW: num(c.imageW, 1, 16384, geometry.w), imageH: num(c.imageH, 1, 16384, geometry.h),
      ...(url ? { url } : {}), ...(title ? { title } : {}),
    };
  }
  if (card) ids.add(card.id);
  return card;
}

export function normalizeBoards(raw: unknown, spaceIds: ReadonlySet<string>): Board[] {
  const list = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { boards?: unknown }).boards : raw;
  if (!Array.isArray(list)) return [];
  const ids = new Set<string>();
  const out: Board[] = [];
  for (const entry of list) {
    if (out.length >= BOARD_LIMIT) break;
    if (!entry || typeof entry !== 'object') continue;
    const b = entry as Record<string, unknown>;
    if (!isBoardId(b.id) || ids.has(b.id) || typeof b.spaceId !== 'string' || !spaceIds.has(b.spaceId)) continue;
    ids.add(b.id);
    const cardIds = new Set<string>();
    const cards: BoardCard[] = [];
    for (const c of Array.isArray(b.cards) ? b.cards : []) {
      if (cards.length >= CARD_LIMIT) break;
      const card = normalizeCard(c, cardIds);
      if (card) cards.push(card);
    }
    out.push({
      id: b.id, name: line(b.name, NAME_LIMIT) || 'Board', spaceId: b.spaceId,
      createdAt: num(b.createdAt, 0, Number.MAX_SAFE_INTEGER, 0), updatedAt: num(b.updatedAt, 0, Number.MAX_SAFE_INTEGER, 0), cards,
    });
  }
  return out;
}

/** Media files a board refers to. */
export function boardMedia(board: Board): Set<string> {
  const files = new Set<string>();
  for (const c of board.cards) {
    if (c.kind === 'capture') files.add(c.file);
    if (c.kind === 'link' && c.icon) files.add(c.icon);
  }
  return files;
}

/** Web URLs the Boards page may open from a card: a link's address, a capture's page, or links in a note. */
export function cardUrls(card: BoardCard): string[] {
  if (card.kind === 'link') return [card.url];
  if (card.kind === 'capture') return card.url ? [card.url] : [];
  return noteLinks(card.text);
}

export function cardLabel(card: BoardCard): string {
  if (card.kind === 'link') return `Link: ${card.title}`;
  if (card.kind === 'capture') return `Capture${card.title ? `: ${card.title}` : ''}`;
  return `Note: ${noteSummary(card.text) || 'empty'}`;
}

/**
 * A board as one self-contained HTML file: no scripts, no requests, captures and icons embedded as data URLs.
 * Cards keep their canvas positions on wide screens and stack in reading order on narrow ones.
 */
export function boardHtml(board: Board, media: (file: string) => Buffer | null, exportedAt = Date.now()): string {
  const img = (file: string | undefined) => {
    const data = file ? media(file) : null;
    return data ? `data:image/png;base64,${data.toString('base64')}` : '';
  };
  const height = Math.max(400, ...board.cards.map((c) => c.y + c.h + 48));
  const width = Math.max(800, ...board.cards.map((c) => c.x + c.w + 48));
  const cards = board.cards.map((c) => {
    const style = `left:${c.x}px;top:${c.y}px;width:${c.w}px;height:${c.h}px`;
    let body: string;
    if (c.kind === 'text') body = `<div class="note">${renderNote(c.text)}</div>`;
    else if (c.kind === 'link') {
      const icon = img(c.icon);
      body = `<a class="link" href="${escapeHtml(c.url)}" rel="noopener noreferrer">${icon ? `<img src="${icon}" alt="" width="16" height="16">` : ''}<span class="t">${escapeHtml(c.title)}</span><span class="h">${escapeHtml(c.host)}</span></a>`;
    } else {
      const src = img(c.file);
      const alt = c.title ? `Capture of ${c.title}` : 'Page capture';
      body = `<figure>${src ? `<img src="${src}" alt="${escapeHtml(alt)}">` : '<p>Image missing</p>'}${c.url ? `<figcaption><a href="${escapeHtml(c.url)}" rel="noopener noreferrer">${escapeHtml(c.title || new URL(c.url).host)}</a></figcaption>` : ''}</figure>`;
    }
    return `<li class="card ${c.kind}" style="${style}" aria-label="${escapeHtml(cardLabel(c))}">${body}</li>`;
  }).join('\n');
  const when = new Date(exportedAt).toISOString().slice(0, 10);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>${escapeHtml(board.name)}</title>
<style>
:root { color-scheme: light dark; --bg: #f4f5f7; --card: #fff; --fg: #1c1f24; --muted: #5d6470; --border: #d6d9de; --accent: #2f5fd0; }
@media (prefers-color-scheme: dark) { :root { --bg: #14161a; --card: #1e2127; --fg: #e3e6eb; --muted: #9aa1ad; --border: #343944; --accent: #8fb0ff; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, sans-serif; }
header { padding: 20px 24px 0; }
h1 { margin: 0; font-size: 20px; }
header p { margin: 4px 0 0; color: var(--muted); }
.canvas { position: relative; list-style: none; margin: 0; padding: 0; width: ${width}px; height: ${height}px; }
.card { position: absolute; overflow: auto; background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; }
.card.capture { padding: 6px; }
.note > :first-child { margin-top: 0; } .note > :last-child { margin-bottom: 0; }
.note h3, .note h4, .note h5 { margin: .4em 0 .2em; } .note blockquote { margin: .4em 0; padding-left: 10px; border-left: 3px solid var(--border); color: var(--muted); }
.note code { font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; background: color-mix(in srgb, var(--border) 45%, transparent); padding: 0 3px; border-radius: 4px; }
a { color: var(--accent); }
.link { display: grid; grid-template-columns: auto 1fr; gap: 2px 8px; align-items: center; text-decoration: none; }
.link img { grid-row: span 2; } .link .t { font-weight: 600; } .link .h { color: var(--muted); font-size: 12px; grid-column: 2; }
figure { margin: 0; height: 100%; display: flex; flex-direction: column; }
figure img { flex: 1; min-height: 0; width: 100%; object-fit: contain; }
figcaption { font-size: 12px; padding-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 860px) {
  .canvas { width: auto; height: auto; padding: 16px; display: grid; gap: 12px; }
  .card { position: static; width: auto !important; height: auto !important; max-height: none; }
  figure img { max-height: 70vh; }
}
</style>
</head>
<body>
<header><h1>${escapeHtml(board.name)}</h1><p>Exported from Quiver on ${when} · ${board.cards.length} ${board.cards.length === 1 ? 'card' : 'cards'}</p></header>
<main><ol class="canvas" aria-label="Cards">
${cards}
</ol></main>
</body>
</html>
`;
}

export type NewCard =
  | { kind: 'text'; text?: string; at?: { x: number; y: number } }
  | { kind: 'link'; url: string; title: string; icon?: Buffer | null }
  | { kind: 'capture'; png: Buffer; imageW: number; imageH: number; url?: string; title?: string };

export type CardPatch = { x?: unknown; y?: unknown; w?: unknown; h?: unknown; text?: unknown };

/** Owns boards.json and the media folder. Every change saves (debounced, atomic) and notifies. */
export class Boards {
  readonly file: string;
  readonly mediaRoot: string;
  private boards: Board[];
  private timer: NodeJS.Timeout | null = null;
  private loadedCleanly = false;

  constructor(dir: string, spaceIds: ReadonlySet<string>, private readonly changed: () => void = () => {}, private readonly now = () => Date.now()) {
    this.file = path.join(dir, 'boards.json');
    this.mediaRoot = path.join(dir, 'boards');
    this.boards = this.load(spaceIds);
    // Only a file that read cleanly says which media is unused; never sweep after quarantining one.
    if (this.loadedCleanly) this.sweepMedia();
  }

  private load(spaceIds: ReadonlySet<string>): Board[] {
    try {
      if (fs.statSync(this.file).size > FILE_BYTES_LIMIT) throw new Error('boards file too large');
      const boards = normalizeBoards(JSON.parse(fs.readFileSync(this.file, 'utf8')), spaceIds);
      this.loadedCleanly = true;
      return boards;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Quarantine unreadable data instead of overwriting it.
        try { fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`); } catch { /* start empty */ }
        console.warn('[quiver] boards file unreadable, starting fresh:', error instanceof Error ? error.message : String(error));
      }
      return [];
    }
  }

  /** Remove media no board refers to: folders of deleted boards and files of deleted cards. */
  sweepMedia(): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(this.mediaRoot, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !isBoardId(entry.name)) continue;
      const dir = path.join(this.mediaRoot, entry.name);
      const board = this.get(entry.name);
      if (!board) {
        fs.rmSync(dir, { recursive: true, force: true });
        continue;
      }
      const keep = boardMedia(board);
      for (const file of fs.readdirSync(dir)) if (isMediaFile(file) && !keep.has(file)) fs.rmSync(path.join(dir, file), { force: true });
    }
  }

  private commit(board?: Board): void {
    if (board) board.updatedAt = Math.max(board.updatedAt, this.now());
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
      this.timer.unref?.();
    }
    this.changed();
  }

  flush(): boolean {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileAtomic(this.file, JSON.stringify({ version: 1, boards: this.boards }));
      return true;
    } catch (error) {
      console.error('[quiver] could not save boards:', error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  get(id: unknown): Board | undefined {
    return isBoardId(id) ? this.boards.find((b) => b.id === id) : undefined;
  }

  card(id: unknown, cardId: unknown): { board: Board; card: BoardCard } | undefined {
    const board = this.get(id);
    const card = board?.cards.find((c) => c.id === cardId);
    return board && card ? { board, card } : undefined;
  }

  list(): BoardSummary[] {
    return [...this.boards].sort((a, b) => b.updatedAt - a.updatedAt)
      .map(({ id, name, spaceId, cards, updatedAt }) => ({ id, name, spaceId, count: cards.length, updatedAt }));
  }

  inSpace(spaceId: string): Board[] {
    return this.boards.filter((b) => b.spaceId === spaceId).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  mediaPath(boardId: unknown, file: unknown): string | null {
    const board = this.get(boardId);
    return board && isMediaFile(file) && boardMedia(board).has(file) ? path.join(this.mediaRoot, board.id, file) : null;
  }

  readMedia(boardId: unknown, file: unknown): Buffer | null {
    const at = this.mediaPath(boardId, file);
    if (!at) return null;
    try {
      const stat = fs.lstatSync(at);
      return stat.isFile() && stat.size <= MEDIA_BYTES_LIMIT ? fs.readFileSync(at) : null;
    } catch {
      return null;
    }
  }

  create(spaceId: string, name: string): Board | undefined {
    const label = line(name, NAME_LIMIT);
    if (!label || this.boards.length >= BOARD_LIMIT) return undefined;
    const at = this.now();
    const board: Board = { id: newId('board', at), name: label, spaceId, createdAt: at, updatedAt: at, cards: [] };
    this.boards.push(board);
    this.commit();
    return board;
  }

  rename(id: unknown, name: unknown): boolean {
    const board = this.get(id);
    const label = line(name, NAME_LIMIT);
    if (!board || !label) return false;
    board.name = label;
    this.commit(board);
    return true;
  }

  delete(id: unknown): boolean {
    const board = this.get(id);
    if (!board) return false;
    this.boards.splice(this.boards.indexOf(board), 1);
    fs.rmSync(path.join(this.mediaRoot, board.id), { recursive: true, force: true });
    this.commit();
    return true;
  }

  private writeMedia(board: Board, file: string, data: Buffer): void {
    const dir = path.join(this.mediaRoot, board.id);
    fs.mkdirSync(dir, { recursive: true });
    writeFileAtomic(path.join(dir, file), data);
  }

  /** Add a card; returns it, or a reason it could not be added. */
  add(id: unknown, input: NewCard): BoardCard | string {
    const board = this.get(id);
    if (!board) return 'That board no longer exists.';
    if (board.cards.length >= CARD_LIMIT) return `“${board.name}” is full (${CARD_LIMIT} cards).`;
    const at = this.now();
    const cardId = newId('card', at);
    let card: BoardCard;
    if (input.kind === 'text') {
      const size = DEFAULT_SIZE.text;
      const spot = { ...placeCard(board.cards, size.w, size.h, input.at), ...size };
      card = { id: cardId, kind: 'text', text: cleanText(input.text ?? '', TEXT_LIMIT), createdAt: at, ...spot };
    } else if (input.kind === 'link') {
      const url = researchUrl(input.url);
      if (!url) return 'Only web pages can be added to a board.';
      const size = DEFAULT_SIZE.link;
      const host = new URL(url).host;
      card = { id: cardId, kind: 'link', url, title: line(input.title, TITLE_LIMIT) || host, host, createdAt: at, ...placeCard(board.cards, size.w, size.h), ...size };
      if (input.icon?.length && input.icon.length <= MEDIA_BYTES_LIMIT) {
        try {
          this.writeMedia(board, `${cardId}-icon.png`, input.icon);
          card.icon = `${cardId}-icon.png`;
        } catch { /* the card shows a letter instead */ }
      }
    } else {
      if (!input.png.length || input.png.length > MEDIA_BYTES_LIMIT) return 'That capture is too large to keep.';
      // Show the capture at most 480 wide on the canvas, keeping its shape.
      const w = Math.max(MIN_W, Math.min(480, input.imageW));
      const h = Math.max(MIN_H, Math.min(420, Math.round((w * input.imageH) / Math.max(1, input.imageW)) + 28));
      const url = input.url ? researchUrl(input.url) : null;
      const title = line(input.title, TITLE_LIMIT);
      try {
        this.writeMedia(board, `${cardId}.png`, input.png);
      } catch {
        return 'Quiver could not save the capture.';
      }
      card = {
        id: cardId, kind: 'capture', file: `${cardId}.png`, imageW: Math.round(input.imageW), imageH: Math.round(input.imageH), createdAt: at,
        ...placeCard(board.cards, w, h), w, h, ...(url ? { url } : {}), ...(title ? { title } : {}),
      };
    }
    board.cards.push(card);
    this.commit(board);
    return card;
  }

  update(id: unknown, cardId: unknown, patch: CardPatch): boolean {
    const found = this.card(id, cardId);
    if (!found || !patch || typeof patch !== 'object') return false;
    const { board, card } = found;
    Object.assign(card, clampGeometry(patch, card));
    if (card.kind === 'text' && typeof patch.text === 'string') card.text = cleanText(patch.text, TEXT_LIMIT);
    this.commit(board);
    return true;
  }

  /** Move a card to a new place in the reading order. */
  reorder(id: unknown, cardId: unknown, index: unknown): boolean {
    const found = this.card(id, cardId);
    if (!found || typeof index !== 'number' || !Number.isInteger(index)) return false;
    const { board, card } = found;
    const from = board.cards.indexOf(card);
    const to = Math.max(0, Math.min(board.cards.length - 1, index));
    if (from === to) return false;
    board.cards.splice(from, 1);
    board.cards.splice(to, 0, card);
    this.commit(board);
    return true;
  }

  remove(id: unknown, cardId: unknown): boolean {
    const found = this.card(id, cardId);
    if (!found) return false;
    const { board, card } = found;
    board.cards.splice(board.cards.indexOf(card), 1);
    for (const file of card.kind === 'capture' ? [card.file] : card.kind === 'link' && card.icon ? [card.icon] : []) {
      fs.rmSync(path.join(this.mediaRoot, board.id, file), { force: true });
    }
    this.commit(board);
    return true;
  }

  /** Drop boards whose Space no longer exists. */
  prune(spaceIds: ReadonlySet<string>): void {
    const gone = this.boards.filter((b) => !spaceIds.has(b.spaceId));
    for (const board of gone) this.delete(board.id);
  }

  exportHtml(id: unknown): string | null {
    const board = this.get(id);
    return board ? boardHtml(board, (file) => this.readMedia(board.id, file), this.now()) : null;
  }
}
