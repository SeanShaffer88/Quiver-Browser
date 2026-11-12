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
$statePath = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Quiver\quiver-state.json'
$evidencePath = Join-Path $workspacePath 'settings-e2e.json'
$expectedProfile = @(
    @{ title = 'Quiver fixture profile one'; url = 'https://example.invalid/chrome-one' }
    @{ title = 'Quiver fixture profile two'; url = 'https://example.invalid/chrome-two' }
)
$expectedAll = $expectedProfile + @{ title = 'Quiver fixture export & one'; url = 'https://example.invalid/html-one' }
$installerRoute = 'quiver://app/settings.html?import=bookmarks'
$settingsRoute = 'quiver://app/settings.html'
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
        if ($window.Current.Name -eq 'Open' -and $window.Current.ClassName -eq '#32770') { return $window }
        $dialog = Find-Control $window 'Open' ([Windows.Automation.ControlType]::Window)
        if ($dialog -and $dialog.Current.ProcessId -eq $script:appProcess.Id -and $dialog.Current.ClassName -eq '#32770') {
            return $dialog
        }
    }
}

function Import-HtmlFile {
    Invoke-Button 'Import HTML file'
    $dialog = Wait-For 'owned Windows Open file dialog' { Get-OpenDialog }
    $fileEdit = [Windows.Automation.ControlType]::Edit
    $fileNameField = Wait-For 'File name field in Open dialog' {
        $edit = Find-Control $dialog 'File name:' $fileEdit
        if ($edit) { return $edit }
        $hostField = Find-Control -Root $dialog -AutomationId 'FileNameControlHost'
        if (!$hostField) { $hostField = Find-Control -Root $dialog -AutomationId '1148' }
        if ($hostField -and $hostField.Current.ControlType -eq $fileEdit) { return $hostField }
        if ($hostField) { Find-Control -Root $hostField -Type $fileEdit }
    }
    $fileNameField.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).SetValue($htmlFile)
    $open = Find-Control $dialog 'Open' ([Windows.Automation.ControlType]::Button)
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
            controls = @($elements | Select-Object -First 100 | ForEach-Object {
                [ordered]@{ name = $_.Current.Name; type = $_.Current.ControlType.ProgrammaticName; id = $_.Current.AutomationId }
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

    Start-Quiver
    Invoke-Button 'Settings'
    Confirm-Route $settingsRoute
    Import-HtmlFile
    Confirm-ImportStatus 'Imported 1 bookmark.'
    Confirm-Bookmarks $expectedAll 'Settings HTML import' $settingsRoute 'Imported 1 bookmark.'

    Import-HtmlFile
    Confirm-ImportStatus 'No new bookmarks found.'
    Confirm-Bookmarks $expectedAll 'Settings repeated HTML import' $settingsRoute 'No new bookmarks found.'
    Stop-Quiver

    Start-Quiver
    Invoke-Button 'Settings'
    Confirm-Route $settingsRoute
    Confirm-Bookmarks $expectedAll 'Quiver restart' $settingsRoute
    Stop-Quiver

    [ordered]@{ passed = $true; steps = $steps.ToArray() } |
        ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $evidencePath -Encoding UTF8
} catch {
    $failure = $_
    $diagnostics = try { @(Get-UiDiagnostics) } catch { @() }
    [ordered]@{ passed = $false; error = $failure.ToString(); steps = $steps.ToArray(); ui = $diagnostics } |
        ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $evidencePath -Encoding UTF8
    throw $failure
} finally {
    if ($script:appProcess -and !$script:appProcess.HasExited) {
        $null = $script:appProcess.CloseMainWindow()
    }
}
