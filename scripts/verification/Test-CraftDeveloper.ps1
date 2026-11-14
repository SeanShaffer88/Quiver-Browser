#requires -Version 7.0
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or !$IsWindows -or
    [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64' -or
    [Threading.Thread]::CurrentThread.GetApartmentState() -ne 'STA') {
    throw 'This test requires an STA PowerShell process on a disposable GitHub-hosted Windows x64 runner.'
}

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$workspace = Join-Path (Resolve-Path -LiteralPath $env:RUNNER_TEMP).Path 'quiver-craft-developer'
if (Test-Path -LiteralPath $workspace) { throw "The evidence workspace already exists at $workspace." }
$profile = Join-Path $workspace 'data'
$boosts = Join-Path $profile 'boosts'
[void][IO.Directory]::CreateDirectory($boosts)
$statePath = Join-Path $profile 'quiver-state.json'
$evidencePath = Join-Path $workspace 'developer-evidence.json'
$portPath = Join-Path $workspace 'port.txt'
$requestPath = Join-Path $workspace 'requests.jsonl'
$electron = (Resolve-Path -LiteralPath (Join-Path $repo 'node_modules/electron/dist/electron.exe')).Path
$electronVersion = (Get-Content -LiteralPath (Join-Path $repo 'node_modules/electron/package.json') -Raw | ConvertFrom-Json).version
$lockedElectron = (Get-Content -LiteralPath (Join-Path $repo 'package-lock.json') -Raw | ConvertFrom-Json).packages.'node_modules/electron'.version
$runtimeVersion = (Get-Item -LiteralPath $electron).VersionInfo
$runtimeElectron = '{0}.{1}.{2}' -f $runtimeVersion.ProductMajorPart, $runtimeVersion.ProductMinorPart, $runtimeVersion.ProductBuildPart
if (!$lockedElectron -or $electronVersion -cne $lockedElectron -or $runtimeElectron -cne $lockedElectron) {
    throw "Expected locked Electron $lockedElectron but found npm package $electronVersion and executable $runtimeElectron."
}
$node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
$checks = [Collections.Generic.List[string]]::new()
$app = $null
$fixture = $null
$phoneButton = 'Phone preview (Ctrl+Shift+P)'

