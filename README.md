# Quiver

Quiver is a local-first Chromium browser for Windows developers, with isolated Spaces, a developer command bar, environment switching, phone preview, and site-specific CSS and TypeScript Boosts. The project takes inspiration from [Flecha](https://github.com/lucianodiisouza/flecha-browser) and uses [Cra](https://github.com/VictorKildahl/cra) as a secondary feature reference.

Quiver keeps settings, tabs and Boosts on this device and has no account or telemetry. Sites, confirmed searches, and local dev-server discovery make network requests.

## Electron and TypeScript

Electron supplies Chromium, native-composited tab views, persistent cookie partitions, and phone emulation through the DevTools protocol. TypeScript runs the desktop shell and its local developer tools. This keeps the Windows build on Node.js and npm. The package includes the Electron runtime.

Every view enables context isolation and sandboxing and disables Node.js integration. Quiver pages use a restrictive Content Security Policy. The preload and allowed IPC channels are reserved for Quiver’s own top-level pages.

## Prerequisites (build)

| Tool | Version | Notes |
|---|---|---|
| Windows | x64 | Verified on Windows 11. Windows 10 is unverified. |
| Node.js | 22.12 or newer | https://nodejs.org |
| npm | bundled with Node | |
| Git | current | Used to clone the repository |
| Visual Studio Build Tools | **not required** | No native modules are used |
| WiX Toolset | only for `build:msi` | electron-builder downloads it automatically on first use |

Pinned dev dependencies: `electron 45.3.1`, `electron-builder 26.18.0`, `typescript 5.9.3` (also a runtime dependency, used to transpile `.ts` Boosts), `@types/node 24.19.2`.

## Build and run

Clone the repository and run the following commands in PowerShell.

```powershell
git clone https://github.com/SeanShaffer88/Quiver-Browser.git
Set-Location Quiver-Browser
npm.cmd ci                 # install the locked dependencies
npm.cmd test               # compile and run unit tests
npm.cmd start              # compile and launch Quiver
```

After closing Quiver, build the Windows packages from the repository root.

```powershell
npm.cmd run build:win      # NSIS installer and portable EXE
npm.cmd run build:msi      # optional MSI
```

Outputs in `release\`:

- `Quiver-v0.1.0-beta.1-x64-Setup.exe` - installer (per-user, choose folder)
- `Quiver-v0.1.0-beta.1-x64-Portable.exe` - portable, stores all data in a `data\` folder next to the exe
- `Quiver-v0.1.0-beta.1-x64-Setup.msi` - from `build:msi`

Local packages are unsigned unless you configure code signing. Windows SmartScreen may show a warning.

The first build can download the pinned Electron runtime and packaging tools. Use `npm run build:dir` to produce an unpacked Windows app in `release\win-unpacked\`.

## Using Quiver

### Shortcuts

| Keys | Action |
|---|---|
| `Ctrl+K` / `Ctrl+L` | Command bar, current tab |
| `Ctrl+T` | Command bar, new tab |
| `Alt+Enter` (in command bar) | Open result in a new tab |
| `Ctrl+Alt+E` / `Ctrl+Shift+E` | Jump to next environment (local → staging → prod) |
| `Ctrl+Shift+P` | Toggle phone preview |
| `Ctrl+B` | Collapse / expand sidebar |
| `Ctrl+Shift+B` | Boosts page |
| `Ctrl+W` | Close tab |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab |
| `Ctrl+1…9` | Jump to tab |
| `Ctrl+R` / `F5` | Reload |
| `Alt+←` / `Alt+→` | Back / forward |
| `F12` / `Ctrl+Shift+I` | DevTools for the active tab |

### Command bar

| Input | Result |
|---|---|
| `gh facebook/react` · `gh facebook/react#12` · `gh vercel` · `gh s term` | Repo · PR/issue · user/org · search |
| `npm vite` · `npm s term` | Package page · search |
| `mdn flex gap` · `caniuse grid` · `so cors error` | Docs search |
| `env` · `env prod` · `env staging` | Jump to the same path on another environment |
| `boost` · `boost css` · `boost github.com` · `boost all` | Edit a Boost for the current / named site |
| a JWT (optionally with `Bearer `) | Header, payload, `exp`/`iat` relative times; copy any value. Signature is **not** verified |
| 10 or 13 digit number | Unix seconds/ms → ISO UTC, local time |
| `localhost:3000`, `:8080`, `example.com/x` | Navigate |
| anything else | Web search (engine configurable) |

Decoding and prefix parsing happen entirely in-process; the only network traffic is the navigation you confirm with Enter.

### Spaces
`+` next to the Space chips creates a Space. Tick "Separate cookies & logins" for an isolated cookie jar and storage (a separate Chromium partition). Right-click or double-click a chip to rename; right-click to delete (deleting an isolated Space also clears its storage). Isolation is chosen at creation.

### Environments
Settings → Environments: add a group with LOCAL / STAGING / PROD origins (e.g. `localhost:3000`, `https://staging.example.com`, `https://example.com`). Then `Ctrl+Alt+E` cycles them keeping path, query and hash. The address bar and tab list show `LOCAL` / `STG` / `PROD`. Any `localhost` URL shows `LOCAL` even without a group.

### Phone preview
`Ctrl+Shift+P` opens a 393 px wide phone view beside the desktop view: mobile user agent, device-scale 3, touch emulation (mouse acts as touch), same cookie jar as the tab, follows navigation. Pages without a viewport meta tag lay out at 980 px, like a real phone.

### Local servers
The sidebar lists IPv4 and IPv6 HTTP servers reachable over loopback. Quiver uses Windows `netstat -ano` to find listeners and makes a bounded local request for each title. Scans run every five seconds while the window is focused and can be disabled in Settings. Results use numeric loopback addresses, so an environment group or site login configured for `localhost` uses a separate origin. Local tabs show a badge counting console errors since the last navigation.

### Boosts
`Ctrl+Shift+B` or `boost` in the command bar. Files are named after a hostname (`github.com.css`, `github.com.ts`, `localhost.css`) or `all.css` / `all.ts`; `www.` is ignored; subdomains need their own file. CSS is injected on load and updated live on save. TypeScript is transpiled on this device and run in the page; saving reloads matching tabs. Files are stored in the profile folder under `boosts\`. External edits to those files are picked up too.

### Where data lives
- Installed: `%APPDATA%\Quiver\`
- Portable: `data\` next to the exe
- Files: `quiver-state.json` (Spaces, tabs, settings, window bounds), `boosts\`, and Chromium partitions.

To remove everything: uninstall, then delete that folder.

## Project layout

```
Quiver-Browser/
├─ package.json, package-lock.json, tsconfig.main.json, tsconfig.renderer.json, .gitignore
├─ README.md, CHANGELOG.md, DESCRIPTION.md, CREDITS.md, LICENSE
├─ build/            icon.ico, icon.png
├─ scripts/          clean.mjs, copy-assets.mjs
└─ src/
   ├─ shared/        types.d.ts, constants.ts, decoders.ts, env.ts, parser.ts   (pure, offline, unit-tested)
   ├─ main/          main.ts, tabs.ts, ipc.ts, boosts.ts, devservers.ts, shortcuts.ts, store.ts
   ├─ preload/       internal.ts   (allow-listed IPC bridge, Quiver pages only)
   ├─ renderer/      shell.*, commandbar.*, boosts.*, settings.*, newtab.html, base/cmd/pages.css
   └─ tests/         parser.test.ts
```

## Feature-parity checklist

Quiver currently covers these Flecha workflows. Pinned tabs, folders, archives, general split view, and browser import are outside this build’s scope.

| # | Flecha feature | Quiver (Windows) | Status |
|---|---|---|---|
| 1 | Chromium rendering | Electron 45.3.1 (Chromium) | Included |
| 2 | Vertical sidebar | Collapsible sidebar, tab list, favicons, close, middle-click close | Included |
| 2 | Spaces | Create / rename / delete, per-Space partition (cookies, storage) | Included |
| 3 | Command bar | `Ctrl+K` / `Ctrl+L` / `Ctrl+T` overlay | Included |
| 3 | `gh` `npm` `mdn` `caniuse` `so` | Offline parser → URL | Included |
| 3 | `env` · `boost` | Wired to env switcher and Boosts editor | Included |
| 3 | JWT / Unix decode | Local only, results copyable | Included |
| 4 | Environment switching + badge | Groups in Settings, shortcut, LOCAL/STAGING/PROD badge | Included |
| 5 | Responsive preview | 393 px, DPR 3, touch, mobile UA, follows navigation | Included |
| 6 | Dev-server detection | netstat + probe, titles in sidebar | Included |
| 6 | Console-error badge | Per local tab | Included |
| 7 | Boosts | CSS live, TS transpile + reload, `all.css`, profile storage | Included |
| 8 | Coding-agent browser automation | Omitted from the Windows build | Unavailable |
| 9 | Local-first / no telemetry | No analytics, no accounts, atomic local JSON | Included |
| 10 | Windows installer / build script | NSIS, portable, optional MSI | Build targets configured |
| – | Other browser features | Chrome Web Store extensions, sync, bookmarks, history UI, downloads UI, permission prompts, password manager, tab drag-reorder, auto-update | Unavailable |

## Verification

On Windows 11 x64, all 10 unit tests passed. The unpacked and portable builds verified tab restoration, Space cookie isolation, IPv4 and IPv6 dev-server discovery, CSS and TypeScript Boosts, and a 393 px phone preview with touch emulation.

The Windows beta workflow checks clean NSIS installation, upgrade from a synthetic older build, and uninstallation on an isolated GitHub-hosted runner. Windows 10, MSI packaging, and screen-reader behavior remain unverified.

## License

MIT, see [LICENSE](LICENSE).
