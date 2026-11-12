#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Installer,
    [Parameter(Mandatory)][ValidatePattern('\A[0-9a-fA-F]{64}\z')][string]$AsarSha256
)

$ErrorActionPreference = 'Stop'
if (!$IsWindows -or $env:GITHUB_ACTIONS -cne 'true' -or
    $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
    [string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
    throw 'This installer test requires a disposable GitHub-hosted Windows runner.'
}
$artifact = Get-Item -LiteralPath $Installer
if ($artifact -isnot [IO.FileInfo] -or $artifact.Name -notlike 'QuiverPortable_*_English.paf.exe') {
    throw 'Expected a Quiver PortableApps installer.'
}

$runnerTemp = (Get-Item -LiteralPath $env:RUNNER_TEMP).FullName
$destination = Join-Path $runnerTemp ('Quiver portable ' + [guid]::NewGuid().ToString('N'))
$package = Join-Path $destination 'QuiverPortable'
$profileDir = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Quiver'
$startupPaths = @('Startup','CommonStartup') | ForEach-Object {
    Join-Path ([Environment]::GetFolderPath($_)) 'Quiver Browser.lnk'
}
$registrationPaths = foreach ($hive in 'HKCU:','HKLM:','HKLM:\Software\WOW6432Node') {
    $software = if ($hive.EndsWith(':')) { "$hive\Software" } else { $hive }
    "$software\Clients\StartMenuInternet\Quiver"
    "$software\Classes\Quiver.Url"
}

function Get-HostState {
    $keys = foreach ($path in $registrationPaths) {
        $key = Get-Item -LiteralPath $path -ErrorAction SilentlyContinue
        if ($null -ne $key) {
            [ordered]@{ path = $path; keys = $key.GetSubKeyNames(); values = @($key.GetValueNames() | ForEach-Object { $key.GetValue($_) }) }
        }
    }
    $browserValues = foreach ($path in 'HKCU:\Software\RegisteredApplications','HKLM:\Software\RegisteredApplications','HKLM:\Software\WOW6432Node\RegisteredApplications') {
        $key = Get-Item -LiteralPath $path -ErrorAction SilentlyContinue
        $value = if ($null -ne $key) { $key.GetValue('Quiver') }
        [ordered]@{ path = $path; value = $value }
    }
    $choices = foreach ($protocol in 'http','https') {
        $key = Get-ItemProperty -LiteralPath "HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\$protocol\UserChoice" -ErrorAction SilentlyContinue
        [ordered]@{ protocol = $protocol; progId = $key.ProgId; hash = $key.Hash }
    }
    $startup = foreach ($path in $startupPaths) {
        if (Test-Path -LiteralPath $path -PathType Leaf) { (Get-FileHash -LiteralPath $path).Hash }
    }
    $profileState = Join-Path $profileDir 'quiver-state.json'
    $profileHash = if (Test-Path -LiteralPath $profileState -PathType Leaf) { (Get-FileHash -LiteralPath $profileState).Hash }
    [ordered]@{ keys = @($keys); browsers = @($browserValues); choices = @($choices); startup = @($startup); profileExists = Test-Path -LiteralPath $profileDir; profileHash = $profileHash } |
        ConvertTo-Json -Depth 6 -Compress
}

# MUI2 assigns ID 1 to Next/Install/Finish and ID 1019 to the destination edit.
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class QuiverPortableWizard {
    private delegate bool WindowCallback(IntPtr window, IntPtr state);
    [DllImport("user32")] private static extern bool EnumWindows(WindowCallback callback, IntPtr state);
    [DllImport("user32")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32")] private static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32")] private static extern IntPtr GetDlgItem(IntPtr window, int id);
    [DllImport("user32", CharSet = CharSet.Unicode)] private static extern IntPtr FindWindowEx(IntPtr window, IntPtr after, string className, string title);
    [DllImport("user32", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wparam, StringBuilder text, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32", SetLastError = true)]
    private static extern bool PostMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);

    private static string Text(IntPtr window) {
        var buffer = new StringBuilder(2048);
        return window != IntPtr.Zero && SendMessageTimeout(window, 0x000D, (IntPtr)buffer.Capacity, buffer, 2, 1000, out _) != IntPtr.Zero
            ? buffer.ToString() : "";
    }
    public static bool TryAdvance(int processId, string step, string destination) {
        IntPtr found = IntPtr.Zero;
        IntPtr button = IntPtr.Zero;
        EnumWindows((window, state) => {
            GetWindowThreadProcessId(window, out uint owner);
            if (owner != (uint)processId || !IsWindowVisible(window)) return true;
            IntPtr next = GetDlgItem(window, 1);
            if (next == IntPtr.Zero || !IsWindowEnabled(next) || !IsWindowVisible(next)) return true;
            if (!string.Equals(Text(next).Replace("&", "").Trim().TrimEnd('>').Trim(), step, StringComparison.OrdinalIgnoreCase)) return true;
            found = window;
            button = next;
            return false;
        }, IntPtr.Zero);
        if (found == IntPtr.Zero) return false;
        if (step == "Install") {
            IntPtr page = FindWindowEx(found, IntPtr.Zero, "#32770", null);
            string actual = Text(GetDlgItem(page, 1019));
            if (!string.Equals(actual.TrimEnd('\\'), destination.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Unexpected PortableApps destination: " + actual);
        }
        if (!PostMessage(found, 0x0111, (IntPtr)1, button))
            throw new InvalidOperationException("Could not advance the PortableApps installer.");
        return true;
    }
}
"@
function Install-Package {
    $info = [Diagnostics.ProcessStartInfo]::new($artifact.FullName)
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.WorkingDirectory = $destination
    # The official installer appends its AppID to this parent path.
    $info.Arguments = '/DESTINATION="' + $destination + '\"'
    $process = [Diagnostics.Process]::Start($info)
    try {
        foreach ($step in 'Next','Install','Finish') {
            $watch = [Diagnostics.Stopwatch]::StartNew()
            while (![QuiverPortableWizard]::TryAdvance($process.Id, $step, $package)) {
                if ($process.HasExited) { throw "PortableApps exited $($process.ExitCode) before $step." }
                if ($watch.Elapsed.TotalSeconds -ge 120) { throw "Timed out waiting for PortableApps $step." }
                Start-Sleep -Milliseconds 250
            }
            Write-Host "PortableApps wizard accepted $step."
        }
        if (!$process.WaitForExit(10000)) { throw 'PortableApps installer did not finish after its Finish page.' }
        Write-Host "PortableApps installer exited $($process.ExitCode)."
        if ($process.ExitCode -ne 0) { throw 'PortableApps installation failed.' }
    } finally {
        if (!$process.HasExited) { $process.Kill($true) }
        $process.Dispose()
    }

    foreach ($relative in 'QuiverPortable.exe','App/Quiver/Quiver.exe','App/AppInfo/appinfo.ini','App/Quiver/resources/app.asar') {
        if (!(Test-Path -LiteralPath (Join-Path $package $relative) -PathType Leaf)) { throw "Missing installed file $relative." }
    }
    if ((Get-FileHash -LiteralPath (Join-Path $package 'App/Quiver/resources/app.asar')).Hash -ine $AsarSha256) {
        throw 'Installed PortableApps ASAR differs from the build output.'
    }
}

$before = Get-HostState
$null = New-Item -ItemType Directory -Path $destination
Install-Package
$marker = Join-Path $package 'Data/quiver-state.json'
$markerContent = '{"version":1,"spaces":[{"id":"space-paf-test","name":"Portable upgrade fixture","color":"#5b8cff","isolated":false}],"activeSpaceId":"space-paf-test","settings":{"devServerScan":false}}'
Set-Content -LiteralPath $marker -Value $markerContent -Encoding utf8
$markerHash = (Get-FileHash -LiteralPath $marker).Hash
Install-Package
if ((Get-FileHash -LiteralPath $marker).Hash -ine $markerHash) { throw 'Reinstallation changed the portable Data profile.' }
if ((Get-HostState) -cne $before) { throw 'Installation changed scoped host browser, startup, or installed-profile state.' }
Write-Host 'PASS: PortableApps installation and reinstallation, expected payload digest, Data preservation, and scoped Windows state.'
