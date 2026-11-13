export type EnvBadge = 'LOCAL' | 'STAGING' | 'PROD';

export interface Space {
  id: string;
  name: string;
  color: string;
  /** true = own cookie jar / storage partition; false = shared default partition */
  isolated: boolean;
  /** A private Space: in-memory storage, no history, never saved or synced. Gone when closed or when Quiver quits. */
  private?: true;
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
  /** Archive temporary tabs unused for this many hours; 0 never. */
  archiveAfterHours: number;
  /** Links a pinned tab opens in a new tab or window open in a floating Peek instead. */
  peekPinnedLinks: boolean;
  privacy: PrivacySettings;
  /** Light, dark, or follow Windows. Applied through nativeTheme so every page's prefers-color-scheme follows. */
  theme: 'system' | 'light' | 'dark';
  /** Rebound shortcuts: action → binding such as "Ctrl+Shift+KeyB" ('' = no key). Missing actions use defaults. */
  shortcuts: Record<string, string>;
  /** Opt-in: look up the latest Quiver release on GitHub at most once a day. Never downloads anything. */
  checkForUpdates: boolean;
}

/** One rebindable action for Settings → Shortcuts. */
export interface ShortcutRow {
  action: string;
  label: string;
  /** Human labels of the current keys, e.g. ["Ctrl+B"]; empty when unbound. */
  keys: string[];
  /** Current bindings in stored form, e.g. ["Ctrl+KeyB"]. */
  bindings: string[];
  isDefault: boolean;
  /** Whether a web page gets the key first. */
  pageFirst: boolean;
}

/** A newer Quiver release, found by the opt-in check. */
export interface UpdateNotice {
  version: string;
  url: string;
}

export interface UpdateStatus {
  enabled: boolean;
  /** Epoch ms of the last completed check, 0 if none. */
  lastCheckedAt: number;
  current: string;
  latest?: string;
  notice?: UpdateNotice;
  error?: string;
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
  /** Block third-party requests to well-known ad and tracker hosts. */
  blockTrackers: boolean;
  /** Sites (hostnames) where ads and trackers are allowed. */
  adAllowList: string[];
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
  /** For a pinned tab, the page it returns to when closed. */
  pinnedUrl: string | null;
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
  /** Which side of the split view the tab is on, when it is in one. */
  split: 'left' | 'right' | null;
}

/** Rectangles are relative to the shell's page area (below the toolbar, right of the sidebar). */
interface ShellRect { x: number; y: number; width: number; height: number }

export interface SplitView {
  left: number;
  right: number;
  /** Share of the width the left pane takes (0.2–0.8). */
  ratio: number;
  /** The area both panes share, for turning a pointer position into a ratio. */
  area: ShellRect;
  divider: ShellRect;
  leftPane: ShellRect;
  rightPane: ShellRect;
}

export interface PeekView {
  host: string;
  url: string;
  header: ShellRect;
  frame: ShellRect;
}

export interface DevServer {
  port: number;
  url: string;
  title: string;
  /** The project the server runs from (package.json name or folder), when Quiver could find it. */
  project: string | null;
  /** What the sidebar shows: "project — Page title", or whichever is known. */
  label: string;
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
  /** First launch found an Arc sidebar; the sidebar offers to import it until the person acts on it. */
  arcImportOffer?: boolean;
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
  /** Ad and tracker blocking on the active web tab; absent for Quiver's own pages. */
  adBlock?: { tabId: number; host: string; blocked: number; enabled: boolean; allowed: boolean };
  /** Downloads in progress, for the toolbar. Progress is null when a size is unknown. */
  downloads?: { active: number; progress: number | null };
  devServers: DevServer[];
  preview: boolean;
  phoneStatus: PhoneStatus;
  localServerStatus: LocalServerStatus | null;
  /** The split view the active tab is part of, when it is shown. */
  split?: SplitView;
  /** The floating preview of a link opened from a pinned tab. */
  peek?: PeekView;
  settings: Settings;
  /** Key labels for rebindable actions (e.g. { 'toggle-sidebar': 'Ctrl+B' }); '' when unbound. */
  keys: Record<string, string>;
  /** A newer Quiver release the user hasn't dismissed. */
  update?: UpdateNotice;
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
  | { type: 'split-with'; target: TabCommandTarget }
  | { type: 'browser'; command: BrowserCommand }
  | { type: 'download'; url: string }
  | { type: 'open-share'; path: string }
  | { type: 'unarchive'; url: string; archivedAt: number }
  | { type: 'research'; op: 'start'; name: string }
  | { type: 'research'; op: 'resume' | 'open'; topicId: string }
  | { type: 'research'; op: 'stop' }
  | { type: 'research'; op: 'note'; text: string }
  | { type: 'noop' };

export type BrowserCommand =
  | 'command-new' | 'close-tab' | 'reopen-tab' | 'reload' | 'back' | 'forward' | 'next-tab' | 'prev-tab'
  | 'move-tab-up' | 'move-tab-down' | 'toggle-sidebar' | 'preview' | 'env' | 'devtools' | 'boosts' | 'settings' | 'downloads'
  | 'find' | 'zoom-in' | 'zoom-out' | 'zoom-reset'
  | 'recent-tab' | 'copy-link' | 'copy-markdown-link' | 'console' | 'next-space' | 'prev-space'
  | 'split' | 'unsplit';
  | 'recent-tab' | 'copy-link' | 'copy-markdown-link' | 'console' | 'next-space' | 'prev-space' | 'private-space';

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
  /** Which downloader handles it: Chromium, or Quiver's own FTP / HLS / DASH / Metalink support. */
  kind?: NativeKind | 'chromium';
  /** Extra progress or result text, such as "12 of 340 segments". */
  detail?: string;
  /** Why it failed, when it did. */
  error?: string;
}

export type NativeKind = 'ftp' | 'hls' | 'dash' | 'metalink' | 'webdav';

/** An Arc sidebar entry as Settings previews it: titles and hosts, never full URLs. */
export type ArcNode =
  | { kind: 'tab'; title: string; host: string }
  | { kind: 'folder' | 'split'; title: string; children: ArcNode[] };

export interface ArcSpace {
  title: string;
  profile: number;
  pinned: ArcNode[];
  pinnedTabs: number;
  todayTabs: number;
}

export interface ArcProfile {
  label: string;
  favorites: ArcNode[];
  favoriteTabs: number;
}

export interface ArcSidebarPreview {
  spaces: ArcSpace[];
  profiles: ArcProfile[];
  skipped: number;
  limited: boolean;
}

/** What importing a reviewed Arc sidebar would add to Quiver right now. */
export interface ArcImportCounts {
  /** Quiver Spaces that receive tabs or folders (new and merged). */
  spaces: number;
  newSpaces: number;
  mergedSpaces: number;
  pinned: number;
  favorites: number;
  folders: number;
  /** Tabs whose URL that Space already has. */
  duplicates: number;
  /** Entries left out by Quiver's limits (folder count, depth, tab count) or because the URL cannot be restored. */
  dropped: number;
}

export interface ArcReview {
  id: number;
  source: string;
  preview: ArcSidebarPreview;
  counts: ArcImportCounts;
}

export interface ArcImportStatus {
  /** An Arc sidebar exists at the usual Windows location. */
  detected: boolean;
  /** The first-launch offer is still waiting for an answer. */
  offer: boolean;
  undo?: { id: number; tabs: number; spaces: number; folders: number };
}