$fixtureSource = @'
const fs = require('node:fs');
const http = require('node:http');
const [portPath, requestPath, port] = process.argv.slice(1);
const page = '<!doctype html><title>Quiver local fixture</title><meta name="viewport" content="width=device-width"><h1>Quiver local fixture</h1>';
const permissions = ['camera', 'microphone', 'geolocation', 'notifications'];
const permissionProbe = `<script>
  (async () => {
    const query = new URLSearchParams({
      page: location.pathname + location.search,
      bridge: String('quiver' in window),
    });
    await Promise.all(${JSON.stringify(permissions)}.map(async name => {
      try {
        query.set(name, (await navigator.permissions.query({ name })).state);
      } catch {
        query.set(name, 'unavailable');
      }
    }));
    await fetch('/permission-probe?' + query, { cache: 'no-store' });
  })();
</script>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const permissionProbeResult = url.pathname === '/permission-probe'
    ? {
      page: url.searchParams.get('page'),
      bridge: url.searchParams.get('bridge'),
      permissions: Object.fromEntries(permissions.map(name => [name, url.searchParams.get(name)])),
    }
    : undefined;
  if (req.url !== '/favicon.ico') {
    fs.appendFileSync(requestPath, JSON.stringify({
      path: req.url,
      scan: req.headers['user-agent'] === 'Quiver-devscan',
      mobile: /Mobile/i.test(req.headers['user-agent'] || ''),
      fixtureCookie: /(?:^|;\s*)quiver_fixture=present(?:;|$)/.test(req.headers.cookie || ''),
      permissionProbe: permissionProbeResult,
    }) + '\n');
  }
  if (permissionProbeResult) {
    res.writeHead(204).end();
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Connection', 'close');
  if (req.url.startsWith('/developer/')) res.setHeader('Set-Cookie', 'quiver_fixture=present; Path=/; HttpOnly; SameSite=Lax');
  res.end(page + (url.pathname.startsWith('/developer/') ? permissionProbe : ''));
});
server.once('error', (error) => {
  console.error(error);
  process.exit(1);
});
server.listen(Number(port), '127.0.0.1', () => {
  fs.writeFileSync(portPath + '.tmp', String(server.address().port));
  fs.renameSync(portPath + '.tmp', portPath);
});
'@

function Wait-For([string]$Description, [scriptblock]$Probe, [int]$Seconds = 25) {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    do {
        try {
            $value = & $Probe
            if ($value) { return $value }
        } catch [System.Windows.Automation.ElementNotAvailableException], [IO.IOException] {
            # UIA elements and atomic fixture evidence may be replaced between reads.
        }
        Start-Sleep -Milliseconds 200
    } while ($timer.Elapsed.TotalSeconds -lt $Seconds)
    throw "Timed out waiting for $Description."
}

function Start-OwnedProcess([string]$File, [string[]]$Arguments, [hashtable]$Environment = @{}, [switch]$Visible) {
    $start = [Diagnostics.ProcessStartInfo]::new($File)
    $start.WorkingDirectory = $repo
    $start.UseShellExecute = $false
    $start.CreateNoWindow = !$Visible
    foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
    foreach ($key in $Environment.Keys) { $start.Environment[$key] = $Environment[$key] }
    [Diagnostics.Process]::Start($start)
}

function Get-AppWindow {
    if (!$app) { return }
    $app.Refresh()
    if ($app.HasExited) { throw "The owned Quiver process exited with $($app.ExitCode)." }
    if ($app.MainWindowHandle -eq [IntPtr]::Zero) { return }
    $window = [Windows.Automation.AutomationElement]::FromHandle($app.MainWindowHandle)
    if ($window.Current.ProcessId -eq $app.Id -and $window.Current.Name -ceq 'Quiver') { $window }
}

function Find-Named([string]$Name, [switch]$Button, [switch]$Link) {
    $window = Get-AppWindow
    if (!$window) { return }
    $filter = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, $Name)
    if ($Button -or $Link) {
        $type = if ($Link) { [Windows.Automation.ControlType]::Hyperlink } else { [Windows.Automation.ControlType]::Button }
        $filter = [Windows.Automation.AndCondition]::new($filter,
            [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, $type))
    }
    $elements = $window.FindAll([Windows.Automation.TreeScope]::Descendants, $filter)
    foreach ($element in $elements) {
        if (!$element.Current.IsOffscreen -and (!$Button -or $element.Current.IsEnabled)) { return $element }
    }
}

function Invoke-Button([string]$Name) {
    $action = Wait-For "enabled '$Name' button with an action in the owned Quiver window" {
        $button = Find-Named $Name -Button
        if (!$button) { return }
        [object]$pattern = $null
        if ($button.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
            return [pscustomobject]@{ pattern = $pattern; toggle = $false }
        }
        if ($button.TryGetCurrentPattern([Windows.Automation.TogglePattern]::Pattern, [ref]$pattern)) {
            return [pscustomobject]@{ pattern = $pattern; toggle = $true }
        }
    }
    if ($action.toggle) { $action.pattern.Toggle() }
    else { $action.pattern.Invoke() }
}

function Read-Requests {
    if (Test-Path -LiteralPath $requestPath -PathType Leaf) {
        Get-Content -LiteralPath $requestPath -Encoding utf8 | ForEach-Object { $_ | ConvertFrom-Json }
    }
}

function Assert-PagePermissions([string]$Route, [string]$Surface, [switch]$Mobile) {
    $request = Wait-For "rendered permission probe on $Surface" {
        Read-Requests | Where-Object {
            !$_.scan -and $_.mobile -eq $Mobile.IsPresent -and $_.permissionProbe.page -ceq $Route
        } | Select-Object -First 1
    }
    $probe = $request.permissionProbe
    if ($probe.bridge -cne 'false') { throw "$Surface exposed the privileged Quiver bridge to web content." }
    foreach ($permission in 'camera', 'microphone', 'geolocation', 'notifications') {
        $state = $probe.permissions.$permission
        if ($state -cne 'denied') { throw "Expected $permission denied on $Surface, got '$state'." }
    }
    Record-Pass "$Surface has no privileged bridge and denies camera, microphone, geolocation and notifications"
}

function Invoke-VisibleControl([string]$Name, [switch]$Link) {
    $control = Wait-For "visible enabled '$Name' control" {
        $target = Find-Named $Name -Link:$Link
        if ($target -and $target.Current.IsEnabled) { $target }
    }
    [object]$action = $null
    if ($control.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$action)) {
        $action.Invoke()
    } elseif ($control.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern, [ref]$action)) {
        $action.Select()
    } else {
        throw "The owned control '$Name' exposes no Invoke or SelectionItem pattern."
    }
}

function Get-ActiveRoute {
    $share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
    $stream = [IO.File]::Open($statePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, $share)
    try {
        $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8)
        try { $state = $reader.ReadToEnd() | ConvertFrom-Json }
        finally { $reader.Dispose() }
    } finally { $stream.Dispose() }
    $space = $state.activeSpaceId
    $tabs = @($state.tabsBySpace.$space)
    $tabs[[int]$state.activeIndexBySpace.$space].url
}

function Record-Pass([string]$Description) {
    $checks.Add($Description)
    Write-Host "PASS $Description"
}

function Write-Evidence([string]$Result, [string]$Failure = '') {
    $names = try {
        $window = Get-AppWindow
        if ($window) {
            $window.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition) |
                Where-Object { !$_.Current.IsOffscreen -and $_.Current.Name } |
                Select-Object -First 65 | ForEach-Object { $_.Current.Name }
        }
    } catch { @() }
    $lastRoute = try { Get-ActiveRoute } catch { $null }
    $evidence = [ordered]@{
        result = $Result
        error = $Failure
        os = [Runtime.InteropServices.RuntimeInformation]::OSDescription
        electron = $electronVersion
        checks = @($checks.ToArray())
        lastRoute = $lastRoute
        fixtureRequests = @(Read-Requests)
        visibleAccessibilityNames = @($names)
    }
    [IO.File]::WriteAllText($evidencePath, ($evidence | ConvertTo-Json -Depth 9))
}

try {
    $fixture = Start-OwnedProcess $node @('-e', $fixtureSource, $portPath, $requestPath, '0')
    $port = Wait-For 'private fixture port' {
        if ($fixture.HasExited) { throw "Fixture server exited with $($fixture.ExitCode)." }
        if (Test-Path -LiteralPath $portPath -PathType Leaf) { [int](Get-Content -LiteralPath $portPath -Raw) }
    }
    $fixturePath = '/developer/original?case=retry'
    $route = "http://127.0.0.1:$port$fixturePath#anchor"
    $sharedFixturePath = '/developer/shared?case=permissions'
    $sharedRoute = "http://127.0.0.1:$port$sharedFixturePath"
    $localStart = Join-Path $workspace 'local-start.html'
    $localTarget = Join-Path $workspace 'local-target.html'
    [IO.File]::WriteAllText($localStart, '<!doctype html><title>Local start fixture</title><h1>Local start fixture</h1><a href="local-target.html">Open linked local fixture</a>')
    [IO.File]::WriteAllText($localTarget, '<!doctype html><title>Local target fixture</title><h1>Local target fixture</h1>')
    $localStartUrl = [Uri]::new($localStart).AbsoluteUri
    $localTargetUrl = [Uri]::new($localTarget).AbsoluteUri
    $state = [ordered]@{
        version = 1
        spaces = @(
            @{ id = 'space-main'; name = 'Fixture'; color = '#5b8cff'; isolated = $true }
            @{ id = 'space-shared'; name = 'Shared fixture'; color = '#ff7a59'; isolated = $false }
            @{ id = 'space-local'; name = 'Local files'; color = '#58d6aa'; isolated = $true }
        )
        activeSpaceId = 'space-main'
        tabsBySpace = @{
            'space-main' = @(@{ url = $route })
            'space-shared' = @(@{ url = $sharedRoute })
            'space-local' = @(@{ url = $localStartUrl })
        }
        activeIndexBySpace = @{ 'space-main' = 0; 'space-shared' = 0; 'space-local' = 0 }
        settings = @{ sidebarCollapsed = $true; devServerScan = $true }
        bookmarks = @()
        bounds = @{ width = 1000; height = 650; maximized = $false }
    }
    [IO.File]::WriteAllText($statePath, ($state | ConvertTo-Json -Depth 10))
    [IO.File]::WriteAllText((Join-Path $boosts '127.0.0.1.css'), 'h1 { text-decoration: underline; }')
    $app = Start-OwnedProcess $electron @('--force-renderer-accessibility', '--disable-background-networking', $repo) @{
        PORTABLE_EXECUTABLE_DIR = $workspace
    } -Visible

    $null = Wait-For 'one active Boost on the fixture page' { Find-Named 'Boosts: 1 active on this page (Ctrl+Shift+B)' -Button }
    Record-Pass 'The toolbar reports the installed host CSS Boost active on the page'
    Assert-PagePermissions $fixturePath 'The isolated Space tab'

    Invoke-Button $phoneButton
    $null = Wait-For 'active phone preview sharing the tab sign-in' { Find-Named ('Phone preview shares this tab' + [char]0x2019 + 's sign-in') }
    $null = Wait-For 'mobile fixture request sharing the desktop fixture cookie' {
        Read-Requests | Where-Object { $_.path -ceq $fixturePath -and $_.mobile -and $_.fixtureCookie } | Select-Object -First 1
    }
    Record-Pass 'The active phone indicator appears and the mobile page receives the desktop fixture cookie'
    Assert-PagePermissions $fixturePath 'Phone Preview in the isolated Space' -Mobile
    Invoke-Button $phoneButton
    $null = Wait-For 'phone companion to close' { !(Find-Named ('Phone preview shares this tab' + [char]0x2019 + 's sign-in')) }

    Invoke-Button 'Collapse / expand sidebar (Ctrl+B)'
    $null = Wait-For 'Quiver local watcher to discover the fixture endpoint' {
        (Find-Named ":$port") -and @(Read-Requests | Where-Object { $_.scan -and $_.path -ceq '/' }).Count -ge 1
    }
    $fixture.Kill()
    if (!$fixture.WaitForExit(5000)) { throw 'The owned fixture server did not exit.' }
    $fixture.Dispose()
    $fixture = $null
    $null = Wait-For 'local server unavailable notice' { Find-Named 'Local server unavailable' }
    Invoke-Button 'Reload (Ctrl+R)'
    $null = Wait-For 'failure on the stopped fixture endpoint' { Find-Named ('This page can' + [char]0x2019 + 't be reached') }
    [IO.File]::Delete($portPath)
    $fixture = Start-OwnedProcess $node @('-e', $fixtureSource, $portPath, $requestPath, [string]$port)
    $null = Wait-For 'the same owned fixture port to reopen' {
        if ($fixture.HasExited) { throw "Restarted fixture server exited with $($fixture.ExitCode)." }
        (Test-Path -LiteralPath $portPath -PathType Leaf) -and ([int](Get-Content -LiteralPath $portPath -Raw) -eq $port)
    }
    $null = Wait-For 'retry button for the recovered original page' { Find-Named 'Retry local page' -Button }
    $beforeRetry = @(Read-Requests | Where-Object { $_.path -ceq $fixturePath }).Count
    Invoke-Button 'Retry local page'
    $null = Wait-For 'retry request and persisted original URL' {
        $requests = @(Read-Requests | Where-Object { $_.path -ceq $fixturePath })
        $requests.Count -gt $beforeRetry -and (Get-ActiveRoute) -ceq $route
    }
    $null = Wait-For 'retry result page and cleared recovery action' {
        (Find-Named 'Quiver local fixture') -and !(Find-Named 'Retry local page' -Button)
    }
    Record-Pass 'A stopped local server shows unavailable, then Retry restores its original path, query and fragment'

    Invoke-VisibleControl 'Shared fixture, shared sign-in'
    $null = Wait-For 'the active shared Space tab to persist' { (Get-ActiveRoute) -ceq $sharedRoute }
    Assert-PagePermissions $sharedFixturePath 'The shared Space tab'

    Invoke-VisibleControl 'Local files, separate sign-in'
    $null = Wait-For 'the local start fixture to load' {
        (Find-Named 'Open linked local fixture' -Link) -and (Get-ActiveRoute) -ceq $localStartUrl
    }
    Invoke-VisibleControl 'Open linked local fixture' -Link
    $null = Wait-For 'the linked local fixture to load and persist' {
        (Find-Named 'Local target fixture') -and (Get-ActiveRoute) -ceq $localTargetUrl
    }
    Invoke-Button ('Back (Alt+' + [char]0x2190 + ')')
    $null = Wait-For 'Back to restore the original local fixture' {
        (Find-Named 'Open linked local fixture' -Link) -and (Get-ActiveRoute) -ceq $localStartUrl
    }
    Record-Pass 'A hostless local file links to a second local file and Back restores the original file'
    Write-Evidence 'passed'
} catch {
    $failure = $_
    Write-Evidence 'failed' $failure.ToString()
    throw $failure
} finally {
    if ($app) {
        if (!$app.HasExited -and (!$app.CloseMainWindow() -or !$app.WaitForExit(5000))) {
            if (!$app.HasExited) { $app.Kill($true) }
        }
        $app.Dispose()
    }
    if ($fixture) {
        if (!$fixture.HasExited) { $fixture.Kill($true) }
        $fixture.Dispose()
    }
}
