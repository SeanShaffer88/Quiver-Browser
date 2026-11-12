#requires -Version 7.0

if (!$IsWindows -or $env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
    [Threading.Thread]::CurrentThread.GetApartmentState() -ne 'STA') {
    throw 'Portable native verification requires STA on a disposable GitHub-hosted Windows runner.'
}

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class QuiverPortableInput {
    [StructLayout(LayoutKind.Sequential)]
    private struct Point { public int X, Y; }

    [DllImport("user32")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32")] private static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32")] private static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32")] private static extern bool EnumWindows(WindowCallback callback, IntPtr state);
    [DllImport("user32")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr window, StringBuilder text, int size);
    [DllImport("user32", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr window, StringBuilder text, int size);
    [DllImport("user32")] private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32")] private static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
    [DllImport("user32")] private static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);

    private delegate bool WindowCallback(IntPtr window, IntPtr state);

    public static IntPtr FindDialog(uint processId, string title) {
        IntPtr result = IntPtr.Zero;
        EnumWindows((window, state) => {
            if (GetWindowThreadProcessId(window, out uint owner) == 0 || owner != processId ||
                !IsWindowVisible(window)) return true;
            var text = new StringBuilder(256);
            if (GetClassName(window, text, text.Capacity) == 0 || text.ToString() != "#32770") return true;
            text.Clear();
            if (GetWindowText(window, text, text.Capacity) == 0 || text.ToString() != title) return true;
            result = window;
            return false;
        }, IntPtr.Zero);
        return result;
    }

    private static bool Focus(IntPtr window, uint processId) {
        if (window == IntPtr.Zero || GetWindowThreadProcessId(window, out uint owner) == 0 || owner != processId)
            return false;
        if (GetForegroundWindow() != window) SetForegroundWindow(window);
        return GetForegroundWindow() == window;
    }

    public static bool Click(IntPtr window, uint processId, int x, int y) {
        if (!Focus(window, processId) || GetAncestor(WindowFromPoint(new Point { X = x, Y = y }), 2) != window ||
            !SetCursorPos(x, y)) return false;
        mouse_event(2, 0, 0, 0, UIntPtr.Zero);
        mouse_event(4, 0, 0, 0, UIntPtr.Zero);
        return true;
    }

    public static bool ShowAddress(IntPtr window, uint processId) {
        if (!Focus(window, processId)) return false;
        keybd_event(0x11, 0, 0, UIntPtr.Zero);
        keybd_event(0x4C, 0, 0, UIntPtr.Zero);
        keybd_event(0x4C, 0, 2, UIntPtr.Zero);
        keybd_event(0x11, 0, 2, UIntPtr.Zero);
        return true;
    }

    public static bool CloseAddress(IntPtr window, uint processId) {
        if (!Focus(window, processId)) return false;
        keybd_event(0x1B, 0, 0, UIntPtr.Zero);
        keybd_event(0x1B, 0, 2, UIntPtr.Zero);
        return true;
    }
}
'@

function Get-PortableWindow([Diagnostics.Process]$Browser) {
    $Browser.Refresh()
    if ($Browser.HasExited) { throw "Owned Quiver exited early with $($Browser.ExitCode)." }
    if ($Browser.MainWindowHandle -ne [IntPtr]::Zero) {
        [Windows.Automation.AutomationElement]::FromHandle($Browser.MainWindowHandle)
    }
}

function Get-PortableControl($Root, $Property, [string]$Value) {
    if (!$Root) { return }
    $condition = [Windows.Automation.PropertyCondition]::new($Property, $Value)
    $Root.FindFirst([Windows.Automation.TreeScope]::Descendants, $condition)
}

function Get-PortableNamedControl([Diagnostics.Process]$Browser, [string]$Name, $Type) {
    try {
        $root = Get-PortableWindow $Browser
        if (!$root) { return }
        $nameCondition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, $Name)
        $typeCondition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, $Type)
        $condition = [Windows.Automation.AndCondition]::new($nameCondition, $typeCondition)
        $element = $root.FindFirst([Windows.Automation.TreeScope]::Descendants, $condition)
        if ($element -and !$element.Current.IsOffscreen -and $element.Current.IsEnabled) { $element }
    } catch [Windows.Automation.ElementNotAvailableException] {
        # The renderer can replace the automation tree while navigation is in progress.
    }
}

