export type EnvBadge = 'LOCAL' | 'STAGING' | 'PROD';

export interface Space {
  id: string;
  name: string;
  color: string;
  /** true = own cookie jar / storage partition; false = shared default partition */
  isolated: boolean;
  /** Pinned-tab folders, nested by parentId. */
  folders?: Folder[];
}

export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  collapsed: boolean;
}

export type SidebarRow =
  | { kind: 'folder'; id: string; name: string; depth: number; collapsed: boolean; count: number }
  | { kind: 'tab'; tabId: number; depth: number; pinned: boolean; folderId: string | null }
  | { kind: 'divider' };

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

export interface BookmarkPreview {
  id: string;
  source: string;
  toAdd: number;
  duplicates: number;
  unsupported: number;
  overCapacity: number;
  scanLimited: boolean;
  sample: Bookmark[];
}

export interface BookmarkLibraryView {
  bookmarks: Bookmark[];
  undo?: { id: string; count: number };
}

export interface TabInfo {
  id: number;
  spaceId: string;
  pinned: boolean;
  folderId: string | null;
  url: string;
  title: string;
  favicon: string;
  loading: boolean;
  canGoBack: boolean;
  canRetryCrash: boolean;
  canGoForward: boolean;
  errors: number;
  local: boolean;
  internal: boolean;
  env: EnvBadge | null;
  activeBoosts: string[];
}

export interface DevServer {
  port: number;
  url: string;
  title: string;
}

export type PhoneStatus = 'off' | 'paused' | 'narrow' | 'starting' | 'active' | 'unavailable';

export interface LocalServerStatus {
  state: 'missing' | 'recovered';
  tabId: number;
  url: string;
}

export interface RecoveryNotice {
  session?: { tabs: number; spaces: number };
  movedToVisibleDisplay?: boolean;
}

export interface ShellState {
  recentlyClosed?: { id: number; spaceId: string; title: string };
  recoveryNotice?: RecoveryNotice;
  spaces: Space[];
  activeSpaceId: string;
  tabs: TabInfo[];
  /** Sidebar rows for the active Space. */
  sidebar: SidebarRow[];
  activeTabId: number | null;
  devServers: DevServer[];
  preview: boolean;
  phoneStatus: PhoneStatus;
  localServerStatus: LocalServerStatus | null;
  settings: Settings;
}

export interface TabCommandTarget {
  id: number;
  spaceId: string;
  spaceName: string;
  revision: number;
  url: string;
  title: string;
  host: string;
  environment: EnvBadge | null;
}

export type SuggestionAction =
  | { type: 'navigate'; url: string }
  | { type: 'copy'; text: string }
  | { type: 'boost'; name: string }
  | { type: 'env'; target: EnvBadge; url: string }
  | { type: 'internal'; page: 'boosts' | 'settings' }
  | { type: 'activate-tab'; target: TabCommandTarget }
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
  tab?: CommandMode | 'existing';
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
  acceptsAltEnter: boolean;
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
