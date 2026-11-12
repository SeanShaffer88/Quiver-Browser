#requires -Version 5.1
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Workspace)

$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
    [Environment]::OSVersion.Platform -ne 'Win32NT' -or
    [Threading.Thread]::CurrentThread.GetApartmentState() -ne 'STA') {
    throw 'This UI test requires a disposable GitHub-hosted Windows runner and an STA PowerShell process.'
}
$workspacePath = (Get-Item -LiteralPath $Workspace).FullName
$runnerTemp = (Get-Item -LiteralPath $env:RUNNER_TEMP).FullName.TrimEnd('\') + '\'
if (!$workspacePath.StartsWith($runnerTemp, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The test workspace must be inside RUNNER_TEMP.'
}

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
$statePath = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Quiver\quiver-state.json'
$evidencePath = Join-Path $workspacePath 'settings-e2e.json'
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
        Get-Content -LiteralPath $statePath -Encoding UTF8 -Raw | ConvertFrom-Json
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

function Open-SettingsFromNewTab {
    $null = Wait-For 'fresh New Tab route before the Settings click' {
        (Get-ActiveRoute (Read-State)) -ceq $newTabRoute
    }
    $null = Wait-For 'Settings gear to open the Settings route' {
        $route = Get-ActiveRoute (Read-State)
        if ($route -ceq $settingsRoute) { return $true }
        if ($route -cne $newTabRoute) { return }
        $window = Get-QuiverWindow
        $button = Find-Control $window 'Settings' ([Windows.Automation.ControlType]::Button)
        if (!$button -or !$button.Current.IsEnabled -or $button.Current.IsOffscreen) { return }
        $bounds = $button.Current.BoundingRectangle
        if ($bounds.IsEmpty -or $bounds.Width -le 0 -or $bounds.Height -le 0) { return }
        $x = [int]($bounds.X + $bounds.Width / 2)
        $y = [int]($bounds.Y + $bounds.Height / 2)
        if ([QuiverTestInput]::Click([IntPtr]$window.Current.NativeWindowHandle, $script:appProcess.Id, $x, $y)) {
            Start-Sleep -Milliseconds 900
        }
    }
    Confirm-Route $settingsRoute
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
        if ($expand.Current.ExpandCollapseState -eq [Windows.Automation.ExpandCollapseState]::Expanded) {
            $expand.Collapse()
        }
    } else {
        $option.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
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
    Invoke-Button 'Import HTML file'
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

function Start-Quiver {
    $script:appProcess = Start-Process -FilePath $exePath -ArgumentList '--force-renderer-accessibility' -PassThru
    $null = Wait-For 'owned Quiver window' { Get-QuiverWindow }
}

function Get-UiDiagnostics {
    if (!$script:appProcess -or $script:appProcess.HasExited) { return }
    $rows = [Collections.Generic.List[object]]::new()
    foreach ($window in Get-OwnedWindows) {
        $elements = $window.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
        $rows.Add([ordered]@{
            window = $window.Current.Name
            class = $window.Current.ClassName
            processId = $window.Current.ProcessId
            controls = @($elements | Select-Object -First 100 | ForEach-Object {
                [ordered]@{
                    name = $_.Current.Name
                    type = $_.Current.ControlType.ProgrammaticName
                    id = $_.Current.AutomationId
                    class = $_.Current.ClassName
                    processId = $_.Current.ProcessId
                }
            })
        })
    }
    $rows.ToArray()
}

try {
    $handoff = Get-Content -LiteralPath (Join-Path $workspacePath 'installer-handoff.json') -Encoding UTF8 -Raw | ConvertFrom-Json
    if ($handoff.installerExit -ne 0) { throw 'The setup handoff did not record a successful installer exit.' }
    $exePath = (Get-Item -LiteralPath $handoff.executablePath).FullName
    if (!$exePath.StartsWith(($workspacePath.TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($exePath) -ine 'Quiver.exe') {
        throw 'The handoff did not identify a Quiver executable inside the test workspace.'
    }
    $htmlFile = (Get-Item -LiteralPath (Join-Path $workspacePath 'bookmarks.html')).FullName
    $process = Get-Process -Id ([int]$handoff.appPid)
    if ($process.MainModule.FileName -ine $exePath) { throw 'The handoff PID does not belong to the installed executable.' }
    $null = $process.Handle
    $script:appProcess = $process

    Confirm-Route $installerRoute
    Open-ChromeProfile
    Invoke-Button 'Import from browser'
    Confirm-ImportStatus 'Imported 2 bookmarks.'
    Confirm-Bookmarks $expectedProfile 'Installer-launched Chrome import' $installerRoute 'Imported 2 bookmarks.'
    Stop-Quiver

    Reset-FixtureSession
    Start-Quiver
    Open-SettingsFromNewTab
    Import-HtmlFile
    Confirm-ImportStatus 'Imported 1 bookmark.'
    Confirm-Bookmarks $expectedAll 'Settings HTML import' $settingsRoute 'Imported 1 bookmark.'

    Import-HtmlFile
    Confirm-ImportStatus 'No new bookmarks found.'
    Confirm-Bookmarks $expectedAll 'Settings repeated HTML import' $settingsRoute 'No new bookmarks found.'
    Stop-Quiver

    Start-Quiver
    Confirm-Route $settingsRoute
    Confirm-Bookmarks $expectedAll 'Quiver restart' $settingsRoute
    Stop-Quiver

    [ordered]@{ passed = $true; steps = $steps.ToArray() } |
        ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $evidencePath -Encoding UTF8
} catch {
    $failure = $_
    $diagnostics = try { @(Get-UiDiagnostics) } catch { @() }
    $state = try { Read-State } catch { $null }
    [ordered]@{
        passed = $false
        error = $failure.ToString()
        steps = $steps.ToArray()
        activeRoute = Get-ActiveRoute $state
        tabs = $state.tabsBySpace
        ui = $diagnostics
    } |
        ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $evidencePath -Encoding UTF8
    throw $failure
} finally {
    if ($script:appProcess -and !$script:appProcess.HasExited) {
        $null = $script:appProcess.CloseMainWindow()
    }
}