function Invoke-PortableClick([Diagnostics.Process]$Browser, [string]$Name, $Type) {
    $null = Wait-For "owned Quiver control '$Name' to accept a click" {
        $element = Get-PortableNamedControl $Browser $Name $Type
        if (!$element) { return }
        $rect = $element.Current.BoundingRectangle
        if ($rect.IsEmpty -or $rect.Width -lt 2 -or $rect.Height -lt 2) { return }
        [QuiverPortableInput]::Click($Browser.MainWindowHandle, $Browser.Id,
            [int]($rect.Left + $rect.Width / 2), [int]($rect.Top + $rect.Height / 2))
    }
}

function Get-PortableSaveDialog([Diagnostics.Process]$Browser, [string]$Title) {
    if ($Browser.HasExited) { throw "Owned Quiver exited early with $($Browser.ExitCode)." }
    $handle = [QuiverPortableInput]::FindDialog($Browser.Id, $Title)
    if ($handle -ne [IntPtr]::Zero) { [Windows.Automation.AutomationElement]::FromHandle($handle) }
}

function Get-PortableDialogFolder($Dialog, [int]$ProcessId) {
    $handle = [IntPtr]$Dialog.Current.NativeWindowHandle
    if (![QuiverPortableInput]::ShowAddress($handle, $ProcessId)) { throw 'Could not focus the owned Save As address bar.' }
    $folder = Wait-For 'the full folder in the Save As address bar' {
        try {
            $focused = [Windows.Automation.AutomationElement]::FocusedElement
            if (!$focused -or $focused.Current.ProcessId -ne $ProcessId -or
                $focused.Current.ControlType -ne [Windows.Automation.ControlType]::Edit) { return }
            $parent = $focused
            $walker = [Windows.Automation.TreeWalker]::RawViewWalker
            while ($parent -and $parent.Current.NativeWindowHandle -ne $handle.ToInt64()) {
                $parent = $walker.GetParent($parent)
            }
            if (!$parent) { return }
            $pattern = $null
            if (!$focused.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) { return }
            $value = $pattern.Current.Value
            if ($value -and [IO.Path]::IsPathFullyQualified($value)) { [IO.Path]::GetFullPath($value) }
        } catch [Windows.Automation.ElementNotAvailableException] {
            # Ctrl+L replaces the breadcrumb control with an edit.
        }
    }
    if (![QuiverPortableInput]::CloseAddress($handle, $ProcessId)) { throw 'Could not close the owned Save As address edit.' }
    $folder
}

