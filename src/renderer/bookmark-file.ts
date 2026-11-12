import type { Bookmark } from '../shared/types';

export async function readBookmarkExport(file: File): Promise<Bookmark[]> {
  if (file.size > 16 * 1024 * 1024) throw new Error('Choose a bookmark export smaller than 16 MB.');
  const html = await file.text();
  if (!/^\s*<!doctype\s+netscape-bookmark-file-1\s*>/i.test(html)) {
    throw new Error('Choose a bookmark HTML export from your browser.');
  }

  // The template is never attached. Its inert content cannot run or fetch resources.
  const template = document.createElement('template');
  template.innerHTML = html;
  const bookmarks = new Map<string, Bookmark>();
  for (const anchor of template.content.querySelectorAll<HTMLAnchorElement>('dt > a[href]')) {
    const raw = anchor.getAttribute('href')?.trim() ?? '';
    if (raw.length > 4096 || !/^https?:\/\//i.test(raw)) continue;
    try {
      const target = new URL(raw);
      if (target.username || target.password || bookmarks.has(target.href)) continue;
      bookmarks.set(target.href, { url: target.href, title: (anchor.textContent ?? '').slice(0, 200) });
    } catch {
      // An invalid entry does not prevent the other links from being imported.
    }
    if (bookmarks.size >= 5000) break;
  }
  return [...bookmarks.values()];
}
