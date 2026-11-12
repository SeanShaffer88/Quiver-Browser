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
if ($electronVersion -cne '45.3.1') { throw "Expected locked Electron 45.3.1 but found $electronVersion." }
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
const server = http.createServer((req, res) => {
  if (req.url !== '/favicon.ico') {
    fs.appendFileSync(requestPath, JSON.stringify({
      path: req.url,
      scan: req.headers['user-agent'] === 'Quiver-devscan',
      mobile: /Mobile/i.test(req.headers['user-agent'] || ''),
      fixtureCookie: /(?:^|;\s*)quiver_fixture=present(?:;|$)/.test(req.headers.cookie || '')
    }) + '\n');
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Connection', 'close');
  if (req.url.startsWith('/developer/')) res.setHeader('Set-Cookie', 'quiver_fixture=present; Path=/; HttpOnly; SameSite=Lax');
  res.end(page);
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

function Find-Named([string]$Name, [switch]$Button) {
    $window = Get-AppWindow
    if (!$window) { return }
    $filter = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, $Name)
    if ($Button) {
        $filter = [Windows.Automation.AndCondition]::new($filter,
            [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Button))
    }
    $elements = $window.FindAll([Windows.Automation.TreeScope]::Descendants, $filter)
    foreach ($element in $elements) {
        if (!$element.Current.IsOffscreen -and (!$Button -or $element.Current.IsEnabled)) { return $element }
    }
}

function Invoke-Button([string]$Name) {
    $button = Wait-For "enabled '$Name' button in the owned Quiver window" { Find-Named $Name -Button }
    $button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
}

function Read-Requests {
    if (Test-Path -LiteralPath $requestPath -PathType Leaf) {
        Get-Content -LiteralPath $requestPath -Encoding utf8 | ForEach-Object { $_ | ConvertFrom-Json }
    }
}

function Get-ActiveRoute {
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
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
    $state = [ordered]@{
        version = 1
        spaces = @(@{ id = 'space-main'; name = 'Fixture'; color = '#5b8cff'; isolated = $true })
        activeSpaceId = 'space-main'
        tabsBySpace = @{ 'space-main' = @(@{ url = $route }) }
        activeIndexBySpace = @{ 'space-main' = 0 }
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

    Invoke-Button $phoneButton
    $null = Wait-For 'active phone preview sharing the tab sign-in' { Find-Named ('Phone preview shares this tab' + [char]0x2019 + 's sign-in') }
    $null = Wait-For 'mobile fixture request sharing the desktop fixture cookie' {
        Read-Requests | Where-Object { $_.path -ceq $fixturePath -and $_.mobile -and $_.fixtureCookie } | Select-Object -First 1
    }
    Record-Pass 'The active phone indicator appears and the mobile page receives the desktop fixture cookie'
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
