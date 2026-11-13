import { markdownUrl } from './keyboard-workflows';
// Research topics: an explicitly started trail of searches, pages and notes, kept per Space on this device.

export interface TopicItem {
  kind: 'search' | 'page';
  url: string;
  /** Page title, or the query for a search. */
  title: string;
  at: number;
  note?: string;
}

export interface Topic {
  id: string;
  name: string;
  spaceId: string;
  createdAt: number;
  updatedAt: number;
  notes: string;
  items: TopicItem[];
}

export const TOPIC_LIMIT = 100;
export const ITEM_LIMIT = 500;
export const NOTES_LIMIT = 100_000;
export const ITEM_NOTE_LIMIT = 4_000;
const URL_LIMIT = 8192;
const TITLE_LIMIT = 200;

export function cleanText(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, limit);
}

function cleanLine(value: unknown, limit = TITLE_LIMIT): string {
  return cleanText(value, limit * 2).replace(/\s+/g, ' ').trim().slice(0, limit);
}

/** The URL to record for a page, or null when it must not be recorded (non-web, too long, unparsable). */
export function researchUrl(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length > URL_LIMIT) return null;
  const url = URL.parse(raw);
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) return null;
  url.username = '';
  url.password = '';
  url.hash = '';
  return url.href;
}

function touch(topic: Topic, at: number): void {
  topic.updatedAt = Math.max(topic.updatedAt, at);
}

function trim(topic: Topic): void {
  if (topic.items.length > ITEM_LIMIT) topic.items.splice(0, topic.items.length - ITEM_LIMIT);
}

export function recordSearch(topic: Topic, query: string, rawUrl: string, at: number): boolean {
  const url = researchUrl(rawUrl);
  const title = cleanLine(query);
  if (!url || !title) return false;
  const existing = topic.items.find((i) => i.kind === 'search' && i.url === url);
  if (existing) existing.at = at;
  else topic.items.push({ kind: 'search', url, title, at });
  trim(topic);
  touch(topic, at);
  return true;
}

export function recordPage(topic: Topic, rawUrl: string, title: string, at: number): boolean {
  const url = researchUrl(rawUrl);
  if (!url) return false;
  if (topic.items.some((i) => i.kind === 'search' && i.url === url)) return false;
  const label = cleanLine(title) || new URL(url).host;
  const existing = topic.items.find((i) => i.kind === 'page' && i.url === url);
  if (existing) {
    existing.at = at;
    if (cleanLine(title)) existing.title = label;
  } else {
    topic.items.push({ kind: 'page', url, title: label, at });
  }
  trim(topic);
  touch(topic, at);
  return true;
}

export function addNote(topic: Topic, rawUrl: string, title: string, note: string, at: number): boolean {
  const url = researchUrl(rawUrl);
  const text = cleanText(note, ITEM_NOTE_LIMIT).trim();
  if (!url || !text) return false;
  let item = topic.items.find((i) => i.kind === 'page' && i.url === url);
  if (!item) {
    recordPage(topic, url, title, at);
    item = topic.items.find((i) => i.kind === 'page' && i.url === url);
  }
  if (!item) return false;
  item.note = (item.note ? `${item.note}\n${text}` : text).slice(0, ITEM_NOTE_LIMIT);
  touch(topic, at);
  return true;
}

export function normalizeTopics(raw: unknown, spaceIds: ReadonlySet<string>): Topic[] {
  if (!Array.isArray(raw)) return [];
  const ids = new Set<string>();
  const out: Topic[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || out.length >= TOPIC_LIMIT) continue;
    const t = entry as Record<string, unknown>;
    if (typeof t.id !== 'string' || !/^[\w-]{1,64}$/.test(t.id) || ids.has(t.id)) continue;
    if (typeof t.spaceId !== 'string' || !spaceIds.has(t.spaceId)) continue;
    ids.add(t.id);
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const items: TopicItem[] = [];
    for (const i of Array.isArray(t.items) ? t.items : []) {
      if (!i || typeof i !== 'object') continue;
      const item = i as Record<string, unknown>;
      const url = typeof item.url === 'string' ? researchUrl(item.url) : null;
      if (!url || (item.kind !== 'page' && item.kind !== 'search')) continue;
      const note = cleanText(item.note, ITEM_NOTE_LIMIT).trim();
      items.push({ kind: item.kind, url, title: cleanLine(item.title) || new URL(url).host, at: num(item.at), ...(note ? { note } : {}) });
    }
    out.push({
      id: t.id, name: cleanLine(t.name, 80) || 'Topic', spaceId: t.spaceId,
      createdAt: num(t.createdAt), updatedAt: num(t.updatedAt), notes: cleanText(t.notes, NOTES_LIMIT),
      items: items.slice(-ITEM_LIMIT),
    });
  }
  return out;
}

