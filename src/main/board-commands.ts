import type { Suggestion } from '../shared/types';
import type { Board } from './boards';
import { fuzzyScore } from './palette';
import { researchUrl } from './research';

/** What the command bar typed for the "…to board" actions, so the palette entries can prefill it. */
export const ADD_TO_BOARD_PREFIX = 'add to board ';
export const CAPTURE_TO_BOARD_PREFIX = 'capture to board ';

const LIMIT = 10;

function matching(name: string, boards: readonly Board[]): Board[] {
  return boards
    .map((b, order) => ({ b, order, score: name ? fuzzyScore(name, b.name) : 0 }))
    .filter(({ score }) => score >= 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, LIMIT)
    .map(({ b }) => b);
}

const cards = (b: Board) => `${b.cards.length} ${b.cards.length === 1 ? 'card' : 'cards'}`;

/**
 * Command-bar suggestions for `board …`, `add to board …` and `capture to board …`, or undefined for other input.
 * `boards` are the current Space's boards, most recently changed first.
 */
export function boardSuggestions(text: string, boards: readonly Board[], pageUrl: string, privateSpace: boolean): Suggestion[] | undefined {
  const trimmed = text.trim();
  const add = /^add(?:\s+(?:this\s+)?page)?\s+to\s+board(?:\s+([\s\S]*))?$/i.exec(trimmed);
  const capture = add ? null : /^capture(?:\s+(?:this\s+)?page)?\s+to\s+board(?:\s+([\s\S]*))?$/i.exec(trimmed);
  const open = add || capture ? null : /^boards?(?:\s+([\s\S]*))?$/i.exec(trimmed);
  const m = add ?? capture ?? open;
  if (!m) return undefined;
  if (privateSpace) return [{ kind: 'board', label: 'Boards are not kept in private Spaces', action: { type: 'noop' } }];
  const name = (m[1] ?? '').replace(/\s+/g, ' ').trim();
  const exact = boards.some((b) => b.name.toLowerCase() === name.toLowerCase());
  const out: Suggestion[] = [];
  if (open) {
    if (name && !exact) out.push({ kind: 'board', label: `New board “${name}”`, detail: 'In this Space', action: { type: 'board', op: 'open', name } });
    for (const b of matching(name, boards)) out.push({ kind: 'board', label: `Open board “${b.name}”`, detail: cards(b), action: { type: 'board', op: 'open', boardId: b.id } });
    if (!name) out.push({ kind: 'board', label: 'Open Boards', action: { type: 'internal', page: 'boards' } });
    return out;
  }
  const op = add ? 'add-page' : 'capture';
  if (!researchUrl(pageUrl)) {
    return [{ kind: 'board', label: add ? 'Only web pages can be added to a board' : 'Only web pages can be captured', action: { type: 'noop' } }];
  }
  const verb = add ? 'Add this page to' : 'Capture to';
  for (const b of matching(name, boards)) out.push({ kind: 'board', label: `${verb} “${b.name}”`, detail: cards(b), action: { type: 'board', op, boardId: b.id } });
  if (name && !exact) out.push({ kind: 'board', label: `${verb} a new board “${name}”`, detail: 'In this Space', action: { type: 'board', op, name } });
  if (!out.length) out.push({ kind: 'board', label: 'Type a name for a new board', action: { type: 'noop' } });
  return out;
}
