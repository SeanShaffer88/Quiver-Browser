import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { noteLinks, noteSummary, renderNote } from '../main/board-text';
import {
  BOARD_LIMIT, boardHtml, Boards, CARD_LIMIT, cardUrls, clampGeometry, MIN_W, normalizeBoards, placeCard, TEXT_LIMIT, type Board,
} from '../main/boards';
import { ADD_TO_BOARD_PREFIX, boardSuggestions, CAPTURE_TO_BOARD_PREFIX } from '../main/board-commands';
import { captureRect, fitSize } from '../main/board-capture';
import { internalPage } from '../main/internal-access';
import { restorableUrl } from '../main/session-recovery';
import { BROWSER_COMMANDS } from '../main/palette';
// The renderer build emits this module as ESM; Node's module syntax detection loads it here.
import { canvasSize, dragged, nudge } from '../renderer/board-geometry';

const spaces = new Set(['s1', 's2']);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'quiver-boards-'));
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4ab0000000049454e44ae426082', 'hex');

test('notes render a small, escaped Markdown subset', () => {
  assert.equal(renderNote('# Title\nplain <b>x</b> & "q"'), '<h3>Title</h3><p>plain &lt;b&gt;x&lt;/b&gt; &amp; &quot;q&quot;</p>');
  assert.equal(renderNote('- one\n- **two**\n\n1. a\n2. *b*'), '<ul><li>one</li><li><strong>two</strong></li></ul><ol><li>a</li><li><em>b</em></li></ol>');
  assert.equal(renderNote('> quoted `<code>`'), '<blockquote><p>quoted <code>&lt;code&gt;</code></p></blockquote>');
  assert.match(renderNote('see [docs](https://example.com/a?b=1&c=2)'), /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2" data-url="https:\/\/example\.com\/a\?b=1&amp;c=2">docs<\/a>/);
  // Only web links become links; anything else stays text.
  assert.doesNotMatch(renderNote('[x](javascript:alert(1)) [y](file:///etc/passwd)'), /<a /);
  assert.doesNotMatch(renderNote('<img src=x onerror=alert(1)> <script>alert(1)</script>'), /<img|<script/);
  assert.equal(renderNote('snake_case_name and 2*3*4'), '<p>snake_case_name and 2*3*4</p>');
  assert.deepEqual(noteLinks('a https://one.test/x. and [two](https://two.test/) https://user:pw@one.test/x'), ['https://one.test/x', 'https://two.test/']);
  assert.equal(noteSummary('\n## **Plan** for _today_\nmore'), 'Plan for today');
});

test('boards normalize: bad entries dropped, limits and geometry enforced', () => {
  const raw = {
    version: 1, boards: [
      { id: 'b1', name: '  Ideas\u202e ', spaceId: 's1', cards: [
        { id: 'c1', kind: 'text', text: 'x'.repeat(TEXT_LIMIT + 50), x: -40, y: 1e9, w: 5, h: 99999 },
        { id: 'c1', kind: 'text', text: 'duplicate id' },
        { id: 'c2', kind: 'link', url: 'https://u:p@example.com/a#frag', title: 'Example' },
        { id: 'c3', kind: 'link', url: 'javascript:alert(1)' },
        { id: 'c4', kind: 'capture', file: '../../evil.png' },
        { id: 'c5', kind: 'capture', file: 'c5.png', url: 'quiver://settings', imageW: 800, imageH: 600 },
        { id: 'c6', kind: 'sticker' },
      ] },
      { id: 'b1', name: 'dup', spaceId: 's1' },
      { id: 'b2', name: 'gone space', spaceId: 'nope' },
      { id: '../x', name: 'bad id', spaceId: 's1' },
    ],
  };
  const [board, ...rest] = normalizeBoards(raw, spaces);
  assert.equal(rest.length, 0);
  assert.equal(board.name, 'Ideas');
  assert.deepEqual(board.cards.map((c) => c.id), ['c1', 'c2', 'c5']);
  const [note, link, capture] = board.cards;
  assert.equal(note.kind === 'text' && note.text.length, TEXT_LIMIT);
  assert.deepEqual([note.x, note.w, note.h], [0, MIN_W, 1600]);
  assert.ok(note.y + note.h <= 10_000);
  assert.equal(link.kind === 'link' && link.url, 'https://example.com/a');
  assert.equal(capture.kind === 'capture' && capture.url, undefined, 'non-web capture source is dropped');
  const many = { boards: Array.from({ length: BOARD_LIMIT + 5 }, (_, i) => ({ id: `b${i}`, spaceId: 's1', cards: Array.from({ length: CARD_LIMIT + 3 }, (_, j) => ({ id: `c${j}`, kind: 'text', text: '' })) })) };
  const out = normalizeBoards(many, spaces);
  assert.equal(out.length, BOARD_LIMIT);
  assert.equal(out[0].cards.length, CARD_LIMIT);
  assert.deepEqual(normalizeBoards('nonsense', spaces), []);
});

test('new cards go to the first free spot without overlapping', () => {
  const first = placeCard([], 240, 160);
  assert.deepEqual(first, { x: 24, y: 24 });
  const second = placeCard([{ ...first, w: 240, h: 160 }], 240, 160);
  assert.ok(second.x >= 24 + 240 + 16 && second.y === 24);
  assert.deepEqual(placeCard([], 100, 100, { x: 500, y: 300 }), { x: 500, y: 300 }, 'a note added while scrolled lands in view');
  assert.deepEqual(clampGeometry({ x: 'a', y: NaN, w: 300, h: 50 }, { x: 5, y: 6, w: 200, h: 100 }), { x: 5, y: 6, w: 300, h: 72 });
});

test('Boards persists to its own file, stores captures as files, and cleans up', async () => {
  const dir = tmp();
  try {
    let changes = 0;
    const boards = new Boards(dir, spaces, () => changes++);
    const board = boards.create('s1', 'Research')!;
    assert.ok(board && changes === 1);
    assert.equal(boards.create('s1', '   '), undefined);
    const link = boards.add(board.id, { kind: 'link', url: 'https://example.com/page', title: 'Page', icon: PNG });
    const capture = boards.add(board.id, { kind: 'capture', png: PNG, imageW: 1000, imageH: 500, url: 'https://example.com/page', title: 'Page' });
    const note = boards.add(board.id, { kind: 'text', text: 'see https://docs.test/x' });
    assert.equal(typeof boards.add(board.id, { kind: 'link', url: 'file:///C:/x', title: '' }), 'string');
    assert.ok(typeof link !== 'string' && typeof capture !== 'string' && typeof note !== 'string');
    assert.ok(capture.kind === 'capture' && capture.w === 480 && capture.h === 268);
    const media = path.join(dir, 'boards', board.id);
    assert.deepEqual(fs.readdirSync(media).sort(), [`${capture.id}.png`, `${link.id}-icon.png`].sort());
    assert.deepEqual(boards.readMedia(board.id, `${capture.id}.png`), PNG);
    assert.equal(boards.readMedia(board.id, '../../boards.json'), null);
    assert.equal(boards.readMedia(board.id, 'unknown.png'), null);
    assert.deepEqual(cardUrls(note), ['https://docs.test/x']);

    assert.ok(boards.update(board.id, note.id, { x: 500, y: 40, w: 10, text: 'changed' }));
    const saved = boards.get(board.id)!.cards.find((c) => c.id === note.id)!;
    assert.deepEqual([saved.x, saved.y, saved.w], [500, 40, MIN_W]);
    assert.ok(boards.reorder(board.id, note.id, 0));
    assert.equal(boards.get(board.id)!.cards[0].id, note.id);
    assert.ok(!boards.reorder(board.id, note.id, 1.5));
    assert.ok(boards.remove(board.id, capture.id));
    assert.ok(!fs.existsSync(path.join(media, `${capture.id}.png`)));

    assert.ok(boards.flush());
    const json = fs.readFileSync(path.join(dir, 'boards.json'), 'utf8');
    assert.doesNotMatch(json, /base64|iVBOR/, 'images are never inlined in the JSON');
    // A stray file and a folder of a deleted board are swept on the next load.
    fs.writeFileSync(path.join(media, 'card-stray.png'), PNG);
    fs.mkdirSync(path.join(dir, 'boards', 'board-orphan'));
    const reloaded = new Boards(dir, spaces);
    assert.deepEqual(reloaded.get(board.id)!.cards.map((c) => c.id), [note.id, link.id]);
    assert.ok(!fs.existsSync(path.join(media, 'card-stray.png')));
    assert.ok(!fs.existsSync(path.join(dir, 'boards', 'board-orphan')));

    reloaded.prune(new Set(['s2']));
    assert.equal(reloaded.list().length, 0);
    assert.ok(!fs.existsSync(media));
    reloaded.flush();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable boards file is quarantined and its media is kept', () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'boards.json'), '{ not json');
    fs.mkdirSync(path.join(dir, 'boards', 'board-keep'), { recursive: true });
    const boards = new Boards(dir, spaces);
    assert.equal(boards.list().length, 0);
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('boards.json.corrupt-')));
    assert.ok(fs.existsSync(path.join(dir, 'boards', 'board-keep')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('export is one self-contained HTML file without scripts', () => {
  const board: Board = {
    id: 'b1', name: 'Plan <x>', spaceId: 's1', createdAt: 0, updatedAt: 0, cards: [
      { id: 'n', kind: 'text', text: '# Hi\n<script>alert(1)</script>', x: 10, y: 20, w: 200, h: 100, createdAt: 0 },
      { id: 'l', kind: 'link', url: 'https://example.com/', title: 'Ex "ample"', host: 'example.com', icon: 'l-icon.png', x: 300, y: 20, w: 200, h: 80, createdAt: 0 },
      { id: 'c', kind: 'capture', file: 'c.png', imageW: 10, imageH: 10, x: 10, y: 200, w: 200, h: 200, createdAt: 0, title: 'Shot', url: 'https://example.com/' },
    ],
  };
  const html = boardHtml(board, () => PNG, 0);
  assert.match(html, /<title>Plan &lt;x&gt;<\/title>/);
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; img-src data:/);
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal(html.match(/src="data:image\/png;base64,/g)?.length, 2);
  assert.match(html, /alt="Capture of Shot"/);
  assert.doesNotMatch(html, /quiver:\/\//);
  assert.match(html, /left:300px;top:20px;width:200px;height:80px/);
});

test('command bar: open, create, add and capture to boards in this Space', () => {
  const boards: Board[] = [
    { id: 'b1', name: 'Design ideas', spaceId: 's1', createdAt: 0, updatedAt: 2, cards: [] },
    { id: 'b2', name: 'Reading', spaceId: 's1', createdAt: 0, updatedAt: 1, cards: [] },
  ];
  const page = 'https://example.com/';
  assert.equal(boardSuggestions('github.com', boards, page, false), undefined);
  const open = boardSuggestions('board', boards, page, false)!;
  assert.deepEqual(open.map((s) => s.action), [
    { type: 'board', op: 'open', boardId: 'b1' }, { type: 'board', op: 'open', boardId: 'b2' }, { type: 'internal', page: 'boards' },
  ]);
  const created = boardSuggestions('board  Trip plans', boards, page, false)!;
  assert.deepEqual(created[0].action, { type: 'board', op: 'open', name: 'Trip plans' });
  const add = boardSuggestions(ADD_TO_BOARD_PREFIX + 'desi', boards, page, false)!;
  assert.deepEqual(add[0].action, { type: 'board', op: 'add-page', boardId: 'b1' });
  assert.deepEqual(add.at(-1)!.action, { type: 'board', op: 'add-page', name: 'desi' });
  const capture = boardSuggestions(CAPTURE_TO_BOARD_PREFIX, boards, page, false)!;
  assert.deepEqual(capture.map((s) => s.action), [{ type: 'board', op: 'capture', boardId: 'b1' }, { type: 'board', op: 'capture', boardId: 'b2' }]);
  assert.equal(boardSuggestions('add page to board x', boards, 'quiver://settings', false)![0].action.type, 'noop');
  assert.equal(boardSuggestions('board', boards, page, true)![0].action.type, 'noop', 'no boards in private Spaces');
  for (const label of ['Add page to board…', 'Capture to board…', 'Open Boards']) assert.ok(BROWSER_COMMANDS.some((c) => c.label === label));
});

test('capture rectangles are clamped to the page; tiny ones are refused', () => {
  assert.equal(captureRect(null, 800, 600), null, 'null is the whole visible page');
  assert.deepEqual(captureRect({ x: -10, y: 5.5, width: 100, height: 50 }, 800, 600), { x: 0, y: 5, width: 90, height: 51 });
  assert.deepEqual(captureRect({ x: 700, y: 500, width: -100, height: 300 }, 800, 600), { x: 600, y: 500, width: 100, height: 100 });
  for (const bad of [undefined, 'x', { x: 1, y: 1, width: 3, height: 100 }, { x: 1, y: 1, width: NaN, height: 10 }, { x: 900, y: 0, width: 50, height: 50 }]) {
    assert.equal(captureRect(bad, 800, 600), undefined);
  }
  assert.deepEqual(fitSize(8192, 1024), { width: 4096, height: 512 });
  assert.deepEqual(fitSize(800, 600), { width: 800, height: 600 });
});

test('cards move and resize from the keyboard and by dragging, within limits', () => {
  const g = { x: 10, y: 10, w: 200, h: 100 };
  assert.deepEqual(nudge(g, 'ArrowRight', false, false), { ...g, x: 18 });
  assert.deepEqual(nudge(g, 'ArrowLeft', true, false), { ...g, x: 0 });
  assert.deepEqual(nudge(g, 'ArrowDown', true, true), { ...g, h: 148 });
  assert.deepEqual(nudge(g, 'ArrowLeft', true, true), { ...g, w: 152 });
  assert.equal(nudge(g, 'Enter', false, false), null);
  assert.deepEqual(dragged(g, 'resize', -500, -500), { ...g, w: 140, h: 72 });
  assert.deepEqual(dragged(g, 'move', 30, -50), { ...g, x: 40, y: 0 });
  assert.deepEqual(canvasSize([g], 900, 600), { width: 900, height: 600 });
  assert.deepEqual(canvasSize([{ x: 2000, y: 100, w: 200, h: 100 }], 900, 600), { width: 2440, height: 600 });
});

test('the Boards and capture pages are Quiver pages; Boards restores with the session', () => {
  assert.equal(internalPage('quiver://app/boards.html?board=b1'), 'boards');
  assert.equal(internalPage('quiver://app/capture.html'), 'capture');
  assert.ok(restorableUrl('quiver://app/boards.html'));
  assert.ok(restorableUrl('quiver://boards'));
  assert.ok(!restorableUrl('quiver://app/capture.html'), 'capture mode is never a tab');
});