function mdText(value: string): string {
  return value.replace(/[\\`*_[\]<>]/g, (c) => '\\' + c);
}

export function topicMarkdown(topic: Topic): string {
  const lines = [`# ${mdText(topic.name)}`, ''];
  if (topic.notes.trim()) lines.push(topic.notes.trim(), '');
  lines.push('## Trail', '');
  for (const item of topic.items) {
    const link = `[${mdText(item.title)}](${markdownUrl(item.url)})`;
    lines.push(item.kind === 'search' ? `- Search: ${link}` : `- ${link}`);
    if (item.note) for (const line of item.note.split('\n')) lines.push(`  > ${line}`);
  }
  lines.push('');
  return lines.join('\n');
}

export interface TopicSummary {
  id: string;
  name: string;
  spaceId: string;
  count: number;
  updatedAt: number;
  active: boolean;
}

interface ResearchState {
  topics?: Topic[];
  activeTopicBySpace?: Record<string, string>;
}

/** Owns topic state inside the persisted store; every mutation saves and notifies. */
export class Research {
  constructor(private readonly state: ResearchState, private readonly save: () => void, private readonly changed: () => void, private readonly now = () => Date.now()) {
    this.state.topics ??= [];
    this.state.activeTopicBySpace ??= {};
  }

  private get topics(): Topic[] {
    return this.state.topics!;
  }

  private get activeBySpace(): Record<string, string> {
    return this.state.activeTopicBySpace!;
  }

  private commit(): void {
    this.save();
    this.changed();
  }

  get(id: string): Topic | undefined {
    return this.topics.find((t) => t.id === id);
  }

  active(spaceId: string): Topic | undefined {
    const id = this.activeBySpace[spaceId];
    return id ? this.get(id) : undefined;
  }

  inSpace(spaceId: string): Topic[] {
    return this.topics.filter((t) => t.spaceId === spaceId).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  list(): TopicSummary[] {
    return [...this.topics].sort((a, b) => b.updatedAt - a.updatedAt).map((t) => ({
      id: t.id, name: t.name, spaceId: t.spaceId, count: t.items.length, updatedAt: t.updatedAt, active: this.activeBySpace[t.spaceId] === t.id,
    }));
  }

  start(spaceId: string, name: string): Topic | undefined {
    const label = cleanLine(name, 80);
    if (!label) return undefined;
    if (this.topics.length >= TOPIC_LIMIT) {
      // Make room by dropping the least recently used topic that is not recording.
      const recording = new Set(Object.values(this.activeBySpace));
      const oldest = [...this.topics].filter((t) => !recording.has(t.id)).sort((a, b) => a.updatedAt - b.updatedAt)[0];
      if (!oldest) return undefined;
      this.topics.splice(this.topics.indexOf(oldest), 1);
    }
    const at = this.now();
    const topic: Topic = { id: `topic-${at.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`, name: label, spaceId, createdAt: at, updatedAt: at, notes: '', items: [] };
    this.topics.push(topic);
    this.activeBySpace[spaceId] = topic.id;
    this.commit();
    return topic;
  }

  resume(id: string): void {
    const topic = this.get(id);
    if (!topic) return;
    this.activeBySpace[topic.spaceId] = topic.id;
    topic.updatedAt = this.now();
    this.commit();
  }

  stop(spaceId: string): void {
    if (!(spaceId in this.activeBySpace)) return;
    delete this.activeBySpace[spaceId];
    this.commit();
  }

  recordPage(spaceId: string, url: string, title: string): void {
    const topic = this.active(spaceId);
    if (topic && recordPage(topic, url, title, this.now())) this.commit();
  }

  recordSearch(spaceId: string, query: string, url: string): void {
    const topic = this.active(spaceId);
    if (topic && recordSearch(topic, query, url, this.now())) this.commit();
  }

  note(spaceId: string, url: string, title: string, text: string): boolean {
    const topic = this.active(spaceId);
    if (!topic || !addNote(topic, url, title, text, this.now())) return false;
    this.commit();
    return true;
  }

  rename(id: string, name: string): void {
    const topic = this.get(id);
    const label = cleanLine(name, 80);
    if (!topic || !label) return;
    topic.name = label;
    this.commit();
  }

  setNotes(id: string, notes: string): void {
    const topic = this.get(id);
    if (!topic) return;
    topic.notes = cleanText(notes, NOTES_LIMIT);
    topic.updatedAt = this.now();
    this.commit();
  }

  private item(id: string, kind: unknown, url: unknown): TopicItem | undefined {
    return this.get(id)?.items.find((i) => i.kind === kind && i.url === url);
  }

  setItemNote(id: string, kind: unknown, url: unknown, note: string): void {
    const item = this.item(id, kind, url);
    if (!item) return;
    const text = cleanText(note, ITEM_NOTE_LIMIT).trim();
    if (text) item.note = text;
    else delete item.note;
    this.commit();
  }

  removeItem(id: string, kind: unknown, url: unknown): void {
    const topic = this.get(id);
    const item = this.item(id, kind, url);
    if (!topic || !item) return;
    topic.items.splice(topic.items.indexOf(item), 1);
    this.commit();
  }

  delete(id: string): void {
    const topic = this.get(id);
    if (!topic) return;
    this.topics.splice(this.topics.indexOf(topic), 1);
    if (this.activeBySpace[topic.spaceId] === id) delete this.activeBySpace[topic.spaceId];
    this.commit();
  }

  /** Drop topics whose Space no longer exists. */
  prune(spaceIds: ReadonlySet<string>): void {
    const before = this.topics.length;
    this.state.topics = this.topics.filter((t) => spaceIds.has(t.spaceId));
    for (const spaceId of Object.keys(this.activeBySpace)) {
      if (!spaceIds.has(spaceId) || !this.get(this.activeBySpace[spaceId])) delete this.activeBySpace[spaceId];
    }
    if (this.topics.length !== before) this.commit();
  }
}
