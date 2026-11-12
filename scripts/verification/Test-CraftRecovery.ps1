#requires -Version 7.0
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
    !$IsWindows -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64' -or
    [Threading.Thread]::CurrentThread.GetApartmentState() -ne 'STA') {
    throw 'Run this check in PowerShell STA on a disposable GitHub-hosted Windows x64 runner.'
}

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class QuiverDisplayEvidence
{
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] private static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);

    public static bool OnDisplay(IntPtr window, uint pid) =>
        window != IntPtr.Zero && GetWindowThreadProcessId(window, out uint owner) != 0 &&
        owner == pid && MonitorFromWindow(window, 0) != IntPtr.Zero;
}
'@

$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$workspace = Join-Path (Resolve-Path -LiteralPath $env:RUNNER_TEMP).Path 'quiver-craft-recovery'
if (Test-Path -LiteralPath $workspace) { throw "Recovery evidence workspace already exists at $workspace." }
$profile = Join-Path $workspace 'data'
[void][IO.Directory]::CreateDirectory($profile)
$statePath = Join-Path $profile 'quiver-state.json'
$originPath = Join-Path $workspace 'origin.txt'
$requestPath = Join-Path $workspace 'requests.jsonl'
$stopPath = Join-Path $workspace 'stop-fixture'
$fixturePath = Join-Path $workspace 'fixture.cjs'
$evidencePath = Join-Path $workspace 'recovery-evidence.json'
$electron = (Resolve-Path -LiteralPath (Join-Path $repo 'node_modules/electron/dist/electron.exe')).Path
$node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
$steps = [ordered]@{}
$fixture = $null
$app = $null

function Start-OwnedProcess([string]$File, [string[]]$Arguments, [switch]$Browser) {
    $start = [Diagnostics.ProcessStartInfo]::new($File)
    $start.WorkingDirectory = $repo
    $start.UseShellExecute = $false
    $start.CreateNoWindow = !$Browser
    if ($Browser) { $start.Environment['PORTABLE_EXECUTABLE_DIR'] = $workspace }
    foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
    [Diagnostics.Process]::Start($start)
}

function Wait-For([string]$Description, [scriptblock]$Probe) {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    do {
        try {
            $value = & $Probe
            if ($value) { return $value }
        } catch [System.Windows.Automation.ElementNotAvailableException], [IO.IOException] {
            # Chromium can rebuild its tree and Quiver replaces the state file.
        }
        Start-Sleep -Milliseconds 150
    } while ($watch.Elapsed.TotalSeconds -lt 20)
    throw "Timed out waiting for $Description."
}

function Get-Window {
    $app.Refresh()
    if ($app.HasExited) { throw "Owned Quiver process exited with $($app.ExitCode)." }
    if ($app.MainWindowHandle -eq [IntPtr]::Zero) { return }
    $window = [Windows.Automation.AutomationElement]::FromHandle($app.MainWindowHandle)
    if ($window.Current.ProcessId -eq $app.Id -and $window.Current.Name -eq 'Quiver') { return $window }
}

function Find-Visible([string]$Name) {
    $window = Get-Window
    if (!$window) { return }
    $condition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, $Name)
    foreach ($element in $window.FindAll([Windows.Automation.TreeScope]::Descendants, $condition)) {
        if (!$element.Current.IsOffscreen) { return $element }
    }
}

function Read-State {
    # Allow Quiver to atomically replace this file while the test reads a snapshot.
    $share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
    $reader = [IO.StreamReader]::new([IO.File]::Open($statePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, $share))
    try { $json = $reader.ReadToEnd() } finally { $reader.Dispose() }
    $json | ConvertFrom-Json
}

function Get-Active([string]$Space, [string]$Url) {
    $state = Read-State
    if ($state.activeSpaceId -eq $Space -and $state.tabsBySpace.$Space[$state.activeIndexBySpace.$Space].url -ceq $Url) { return $state }
}

