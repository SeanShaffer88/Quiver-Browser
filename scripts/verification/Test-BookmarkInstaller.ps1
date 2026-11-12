#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Setup,
    [Parameter(Mandatory)][string]$Workspace
)

$ErrorActionPreference = 'Stop'
if (!$IsWindows -or $env:GITHUB_ACTIONS -cne 'true' -or
    $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or !$env:RUNNER_TEMP) {
    throw 'This attended installer test requires a disposable GitHub-hosted Windows runner.'
}
$root = (Get-Item -LiteralPath $env:RUNNER_TEMP).FullName
$workspaceItem = Get-Item -LiteralPath $Workspace
$workspacePath = $workspaceItem.FullName
$relative = [IO.Path]::GetRelativePath($root, $workspacePath)
if (!$workspaceItem.PSIsContainer -or ($workspaceItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
    $relative -eq '.' -or [IO.Path]::IsPathRooted($relative) -or $relative -match '^\.\.([\\/]|$)') {
    throw 'The workspace must be an existing regular child directory of RUNNER_TEMP.'
}
$setupFile = Get-Item -LiteralPath $Setup
$setupSha256 = '962cab97ae034f5357c940bafdc412b19f5451e73e1c49937edbf82bb66e7f10'
if ($setupFile -isnot [IO.FileInfo] -or (Get-FileHash -LiteralPath $setupFile.FullName).Hash -ine $setupSha256) {
    throw 'The setup file differs from the published Quiver Beta 2 installer.'
}
$installDirectory = Join-Path $workspacePath 'Quiver'
$executablePath = Join-Path $installDirectory 'Quiver.exe'
if (Test-Path -LiteralPath $installDirectory) { throw 'The test installation directory already exists.' }

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;

public static class QuiverBookmarkWizard {
    private delegate bool Callback(IntPtr window, IntPtr state);
    [DllImport("user32")] private static extern bool EnumWindows(Callback callback, IntPtr state);
    [DllImport("user32")] private static extern bool EnumChildWindows(IntPtr window, Callback callback, IntPtr state);
    [DllImport("user32")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32")] private static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32")] private static extern IntPtr GetDlgItem(IntPtr window, int id);
    [DllImport("user32")] private static extern int GetDlgCtrlID(IntPtr window);
    [DllImport("user32", CharSet = CharSet.Unicode)]
    private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wparam, StringBuilder text, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32", CharSet = CharSet.Unicode)]
    private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wparam, IntPtr lparam, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32")] private static extern bool PostMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);

    private static string Text(IntPtr window) {
        var buffer = new StringBuilder(2048);
        return SendMessageTimeout(window, 0x000D, (IntPtr)buffer.Capacity, buffer, 2, 1000, out _) != IntPtr.Zero
            ? buffer.ToString() : "";
    }

    private static string Label(IntPtr window) {
        return Text(window).Replace("&", "").Trim().TrimEnd('>').Trim();
    }

    private static IntPtr FindWizard(int processId) {
        IntPtr match = IntPtr.Zero;
        EnumWindows((window, state) => {
            GetWindowThreadProcessId(window, out uint owner);
            if (owner != (uint)processId || !IsWindowVisible(window) || GetDlgItem(window, 1) == IntPtr.Zero)
                return true;
            match = window;
            return false;
        }, IntPtr.Zero);
        return match;
    }

    private static List<IntPtr> Children(IntPtr root) {
        var children = new List<IntPtr>();
        EnumChildWindows(root, (window, state) => {
            if (IsWindowVisible(window)) children.Add(window);
            return true;
        }, IntPtr.Zero);
        return children;
    }

    private static IntPtr Forward(IntPtr wizard, params string[] expected) {
        var button = GetDlgItem(wizard, 1);
        return button != IntPtr.Zero && IsWindowVisible(button) && IsWindowEnabled(button) &&
            expected.Contains(Label(button), StringComparer.OrdinalIgnoreCase) ? button : IntPtr.Zero;
    }

    private static void Advance(IntPtr wizard, IntPtr button) {
        if (!PostMessage(wizard, 0x0111, (IntPtr)1, button))
            throw new InvalidOperationException("Could not advance the owned Quiver setup wizard.");
    }

    private static int ButtonMessage(IntPtr control, uint message) {
        if (SendMessageTimeout(control, message, IntPtr.Zero, IntPtr.Zero, 2, 1000, out var result) == IntPtr.Zero)
            throw new InvalidOperationException("Could not operate a Quiver setup checkbox.");
        return result.ToInt32();
    }

    private static int CheckState(IntPtr control) => ButtonMessage(control, 0x00F0);

    public static bool TryDirectory(int processId, string directory) {
        var wizard = FindWizard(processId);
        if (wizard == IntPtr.Zero) return false;
        var edits = Children(wizard).Where(control => GetDlgCtrlID(control) == 1019).ToArray();
        if (edits.Length != 1) return false;
        var button = Forward(wizard, "Next", "Install");
        if (button == IntPtr.Zero) return false;
        string current = Text(edits[0]);
        if (!string.Equals(current.TrimEnd('\\'), directory.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Unexpected Quiver installation directory: " + current);
        Advance(wizard, button);
        return true;
    }

    public static bool TryImport(int processId) {
        var wizard = FindWizard(processId);
        if (wizard == IntPtr.Zero) return false;
        var children = Children(wizard);
        var import = children.Where(c => Label(c) == "Import bookmarks from another browser").ToArray();
        if (import.Length == 0) return false;
        var defaults = children.Where(c => Label(c) == "Open Windows Default Apps after setup").ToArray();
        var startup = children.Where(c => Label(c) == "Launch Quiver when I sign in").ToArray();
        var button = Forward(wizard, "Install", "Next");
        if (import.Length != 1 || defaults.Length != 1 || startup.Length != 1 || button == IntPtr.Zero)
            throw new InvalidOperationException("The Quiver options page did not expose the expected current-user choices.");
        if (CheckState(import[0]) != 0 || CheckState(defaults[0]) != 0 || CheckState(startup[0]) != 0)
            throw new InvalidOperationException("Fresh Quiver setup did not present all options unchecked.");
        if (!IsWindowEnabled(import[0]))
            throw new InvalidOperationException("The Quiver setup import checkbox was disabled.");
        ButtonMessage(import[0], 0x00F5); // BM_CLICK
        if (CheckState(import[0]) != 1 || CheckState(defaults[0]) != 0 || CheckState(startup[0]) != 0)
            throw new InvalidOperationException("The Quiver setup import-only selection did not hold.");
        Advance(wizard, button);
        return true;
    }

    public static bool TryFinish(int processId) {
        var wizard = FindWizard(processId);
        if (wizard == IntPtr.Zero) return false;
        var button = Forward(wizard, "Finish");
        if (button == IntPtr.Zero) return false;
        Advance(wizard, button);
        return true;
    }

    public static string VisibleLabels(int processId) {
        var wizard = FindWizard(processId);
        if (wizard == IntPtr.Zero) return "(no owned wizard window)";
        return string.Join(" | ", Children(wizard).Select(Label).Where(label => label.Length > 0).Take(30));
    }
}
'@

$handoff = [ordered]@{
    setupSha256 = $setupSha256
    directoryConfirmed = $false
    importChecked = $false
    defaultBrowserChecked = $false
    startupChecked = $false
    installerExit = $null
    executablePath = $executablePath
    appPid = $null
    importLaunchArgument = $false
}
$handoffPath = Join-Path $workspacePath 'installer-handoff.json'
$start = [Diagnostics.ProcessStartInfo]::new($setupFile.FullName)
$start.UseShellExecute = $false
$start.WorkingDirectory = $workspacePath
# NSIS requires raw unquoted /D= as the final argument, even for a path with spaces.
$start.Arguments = "/currentuser /D=$installDirectory"
$installer = [Diagnostics.Process]::Start($start)
try {
    foreach ($stage in 'directory','import','finish') {
        $timer = [Diagnostics.Stopwatch]::StartNew()
        do {
            if ($installer.HasExited) { throw "Quiver setup exited $($installer.ExitCode) before $stage." }
            $advanced = switch ($stage) {
                'directory' { [QuiverBookmarkWizard]::TryDirectory($installer.Id, $installDirectory) }
                'import' { [QuiverBookmarkWizard]::TryImport($installer.Id) }
                'finish' { [QuiverBookmarkWizard]::TryFinish($installer.Id) }
            }
            if (!$advanced) { Start-Sleep -Milliseconds 200 }
        } until ($advanced -or $timer.Elapsed.TotalSeconds -ge 60)
        if (!$advanced) { throw "Timed out at Quiver setup $stage. $([QuiverBookmarkWizard]::VisibleLabels($installer.Id))" }
        if ($stage -eq 'directory') { $handoff.directoryConfirmed = $true }
        if ($stage -eq 'import') { $handoff.importChecked = $true }
        Write-Host "Quiver setup advanced past $stage."
    }
    if (!$installer.WaitForExit(15000)) { throw 'Quiver setup did not exit after Finish.' }
    $handoff.installerExit = $installer.ExitCode
    if ($installer.ExitCode -ne 0) { throw "Quiver setup exited $($installer.ExitCode)." }
    if (!(Test-Path -LiteralPath $executablePath -PathType Leaf)) { throw 'The installed Quiver executable is missing.' }

    $timer = [Diagnostics.Stopwatch]::StartNew()
    do {
        $app = Get-CimInstance Win32_Process -Filter "Name = 'Quiver.exe'" |
            Where-Object {
                $_.ExecutablePath -ieq $executablePath -and
                $_.CommandLine -match '(?:^|\s)--import-bookmarks(?:\s|$)' -and
                $_.CommandLine -notmatch '(?:^|\s)--type='
            } | Select-Object -First 1
        if (!$app) { Start-Sleep -Milliseconds 250 }
    } until ($app -or $timer.Elapsed.TotalSeconds -ge 25)
    if (!$app) { throw 'No installed Quiver main process launched with --import-bookmarks after setup.' }
    $handoff.appPid = [int]$app.ProcessId
    $handoff.importLaunchArgument = $true
    Write-Host "PASS: attended setup selected only bookmark import and launched the installed Quiver process $($app.ProcessId)."
} catch {
    $handoff.error = $_.Exception.Message
    throw
} finally {
    if (!$installer.HasExited) { $installer.Kill($true) }
    $installer.Dispose()
    $handoff | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $handoffPath -Encoding utf8
}
