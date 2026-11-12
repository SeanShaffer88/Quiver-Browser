#requires -Version 7.0
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or !$IsWindows -or
    [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64' -or
    [Threading.Thread]::CurrentThread.GetApartmentState() -ne 'STA') {
    throw 'This test requires an STA PowerShell process on a disposable GitHub-hosted Windows x64 runner.'
}
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$workspacePath = Join-Path (Resolve-Path -LiteralPath $env:RUNNER_TEMP).Path 'quiver-craft-bookmarks'
if (Test-Path -LiteralPath $workspacePath) { throw "The evidence workspace already exists at $workspacePath." }
$portableData = Join-Path $workspacePath 'data'
$localBrowserData = Join-Path $workspacePath 'local'
$profile = Join-Path $localBrowserData 'Google/Chrome/User Data/Profile 98765'
[void][IO.Directory]::CreateDirectory($portableData)
[void][IO.Directory]::CreateDirectory($profile)
$statePath = Join-Path $portableData 'quiver-state.json'
$evidencePath = Join-Path $workspacePath 'bookmark-evidence.json'
$htmlFile = Join-Path $workspacePath 'fixture bookmarks.html'
$exePath = (Resolve-Path -LiteralPath (Join-Path $repo 'node_modules/electron/dist/electron.exe')).Path

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class QuiverTestInput
{
    [StructLayout(LayoutKind.Sequential)]
    private struct Point { public int X, Y; }

    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] private static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);

    public static bool Click(IntPtr window, uint processId, int x, int y)
    {
        uint owner;
        if (window == IntPtr.Zero || GetWindowThreadProcessId(window, out owner) == 0 || owner != processId)
            return false;
        SetForegroundWindow(window);
        var point = new Point { X = x, Y = y };
        if (GetForegroundWindow() != window || GetAncestor(WindowFromPoint(point), 2) != window || !SetCursorPos(x, y))
            return false;
        mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
        mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
        return true;
    }
}
'@
$expectedProfile = @(
    @{ title = 'Quiver fixture profile one'; url = 'https://example.invalid/chrome-one' }
    @{ title = 'Quiver fixture profile two'; url = 'https://example.invalid/chrome-two' }
)
$expectedAll = $expectedProfile + @{ title = 'Quiver fixture export & one'; url = 'https://example.invalid/html-one' }
$installerRoute = 'quiver://app/settings.html?import=bookmarks'
$settingsRoute = 'quiver://app/settings.html'
$newTabRoute = 'quiver://app/newtab.html'
$steps = [Collections.Generic.List[object]]::new()
$script:appProcess = $null
$script:settingsGearAttempts = [Collections.Generic.List[object]]::new()

function Wait-For {
    param([string]$Description, [scriptblock]$Probe, [int]$Seconds = 25)
    $timer = [Diagnostics.Stopwatch]::StartNew()
    do {
        try {
            $value = & $Probe
            if ($value) { return $value }
        } catch [System.Windows.Automation.ElementNotAvailableException], [IO.IOException] {
            # A page refresh or atomic state write may temporarily invalidate a read.
        }
        Start-Sleep -Milliseconds 200
    } while ($timer.Elapsed.TotalSeconds -lt $Seconds)
    throw "Timed out waiting for $Description."
}

function Get-OwnedWindows {
    $condition = [Windows.Automation.PropertyCondition]::new(
        [Windows.Automation.AutomationElement]::ProcessIdProperty, $script:appProcess.Id
    )
    [Windows.Automation.AutomationElement]::RootElement.FindAll(
        [Windows.Automation.TreeScope]::Children, $condition
    )
}

function Get-QuiverWindow {
    $script:appProcess.Refresh()
    if ($script:appProcess.HasExited) { throw "Quiver exited with code $($script:appProcess.ExitCode)." }
    foreach ($window in Get-OwnedWindows) {
        if ($window.Current.Name -eq 'Quiver') { return $window }
    }
}

