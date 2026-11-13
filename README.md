# Quiver

Quiver is a local-first Chromium browser for Windows developers, with isolated Spaces, a developer command bar, environment switching, phone preview, and site-specific CSS and TypeScript Boosts. The project takes inspiration from [Flecha](https://github.com/lucianodiisouza/flecha-browser) and uses [Cra](https://github.com/VictorKildahl/cra) as a secondary feature reference.

Quiver keeps settings, tabs and Boosts on this device and has no account or telemetry. Sites, confirmed searches, and local dev-server discovery make network requests.

## Electron and TypeScript

Electron supplies Chromium, native-composited tab views, persistent cookie partitions, and phone emulation through the DevTools protocol. TypeScript runs the desktop shell and its local developer tools. This keeps the Windows build on Node.js and npm. The package includes the Electron runtime.

Every view enables context isolation and sandboxing and disables Node.js integration. Quiver pages use a restrictive Content Security Policy. Each privileged command is available only to the top-level Quiver page that needs it. Regular tabs and Phone Preview share the same navigation and site permission rules. Quiver denies access to camera, microphone, location, notifications, and external app protocols.

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
npm.cmd run build:win      # Windows setup EXE
npm.cmd run build:msi      # optional MSI
```

Outputs in `release\`:

- `Quiver-v0.1.0-beta.3-x64-Setup.exe` - installer (per-user, choose folder)
- `QuiverPortable_0.1.0-beta.3_English.paf.exe` - offline PortableApps.com installer for a portable Quiver folder
- `Quiver-v0.1.0-beta.3-x64-Setup.msi` - from `build:msi`

Windows setup adds Quiver to Windows Default Apps. Select **Open Windows Default Apps after setup** to choose Quiver there. Setup can also open Quiver’s bookmark importer and add a launch-at-sign-in shortcut. Each option is opt-in on a fresh install. For unattended setup, `/S /currentuser /STARTATLOGIN` opts in to startup without opening Windows Settings or the importer.

Start the PortableApps edition with `QuiverPortable.exe`. It keeps the browser profile, cache, temporary files, and logs in `QuiverPortable\Data`. Downloads start in `Data\Downloads`, and the Save As dialog lets you choose another destination. Portable crash dumps are kept in `Data\CrashDumps` with uploads disabled. To build it locally, first build the Windows setup to populate `release\win-unpacked`. Then run `pwsh -File scripts/Build-PortableApps.ps1 -InstallerRoot <PortableApps.comInstaller-folder>`. This requires the official PortableApps.com Installer toolchain. The GitHub workflow pins and verifies the tool archive.

In **Settings → Bookmarks**, choose a local profile from Chrome, Edge, Brave, or Vivaldi and select **Review import**. **Choose HTML file** accepts a bookmark export from Firefox or another browser. Setup opens the same importer when you select its bookmark option. The review shows a sample and totals for new, duplicate, unsupported, and excess entries before you confirm. **Undo this import** removes the latest batch, even after restart. Quiver stores HTTP and HTTPS bookmarks locally and opens pages only when you select a bookmark.

Local packages are unsigned unless you configure code signing. Windows SmartScreen may show a warning.

The first build can download the pinned Electron runtime and packaging tools. Use `npm run build:dir` to produce an unpacked Windows app in `release\win-unpacked\`.

## Using Quiver

This section describes the current source. See the release notes for the features in a published build.

### Shortcuts

Right-click a tab to pin it or file it in a folder. Pinned tabs and folders sit above the **Tabs** divider; folders nest, collapse (click, or `←` / `→`), rename (double-click or `F2`) and can be dragged onto other folders. Drop a tab on a folder to pin it there, or on the divider to unpin it. Drag a tab in the sidebar to reorder it within its Space; the order is saved with the session. In the tab list, `↑` / `↓` / `Home` / `End` move focus between tabs. The list only draws the rows in view, so Spaces with hundreds of tabs stay responsive.

Type `tab` in the command bar to list up to 20 open tabs across Spaces, or add a title or hostname to narrow the results. Use the arrow keys and Enter to switch directly to a tab in its Space. Each result shows its Space and, when available, its environment.

| Keys | Action |
|---|---|
| `Ctrl+K` / `Ctrl+L` | Command bar, current tab |
| `Ctrl+T` | Command bar, new tab |
| `Alt+Enter` (in command bar) | Open a navigation result in a new tab when offered |
| `Esc` (in command bar) | Close the bar and return focus to the control or page where you started |
| `Ctrl+Alt+E` / `Ctrl+Shift+E` | Jump to next environment (local → staging → prod) |
| `Ctrl+Shift+P` | Toggle phone preview |
| `Ctrl+B` | Collapse / expand sidebar |
| `Ctrl+Shift+B` | Boosts page |
| `Ctrl+W` | Close tab |
| `Ctrl+Shift+T` | Reopen the latest closed tab in its original Space |
| `Ctrl+Tab` / `Ctrl+Shift+Tab`, `Ctrl+PageDown` / `Ctrl+PageUp` | Next / previous tab |
| `Ctrl+Shift+PageUp` / `Ctrl+Shift+PageDown` | Move the active tab up / down in its Space |
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
| anything else | Web search (engine configurable), with fuzzy-matched browser actions, open tabs and bookmarks listed below it |
| `> reload` · `> phone` | Browser actions only (tab, navigation, sidebar, preview, environment, DevTools, Boosts, Settings) |
| `tab orders` | Open tabs across Spaces |
| `bm react` · `bookmarks` | Bookmarks |
| `meet` · `meet abc-defg-hij` · `meet https://zoom.us/j/123456789` | Start or join a meeting |
| `research webgpu` · `research` · `note read later` | Start or continue a research topic · list topics · note on this page |

Matching is fuzzy: letters must start words (`rct` → *Reopen closed tab*) or follow each other (`dash` → *dashboard*), and all words must match in any order.

The selected result shows the action before you confirm, including the destination, tab, and Space when relevant. Use the arrow keys to change the selection. If the page or destination changes before confirmation, Quiver refreshes the preview for you to review again. Parsing and decoding run locally. Network navigation starts when you confirm an action that opens a page.

### Research

Type `research <name>` in the command bar to start a topic for the current Space. While it records, web searches from the command bar and the web pages you open in that Space join its trail, with credentials and `#fragments` removed. `note <text>` attaches a note to the current page. The toolbar shows the recording topic; click it to open `quiver://research`, where you can write topic notes, annotate or remove trail items, reopen pages, stop or continue recording, and copy the topic as Markdown. `research` alone lists topics to continue or stop. Nothing is recorded unless a topic is recording, and topics stay in the local profile.

### Spaces
`+` next to the Space chips creates a Space. Tick "Separate cookies & logins" for an isolated cookie jar and storage (a separate Chromium partition). Right-click or double-click a chip to rename; right-click to delete (deleting an isolated Space also clears its storage). Isolation is chosen at creation. The sidebar labels the active Space **Separate sign-in** or **Shared sign-in**.

### Tab and window recovery

The sidebar's **Reopen in …** action and `Ctrl+Shift+T` restore the latest closed tab at its original position in the same Space, even after a restart. Quiver keeps up to 20 recently closed tabs in the local profile and skips saving addresses with embedded sign-in credentials. Quiver reloads saved tab URLs after restart and shows a notice when it recovers a prior session that was left open. Use **Retry page** if a tab's renderer stops. Quiver fits a saved window to an available display if its old position is offscreen.

### Environments
Settings → Environments: add a group with LOCAL / STAGING / PROD origins (e.g. `localhost:3000`, `https://staging.example.com`, `https://example.com`). Then `Ctrl+Alt+E` cycles them keeping path, query and hash. The address bar and tab list show `LOCAL` / `STG` / `PROD`. Any `localhost` URL shows `LOCAL` even without a group.

### Phone preview
`Ctrl+Shift+P` opens a 393 px wide phone view beside the desktop view: mobile user agent, device-scale 3, touch emulation (mouse acts as touch), same cookie jar as the tab, follows navigation. Pages without a viewport meta tag lay out at 980 px, like a real phone. The phone label shows when it shares the active tab's sign-in. Preview pauses on internal, failed, or stopped pages and when the window is too narrow. It resumes when the current page and window can support it.

### Local servers
The sidebar lists IPv4 and IPv6 HTTP servers reachable over loopback. Quiver uses Windows `netstat -ano` to find listeners and makes a bounded local request for each title. Scans run every five seconds while the window is focused and can be disabled in Settings. Results use numeric loopback addresses, so an environment group or site login configured for `localhost` uses a separate origin. Local tabs show a badge counting console errors since the last navigation. For an HTTP page on a previously detected numeric loopback address, Quiver reports **Local server unavailable** or **Local server is back** based on completed scans. **Retry page** opens the original failed URL. Use `Ctrl+R` to retry HTTPS pages and hostname aliases such as `localhost` manually.

### Boosts
`Ctrl+Shift+B` or `boost` in the command bar. Files are named after a hostname (`github.com.css`, `github.com.ts`, `localhost.css`) or `all.css` / `all.ts`; `www.` is ignored; subdomains need their own file. CSS is injected on load and updated live on save. TypeScript is transpiled on this device and run in the page; saving reloads matching tabs. Files are stored in the profile folder under `boosts\`. External edits to those files are picked up too. The toolbar counts Boosts applied to the current page and names them in the button tooltip.

### Meetings

Type `meet` in the command bar to start a Google Meet or a Jitsi room, or `meet <link>`, a Meet code (`abc-defg-hij`) or a Zoom meeting ID to join. Zoom links open in Zoom's web client, so no app is needed. When a site asks for your camera, microphone or screen, Quiver asks in the toolbar: **Allow this time** (until the tab leaves the page), **Always allow** or **Block** for that site. Screen sharing then shows a menu of screens and windows to share. Tabs using the camera, microphone or screen show a red dot in the sidebar. Saved choices are listed in **Settings → Camera, microphone and screen sharing**.

Only secure pages (`https`, or `http` on localhost) in a tab's main frame can ask. Known meeting sites report the camera and microphone as available so their join screens work; other sites read as denied until they ask and you agree.
### Sync

In **Settings → Sync**, choose a folder you already sync with OneDrive, Dropbox, Syncthing or similar. Quiver keeps a `Quiver Sync` subfolder there in which each device writes only its own file, so sync clients never create conflict copies. No Quiver server is involved.

- **What syncs:** settings (environments, search engine, local-server scanning), bookmarks, Spaces with their folders and pinned tabs, and research topics. Boosts can also sync, but that is off by default because they run code on websites.
- **When:** at launch, every minute, and on **Sync now**. For each part, the most recent change on any device wins.
- **First sync:** a device syncing for the first time merges its bookmarks, topics, Spaces and pinned tabs with what is already shared.
- **What sync never does:** delete a Space or close a tab. A pinned tab removed on another device becomes a regular tab. Cookies, open regular tabs and privacy settings stay per device.
### Privacy

Quiver sends no telemetry, has no account and does not check for updates; crash reports stay on the device. **Settings → Privacy** controls what pages and Chromium can send:

- **Global Privacy Control** (on by default): sends `Sec-GPC: 1` and `DNT: 1` with page requests.
- **Hide local IP** (on by default): WebRTC uses only the public interface, so sites can't read local network addresses.
- **Secure DNS**: automatic (default), off, or a custom DNS-over-HTTPS server.
- **Spell check**: on Windows it uses the Windows spell checker and downloads nothing. On other systems it is off by default because Chromium would download dictionaries from Google.
- **Clear on exit**: deletes cookies, site storage and cache in every Space when Quiver closes; tabs, bookmarks and notes stay.

### Where data lives
- Installed: `%APPDATA%\Quiver\`
- PortableApps: `Data\` in the QuiverPortable folder. In addition to the profile, it holds `Cache\`, `Temp\`, `Logs\`, `CrashDumps\` and the default `Downloads\` directory.
- Profile files: `quiver-state.json` (Spaces, tabs, settings, window bounds), `boosts\`, and Chromium partitions.

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

Quiver currently covers these Flecha workflows. Archives and general split view are outside this build’s scope.

| # | Flecha feature | Quiver (Windows) | Status |
|---|---|---|---|
| 1 | Chromium rendering | Electron 45.3.1 (Chromium) | Included |
| 2 | Vertical sidebar | Collapsible sidebar, tab list, favicons, close, middle-click close, drag and keyboard reorder | Included |
| 2 | Pinned tabs and folders | Pin, nested folders, collapse, drag between pinned and temporary, saved per Space | Included |
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
| 10 | Windows installer / build script | Branded Windows setup, offline PortableApps.com installer, optional MSI | Build targets configured |
| – | Other browser features | Chrome Web Store extensions, account-based sync, bookmark editing, history UI, downloads UI, permission prompts other than camera/microphone/screen, third-party cookie blocking, password manager, auto-update | Unavailable |

## Verification

The unit tests cover bookmark import, command parsing, environment switching, and other core behavior. On Windows 11 x64, the unpacked and portable builds verified tab restoration, Space cookie isolation, IPv4 and IPv6 dev-server discovery, CSS and TypeScript Boosts, and a 393 px phone preview with touch emulation.

The Windows beta workflow checks NSIS installation, upgrade and removal, default browser registration, sign-in startup, and PortableApps installation and profile preservation on an isolated GitHub-hosted runner. Windows 10, MSI packaging, and screen-reader behavior remain unverified.

## Stable release preparation

Follow [Electron releases](https://releases.electronjs.org/) for Chromium and Electron security updates. Before publishing, confirm Quiver is pinned to a patched, supported Electron line. For a security update, rebuild both Windows packages and run the installer, portable, and browser checks against the same candidate. Publish the tested packages and their SHA-256 hashes together.

For the first stable release, verify trusted signatures on both distributables and test on a clean Windows 11 x64 desktop. Cover default browser selection, upgrading from the latest beta with an existing profile, keyboard and Narrator operation, and portable use from removable storage. Check site permissions, navigation, and IPC whenever a change affects what web pages can reach.

### Windows signing

Configure a public-trust signing identity with a [Windows signing provider](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/code-signing-for-smart-app-control). Use the provider's integration for [electron-builder 26](https://www.electron.build/v26/docs/win/) and enable `forceCodeSigning` for the Windows setup build. Sign the application, uninstaller, and final setup with SHA-256 and a timestamp.

Use the signed `win-unpacked` application as the PortableApps input. Pass a PowerShell script block that signs its one file-path argument in place, timestamps it, and throws on failure. Use the expected certificate subject from your provider. A thumbprint is optional when the provider rotates signing certificates.

```powershell
./scripts/Build-PortableApps.ps1 -InstallerRoot $installerRoot -UnpackedDirectory $signedUnpacked `
  -OutputDirectory $newOutput -SignFile $signFile -SignTool $signTool -PublisherSubject $publisherSubject
./scripts/Test-WindowsSignatures.ps1 -Path $setupExe, $portableInstallerExe `
  -SignTool $signTool -PublisherSubject $publisherSubject
```

The PortableApps build checks the signed application, signs the launcher before compression, and signs the final installer after branding. Record checksums after signing. On a clean Windows 11 x64 system, verify both exact downloads with normal Windows trust settings and complete the desktop checks above.

## License

MIT, see [LICENSE](LICENSE).
