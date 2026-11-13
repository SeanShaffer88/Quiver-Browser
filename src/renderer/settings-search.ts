/** Words of a settings search, lower-cased. Empty when the box is empty, so everything shows. */
export function searchTerms(query: string): string[] {
  return query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * A section matches when every word appears somewhere in its text, in any order, so "clear exit" finds
 * "Clear on exit" and "dns secure" finds "Secure DNS".
 */
export function sectionMatches(text: string, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  const haystack = text.toLocaleLowerCase().replace(/\s+/g, ' ');
  return terms.every((term) => haystack.includes(term));
}

/** The section to mark current: the last one whose top has scrolled to or above the reading line. */
export function currentSection(tops: readonly number[], line: number): number {
  let current = 0;
  for (let i = 0; i < tops.length; i++) if (tops[i] <= line) current = i;
  return current;
}