function Find-Control {
    param(
        [Windows.Automation.AutomationElement]$Root,
        [string]$Name,
        [Windows.Automation.ControlType]$Type,
        [string]$AutomationId
    )
    if (!$Root) { return }
    $condition = if ($Type) {
        [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, $Type)
    }
    if ($Name) {
        $nameCondition = [Windows.Automation.PropertyCondition]::new(
            [Windows.Automation.AutomationElement]::NameProperty, $Name
        )
        $condition = if ($condition) { [Windows.Automation.AndCondition]::new($condition, $nameCondition) } else { $nameCondition }
    }
    if ($AutomationId) {
        $idCondition = [Windows.Automation.PropertyCondition]::new(
            [Windows.Automation.AutomationElement]::AutomationIdProperty, $AutomationId
        )
        $condition = if ($condition) { [Windows.Automation.AndCondition]::new($condition, $idCondition) } else { $idCondition }
    }
    $Root.FindFirst([Windows.Automation.TreeScope]::Descendants, $condition)
}

function Invoke-Button {
    param([string]$Name)
    $button = Wait-For "enabled Quiver button '$Name'" {
        $element = Find-Control (Get-QuiverWindow) $Name ([Windows.Automation.ControlType]::Button)
        if ($element -and $element.Current.IsEnabled) { $element }
    }
    $button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
}

function Read-State {
    if (Test-Path -LiteralPath $statePath -PathType Leaf) {
        # Close the file handle before parsing to minimize interference with Windows replacement.
        $share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
        $reader = [IO.StreamReader]::new([IO.File]::Open($statePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, $share))
        try { $json = $reader.ReadToEnd() } finally { $reader.Dispose() }
        $json | ConvertFrom-Json
    }
}

function Get-ActiveRoute($State) {
    if (!$State -or !$State.activeSpaceId) { return }
    $space = $State.activeSpaceId
    $tabs = @($State.tabsBySpace.$space)
    $index = [int]$State.activeIndexBySpace.$space
    if ($index -lt $tabs.Count) { $tabs[$index].url }
}

function Reset-FixtureSession {
    if (!$script:appProcess.HasExited) { throw 'The fixture session can only be reset with Quiver closed.' }
    $state = Read-State
    $state.tabsBySpace = [pscustomobject]@{}
    $state.activeIndexBySpace = [pscustomobject]@{}
    $json = $state | ConvertTo-Json -Depth 20
    [IO.File]::WriteAllText($statePath, $json, [Text.UTF8Encoding]::new($false))
}

function Get-RectEvidence($Rect) {
    if ($Rect.IsEmpty) { return $null }
    [ordered]@{ x = $Rect.X; y = $Rect.Y; width = $Rect.Width; height = $Rect.Height }
}

function Get-GearSnapshot {
    $window = Get-QuiverWindow
    if (!$window) { return [ordered]@{ ownedWindowFound = $false; pid = $script:appProcess.Id } }
    $condition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, 'Settings')
    $matches = @($window.FindAll([Windows.Automation.TreeScope]::Descendants, $condition) | ForEach-Object {
        $current = $_.Current
        [ordered]@{
            name = $current.Name
            role = $current.ControlType.ProgrammaticName
            enabled = $current.IsEnabled
            offscreen = $current.IsOffscreen
            bounds = Get-RectEvidence $current.BoundingRectangle
        }
    })
    $current = $window.Current
    [ordered]@{
        ownedWindowFound = $true
        pid = $current.ProcessId
        name = $current.Name
        hwnd = $current.NativeWindowHandle
        bounds = Get-RectEvidence $current.BoundingRectangle
        settingsMatches = $matches
    }
}