function Invoke-PortableSaveAs([Diagnostics.Process]$Browser, [string]$Root, [string]$Origin) {
    if ($Origin -notmatch '\Ahttp://127\.0\.0\.1:\d{1,5}\z') { throw 'Invalid local download fixture origin.' }
    $downloads = Join-Path $Root 'Data/Downloads'
    $chosenFolder = Join-Path $downloads 'Chosen Folder'
    $null = New-Item -ItemType Directory -Path $chosenFolder
    $tests = @(
        @{ link = 'Quiver Default Download'; name = 'quiver-default.txt'; folder = $downloads },
        @{ link = 'Quiver Custom Download'; name = 'quiver-custom.txt'; folder = $chosenFolder },
        @{ link = 'Quiver Reopened Download'; name = 'quiver-reopened.txt'; folder = $downloads }
    )
    $proof = foreach ($test in $tests) {
        $target = Join-Path $test.folder $test.name
        $dialogTitle = "$Origin/portable-download?name=$($test.name)"
        if (Test-Path -LiteralPath $target) { throw 'A portable download fixture already exists.' }
        Invoke-PortableClick $Browser $test.link ([Windows.Automation.ControlType]::Hyperlink)
        $dialog = Wait-For "the native Save As dialog for $($test.name)" { Get-PortableSaveDialog $Browser $dialogTitle }
        $initialFolder = Get-PortableDialogFolder $dialog $Browser.Id
        if ($initialFolder -ine [IO.Path]::GetFullPath($downloads)) {
            throw "Save As opened in '$initialFolder' instead of portable Data/Downloads."
        }

        $fileEdit = Wait-For 'the Save As file name field' {
            try {
                $element = Get-PortableControl $dialog ([Windows.Automation.AutomationElement]::AutomationIdProperty) '1001'
                if ($element -and $element.Current.ControlType -eq [Windows.Automation.ControlType]::Edit) {
                    $element.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
                }
            } catch [Windows.Automation.ElementNotAvailableException] { }
        }
        $initialName = $fileEdit.Current.Value
        if ($initialName -cne $test.name -and $initialName -cne [IO.Path]::GetFileNameWithoutExtension($test.name)) {
            throw "Save As suggested '$initialName' instead of '$($test.name)'."
        }
        if ($test.folder -ine $downloads) { $fileEdit.SetValue($target) }
        $save = Get-PortableControl $dialog ([Windows.Automation.AutomationElement]::AutomationIdProperty) '1'
        if (!$save -or $save.Current.Name.TrimStart('&') -cne 'Save' -or !$save.Current.IsEnabled) {
            throw 'Could not identify the enabled Save button in the owned dialog.'
        }
        $save.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()

        $body = [Text.Encoding]::ASCII.GetBytes("Quiver portable download: $($test.name)" + [char]10)
        $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($body))
        $null = Wait-For "the exact downloaded bytes in $target" {
            if (Test-Path -LiteralPath $target -PathType Leaf) {
                try { (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ceq $hash } catch [IO.IOException] { }
            }
        }
        if (Get-PortableSaveDialog $Browser $dialogTitle) { throw 'Save As remained open after saving.' }
        [ordered]@{
            initialFolder = [IO.Path]::GetRelativePath($Root, $initialFolder)
            initialName = $initialName
            savedPath = [IO.Path]::GetRelativePath($Root, $target)
            sha256 = $hash
        }
    }
    Write-Host 'PASS: native Save As started in Data/Downloads, saved exact bytes to the chosen destination, and reopened in Data/Downloads.'
    [ordered]@{ dialog = 'Save As'; downloads = @($proof) }
}

