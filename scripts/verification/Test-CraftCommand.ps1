#requires -Version 7.0
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
    !$IsWindows -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64' -or
    [Threading.Thread]::CurrentThread.GetApartmentState() -ne 'STA') {
    throw 'This test requires an STA PowerShell process on a disposable GitHub-hosted Windows x64 runner.'
}

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class QuiverCommandKeyboard
{
    [StructLayout(LayoutKind.Sequential)]
    private struct KeyboardInput {
        public ushort Key, ScanCode;
        public uint Flags, Time;
        public UIntPtr ExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MouseInput {
        public int X, Y;
        public uint Data, Flags, Time;
        public UIntPtr ExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputData {
        [FieldOffset(0)] public KeyboardInput Keyboard;
        [FieldOffset(0)] public MouseInput Mouse;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Input {
        public uint Type;
        public InputData Data;
    }

    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")] private static extern uint MapVirtualKeyW(uint code, uint mapType);
    [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint count, Input[] inputs, int size);

    public static bool OwnsForeground(IntPtr window, uint processId)
    {
        if (window == IntPtr.Zero || GetWindowThreadProcessId(window, out uint owner) == 0 || owner != processId)
            return false;
        if (GetForegroundWindow() != window)
            SetForegroundWindow(window);
        return GetForegroundWindow() == window &&
            GetWindowThreadProcessId(window, out owner) != 0 && owner == processId;
    }

    private static Input Key(ushort key, ushort scan, uint flags)
    {
        return new Input {
            Type = 1,
            Data = new InputData { Keyboard = new KeyboardInput { Key = key, ScanCode = scan, Flags = flags } }
        };
    }

    private static bool Send(IntPtr window, uint processId, Input[] inputs)
    {
        return OwnsForeground(window, processId) && SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<Input>()) == inputs.Length;
    }

    public static bool Press(IntPtr window, uint processId, ushort key, ushort modifier)
    {
        var inputs = new List<Input>();
        ushort scan = (ushort)MapVirtualKeyW(key, 0);
        ushort modifierScan = (ushort)MapVirtualKeyW(modifier, 0);
        if (modifier != 0) inputs.Add(Key(modifier, modifierScan, 0));
        inputs.Add(Key(key, scan, 0));
        inputs.Add(Key(key, scan, 2));
        if (modifier != 0) inputs.Add(Key(modifier, modifierScan, 2));
        return Send(window, processId, inputs.ToArray());
    }

    public static bool Type(IntPtr window, uint processId, string value)
    {
        var inputs = new List<Input>();
        foreach (char character in value) {
            inputs.Add(Key(0, character, 4));
            inputs.Add(Key(0, character, 6));
        }
        return Send(window, processId, inputs.ToArray());
    }
}
'@

$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$runnerTemp = (Resolve-Path -LiteralPath $env:RUNNER_TEMP).Path
$workspace = Join-Path $runnerTemp 'quiver-craft-command'
if (Test-Path -LiteralPath $workspace) { throw "The evidence workspace already exists at $workspace." }
$profile = Join-Path $workspace 'data'
[void][IO.Directory]::CreateDirectory($profile)
$statePath = Join-Path $profile 'quiver-state.json'
$originPath = Join-Path $workspace 'origins.json'
$requestPath = Join-Path $workspace 'requests.jsonl'
$evidencePath = Join-Path $workspace 'command-evidence.json'
$electron = (Resolve-Path -LiteralPath (Join-Path $repo 'node_modules/electron/dist/electron.exe')).Path
$node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
$commandInputName = 'Command or address'
$fixtureInputName = 'Fixture focus target'
$steps = [Collections.Generic.List[object]]::new()
$fixture = $null
$app = $null

function Start-OwnedProcess([string]$File, [string[]]$Arguments, [hashtable]$Environment = @{}, [bool]$Visible = $false) {
    $start = [Diagnostics.ProcessStartInfo]::new($File)
    $start.WorkingDirectory = $repo
    $start.UseShellExecute = $false
    $start.CreateNoWindow = !$Visible
    foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
    foreach ($key in $Environment.Keys) { $start.Environment[$key] = $Environment[$key] }
    [Diagnostics.Process]::Start($start)
}

function Wait-For([string]$Description, [scriptblock]$Probe, [int]$Seconds = 20) {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    do {
        try {
            $result = & $Probe
            if ($result) { return $result }
        } catch [System.Windows.Automation.ElementNotAvailableException], [IO.IOException] {
            # Chromium can rebuild its accessibility tree and the store replaces its state file.
        }
        Start-Sleep -Milliseconds 150
    } while ($watch.Elapsed.TotalSeconds -lt $Seconds)
    throw "Timed out waiting for $Description."
}

function Get-AppWindow {
    if (!$app) { return }
    $app.Refresh()
    if ($app.HasExited) { throw "The owned Electron process exited with $($app.ExitCode)." }
    if ($app.MainWindowHandle -eq [IntPtr]::Zero) { return }
    $window = [Windows.Automation.AutomationElement]::FromHandle($app.MainWindowHandle)
    if ($window.Current.ProcessId -eq $app.Id -and $window.Current.Name -eq 'Quiver') { $window }
}

function Find-Edit([string]$Name) {
    $window = Get-AppWindow
    if (!$window) { return }
    $window.FindFirst(
        [Windows.Automation.TreeScope]::Descendants,
        [Windows.Automation.AndCondition]::new(
            [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, $Name),
            [Windows.Automation.OrCondition]::new(
                [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Edit),
                [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::ComboBox)
            )
        )
    )
}

function Get-VisibleNames {
    $window = Get-AppWindow
    if (!$window) { return }
    $all = $window.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
    foreach ($element in $all) {
        if (!$element.Current.IsOffscreen -and $element.Current.Name) { $element.Current.Name }
    }
}

function Confirm-Preview([string]$Action, [string]$Destination = '', [string]$Space = '') {
    $null = Wait-For "visible '$Action' preview" {
        $names = @(Get-VisibleNames) -join '|'
        $names.Contains($Action) -and (!$Destination -or $names.Contains($Destination)) -and
            (!$Space -or $names.Contains($Space))
    }
}

function Press-Key([int]$Key, [int]$Modifier = 0) {
    $null = Get-AppWindow
    if (![QuiverCommandKeyboard]::Press($app.MainWindowHandle, $app.Id, $Key, $Modifier)) {
        throw "Could not send key $Key to the foreground Quiver window."
    }
}

function Type-Command([string]$Value) {
    $null = Wait-For 'command input keyboard focus' {
        $field = Find-Edit $commandInputName
        $field -and $field.Current.HasKeyboardFocus
    }
    Press-Key 0x41 0x11
    if (![QuiverCommandKeyboard]::Type($app.MainWindowHandle, $app.Id, $Value)) {
        throw 'Could not type into the foreground Quiver window.'
    }
}

function Open-Command([int]$Key = 0x4c) {
    Press-Key $Key 0x11
    $null = Wait-For 'command input keyboard focus' {
        $field = Find-Edit $commandInputName
        $field -and $field.Current.HasKeyboardFocus
    }
}

function Read-Session {
    $state = Get-Content -LiteralPath $statePath -Raw -Encoding utf8 | ConvertFrom-Json
    $space = $state.activeSpaceId
    $tabs = @($state.tabsBySpace.$space)
    $index = [int]$state.activeIndexBySpace.$space
    if ($tabs.Count -gt $index) {
        [pscustomobject]@{ count = $tabs.Count; route = $tabs[$index].url; space = $space }
    }
}

function Wait-Session([string]$Url, [int]$Count) {
    $null = Wait-For "persisted tab $Url and $Count tabs" {
        $s = Read-Session
        $s.route -ceq $Url -and $s.count -eq $Count -and $s.space -ceq 'space-main'
    }
}

function Read-Requests {
    if (Test-Path -LiteralPath $requestPath -PathType Leaf) {
        Get-Content -LiteralPath $requestPath -Encoding utf8 |
            ForEach-Object { $_ | ConvertFrom-Json } |
            Where-Object { $_.path -ne '/favicon.ico' }
    }
}

function Confirm-NoRequest([int]$Before, [string]$Route, [int]$Count) {
    Start-Sleep -Milliseconds 400
    $after = @(Read-Requests).Count
    $s = Read-Session
    if ($after -ne $Before -or $s.route -cne $Route -or $s.count -ne $Count) {
        throw "An unconfirmed command changed browser state or made a fixture request. Before: $Before. After: $after."
    }
}

function Record-Pass([string]$Description) {
    $steps.Add([ordered]@{ result = $Description; session = Read-Session; requests = @(Read-Requests).Count })
    Write-Host "PASS $Description"
}

function Write-Evidence([string]$Result, [string]$Failure = '') {
    $names = try { @(Get-VisibleNames | Select-Object -First 80) } catch { @() }
    $data = [ordered]@{
        result = $Result
        error = $Failure
        os = [Runtime.InteropServices.RuntimeInformation]::OSDescription
        architecture = [string][Runtime.InteropServices.RuntimeInformation]::OSArchitecture
        electron = (Get-Item -LiteralPath $electron).VersionInfo.ProductVersion
        checks = @($steps.ToArray())
        fixtureRequests = @(Read-Requests)
        visibleAccessibilityNames = $names
        limits = @('UI Automation names and focus only', 'No screen-reader speech, OS high contrast, or physical mixed-DPI coverage')
    }
    [IO.File]::WriteAllText($evidencePath, ($data | ConvertTo-Json -Depth 10))
}

$fixtureSource = @'
const fs = require('node:fs');
const http = require('node:http');
const [originPath, requestPath] = process.argv.slice(1);
const server = (name) => new Promise((resolve, reject) => {
  const service = http.createServer((req, res) => {
    fs.appendFileSync(requestPath, JSON.stringify({ environment: name, path: req.url }) + '\n');
    if (req.url === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Quiver command fixture</title><h1>Quiver command fixture</h1><label for="field">Fixture focus target</label><input id="field">');
  });
  service.once('error', reject);
  service.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + service.address().port));
});
Promise.all([server('staging'), server('prod')]).then(([staging, prod]) => {
  fs.writeFileSync(originPath + '.tmp', JSON.stringify({ staging, prod }));
  fs.renameSync(originPath + '.tmp', originPath);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
'@

try {
    $fixture = Start-OwnedProcess $node @('-e', $fixtureSource, $originPath, $requestPath)
    $origins = Wait-For 'private loopback origins' {
        if ($fixture.HasExited) { throw "Fixture server exited with $($fixture.ExitCode)." }
        if (Test-Path -LiteralPath $originPath -PathType Leaf) {
            Get-Content -LiteralPath $originPath -Raw | ConvertFrom-Json
        }
    }
    $staging = $origins.staging
    $prod = $origins.prod
    $initial = "$staging/orders/42?sample=1#details"
    $environmentTarget = "$prod/orders/42?sample=1#details"
    $newTab = "$prod/docs"
    $searchResult = "$staging/search?q=fixture%20release%20notes"
    $seed = [ordered]@{
        version = 1
        spaces = @(@{ id = 'space-main'; name = 'Fixture Space'; color = '#5b8cff'; isolated = $false })
        activeSpaceId = 'space-main'
        tabsBySpace = @{ 'space-main' = @(@{ url = $initial }) }
        activeIndexBySpace = @{ 'space-main' = 0 }
        settings = @{
            envGroups = @(@{ name = 'Fixture'; local = ''; staging = $staging; prod = $prod })
            searchEngine = "$staging/search?q=%s"
            devServerScan = $false
            sidebarCollapsed = $false
        }
        bookmarks = @()
        bounds = @{ width = 920; height = 650; maximized = $false }
    }
    [IO.File]::WriteAllText($statePath, ($seed | ConvertTo-Json -Depth 10))
    $app = Start-OwnedProcess $electron @('--force-renderer-accessibility', '--disable-background-networking', $repo) @{
        PORTABLE_EXECUTABLE_DIR = $workspace
    } $true

    $fixtureInput = Wait-For 'loopback fixture edit control' { Find-Edit $fixtureInputName }
    $null = Wait-For 'foreground Quiver window' { [QuiverCommandKeyboard]::OwnsForeground($app.MainWindowHandle, $app.Id) }
    $fixtureInput.SetFocus()
    $null = Wait-For 'loopback edit control keyboard focus' { (Find-Edit $fixtureInputName).Current.HasKeyboardFocus }
    Wait-Session $initial 1
    $requestsBefore = @(Read-Requests).Count
    if ($requestsBefore -lt 1) { throw 'The fixture page was not requested by the owned Quiver instance.' }

    Open-Command
    Type-Command $newTab
    Confirm-Preview 'Open in this tab' '/docs' 'Space: Fixture Space'
    Confirm-NoRequest $requestsBefore $initial 1
    Press-Key 0x1b
    $null = Wait-For 'Escape to return keyboard focus to the original page field' {
        $focus = [Windows.Automation.AutomationElement]::FocusedElement
        $focus.Current.Name -ceq $fixtureInputName -and (Find-Edit $fixtureInputName).Current.HasKeyboardFocus
    }
    Record-Pass 'Ctrl+L previews current-tab navigation and Escape restores the original page field'

    Open-Command
    Type-Command '1700000000'
    Confirm-Preview 'Decode locally'
    Confirm-NoRequest $requestsBefore $initial 1
    Press-Key 0x1b
    $null = Wait-For 'Escape to return keyboard focus after local decode' { (Find-Edit $fixtureInputName).Current.HasKeyboardFocus }
    Record-Pass 'Unix time is previewed locally without navigation or a fixture request'

    Open-Command
    Type-Command 'env prod'
    Confirm-Preview 'Switch to PROD' '/orders/42' 'Space: Fixture Space'
    Confirm-NoRequest $requestsBefore $initial 1
    Type-Command 'env nowhere'
    Confirm-Preview 'No matching environment'
    Press-Key 0x0d
    Confirm-NoRequest $requestsBefore $initial 1
    Record-Pass 'Unavailable environment cannot activate the previous production preview'

    Type-Command 'env prod'
    Confirm-Preview 'Switch to PROD' '/orders/42' 'Space: Fixture Space'
    Press-Key 0x0d
    Wait-Session $environmentTarget 1
    $null = Wait-For 'production fixture request' {
        Read-Requests | Where-Object { $_.environment -ceq 'prod' -and $_.path -ceq '/orders/42?sample=1' }
    }
    Record-Pass 'Enter switches environment and preserves path, query, and fragment'

    Open-Command 0x54
    $requestsBefore = @(Read-Requests).Count
    Type-Command $newTab
    Confirm-Preview 'Open in new tab' '/docs' 'Space: Fixture Space'
    Confirm-NoRequest $requestsBefore $environmentTarget 1
    Press-Key 0x0d
    Wait-Session $newTab 2
    $null = Wait-For 'new tab fixture request' { Read-Requests | Where-Object { $_.path -ceq '/docs' } }
    Record-Pass 'Ctrl+T previews and then opens in a new tab on Enter'

    Open-Command
    $requestsBefore = @(Read-Requests).Count
    Type-Command 'fixture release notes'
    Confirm-Preview 'Search the web' '127.0.0.1' 'Space: Fixture Space'
    Confirm-NoRequest $requestsBefore $newTab 2
    Press-Key 0x0d
    Wait-Session $searchResult 2
    $null = Wait-For 'confirmed search fixture request' {
        Read-Requests | Where-Object { $_.path -ceq '/search?q=fixture%20release%20notes' }
    }
    Record-Pass 'Search goes to the configured destination only after Enter'
    Write-Evidence 'passed'
} catch {
    $failure = $_
    Write-Evidence 'failed' $failure.ToString()
    throw $failure
} finally {
    if ($app) {
        if (!$app.HasExited) {
            if (!$app.CloseMainWindow() -or !$app.WaitForExit(5000)) {
                if (!$app.HasExited) { $app.Kill($true) }
            }
        }
        $app.Dispose()
    }
    if ($fixture) {
        if (!$fixture.HasExited) { $fixture.Kill($true) }
        $fixture.Dispose()
    }
}