function Get-VisibleGear {
    $window = Get-QuiverWindow
    $button = Find-Control $window 'Settings' ([Windows.Automation.ControlType]::Button)
    if (!$button -or !$button.Current.IsEnabled -or $button.Current.IsOffscreen) { return }
    $bounds = $button.Current.BoundingRectangle
    if ($bounds.IsEmpty -or $bounds.Width -le 0 -or $bounds.Height -le 0) { return }
    $x = $bounds.X + $bounds.Width / 2
    $y = $bounds.Y + $bounds.Height / 2
    if (![double]::IsFinite($x) -or ![double]::IsFinite($y) -or
        $x -lt [int]::MinValue -or $x -gt [int]::MaxValue -or $y -lt [int]::MinValue -or $y -gt [int]::MaxValue) { return }
    $hwnd = [IntPtr]$window.Current.NativeWindowHandle
    $pidAtCapture = $window.Current.ProcessId
    if ($hwnd -ne [IntPtr]::Zero -and $pidAtCapture -eq $script:appProcess.Id) {
        [pscustomobject]@{ button = $button; hwnd = $hwnd; ownerPid = $pidAtCapture; x = [int]$x; y = [int]$y; bounds = Get-RectEvidence $bounds }
    }
}

function Wait-ForSettingsNavigation([int]$Milliseconds) {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    do {
        try {
            $route = Get-ActiveRoute (Read-State)
            if ($route -ceq $settingsRoute) { return $true }
            if ($route -and $route -cne $newTabRoute) { throw "Settings gear opened unexpected route '$route'." }
        } catch [IO.IOException] {
            # The store replaces the state file atomically.
        }
        Start-Sleep -Milliseconds 150
    } while ($timer.ElapsedMilliseconds -lt $Milliseconds)
    return $false
}

function Open-SettingsFromNewTab {
    $null = Wait-For 'fresh New Tab route before the Settings click' {
        (Get-ActiveRoute (Read-State)) -ceq $newTabRoute
    }
    try {
        $target = Wait-For 'visible enabled Settings toolbar gear' { Get-VisibleGear }
        $click = [ordered]@{ action = 'owned click'; x = $target.x; y = $target.y; hwnd = $target.hwnd.ToInt64(); pid = $target.ownerPid; bounds = $target.bounds }
        $script:settingsGearAttempts.Add($click)
        $click.sent = [QuiverTestInput]::Click($target.hwnd, $target.ownerPid, $target.x, $target.y)
        $click.navigated = Wait-ForSettingsNavigation 2500
        Write-Host "Settings gear click accepted=$($click.sent), navigated=$($click.navigated)."
        if (!$click.navigated) {
            $target = Wait-For 'visible enabled Settings toolbar gear for UIA Invoke' { Get-VisibleGear }
            $invoke = [ordered]@{ action = 'UIA Invoke'; before = Get-GearSnapshot }
            $script:settingsGearAttempts.Add($invoke)
            try {
                $target.button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
                $invoke.sent = $true
            } catch {
                $invoke.error = $_.Exception.Message
                throw
            }
            $invoke.navigated = Wait-ForSettingsNavigation 4000
            Write-Host "Settings gear Invoke accepted=$($invoke.sent), navigated=$($invoke.navigated)."
            if (!$invoke.navigated) { throw 'The visible Settings gear did not open Settings after click and UIA Invoke.' }
        }
        Confirm-Route $settingsRoute
    } catch {
        $script:settingsGearAttempts.Add([ordered]@{
            action = 'failure snapshot'
            window = try { Get-GearSnapshot } catch { @{ error = $_.Exception.Message } }
        })
        throw
    }
}


function Confirm-Route {
    param([string]$Route)
    $null = Wait-For "active Quiver route $Route" {
        (Get-ActiveRoute (Read-State)) -ceq $Route
    }
    $null = Wait-For 'visible Bookmarks heading' {
        $heading = Find-Control (Get-QuiverWindow) 'Bookmarks'
        $heading -and !$heading.Current.IsOffscreen
    }
}

