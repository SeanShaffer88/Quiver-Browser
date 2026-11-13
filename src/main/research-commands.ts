import type { Suggestion } from '../shared/types';
import { fuzzyScore } from './palette';
import { researchUrl, type Topic } from './research';

/**
 * Command-bar suggestions for `research …` / `topic …` and `note …`, or undefined for other input.
 * `topics` are the current Space's topics, most recently used first.
 */
export function researchSuggestions(text: string, topics: readonly Topic[], active: Topic | undefined, pageUrl: string): Suggestion[] | undefined {
  const trimmed = text.trim();
  const note = /^note(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (note) {
    const body = (note[1] ?? '').trim();
    if (!active) return [{ kind: 'note', label: 'Start a topic first: research <name>', action: { type: 'noop' } }];
    if (!researchUrl(pageUrl)) return [{ kind: 'note', label: 'Notes attach to web pages', detail: active.name, action: { type: 'noop' } }];
    if (!body) return [{ kind: 'note', label: `Type a note for this page in “${active.name}”`, action: { type: 'noop' } }];
    return [{ kind: 'note', label: `Add note to this page`, detail: active.name, action: { type: 'research', op: 'note', text: body } }];
  }
  const topic = /^(?:research|topic)(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (!topic) return undefined;
  const name = (topic[1] ?? '').replace(/\s+/g, ' ').trim();
  const out: Suggestion[] = [];
  if (!name && active) {
    out.push({ kind: 'research', label: `Stop researching “${active.name}”`, action: { type: 'research', op: 'stop' } });
    out.push({ kind: 'research', label: `Open “${active.name}” notes`, detail: `${active.items.length} items`, action: { type: 'research', op: 'open', topicId: active.id } });
  }
  const matches = topics
    .map((t, order) => ({ t, order, score: name ? fuzzyScore(name, t.name) : 0 }))
    .filter(({ t, score }) => score >= 0 && t.id !== active?.id)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, 10);
  const exact = topics.some((t) => t.name.toLowerCase() === name.toLowerCase());
  if (name && !exact) out.push({ kind: 'research', label: `Start researching “${name}”`, detail: 'Records searches and pages in this Space', action: { type: 'research', op: 'start', name } });
  for (const { t } of matches) {
    out.push({ kind: 'research', label: `Continue “${t.name}”`, detail: `${t.items.length} items`, action: { type: 'research', op: 'resume', topicId: t.id } });
  }
  if (!name) out.push({ kind: 'research', label: 'Open research notes', action: { type: 'internal', page: 'research' } });
  if (!out.length) out.push({ kind: 'research', label: 'Type a topic name to start researching', action: { type: 'noop' } });
  return out;
}
