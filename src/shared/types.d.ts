export type EnvBadge = 'LOCAL' | 'STAGING' | 'PROD';

export interface Space {
  id: string;
  name: string;
  color: string;
  /** true = own cookie jar / storage partition; false = shared default partition */
  isolated: boolean;
}

export interface EnvGroup {
  name: string;
  local: string;
  staging: string;
  prod: string;
}

export interface Settings {
  envGroups: EnvGroup[];
  searchEngine: string;
  devServerScan: boolean;
  sidebarCollapsed: boolean;
}

export interface Bookmark {
  title: string;
  url: string;
}

export interface BookmarkProfile {
  browser: string;
  profile: string;
  label: string;
}

export type BookmarkImportResult =
  | { added: number; full: boolean }
  | { error: string };

export interface TabInfo {
  id: number;
  spaceId: string;
  url: string;
  title: string;
  favicon: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  errors: number;
  local: boolean;
  internal: boolean;
  env: EnvBadge | null;
}

export interface DevServer {
  port: number;
  url: string;
  title: string;
}

export interface ShellState {
  spaces: Space[];
  activeSpaceId: string;
  tabs: TabInfo[];
  activeTabId: number | null;
  devServers: DevServer[];
  preview: boolean;
  settings: Settings;
}

export type SuggestionAction =
  | { type: 'navigate'; url: string }
  | { type: 'copy'; text: string }
  | { type: 'boost'; name: string }
  | { type: 'env'; target: EnvBadge; url: string }
  | { type: 'internal'; page: 'boosts' | 'settings' }
  | { type: 'noop' };

export interface Suggestion {
  kind: string;
  label: string;
  detail?: string;
  action: SuggestionAction;
}

export type CommandMode = 'new' | 'current';

export interface CommandOpen {
  id: number;
  text: string;
  mode: CommandMode;
  maxInputLength: number;
  message?: string;
}

export interface CommandPreview {
  title: string;
  destination?: string;
  space?: string;
  tab?: CommandMode;
  environment?: EnvBadge;
  source?: EnvBadge;
  canRun: boolean;
}

export interface CommandChoice {
  kind: string;
  label: string;
  detail?: string;
  accessibleLabel: string;
  preview: CommandPreview;
  alternative?: CommandPreview;
}

export type CommandCommitResult = 'done' | 'stale' | 'unavailable';

export interface BoostFileInfo {
  name: string;
  kind: 'css' | 'ts';
  size: number;
  mtimeMs: number;
}

export interface McpInfo {
  running: boolean;
  port: number;
  token: string;
  tokenPath: string;
  url: string;
  error?: string;
}

export interface ParseContext {
  searchEngine: string;
  envGroups: EnvGroup[];
  currentUrl?: string;
}