function Confirm-Bookmarks {
    param([object[]]$Expected, [string]$Stage, [string]$Route, [string]$Status)
    $records = @((Read-State).bookmarks)
    if ($records.Count -ne $Expected.Count) {
        throw "$Stage persisted $($records.Count) bookmarks. Expected $($Expected.Count)."
    }
    for ($i = 0; $i -lt $Expected.Count; $i++) {
        $record = $records[$i]
        $wanted = $Expected[$i]
        if ($record.title -cne $wanted.title -or $record.url -cne $wanted.url) {
            throw "$Stage has an unexpected bookmark at index $i."
        }
        $null = Wait-For "visible bookmark '$($wanted.title)'" {
            $element = Find-Control (Get-QuiverWindow) $wanted.title ([Windows.Automation.ControlType]::Button)
            $element -and !$element.Current.IsOffscreen
        }
    }
    $steps.Add([ordered]@{
        stage = $Stage
        processId = $script:appProcess.Id
        activeRoute = $Route
        status = $Status
        bookmarks = $records
    })
    Write-Host "PASS $Stage ($($records.Count) bookmarks visible and persisted)."
}

function Open-ChromeProfile {
    $profileLabel = 'Google Chrome ' + [char]0x00B7 + ' Profile 98765'
    $combo = Wait-For 'enabled Browser profile selector' {
        $element = Find-Control (Get-QuiverWindow) 'Browser profile' ([Windows.Automation.ControlType]::ComboBox)
        if ($element -and $element.Current.IsEnabled) { $element }
    }
    $expand = $combo.GetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern)
    $expand.Expand()
    $option = Wait-For "owned Chrome option '$profileLabel'" {
        foreach ($window in Get-OwnedWindows) {
            $element = Find-Control $window $profileLabel
            if ($element) { return $element }
        }
    }
    $selection = $null
    if ($option.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selection)) {
        $selection.Select()
        $method = 'SelectionItem.Select'
    } else {
        $option.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
        $method = 'Invoke'
    }
    # Chromium can replace the expanded popup provider as the option is selected.
    # Wait on the resulting Settings button in the owned window instead of reusing that provider.
    $null = Wait-For "Review import to become enabled after $method selected '$profileLabel'" {
        $button = Find-Control (Get-QuiverWindow) 'Review import' ([Windows.Automation.ControlType]::Button)
        $button -and $button.Current.IsEnabled
    }
}

function Get-OpenDialog {
    foreach ($window in Get-OwnedWindows) {
        # The file picker can appear as a proxy descendant of the owned app window.
        $dialog = if ($window.Current.Name -eq 'Open' -and $window.Current.ControlType -eq [Windows.Automation.ControlType]::Window) {
            $window
        } else {
            Find-Control $window 'Open' ([Windows.Automation.ControlType]::Window)
        }
        if ((Find-Control -Root $dialog -Type ([Windows.Automation.ControlType]::Edit) -AutomationId '1148') -and
            (Find-Control $dialog 'Open' ([Windows.Automation.ControlType]::Button) '1')) {
            return $dialog
        }
    }
}

function Import-HtmlFile {
    Invoke-Button 'Choose HTML file'
    $dialog = Wait-For 'owned Windows Open file dialog' { Get-OpenDialog }
    $fileNameField = Find-Control -Root $dialog -Type ([Windows.Automation.ControlType]::Edit) -AutomationId '1148'
    $fileNameField.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).SetValue($htmlFile)
    $open = Find-Control $dialog 'Open' ([Windows.Automation.ControlType]::Button) '1'
    if (!$open -or !$open.Current.IsEnabled) { throw 'The owned file dialog has no enabled Open button.' }
    $open.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
    $null = Wait-For 'owned Open file dialog to close' { !(Get-OpenDialog) }
}

function Confirm-ImportStatus {
    param([string]$Status)
    $null = Wait-For "bookmark import status '$Status'" { Find-Control (Get-QuiverWindow) $Status }
}

