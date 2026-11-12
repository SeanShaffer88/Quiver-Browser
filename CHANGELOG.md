# Changelog

All notable changes to Quiver. Format: [Keep a Changelog](https://keepachangelog.com), versioning: SemVer.

## [0.1.0] - Unreleased

Initial Windows build inspired by Flecha.

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
