import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addNote, normalizeTopics, recordPage, recordSearch, researchUrl, topicMarkdown, type Topic } from '../main/research';

const topic = (): Topic => ({ id: 't1', name: 'WebGPU', spaceId: 's', createdAt: 1, updatedAt: 1, notes: '', items: [] });

test('only web URLs are recorded, without credentials or fragments', () => {
  assert.equal(researchUrl('https://user:pw@example.com/a?q=1#frag'), 'https://example.com/a?q=1');
  for (const bad of ['quiver://settings', 'file:///C:/x', 'data:text/html,x', 'javascript:alert(1)', 'not a url', 'x'.repeat(9000)]) {
    assert.equal(researchUrl(bad), null, bad);
  }
});

test('page visits dedupe by URL and keep the latest title and time', () => {
  const t = topic();
  recordPage(t, 'https://a.example/', 'A', 10);
  recordPage(t, 'https://b.example/', '', 11);
  recordPage(t, 'https://a.example/#x', 'A, updated', 12);
  assert.deepEqual(t.items.map((i) => [i.kind, i.url, i.title, i.at]), [
    ['page', 'https://a.example/', 'A, updated', 12], ['page', 'https://b.example/', 'b.example', 11],
  ]);
  assert.equal(t.updatedAt, 12);
});

test('a search keeps its query and its results page is not also recorded as a visit', () => {
  const t = topic();
  recordSearch(t, '  webgpu compute  ', 'https://duckduckgo.com/?q=webgpu+compute', 5);
  recordPage(t, 'https://duckduckgo.com/?q=webgpu+compute', 'webgpu compute at DuckDuckGo', 6);
  assert.deepEqual(t.items.map((i) => [i.kind, i.title]), [['search', 'webgpu compute']]);
});

test('notes attach to the page, adding it when missing', () => {
  const t = topic();
  addNote(t, 'https://a.example/', 'A', 'first', 1);
  addNote(t, 'https://a.example/', 'A', 'second', 2);
  assert.equal(t.items.length, 1);
  assert.equal(t.items[0].note, 'first\nsecond');
  assert.equal(addNote(t, 'quiver://settings', '', 'nope', 3), false);
});

test('normalize drops malformed topics and items and enforces limits', () => {
  const items = Array.from({ length: 600 }, (_, i) => ({ kind: 'page', url: `https://e.example/${i}`, title: 't', at: i }));
  const out = normalizeTopics([
    { id: 't1', name: '  Rust  ', spaceId: 's', createdAt: 1, updatedAt: 2, notes: 5, items: [...items, { kind: 'page', url: 'javascript:x' }, null] },
    { id: 't1', name: 'dup', spaceId: 's' },
    { id: 'bad id!', name: 'x', spaceId: 's' },
    'junk',
  ], new Set(['s']));
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Rust');
  assert.equal(out[0].notes, '');
  assert.equal(out[0].items.length, 500);
  assert.equal(out[0].items[0].url, 'https://e.example/100');
  assert.deepEqual(normalizeTopics([{ id: 't2', name: 'x', spaceId: 'gone' }], new Set(['s'])), []);
});

test('markdown export lists notes, searches and pages', () => {
  const t = topic();
  t.notes = 'Overall notes';
  recordSearch(t, 'webgpu', 'https://duckduckgo.com/?q=webgpu', 1);
  recordPage(t, 'https://gpuweb.github.io/', 'Spec [draft]', 2);
  recordPage(t, 'https://en.wikipedia.org/wiki/Shader_(computing)', 'Shader', 2);
  addNote(t, 'https://gpuweb.github.io/', 'Spec', 'read section 3', 3);
  assert.equal(topicMarkdown(t), [
    '# WebGPU', '', 'Overall notes', '', '## Trail', '',
    '- Search: [webgpu](https://duckduckgo.com/?q=webgpu)',
    '- [Spec \\[draft\\]](https://gpuweb.github.io/)', '  > read section 3',
    '- [Shader](https://en.wikipedia.org/wiki/Shader_%28computing%29)', '',
  ].join('\n'));
});

test('research commands start, continue, stop and note', async () => {
  const { researchSuggestions } = await import('../main/research-commands');
  const a = { ...topic(), id: 'a', name: 'WebGPU compute' };
  const b = { ...topic(), id: 'b', name: 'Rust async' };
  const labels = (list?: { label: string }[]) => list?.map((s) => s.label);
  assert.equal(researchSuggestions('researcher', [a], undefined, ''), undefined);
  assert.deepEqual(labels(researchSuggestions('research gpu', [a, b], undefined, '')), ['Start researching “gpu”', 'Continue “WebGPU compute”']);
  assert.deepEqual(labels(researchSuggestions('topic Rust async', [a, b], undefined, '')), ['Continue “Rust async”']);
  assert.deepEqual(labels(researchSuggestions('research', [a, b], a, '')), ['Stop researching “WebGPU compute”', 'Open “WebGPU compute” notes', 'Continue “Rust async”', 'Open research notes']);
  assert.deepEqual(researchSuggestions('note  read later ', [a], a, 'https://x.example/')?.[0].action, { type: 'research', op: 'note', text: 'read later' });
  assert.equal(researchSuggestions('note x', [a], undefined, 'https://x.example/')?.[0].action.type, 'noop');
  assert.equal(researchSuggestions('note x', [a], a, 'quiver://settings')?.[0].action.type, 'noop');
});

test('the Research store starts, records only while active, and prunes deleted Spaces', async () => {
  const { Research } = await import('../main/research');
  const state: { topics?: Topic[]; activeTopicBySpace?: Record<string, string> } = {};
  let saves = 0;
  let clock = 100;
  const r = new Research(state, () => saves++, () => {}, () => clock++);
  r.recordPage('s', 'https://ignored.example/', 'x');
  assert.equal(saves, 0);
  const t = r.start('s', ' Topic ')!;
  r.recordPage('s', 'https://a.example/', 'A');
  r.recordPage('other', 'https://b.example/', 'B');
  assert.deepEqual(t.items.map((i) => i.url), ['https://a.example/']);
  r.stop('s');
  r.recordPage('s', 'https://c.example/', 'C');
  assert.equal(t.items.length, 1);
  r.resume(t.id);
  assert.equal(r.active('s')?.id, t.id);
  r.prune(new Set(['other']));
  assert.equal(r.get(t.id), undefined);
  assert.deepEqual(state.activeTopicBySpace, {});
});
