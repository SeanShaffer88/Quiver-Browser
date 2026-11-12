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
    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    private struct ThreadInfo {
        public int Size;
        public uint Flags;
        public IntPtr Active, Focus, Capture, MenuOwner, MoveSize, Caret;
        public Rect CaretRect;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct MouseInput {
        public int X, Y;
        public uint Data, Flags, Time;
        public UIntPtr Extra;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct KeyInput {
        public ushort Key, Scan;
        public uint Flags, Time;
        public UIntPtr Extra;
    }
    [StructLayout(LayoutKind.Explicit)]
    private struct InputValue {
        [FieldOffset(0)] public MouseInput Mouse;
        [FieldOffset(0)] public KeyInput Key;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct Input {
        public uint Type;
        public InputValue Value;
    }

    [DllImport("user32")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32")] private static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32")] private static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32")] private static extern bool EnumWindows(WindowCallback callback, IntPtr state);
    [DllImport("user32")] private static extern bool EnumChildWindows(IntPtr window, WindowCallback callback, IntPtr state);
    [DllImport("user32")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32")] private static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32")] private static extern int GetDlgCtrlID(IntPtr window);
    [DllImport("user32")] private static extern IntPtr GetDlgItem(IntPtr window, int id);
    [DllImport("user32")] private static extern bool GetGUIThreadInfo(uint thread, ref ThreadInfo info);
    [DllImport("user32", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr window, StringBuilder text, int size);
    [DllImport("user32", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr window, StringBuilder text, int size);
    [DllImport("user32")] private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32")] private static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
    [DllImport("user32")] private static extern bool PostMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
    [DllImport("user32", EntryPoint = "SendMessageTimeoutW", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern IntPtr ReadText(IntPtr window, uint message, IntPtr capacity, StringBuilder text,
        uint flags, uint timeout, out IntPtr result);
    [DllImport("user32", EntryPoint = "SendMessageTimeoutW", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern IntPtr WriteText(IntPtr window, uint message, IntPtr unused, string text,
        uint flags, uint timeout, out IntPtr result);
    [DllImport("user32")] private static extern uint SendInput(uint count, Input[] inputs, int size);

    private delegate bool WindowCallback(IntPtr window, IntPtr state);

    private static string ClassName(IntPtr window) {
        var text = new StringBuilder(128);
        return GetClassName(window, text, text.Capacity) != 0 ? text.ToString() : "";
    }

    public static IntPtr FindDialog(uint processId, string title) {
        IntPtr result = IntPtr.Zero;
        EnumWindows((window, state) => {
            if (GetWindowThreadProcessId(window, out uint owner) == 0 || owner != processId ||
                !IsWindowVisible(window)) return true;
            if (ClassName(window) != "#32770") return true;
            var text = new StringBuilder(256);
            if (GetWindowText(window, text, text.Capacity) == 0 || text.ToString() != title) return true;
            result = window;
            return false;
        }, IntPtr.Zero);
        return result;
    }

    public static bool CloseDialog(uint processId, string title) {
        IntPtr dialog = FindDialog(processId, title);
        return dialog == IntPtr.Zero || PostMessage(dialog, 0x0010, IntPtr.Zero, IntPtr.Zero);
    }

    private static bool OwnedControl(IntPtr control, IntPtr dialog, uint processId) =>
        control != IntPtr.Zero && GetAncestor(control, 2) == dialog &&
        GetWindowThreadProcessId(control, out uint owner) != 0 && owner == processId &&
        IsWindowEnabled(control) && IsWindowVisible(control);

    private static bool TryReadControl(IntPtr control, out string value) {
        var text = new StringBuilder(1024);
        bool read = ReadText(control, 0x000D, (IntPtr)text.Capacity, text, 2, 250, out _) != IntPtr.Zero;
        value = read ? text.ToString() : "";
        return read;
    }

    public static bool SetFileName(uint processId, string title, string name, string stem, string target) {
        IntPtr dialog = FindDialog(processId, title);
        if (dialog == IntPtr.Zero) return false;
        IntPtr match = IntPtr.Zero;
        int matches = 0;
        EnumChildWindows(dialog, (control, state) => {
            if (ClassName(control) == "Edit" && OwnedControl(control, dialog, processId) &&
                TryReadControl(control, out string text) && (text == name || text == stem)) {
                match = control;
                matches++;
            }
            return matches < 2;
        }, IntPtr.Zero);
        return matches == 1 && OwnedControl(match, dialog, processId) &&
            WriteText(match, 0x000C, IntPtr.Zero, target, 2, 500, out _) != IntPtr.Zero &&
            TryReadControl(match, out string actual) && actual == target;
    }

    private static Input Key(ushort key, ushort scan = 0, uint flags = 0) =>
        new Input { Type = 1, Value = new InputValue { Key = new KeyInput { Key = key, Scan = scan, Flags = flags } } };

    private static bool SendKeys(Input[] keys) => SendInput((uint)keys.Length, keys, Marshal.SizeOf<Input>()) == keys.Length;

    public static bool FocusFileName(uint processId, string title) {
        IntPtr dialog = FindDialog(processId, title);
        // Alt+N selects the File name field in the English Common Item Dialog.
        return Focus(dialog, processId) && SendKeys(new[] { Key(0x12), Key(0x4E), Key(0x4E, flags: 2), Key(0x12, flags: 2) });
    }

    private static IntPtr FindFocusedFileName(uint processId, string title) {
        IntPtr dialog = FindDialog(processId, title);
        if (dialog == IntPtr.Zero || GetForegroundWindow() != dialog) return IntPtr.Zero;
        var info = new ThreadInfo { Size = Marshal.SizeOf<ThreadInfo>() };
        uint thread = GetWindowThreadProcessId(dialog, out _);
        return thread != 0 && GetGUIThreadInfo(thread, ref info) && OwnedControl(info.Focus, dialog, processId) &&
            ClassName(info.Focus) == "Edit" ? info.Focus : IntPtr.Zero;
    }

    public static bool TypeFileName(uint processId, string title, string name, string stem, string target) {
        IntPtr edit = FindFocusedFileName(processId, title);
        if (edit == IntPtr.Zero || !TryReadControl(edit, out string value) || (value != name && value != stem))
            return false;
        var keys = new Input[4 + target.Length * 2];
        keys[0] = Key(0x11);
        keys[1] = Key(0x41);
        keys[2] = Key(0x41, flags: 2);
        keys[3] = Key(0x11, flags: 2);
        for (int index = 0; index < target.Length; index++) {
            keys[4 + index * 2] = Key(0, target[index], 4);
            keys[5 + index * 2] = Key(0, target[index], 6);
        }
        return SendKeys(keys);
    }

    public static bool VerifyTypedFileName(uint processId, string title, string target) {
        IntPtr edit = FindFocusedFileName(processId, title);
        return edit != IntPtr.Zero && TryReadControl(edit, out string value) && value == target;
    }

    public static bool ClickSave(uint processId, string title) {
        IntPtr dialog = FindDialog(processId, title);
        if (!Focus(dialog, processId)) return false;
        IntPtr button = GetDlgItem(dialog, 1);
        return OwnedControl(button, dialog, processId) && ClassName(button) == "Button" &&
            TryReadControl(button, out string caption) && caption.TrimStart('&') == "Save" &&
            PostMessage(button, 0x00F5, IntPtr.Zero, IntPtr.Zero);
    }

    public static string DescribeDialog(uint processId, string title) {
        IntPtr dialog = FindDialog(processId, title);
        if (dialog == IntPtr.Zero) return "Owned dialog no longer present";
        var controls = new StringBuilder();
        int count = 0;
        EnumChildWindows(dialog, (control, state) => {
            if (OwnedControl(control, dialog, processId))
                controls.Append(ClassName(control)).Append('#').Append(GetDlgCtrlID(control)).Append(' ');
            return ++count < 40;
        }, IntPtr.Zero);
        return controls.ToString();
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
}
'@

function Get-PortableWindow([Diagnostics.Process]$Browser) {
    $Browser.Refresh()
    if ($Browser.HasExited) { throw "Owned Quiver exited early with $($Browser.ExitCode)." }
    if ($Browser.MainWindowHandle -ne [IntPtr]::Zero) {
        [Windows.Automation.AutomationElement]::FromHandle($Browser.MainWindowHandle)
    }
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

function Test-PortableSaveDialog([Diagnostics.Process]$Browser, [string]$Title) {
    if ($Browser.HasExited) { throw "Owned Quiver exited early with $($Browser.ExitCode)." }
    [QuiverPortableInput]::FindDialog($Browser.Id, $Title) -ne [IntPtr]::Zero
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
        $defaultTarget = Join-Path $downloads $test.name
        $useDefaultDestination = $test.folder -ieq $downloads
        $dialogTitle = "$Origin/portable-download?name=$($test.name)"
        if ((Test-Path -LiteralPath $target) -or (Test-Path -LiteralPath $defaultTarget)) {
            throw 'A portable download fixture already exists.'
        }
        Invoke-PortableClick $Browser $test.link ([Windows.Automation.ControlType]::Hyperlink)
        try {
            $null = Wait-For "the native Save As dialog for $($test.name)" { Test-PortableSaveDialog $Browser $dialogTitle }
            if (!$useDefaultDestination) {
                $stem = [IO.Path]::GetFileNameWithoutExtension($test.name)
                if (![QuiverPortableInput]::SetFileName($Browser.Id, $dialogTitle, $test.name, $stem, $target)) {
                    $null = Wait-For 'the owned Save As dialog to focus its File name field' {
                        [QuiverPortableInput]::FocusFileName($Browser.Id, $dialogTitle)
                    }
                    $null = Wait-For 'the verified native filename edit to accept the custom path' {
                        [QuiverPortableInput]::TypeFileName($Browser.Id, $dialogTitle, $test.name, $stem, $target)
                    }
                    $null = Wait-For 'the custom path to appear in the verified filename edit' {
                        [QuiverPortableInput]::VerifyTypedFileName($Browser.Id, $dialogTitle, $target)
                    }
                }
            }
            $null = Wait-For 'the owned native Save button to accept a click' {
                [QuiverPortableInput]::ClickSave($Browser.Id, $dialogTitle)
            }
            $null = Wait-For 'the owned native Save As dialog to close' { !(Test-PortableSaveDialog $Browser $dialogTitle) }
        } catch {
            Write-Warning "Owned Save As control classes and IDs: $([QuiverPortableInput]::DescribeDialog($Browser.Id, $dialogTitle))"
            if ([QuiverPortableInput]::CloseDialog($Browser.Id, $dialogTitle)) {
                try {
                    $null = Wait-For 'the failed Save As dialog to close' { !(Test-PortableSaveDialog $Browser $dialogTitle) } -Seconds 5
                } catch { Write-Warning $_.Exception.Message }
            }
            throw
        }

        $body = [Text.Encoding]::ASCII.GetBytes("Quiver portable download: $($test.name)" + [char]10)
        $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($body))
        $null = Wait-For "the exact downloaded bytes in $target" {
            if (Test-Path -LiteralPath $target -PathType Leaf) {
                try { (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ceq $hash } catch [IO.IOException] { }
            }
        }
        if (!$useDefaultDestination -and (Test-Path -LiteralPath $defaultTarget)) {
            throw 'The custom download unexpectedly also appeared at the default destination.'
        }
        [ordered]@{
            usedDefaultDestination = $useDefaultDestination
            savedPath = [IO.Path]::GetRelativePath($Root, $target)
            sha256 = $hash
        }
    }
    Write-Host 'PASS: native Save As saved exact bytes to Data/Downloads, the chosen folder, and then Data/Downloads again.'
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
