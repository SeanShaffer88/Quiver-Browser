# Changelog

All notable changes to Quiver. Format: [Keep a Changelog](https://keepachangelog.com), versioning: SemVer.

## [Unreleased]

- Downloads: `quiver://downloads` (`Ctrl+J`) with progress, speed, pause, resume (also after restart), cancel, retry, open (with a warning for executables), show in folder and remove; a toolbar progress indicator; and an option to save without asking, with unique file names.
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
