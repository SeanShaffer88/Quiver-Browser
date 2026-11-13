/** Tabs for a Ctrl+Tab walk: the active tab, then by most recent use, then any others in sidebar order. */
export function recentOrder(recent: readonly number[], sidebar: readonly number[], active: number | null): number[] {
  const present = new Set(sidebar);
  const out: number[] = [];
  const add = (id: number) => { if (present.has(id) && !out.includes(id)) out.push(id); };
  if (active !== null) add(active);
  recent.forEach(add);
  sidebar.forEach(add);
  return out;
}

/** Percent-encode the characters that end or break a Markdown link target (encodeURIComponent leaves parentheses alone). */
export function markdownUrl(url: string): string {
  return url.replace(/[()\s<>]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}

/** A Markdown link for a page, safe to paste into GitHub, Slack or docs. */
export function markdownLink(title: string, url: string): string {
  const label = (title.trim() || URL.parse(url)?.host || url).replace(/[\\[\]]/g, (c) => '\\' + c);
  return `[${label}](${markdownUrl(url)})`;
}
