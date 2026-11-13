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
  /** Saved camera/microphone/screen decisions by origin. */
  sitePermissions: Record<string, 'allow' | 'block'>;
  /** Keep a local browsing history for command-bar search. */
  rememberHistory: boolean;
  /** Show Save As for each download instead of saving straight to the downloads folder. */
  askWhereToSave: boolean;
  privacy: PrivacySettings;
}

export interface PrivacySettings {
  /** Send Global Privacy Control (Sec-GPC) and Do Not Track headers. */
  gpc: boolean;
  /** Keep WebRTC from exposing local network addresses. */
  hideLocalIp: boolean;
  secureDns: 'automatic' | 'off' | 'custom';
  /** DNS-over-HTTPS template used when secureDns is 'custom'. */
  dohTemplate: string;
  spellcheck: boolean;
  /** Clear cookies, site storage and cache for web Spaces when Quiver closes. */
  clearOnExit: boolean;
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
  /** The page was given camera, microphone or screen access since it loaded. */
  live: boolean;
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
  /** The find bar for the active tab, when open. */
  find?: { tabId: number; text: string; matches: number; active: number };
  /** Zoom factor of the active tab (1 = 100%). */
  zoom: number;
  /** The research topic recording in the active Space. */
  research?: { id: string; name: string; count: number };
  /** A camera / microphone / screen request waiting on the active tab. */
  permissionPrompt?: { id: number; host: string; kinds: ('camera' | 'microphone' | 'screen')[] };
  /** Downloads in progress, for the toolbar. Progress is null when a size is unknown. */
  downloads?: { active: number; progress: number | null };
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
  | { type: 'internal'; page: 'boosts' | 'settings' | 'research' | 'downloads' }
  | { type: 'activate-tab'; target: TabCommandTarget }
  | { type: 'browser'; command: BrowserCommand }
  | { type: 'research'; op: 'start'; name: string }
  | { type: 'research'; op: 'resume' | 'open'; topicId: string }
  | { type: 'research'; op: 'stop' }
  | { type: 'research'; op: 'note'; text: string }
  | { type: 'noop' };

export type BrowserCommand =
  | 'command-new' | 'close-tab' | 'reopen-tab' | 'reload' | 'back' | 'forward' | 'next-tab' | 'prev-tab'
  | 'move-tab-up' | 'move-tab-down' | 'toggle-sidebar' | 'preview' | 'env' | 'devtools' | 'boosts' | 'settings' | 'downloads'
  | 'find' | 'zoom-in' | 'zoom-out' | 'zoom-reset'
  | 'recent-tab' | 'copy-link' | 'copy-markdown-link' | 'console' | 'next-space' | 'prev-space';

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

export type DownloadState = 'progressing' | 'completed' | 'cancelled' | 'interrupted';

export interface DownloadInfo {
  id: string;
  url: string;
  filename: string;
  savePath: string;
  state: DownloadState;
  paused: boolean;
  received: number;
  total: number;
  /** Bytes per second, smoothed. */
  speed: number;
  startedAt: number;
  endedAt: number;
  mime: string;
  canResume: boolean;
  /** Opening it can run code (executables, scripts, shortcuts, disk images). */
  risky: boolean;
  /** A finished file that is no longer on disk. */
  missing?: boolean;
}
