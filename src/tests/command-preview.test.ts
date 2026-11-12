import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandChoice, commandContextMatches, type CommandContext } from '../shared/command-preview';
import { parseCommand } from '../shared/parser';
import type { ParseContext } from '../shared/types';

const parserContext: ParseContext = {
  searchEngine: 'https://search.example/?q=%s',
  currentUrl: 'https://staging.example/a?view=full#details',
  envGroups: [{ name: 'App', local: 'localhost:3000', staging: 'https://staging.example', prod: 'https://prod.example' }],
};

const context: CommandContext = {
  spaceId: 'work', spaceName: 'Work', tabId: 7, url: parserContext.currentUrl!,
  internal: false, mode: 'current', navigation: 11, navigationPending: false,
};

test('command previews describe the actual tab, including when an internal tab cannot be replaced', () => {
  const [suggestion] = parseCommand('example.com/docs', parserContext);
  const { preview, alternative } = commandChoice(suggestion, context);
  assert.equal(preview.title, 'Open in this tab');
  assert.equal(preview.destination, 'https://example.com/docs');
  assert.equal(preview.space, 'Work');
  assert.equal(alternative?.title, 'Open in new tab');
  assert.equal(commandChoice(suggestion, { ...context, internal: true }).preview.title, 'Open in new tab');
  assert.equal(commandChoice(suggestion, { ...context, mode: 'new' }).alternative, undefined);
  assert.equal(commandChoice(suggestion, { ...context, mode: 'new' }).acceptsAltEnter, true);
  assert.equal(commandChoice(suggestion, { ...context, internal: true }).acceptsAltEnter, true);
});

test('the parser classifies a search by the chosen path, regardless of the search template prefix', () => {
  const overlappingSearch = { ...parserContext, searchEngine: 'https://search.example/%s' };
  const [website] = parseCommand('search.example/docs', overlappingSearch);
  assert.equal(commandChoice(website, context).preview.title, 'Open in this tab');
  const [search] = parseCommand('rare word', parserContext);
  assert.equal(commandChoice(search, context).preview.title, 'Search the web');
  assert.equal(commandChoice(search, context).preview.destination, 'search.example');
  const [fallback] = parseCommand('rare word', { ...parserContext, searchEngine: '' });
  assert.equal(commandChoice(fallback, context).preview.title, 'Search the web');
});

test('unavailable environment commands explain the problem and cannot run', () => {
  for (const [text, label] of [['env other', 'No matching environment'], ['env staging', 'Already in STAGING']]) {
    const [suggestion] = parseCommand(text, parserContext);
    assert.equal(commandChoice(suggestion, context).preview.title, label);
    assert.equal(commandChoice(suggestion, context).preview.canRun, false);
  }
});

test('env previews resolve the exact destination and reject stale source or changed environment origins', () => {
  const [suggestion] = parseCommand('env', parserContext);
  assert.deepEqual(suggestion.action, {
    type: 'env', target: 'PROD', url: 'https://prod.example/a?view=full#details',
  });
  const { preview, alternative } = commandChoice(suggestion, context);
  assert.equal(preview.title, 'Switch to PROD');
  assert.equal(preview.destination, 'https://prod.example/a?view=full#details');
  assert.equal(alternative, undefined);
  assert.equal(commandChoice(suggestion, context).acceptsAltEnter, false);
  assert.equal(commandContextMatches(context, { ...context, tabId: 9 }, suggestion.action, parserContext), false);
  assert.equal(commandContextMatches(context, { ...context, spaceId: 'personal' }, suggestion.action, parserContext), false);
  assert.equal(commandContextMatches(context, { ...context, navigation: 12 }, suggestion.action, parserContext), false);
  assert.equal(commandContextMatches(context, { ...context, navigationPending: true }, suggestion.action, parserContext), false);
  assert.equal(commandContextMatches({ ...context, navigationPending: true }, context, suggestion.action, parserContext), false);
  assert.equal(commandContextMatches(context, context, suggestion.action, {
    ...parserContext, envGroups: [{ ...parserContext.envGroups[0], prod: 'https://new-prod.example' }],
  }), false);
  assert.equal(commandContextMatches(context, context, suggestion.action, parserContext), true);
});

test('a local decode preview never includes decoded values in its action announcement', () => {
  const [timestamp] = parseCommand('1700000000', parserContext);
  assert.equal(commandChoice(timestamp, context).preview.title, 'Decode locally');
  assert.equal(commandChoice(timestamp, context).preview.destination, 'Copy the selected value');
  const [invalid] = parseCommand('Bearer sensitive-value', parserContext);
  assert.equal(commandChoice(invalid, context).preview.canRun, false);
  assert.doesNotMatch(JSON.stringify(commandChoice(invalid, context).preview), /sensitive-value/);
});