function Get-FixtureRequests([string]$Route) {
    if (!(Test-Path -LiteralPath $requestPath)) { return }
    foreach ($line in [IO.File]::ReadAllLines($requestPath)) {
        try { $request = $line | ConvertFrom-Json -ErrorAction Stop } catch { continue }
        if ($request.route -ceq $Route) { $request }
    }
}

function Invoke-Visible([string]$Name) {
    $control = Wait-For $Name { Find-Visible $Name }
    if (!$control.Current.IsEnabled) { throw "Control $Name is disabled." }
    $action = $null
    if ($control.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$action)) {
        $action.Invoke()
    } elseif ($control.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern, [ref]$action)) {
        $action.Select()
    } else {
        throw "Control $Name exposes no Invoke or SelectionItem pattern."
    }
}

@'
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const [originPath, requestPath, stopPath] = process.argv.slice(2);
const titles = new Map([['/work', 'Shared work'], ['/before', 'QA before'], ['/target', 'QA target'], ['/after', 'QA after']]);
const server = http.createServer((req, res) => {
  const title = titles.get(req.url);
  if (!title) { res.writeHead(404).end(); return; }
  const cookie = /(?:^|;\s*)quiver_fixture_space=(qa|shared)(?:;|$)/.exec(req.headers.cookie ?? '')?.[1] ?? null;
  fs.appendFileSync(requestPath, JSON.stringify({ route: req.url, cookie }) + '\n');
  const headers = { 'Content-Type': 'text/html', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'" };
  if (req.url === '/target' || req.url === '/work') {
    headers['Set-Cookie'] = 'quiver_fixture_space=' + (req.url === '/target' ? 'qa' : 'shared') + '; Path=/; Max-Age=3600; HttpOnly; SameSite=Strict';
  }
  res.writeHead(200, headers).end('<!doctype html><title>' + title + '</title><h1>' + title + '</h1>');
});
const watcher = fs.watch(path.dirname(stopPath), () => { if (fs.existsSync(stopPath)) stop(); });
function stop() { watcher.close(); server.close(); }
setTimeout(stop, 100_000).unref();
server.listen(0, '127.0.0.1', () => fs.writeFileSync(originPath, 'http://127.0.0.1:' + server.address().port));
'@ | Set-Content -LiteralPath $fixturePath -Encoding utf8

try {
    $fixture = Start-OwnedProcess $node @($fixturePath, $originPath, $requestPath, $stopPath)
    $origin = Wait-For 'loopback fixture origin' { if (Test-Path -LiteralPath $originPath) { Get-Content -LiteralPath $originPath -Raw } }
    if ($origin -notmatch '^http://127\.0\.0\.1:\d{1,5}$') { throw 'Fixture did not return a loopback URL.' }
    $qa = 'space-qa'
    $shared = 'space-main'
    $urls = @("$origin/before", "$origin/target", "$origin/after")
    @{
        version = 1
        spaces = @(@{ id = $shared; name = 'Main'; color = '#5b8cff'; isolated = $false }, @{ id = $qa; name = 'QA'; color = '#ff7a59'; isolated = $true })
        activeSpaceId = $qa
        tabsBySpace = @{ $shared = @(@{ url = "$origin/work" }); $qa = @($urls | ForEach-Object { @{ url = $_ } }) }
        activeIndexBySpace = @{ $shared = 0; $qa = 1 }
        settings = @{ envGroups = @(); searchEngine = "$origin/search?q=%s"; devServerScan = $false; sidebarCollapsed = $false }
        bookmarks = @()
        bounds = @{ x = -30000; y = -30000; width = 1000; height = 700; maximized = $false }
        sessionOpen = $false
    } | ConvertTo-Json -Depth 9 | Set-Content -LiteralPath $statePath -Encoding utf8

    $arguments = @($repo, '--force-renderer-accessibility', '--disable-background-networking')
    $app = Start-OwnedProcess $electron $arguments -Browser
    $window = Wait-For 'owned Quiver window' { Get-Window }
    if (![QuiverDisplayEvidence]::OnDisplay([IntPtr]$window.Current.NativeWindowHandle, $app.Id)) {
        throw 'Restored window is outside the available displays.'
    }
    $null = Wait-For 'offscreen recovery notice' { Find-Visible 'Quiver moved to an available display.' }
    $state = Wait-For 'fitted persisted bounds' { $value = Read-State; if ($value.bounds.x -ne -30000 -and $value.bounds.y -ne -30000) { $value } }
    $steps.windowPlacement = @{ bounds = $state.bounds; onDisplay = $true }

    $null = Wait-For 'initial QA target request' { Get-FixtureRequests '/target' }
    $null = Wait-For 'separate sign-in Space' { Find-Visible 'QA, separate sign-in' }
    Invoke-Visible 'Close QA target'
    $null = Wait-For 'QA tab after close' { Get-Active $qa "$origin/after" }
    Invoke-Visible 'Main, shared sign-in'
    $null = Wait-For 'active shared Space' { Get-Active $shared "$origin/work" }
    $work = Wait-For 'shared request' { Get-FixtureRequests '/work' | Select-Object -First 1 }
    if ($work.cookie) { throw 'The shared Space sent the QA cookie before setting its own.' }
    Invoke-Visible 'Reopen QA target in QA'
    $state = Wait-For 'active reopened tab in original Space' { Get-Active $qa "$origin/target" }
    $returned = Wait-For 'reopened request with QA cookie' { Get-FixtureRequests '/target' | Where-Object cookie -CEQ 'qa' | Select-Object -Last 1 }
    $order = @($state.tabsBySpace.$qa | ForEach-Object url)
    if (($order -join '|') -cne ($urls -join '|')) { throw 'The reopened tab did not return to its original position.' }
    $steps.reopen = @{ space = $qa; originalIndex = $state.activeIndexBySpace.$qa; order = $order; isolatedCookie = $returned.cookie }

    if (!(Read-State).sessionOpen) { throw 'Running session was not marked open.' }
    if (!$app.CloseMainWindow() -or !$app.WaitForExit(15000) -or $app.ExitCode -ne 0) { throw 'Owned Quiver did not close normally.' }
    $app.Dispose()
    $app = $null
    $state = Read-State
    if ($state.sessionOpen -ne $false) { throw 'Normal exit left the previous session marked open.' }
    $steps.cleanExit = $true

    # Simulate the saved marker of an interrupted session without forcibly terminating processes.
    $state.sessionOpen = $true
    $state | ConvertTo-Json -Depth 9 | Set-Content -LiteralPath $statePath -Encoding utf8
    $app = Start-OwnedProcess $electron $arguments -Browser
    $null = Wait-For 'restored saved session notice' { Find-Visible 'Restored 4 tabs across 2 Spaces from the last saved session.' }
    $state = Wait-For 'restored active QA target' { Get-Active $qa "$origin/target" }
    $steps.restart = @{ space = $qa; activeIndex = $state.activeIndexBySpace.$qa; restoredTabs = 4; seededPriorSessionMarker = $true }
    if (!$app.CloseMainWindow() -or !$app.WaitForExit(15000) -or $app.ExitCode -ne 0) { throw 'Restarted Quiver did not close normally.' }
    Write-Host 'Verified same-Space undo and cookie isolation, saved session recovery, and offscreen placement.'
} catch {
    $steps.failure = $_.Exception.Message
    throw
} finally {
    if ($app) {
        if (!$app.HasExited) { [void]$app.CloseMainWindow(); [void]$app.WaitForExit(5000) }
        $app.Dispose()
    }
    if ($fixture) {
        New-Item -ItemType File -Path $stopPath -Force | Out-Null
        [void]$fixture.WaitForExit(5000)
        $fixture.Dispose()
    }
    $steps | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $evidencePath -Encoding utf8
    Write-Host "Recovery evidence $evidencePath"
}