function Invoke-PortableCrashDump([string]$Root, [string]$Origin) {
    if ($Origin -notmatch '\Ahttp://127\.0\.0\.1:\d{1,5}\z') { throw 'Invalid local crash fixture origin.' }
    $exe = (Get-Item -LiteralPath (Join-Path $Root 'App/Quiver/Quiver.exe')).FullName
    $data = Join-Path $Root 'Data'
    $dumpFolder = Join-Path $data 'CrashDumps'
    $activePortFile = Join-Path $data 'DevToolsActivePort'
    if (Test-Path -LiteralPath $activePortFile) { throw 'The crash fixture requires an unused DevTools port record.' }
    $existing = @(Get-ChildItem -LiteralPath $dumpFolder -Filter '*.dmp' -File -Recurse | Select-Object -ExpandProperty FullName)
    $url = "$Origin/portable-crash"
    $info = [Diagnostics.ProcessStartInfo]::new($exe)
    $info.UseShellExecute = $false
    $info.WorkingDirectory = $data
    $info.Environment['PORTABLE_EXECUTABLE_DIR'] = $Root
    $info.Environment['TEMP'] = Join-Path $data 'Temp'
    $info.Environment['TMP'] = Join-Path $data 'Temp'
    $info.Environment['ELECTRON_LOG_FILE'] = Join-Path $data 'Logs/electron.log'
    foreach ($argument in "--user-data-dir=$data", '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--', $url) {
        $info.ArgumentList.Add($argument)
    }
    $outside = Join-Path $env:RUNNER_TEMP ('quiver-crash-sentinel-' + [guid]::NewGuid().ToString('N'))
    $null = New-Item -ItemType Directory -Path $outside
    $info.Environment['BREAKPAD_DUMP_LOCATION'] = $outside
    $browser = $null
    $socket = [Net.WebSockets.ClientWebSocket]::new()
    try {
        $browser = [Diagnostics.Process]::Start($info)
        $port = Wait-For 'the owned loopback DevTools listener for the crash fixture' {
            if ($browser.HasExited) { throw "Crash fixture browser exited with $($browser.ExitCode)." }
            if (!(Test-Path -LiteralPath $activePortFile -PathType Leaf)) { return }
            $portText = Get-Content -LiteralPath $activePortFile -TotalCount 1
            if ($portText -notmatch '\A[1-9]\d{0,4}\z' -or [int]$portText -gt 65535) { return }
            $listeners = @(Get-NetTCPConnection -OwningProcess $browser.Id -LocalPort ([int]$portText) -State Listen -ErrorAction SilentlyContinue)
            if ($listeners.Count -eq 1 -and $listeners[0].LocalAddress -ceq '127.0.0.1') { [int]$portText }
        }
        $target = Wait-For 'the exact loopback fixture renderer in the owned browser' {
            $pages = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/list" -NoProxy -TimeoutSec 3
            $targets = @($pages | Where-Object { $_.type -ceq 'page' -and $_.url -ceq $url })
            if ($targets.Count -eq 1 -and $targets[0].id -match '\A[0-9a-fA-F]{32}\z') { $targets[0] }
        }
        $endpoint = "ws://127.0.0.1:$port/devtools/page/$($target.id)"
        if ($target.webSocketDebuggerUrl -cne $endpoint) { throw 'The DevTools page advertised an unexpected socket endpoint.' }
        $deadline = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(10))
        try {
            [void]$socket.ConnectAsync([Uri]$endpoint, $deadline.Token).GetAwaiter().GetResult()
            $command = [ArraySegment[byte]]::new([Text.Encoding]::UTF8.GetBytes('{"id":1,"method":"Page.crash"}'))
            [void]$socket.SendAsync($command, [Net.WebSockets.WebSocketMessageType]::Text, $true, $deadline.Token).GetAwaiter().GetResult()
        } finally {
            $deadline.Dispose()
        }
        $dump = Wait-For 'a new valid minidump under portable Data/CrashDumps' {
            foreach ($item in Get-ChildItem -LiteralPath $dumpFolder -Filter '*.dmp' -File -Recurse) {
                if ($existing -contains $item.FullName -or $item.Length -le 32 -or
                    ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { continue }
                try {
                    $stream = [IO.File]::Open($item.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
                    try {
                        $header = [byte[]]::new(4)
                        $count = $stream.Read($header, 0, $header.Length)
                    } finally { $stream.Dispose() }
                    if ($count -eq 4 -and [Text.Encoding]::ASCII.GetString($header) -ceq 'MDMP') { return $item }
                } catch [IO.IOException] { }
            }
        } -Seconds 45
        Invoke-PortableClick $browser 'Retry stopped page' ([Windows.Automation.ControlType]::Button)
        $null = Wait-For 'the recovered loopback fixture after clicking Retry' {
            Get-PortableNamedControl $browser 'Quiver portable crash fixture' ([Windows.Automation.ControlType]::Text)
        }
        if (!$browser.CloseMainWindow() -or !$browser.WaitForExit(15000) -or $browser.ExitCode -ne 0) {
            throw 'The portable browser did not exit cleanly after renderer recovery.'
        }
        if (Get-ChildItem -LiteralPath $outside -Force) { throw 'Crashpad wrote to the inherited host dump location.' }
        Write-Host 'PASS: the exact packaged browser captured a local renderer minidump and retried the stopped page.'
        [ordered]@{
            trigger = 'Page.crash on owned loopback fixture'
            dump = [IO.Path]::GetRelativePath($Root, $dump.FullName)
            length = $dump.Length
            signature = 'MDMP'
            retryRestoredFixture = $true
            inheritedHostLocationUnchanged = $true
            browserExit = $browser.ExitCode
        }
    } finally {
        $socket.Dispose()
        if ($browser) {
            if (!$browser.HasExited) { $browser.Kill($true); [void]$browser.WaitForExit(5000) }
            $browser.Dispose()
        }
        if (Test-Path -LiteralPath $activePortFile -PathType Leaf) { Remove-Item -LiteralPath $activePortFile }
        if (!(Get-ChildItem -LiteralPath $outside -Force)) { [IO.Directory]::Delete($outside, $false) }
    }
}