function Stop-Quiver {
    if (!$script:appProcess -or $script:appProcess.HasExited) { return }
    if (!$script:appProcess.CloseMainWindow() -or !$script:appProcess.WaitForExit(15000)) {
        throw "Owned Quiver process $($script:appProcess.Id) did not close gracefully."
    }
    if ($script:appProcess.ExitCode -ne 0) { throw "Quiver exited with code $($script:appProcess.ExitCode)." }
}


function Start-Quiver([switch]$ImportBookmarks) {
    if ($script:appProcess -and $script:appProcess.HasExited) { $script:appProcess.Dispose() }
    $start = [Diagnostics.ProcessStartInfo]::new($exePath)
    $start.WorkingDirectory = $repo
    $start.UseShellExecute = $false
    $start.Environment['PORTABLE_EXECUTABLE_DIR'] = $workspacePath
    $start.Environment['LOCALAPPDATA'] = $localBrowserData
    foreach ($argument in '--force-renderer-accessibility', '--disable-background-networking', $repo) {
        $start.ArgumentList.Add($argument)
    }
    if ($ImportBookmarks) { $start.ArgumentList.Add('--import-bookmarks') }
    $script:appProcess = [Diagnostics.Process]::Start($start)
    $null = Wait-For 'owned Quiver window' { Get-QuiverWindow }
}

function Confirm-Review {
    param([string]$Source, [string]$Add, [string]$Duplicates, [string]$Unsupported)
    foreach ($text in "From $Source", $Add, $Duplicates, $Unsupported, '0 over the library limit') {
        $null = Wait-For "visible bookmark review text '$text'" {
            $element = Find-Control (Get-QuiverWindow) $text
            $element -and !$element.Current.IsOffscreen
        }
    }
}

function Write-Evidence([string]$Result, [string]$Failure = '') {
    $data = [ordered]@{
        result = $Result
        error = $Failure
        os = [Runtime.InteropServices.RuntimeInformation]::OSDescription
        installerCoverage = 'Launch argument and installer-specific Settings route'
        checks = @($steps.ToArray())
        settingsGear = @($script:settingsGearAttempts.ToArray())
        lastRoute = try { Get-ActiveRoute (Read-State) } catch { $null }
    }
    [IO.File]::WriteAllText($evidencePath, ($data | ConvertTo-Json -Depth 10))
}


