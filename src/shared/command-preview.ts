import { resolveEnvironment } from './env';
import type { CommandChoice, CommandMode, CommandPreview, EnvBadge, ParseContext, Suggestion, SuggestionAction } from './types';

export interface CommandContext {
  spaceId: string;
  spaceName: string;
  tabId: number | null;
  url: string;
  internal: boolean;
  mode: CommandMode;
  environment?: EnvBadge;
}

function displayDestination(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.protocol === 'data:') return 'Data URL';
    if (url.username || url.password) {
      url.username = '';
      url.password = '';
      return url.href;
    }
  } catch {
    // Preserve nonstandard destinations accepted by the address parser.
  }
  return raw;
}

function destinationHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

export function commandChoice(suggestion: Suggestion, context: CommandContext): CommandChoice {
  const { action, kind } = suggestion;
  let { label, detail } = suggestion;
  let preview: CommandPreview;
  let alternative: CommandPreview | undefined;
  let accessibleLabel = label;
  switch (action.type) {
    case 'navigate': {
      const destination = displayDestination(action.url);
      const host = destinationHost(action.url);
      if (kind === 'url') label = `Go to ${destination}`;
      detail = kind === 'search' ? host : destination;
      const tab = context.mode === 'new' || context.internal || context.tabId === null || action.url.startsWith('quiver://')
        ? 'new' : 'current';
      const title = (mode: CommandMode) => kind === 'search' ? 'Search the web' : mode === 'new' ? 'Open in new tab' : 'Open in this tab';
      preview = { title: title(tab), destination: detail, space: context.spaceName, tab, canRun: true };
      if (tab === 'current') alternative = { ...preview, title: title('new'), tab: 'new' };
      accessibleLabel = host ? `${preview.title}, ${host}` : preview.title;
      break;
    }
    case 'env':
      preview = {
        title: `Switch to ${action.target}`, destination: displayDestination(action.url), space: context.spaceName,
        tab: 'current', environment: action.target, source: context.environment, canRun: true,
      };
      accessibleLabel = `${preview.title}, ${destinationHost(action.url)}`;
      break;
    case 'copy':
      preview = { title: 'Decode locally', destination: 'Copy the selected value', canRun: true };
      if (kind === 'jwt') accessibleLabel = /^Copy (payload|header)$/.test(label) ? label : 'Copy JWT claim';
      break;
    case 'internal':
      preview = { title: action.page === 'settings' ? 'Open Settings' : 'Open Boosts', space: context.spaceName, tab: 'new', canRun: true };
      break;
    case 'boost':
      preview = { title: 'Edit Boost', destination: action.name, space: context.spaceName, tab: 'new', canRun: true };
      break;
    case 'noop':
      preview = { title: kind === 'jwt' ? 'Decode locally' : label, destination: detail, canRun: false };
      if (kind === 'jwt') accessibleLabel = 'JWT decode result';
      break;
  }
  return { kind, label, detail, preview, alternative, accessibleLabel };
}

export function commandContextMatches(before: CommandContext, after: CommandContext, action: SuggestionAction, parser: ParseContext): boolean {
  if (before.spaceId !== after.spaceId || before.spaceName !== after.spaceName || before.tabId !== after.tabId ||
      before.url !== after.url || before.internal !== after.internal || before.mode !== after.mode ||
      before.environment !== after.environment) return false;
  if (action.type !== 'env') return true;
  return resolveEnvironment(after.url, parser.envGroups, action.target)?.url === action.url;
}
