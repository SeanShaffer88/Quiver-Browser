import type { Bookmark } from '../shared/types';

export async function readBookmarkExport(file: File): Promise<{ candidates: Bookmark[]; scanLimited: boolean }> {
  if (file.size > 16 * 1024 * 1024) throw new Error('Choose a bookmark export smaller than 16 MB.');
  const html = await file.text().catch(() => { throw new Error('Quiver could not read this HTML file.'); });
  if (!/^\s*<!doctype\s+netscape-bookmark-file-1\s*>/i.test(html)) {
    throw new Error('Choose a bookmark HTML export from your browser.');
  }

  // The template is never attached. Its inert content cannot run or fetch resources.
  const template = document.createElement('template');
  template.innerHTML = html;
  const candidates: Bookmark[] = [];
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT);
  let scanned = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (++scanned > 100_000) return { candidates, scanLimited: true };
    const anchor = node as Element;
    if (!anchor.matches('dt > a[href]')) continue;
    if (candidates.length === 5000) return { candidates, scanLimited: true };
    candidates.push({
      url: (anchor.getAttribute('href') ?? '').slice(0, 4097),
      title: (anchor.textContent ?? '').slice(0, 200),
    });
  }
  return { candidates, scanLimited: false };
}
