# Changelog

All notable changes to Quiver. Format: [Keep a Changelog](https://keepachangelog.com), versioning: SemVer.

## [Unreleased]

- HLS downloads fetch a separate audio playlist (`#EXT-X-MEDIA`, preferring `DEFAULT=YES`) and combine fragmented-MP4 video and audio into one `.mp4`, so the best variant is no longer passed over for a lower one with audio inside.
- Local servers in the sidebar are named after their project folder (`package.json` name, else the folder name), found from the listening process's command line.
- Split view: two tabs of a Space side by side (tab menu, `split …` in the command bar, `Ctrl+Shift+=` / `Ctrl+Shift+-`), with a draggable divider (20–80%, remembered per pair), the active pane followed by the address bar, find, zoom and phone preview, and both tabs marked in the sidebar.
- Peek: links pinned tabs open in a new tab or window show in a floating preview with *Open as tab* and *Close* (Esc). Setting in Settings → Tabs, on by default.
- `Ctrl+Shift+=` now starts split view instead of zooming in; `Ctrl+=` still zooms.
- Light and dark themes: **Settings → Appearance** chooses System (follows Windows, the default), Light or Dark for every Quiver page, native menus and dialogs, and websites' `prefers-color-scheme`. Both palettes meet WCAG AA for text; high-contrast mode is unchanged.
- Settings has a section list (beside the page on wide windows, above it on narrow ones) that highlights the section you are reading, and a search box that filters sections.
- Collapsed sidebar opens over the page while you hover it and closes when the pointer leaves; the page does not resize. `Ctrl+B` still pins it open or closed.
- Import from Arc: Settings finds or opens Arc's `StorableSidebar.json`, reviews it, and imports Spaces, pinned tabs, nested folders and Favorites as lazy pinned tabs, merging same-named Spaces and skipping tabs already there, with undo. A first launch with Arc installed offers it once in the sidebar.
- Shortcuts can be changed in Settings → Shortcuts (record a new combination, remove it, or reset to default), with conflict checks; tooltips and the command bar's action list follow your keys.
- Web pages get the first chance at shortcuts Quiver doesn't reserve, as in Chrome: `Ctrl+B` is bold and `Ctrl+F` the editor's own find in Google Docs and GitHub editors. Tab and window keys (`Ctrl+T`, `Ctrl+W`, `Ctrl+L`, `Ctrl+Tab`, …) stay with Quiver.
- Opt-in update notice (Settings → Updates, off by default): checks GitHub's latest release at most once a day and shows "Quiver X is available" with a link to the release page. Nothing is downloaded or installed.
- WebDAV downloads (`davs://…`): files or whole folders, passwords only over HTTPS, listings confined to the folder.
- DASH downloads combine fragmented-MP4 video and audio into one `.mp4` with Quiver's own muxer.
- Native downloaders: FTP/FTPS (resumable, encryption first, no FTP bounce), HLS with AES-128, on-demand MPEG-DASH, and Metalink with mirror failover and checksum checks; `download <address>` in the command bar; Windows shares open in File Explorer.
- Meetings: camera, microphone and screen-share prompts (allow once, always or block per site), a screen/window picker, a live indicator on tabs, `meet` commands to start or join Meet, Zoom (web client), Teams, Webex, Jitsi and Whereby, and saved choices in Settings.
- Auto-archive: temporary tabs unused for 12 hours (configurable, or never) move to a searchable archive (`archive` in the command bar). Pinned, current and audible tabs stay.
- Closing a pinned tab returns it to its pinned page instead of removing it; the tab menu can update the pinned page or remove the tab.
- Folder sync: settings, bookmarks, Spaces with folders and pinned tabs, research topics and (opt-in) Boosts sync through a folder you already sync, one file per device, newest change wins, first sync merges.
- History search: Quiver keeps up to 5,000 visited web pages locally (Settings → History to turn off or clear); `Ctrl+K` lists matches below other results and `h …` searches only history.
- Downloads: `quiver://downloads` (`Ctrl+J`) with progress, speed, pause, resume (also after restart), cancel, retry, open (with a warning for executables), show in folder and remove; a toolbar progress indicator; and an option to save without asking, with unique file names.
- Find in page (`Ctrl+F`, `F3`) and zoom (`Ctrl+=`, `Ctrl+-`, `Ctrl+0`) with a toolbar indicator.
- Pages see the plain Chromium user agent instead of one naming Electron and Quiver, which some sites (Google sign-in among them) refuse.
- `Ctrl+Tab` returns to the most recently used tab (hold `Ctrl` to go further back); `Ctrl+PageUp/PageDown` keep sidebar order. `Alt+1…9` switch Spaces.
- Copy link and Copy Markdown link (tab menu and command bar), open the console from a local tab's error count, and `?` in the command bar lists actions with their shortcuts.
- Fix: Markdown links in research exports now escape parentheses in URLs.
- Privacy settings: Global Privacy Control, WebRTC local-IP hiding, Secure DNS (automatic, off or custom DoH), spell check without dictionary downloads off Windows, and clearing site data on exit.
- Research topics: `research <name>` records command-bar searches and visited pages in the Space, `note <text>` annotates the current page, and `quiver://research` keeps topic notes, the trail and a Markdown export.
- Command palette: `Ctrl+K` fuzzy-matches browser actions, open tabs and bookmarks beneath the address result; `>` lists actions, `bm` lists bookmarks, and `tab` search is now fuzzy.
- Pin tabs and organize them in nested, collapsible folders per Space; drag tabs between folders, pinned and temporary sections. `Ctrl+Tab`, `Ctrl+1…9` follow sidebar order.
- Virtualize the sidebar tab list so only visible rows are drawn; the active tab scrolls into view when it changes.
- Move focus between sidebar tabs with `↑` / `↓` / `Home` / `End`; tabs announce their position and count to screen readers.
- Reorder tabs within a Space by dragging them in the sidebar or with `Ctrl+Shift+PageUp` / `Ctrl+Shift+PageDown`; the order is saved with the session.
- `Ctrl+PageUp` / `Ctrl+PageDown` switch to the previous / next tab.

## [0.1.0-beta.2] - 2026-11-12

- Use the Pierced Q icon in Quiver and its Windows installers.
- Add a branded setup page with optional Windows Default Apps, bookmark import, and launch-at-sign-in choices.
- Import bookmarks from selected Chrome, Edge, Brave, and Vivaldi profiles or from an HTML export.
- Distribute the portable build as an offline PortableApps.com installer.

## [0.1.0-beta.1] - 2026-11-11

First Windows x64 beta, inspired by Flecha.

### Added
- Electron 45.3.1 shell (TypeScript, `contextIsolation` on, `nodeIntegration` off, sandboxed views, allow-listed IPC).
- Vertical collapsible sidebar with tabs; Spaces (create, rename, delete, optional isolated cookie jar via `session.fromPartition`).
- Command bar (`Ctrl+K`, `Ctrl+L`, `Ctrl+T` for new tab) with `gh`, `npm`, `mdn`, `caniuse`, `so`, `env`, `boost`, local JWT decode and Unix timestamp decode. Parsing is offline.
- Environment groups in Settings; `Ctrl+Alt+E` (or `Ctrl+Shift+E`) cycles LOCAL / STAGING / PROD keeping path, query, hash; badge in address bar and tab list.
- Phone preview: 393 px viewport, DPR 3, touch emulation, iPhone user agent, follows navigation, shares the tab's cookie jar (`Ctrl+Shift+P`).
- Local dev-server detection for IPv4 and IPv6 loopback HTTP endpoints, with a console-error badge on local tabs.
- Boosts page: `<hostname>.css`, `<hostname>.ts`, `all.css`, `all.ts`; CSS applies live, TypeScript is transpiled locally and reloads matching tabs on save.
- Local-first persistence (atomic JSON writes, corrupt-file quarantine); window size/position restore validated against current displays.
- NSIS installer, portable exe (stores the browser profile in adjacent `data\`), optional MSI via `npm run build:msi`.
- Unit tests (`npm test`).