$chrome = @{ roots = @{ bar = @{ type = 'folder'; children = @(
    @{ type = 'url'; name = 'Quiver fixture profile one'; url = 'https://example.invalid/chrome-one' },
    @{ type = 'url'; name = 'Quiver fixture profile two'; url = 'https://example.invalid/chrome-two' },
    @{ type = 'url'; name = 'Duplicate'; url = 'https://example.invalid/chrome-one' },
    @{ type = 'url'; name = 'Unsupported'; url = 'file:///fixture' }
) } } }
[IO.File]::WriteAllText((Join-Path $profile 'Bookmarks'), ($chrome | ConvertTo-Json -Depth 10))
[IO.File]::WriteAllText($htmlFile, @'
<!DOCTYPE NETSCAPE-Bookmark-file-1>
<TITLE>Bookmarks</TITLE><H1>Bookmarks</H1>
<DL><p>
<DT><A HREF="https://example.invalid/html-one">Quiver fixture export &amp; one</A>
<DT><A HREF="https://example.invalid/chrome-two">Duplicate of Chrome</A>
<DT><A HREF="file:///fixture">Unsupported</A>
</DL><p>
'@)
$seed = @{
    version = 1
    spaces = @(@{ id = 'space-main'; name = 'Main'; color = '#5b8cff'; isolated = $false })
    activeSpaceId = 'space-main'
    tabsBySpace = @{}
    activeIndexBySpace = @{}
    settings = @{ devServerScan = $false }
    bookmarks = @()
    bounds = @{ width = 920; height = 650; maximized = $false }
}
[IO.File]::WriteAllText($statePath, ($seed | ConvertTo-Json -Depth 10))
$chromeSource = 'Google Chrome ' + [char]0x00B7 + ' Profile 98765'

try {
    Start-Quiver -ImportBookmarks
    Confirm-Route $installerRoute
    Open-ChromeProfile
    Invoke-Button 'Review import'
    Confirm-Review $chromeSource '2 to add' '1 duplicate' '1 unsupported link'
    Confirm-Bookmarks @() 'Installer route review leaves library unchanged' $installerRoute '2 to add'
    Invoke-Button 'Cancel'
    Confirm-ImportStatus 'Import canceled.'
    Confirm-Bookmarks @() 'Cancel leaves library unchanged' $installerRoute 'Import canceled.'
    Invoke-Button 'Review import'
    Confirm-Review $chromeSource '2 to add' '1 duplicate' '1 unsupported link'
    Invoke-Button 'Add 2 bookmarks'
    Confirm-ImportStatus 'Imported 2 bookmarks.'
    Confirm-Bookmarks $expectedProfile 'Installer route profile confirmation' $installerRoute 'Imported 2 bookmarks.'
    Stop-Quiver

    Reset-FixtureSession
    Start-Quiver
    Open-SettingsFromNewTab
    Import-HtmlFile
    Confirm-Review 'fixture bookmarks.html' '1 to add' '1 duplicate' '1 unsupported link'
    Confirm-Bookmarks $expectedProfile 'Native HTML preview leaves earlier batch unchanged' $settingsRoute '1 to add'
    Invoke-Button 'Add 1 bookmark'
    Confirm-ImportStatus 'Imported 1 bookmark.'
    Confirm-Bookmarks $expectedAll 'Native HTML confirmation' $settingsRoute 'Imported 1 bookmark.'
    Import-HtmlFile
    Confirm-Review 'fixture bookmarks.html' '0 to add' '2 duplicates' '1 unsupported link'
    Confirm-ImportStatus 'No new bookmarks found.'
    $disabled = Find-Control (Get-QuiverWindow) 'Add bookmarks' ([Windows.Automation.ControlType]::Button)
    if (!$disabled -or $disabled.Current.IsEnabled) { throw 'A duplicate-only import must not be confirmable.' }
    Invoke-Button 'Cancel'
    Confirm-Bookmarks $expectedAll 'Duplicate-only review leaves library unchanged' $settingsRoute 'No new bookmarks found.'
    Stop-Quiver

    Start-Quiver
    Confirm-Route $settingsRoute
    Confirm-Bookmarks $expectedAll 'Committed imports persist after restart' $settingsRoute 'Last import added 1 bookmark.'
    Invoke-Button 'Undo this import'
    Confirm-ImportStatus 'Undid the import of 1 bookmark.'
    Confirm-Bookmarks $expectedProfile 'Undo removes only the most recent import' $settingsRoute 'Undid the import of 1 bookmark.'
    Stop-Quiver

    Start-Quiver
    Confirm-Route $settingsRoute
    Confirm-Bookmarks $expectedProfile 'Earlier profile batch and undo persist after restart' $settingsRoute ''
    if ((Read-State).bookmarkUndo) { throw 'The completed undo marker persisted after the batch was removed.' }
    Stop-Quiver
    Write-Evidence 'passed'
} catch {
    $failure = $_
    Write-Evidence 'failed' $failure.ToString()
    throw $failure
} finally {
    if ($script:appProcess) {
        if (!$script:appProcess.HasExited) {
            if (!$script:appProcess.CloseMainWindow() -or !$script:appProcess.WaitForExit(5000)) {
                if (!$script:appProcess.HasExited) { $script:appProcess.Kill($true) }
            }
        }
        $script:appProcess.Dispose()
    }
}
