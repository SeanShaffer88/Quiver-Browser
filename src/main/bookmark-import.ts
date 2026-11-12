import { createHash, randomUUID } from 'node:crypto';
import type { Bookmark, BookmarkPreview } from '../shared/types';
import { BOOKMARK_LIMIT, normalizeBookmark } from './bookmarks';

export interface BookmarkUndo {
  id: string;
  start: number;
  count: number;
  fingerprint: string;
}

export interface BookmarkLibrary {
  bookmarks: Bookmark[];
  bookmarkUndo?: BookmarkUndo;
}

type ImportError = { error: string };
const changed = (): ImportError => ({ error: 'This import review has expired. Review the source again.' });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fingerprint(bookmarks: Bookmark[]): string {
  const hash = createHash('sha256');
  for (const { title, url } of bookmarks) hash.update(JSON.stringify([title, url]));
  return hash.digest('hex');
}

export function validBookmarkUndo(input: unknown, bookmarks: Bookmark[]): BookmarkUndo | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const { id, start, count, fingerprint: recorded } = input as Partial<BookmarkUndo>;
  if (typeof id !== 'string' || !uuid.test(id) || typeof start !== 'number' || typeof count !== 'number' ||
      !Number.isSafeInteger(start) || !Number.isSafeInteger(count) || start < 0 || count < 1 ||
      start + count !== bookmarks.length || recorded !== fingerprint(bookmarks.slice(start))) return undefined;
  return { id, start, count, fingerprint: recorded };
}

interface Plan {
  preview: BookmarkPreview;
  additions: Bookmark[];
  library: string;
}

/** One main-process review at a time. Only its Settings document can confirm it. */
export class BookmarkImports<Owner extends object> {
  private current?: { owner: Owner; generation: symbol; plan?: Plan };

  constructor(private readonly state: BookmarkLibrary, private readonly flush: () => boolean) {}

  begin(owner: Owner): symbol {
    const generation = Symbol();
    this.current = { owner, generation };
    return generation;
  }

  cancel(owner: Owner): void {
    if (this.current?.owner === owner) this.current = undefined;
  }

  isCurrent(owner: Owner, generation: symbol): boolean {
    return this.current?.owner === owner && this.current.generation === generation;
  }

  finish(owner: Owner, generation: symbol, source: string, input: unknown, scanLimited: boolean): BookmarkPreview | ImportError {
    const current = this.current;
    if (!current || current.owner !== owner || current.generation !== generation || current.plan) return changed();
    if (!Array.isArray(input)) return { error: 'Quiver could not read this bookmark export.' };
    const existing = this.state.bookmarks;
    const seen = new Set(existing.map(({ url }) => url));
    const available = Math.max(0, BOOKMARK_LIMIT - existing.length);
    const additions: Bookmark[] = [];
    let duplicates = 0;
    let unsupported = 0;
    let overCapacity = 0;
    for (const entry of input.slice(0, BOOKMARK_LIMIT)) {
      const bookmark = normalizeBookmark(entry);
      if (!bookmark) {
        unsupported++;
      } else if (seen.has(bookmark.url)) {
        duplicates++;
      } else {
        seen.add(bookmark.url);
        if (additions.length >= available) overCapacity++;
        else additions.push(bookmark);
      }
    }
    const preview = {
      id: randomUUID(), source, toAdd: additions.length, duplicates, unsupported, overCapacity,
      scanLimited: scanLimited || input.length > BOOKMARK_LIMIT, sample: additions.slice(0, 5),
    };
    current.plan = { preview, additions, library: fingerprint(existing) };
    return preview;
  }

  commit(owner: Owner, id: unknown): { added: number } | ImportError {
    const plan = this.current?.owner === owner ? this.current.plan : undefined;
    if (!plan || plan.preview.id !== id) return changed();
    this.current = undefined;
    const existing = this.state.bookmarks;
    if (plan.library !== fingerprint(existing)) return changed();
    if (!plan.additions.length) return { added: 0 };
    const undo = { id: randomUUID(), start: existing.length, count: plan.additions.length, fingerprint: fingerprint(plan.additions) };
    if (!this.persist([...existing, ...plan.additions], undo)) return { error: 'Quiver could not save the bookmarks. Try the import again.' };
    return { added: undo.count };
  }

  getUndo(): Pick<BookmarkUndo, 'id' | 'count'> | undefined {
    const undo = validBookmarkUndo(this.state.bookmarkUndo, this.state.bookmarks);
    return undo && { id: undo.id, count: undo.count };
  }

  undo(id: unknown): { removed: number } | ImportError {
    const undo = validBookmarkUndo(this.state.bookmarkUndo, this.state.bookmarks);
    if (!undo || undo.id !== id) return { error: 'That import can no longer be undone.' };
    if (!this.persist(this.state.bookmarks.slice(0, undo.start))) return { error: 'Quiver could not undo the import. Try again.' };
    this.current = undefined;
    return { removed: undo.count };
  }

  private persist(bookmarks: Bookmark[], undo?: BookmarkUndo): boolean {
    const previous = this.state.bookmarks;
    const previousUndo = this.state.bookmarkUndo;
    this.state.bookmarks = bookmarks;
    this.state.bookmarkUndo = undo;
    if (this.flush()) return true;
    this.state.bookmarks = previous;
    this.state.bookmarkUndo = previousUndo;
    return false;
  }
}
