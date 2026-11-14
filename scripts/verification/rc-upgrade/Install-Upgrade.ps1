#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('nsis','paf')][string]$Mode,
    [Parameter(Mandatory)][string]$Rc1Installer,
    [Parameter(Mandatory)][string]$Rc2Installer,
    [Parameter(Mandatory)][string]$Destination,
    [string]$RuntimeScript = (Join-Path $PSScriptRoot 'runtime.cjs'),
    [string]$ResumeScript = (Join-Path $PSScriptRoot 'resume.cjs')
)

$ErrorActionPreference = 'Stop'
if (!$IsWindows -or $env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
    [string]::IsNullOrWhiteSpace($env:RUNNER_TEMP) -or
    [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
    throw 'This test requires a disposable GitHub-hosted Windows x64 runner.'
}

$runnerTemp = (Get-Item -LiteralPath $env:RUNNER_TEMP).FullName
$destinationPath = [IO.Path]::GetFullPath($Destination)
$destinationParent = Get-Item -LiteralPath (Split-Path -Parent $destinationPath)
$relativeDestination = [IO.Path]::GetRelativePath($runnerTemp, $destinationPath)
if ([IO.Path]::IsPathRooted($relativeDestination) -or $relativeDestination -in '.','..' -or
    $relativeDestination.StartsWith('..\') -or $destinationParent.FullName -ine $runnerTemp -or
    (Test-Path -LiteralPath $destinationPath)) {
    throw 'Destination must be a new immediate child of RUNNER_TEMP.'
}

$metadata = @{
    nsis = @{
        Name = 'Quiver-v0.1.0-x64-Setup.exe'
        Rc1 = '54D0942F43F494190A925CF8E26E111225A62AD7A55F400CA22D0291756998D4'
        Rc2 = '351C469F0797C147A4AD09D953A3B5C6C86D9BF903D13229D3988A3A7788D036'
    }
    paf = @{
        Name = 'QuiverPortable_0.1.0_English.paf.exe'
        Rc1 = '10E54F6D7F4A7E7B93C8D02C3FFD6444DA6503DA6D214D294EF1A03F2AB6CDEB'
        Rc2 = '1304D6919D0D5DD98629717879C2687AE4B6D652F54045746572D73816FFAE57'
    }
}
$expected = $metadata[$Mode]
$verified = @(
    @{
        label = 'RC 1'; file = $Rc1Installer; installer = $expected.Rc1
        exe = '5A3ACC62C9BFD417B170C6421C383A93CDCA8C19B2C25C67AC26145C16DD2CA8'
        asar = '528E55EFA0DD8C642E09B39F678A3BF71CAA846F67FA103F2C7854BC65EF096D'
    }
    @{
        label = 'RC 2'; file = $Rc2Installer; installer = $expected.Rc2
        exe = 'E3C08E94EC9D654038C43114B1375B37B3AC3DF96D089DB50180943C10430918'
        asar = '367EB9C0E5D1CBF7CCFB3071C8FC2A3780420191EB63B6C8DD7E092369F5AF5A'
    }
)
foreach ($package in $verified) {
    $item = Get-Item -LiteralPath $package.file
    if ($item -isnot [IO.FileInfo] -or $item.Name -cne $expected.Name -or
        (Get-FileHash -LiteralPath $item.FullName).Hash -cne $package.installer -or
        (Get-AuthenticodeSignature -LiteralPath $item.FullName).Status -ne 'NotSigned') {
        throw "Invalid published $($package.label) $Mode installer."
    }
    $package.file = $item.FullName
}
$RuntimeScript = (Get-Item -LiteralPath $RuntimeScript).FullName
$ResumeScript = (Get-Item -LiteralPath $ResumeScript).FullName
$node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
if (Get-Process Quiver,QuiverPortable -ErrorAction SilentlyContinue) { throw 'Quiver is already running.' }

$installRoot = Join-Path $destinationPath $(if ($Mode -eq 'nsis') { 'Quiver' } else { 'QuiverPortable' })
$exePath = Join-Path $installRoot $(if ($Mode -eq 'nsis') { 'Quiver.exe' } else { 'App/Quiver/Quiver.exe' })
$asarPath = Join-Path (Split-Path -Parent $exePath) 'resources/app.asar'
$profileDir = if ($Mode -eq 'nsis') { Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Quiver' }
              else { Join-Path $installRoot 'Data' }
$uninstallRoot = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'

function Get-Registration {
    if (Test-Path -LiteralPath $uninstallRoot) {
        Get-ItemProperty -Path "$uninstallRoot\*" -ErrorAction SilentlyContinue |
            Where-Object DisplayName -Match '^Quiver(?:\s|$)'
    }
}

if ($Mode -eq 'nsis' -and ((Test-Path -LiteralPath $profileDir) -or @(Get-Registration).Count)) {
    throw 'The runner already contains a Quiver profile or install registration.'
}

[void][IO.Directory]::CreateDirectory($destinationPath)
$evidencePath = Join-Path $destinationPath 'lifecycle.json'
$baselinePath = Join-Path $destinationPath 'baseline.json'
$reopenPath = Join-Path $destinationPath 'reopen.json'
$evidence = [ordered]@{
    mode = $Mode
    windows = Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber, OSArchitecture
    runnerEnvironment = $env:RUNNER_ENVIRONMENT
    packageVersion = '0.1.0'
    installRoot = $installRoot
    profileDir = $profileDir
    exePath = $exePath
    packages = $verified
    commands = [Collections.Generic.List[object]]::new()
    checks = [ordered]@{}
    passed = $false
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
function Invoke-Owned([Diagnostics.ProcessStartInfo]$Info, [string]$Name, [int]$TimeoutSeconds, [switch]$Wizard) {
    $command = [ordered]@{
        phase = $Name
        executable = $Info.FileName
        arguments = if ($Info.Arguments) { $Info.Arguments } else { @($Info.ArgumentList) }
        pid = $null
        exit = $null
        timedOut = $false
    }
    $evidence.commands.Add($command)
    $process = [Diagnostics.Process]::Start($Info)
    $command.pid = $process.Id
    try {
        $watch = [Diagnostics.Stopwatch]::StartNew()
        if ($Wizard) {
            foreach ($step in 'Next','Install','Finish') {
                while (![QuiverPortableWizard]::TryAdvance($process.Id, $step, $installRoot)) {
                    if ($process.HasExited) { throw "PortableApps exited $($process.ExitCode) before $step." }
                    if ($watch.Elapsed.TotalSeconds -ge $TimeoutSeconds) {
                        $command.timedOut = $true
                        throw "Timed out waiting for PortableApps $step."
                    }
                    Start-Sleep -Milliseconds 250
                }
                Write-Host "$Name wizard accepted $step."
            }
        }
        $remaining = [Math]::Max(1, $TimeoutSeconds * 1000 - [int]$watch.ElapsedMilliseconds)
        if (!$process.WaitForExit($remaining)) {
            $command.timedOut = $true
            throw "$Name exceeded $TimeoutSeconds seconds."
        }
        if ($process.ExitCode -ne 0) { throw "$Name exited with code $($process.ExitCode)." }
    } finally {
        if (!$process.HasExited) {
            $process.Kill($true)
            [void]$process.WaitForExit(5000)
        }
        if ($process.HasExited) { $command.exit = $process.ExitCode }
        $process.Dispose()
    }
}

function Install-PublishedPackage([hashtable]$Package) {
    $info = [Diagnostics.ProcessStartInfo]::new($Package.file)
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.WorkingDirectory = $destinationPath
    if ($Mode -eq 'nsis') {
        $info.Arguments = "/S /currentuser /D=$installRoot"
    } else {
        # The official PAF wizard appends AppID to the selected parent.
        $info.Arguments = '/DESTINATION="' + $destinationPath + '\"'
    }
    Invoke-Owned $info "$($Package.label) install" 150 -Wizard:($Mode -eq 'paf')
    $installed = [ordered]@{
        exeSha256 = (Get-FileHash -LiteralPath $exePath).Hash
        asarSha256 = (Get-FileHash -LiteralPath $asarPath).Hash
    }
    if ($installed.exeSha256 -cne $Package.exe -or $installed.asarSha256 -cne $Package.asar) {
        throw "Installed $($Package.label) payload differs from the verified release."
    }
    if ($Mode -eq 'nsis') {
        $registration = @(Get-Registration)
        if ($registration.Count -ne 1 -or $registration[0].DisplayVersion -cne '0.1.0' -or
            $registration[0].QuietUninstallString -notmatch '^"([^"]+)" /currentuser /S$') {
            throw 'Expected one per-user Quiver 0.1.0 registration with quiet uninstall.'
        }
        $uninstaller = Get-Item -LiteralPath $Matches[1]
        if ($uninstaller.DirectoryName -ine $installRoot) { throw 'Registration points outside the owned install.' }
        $installed.registrationVersion = $registration[0].DisplayVersion
    } else {
        $launcher = Join-Path $installRoot 'QuiverPortable.exe'
        $appInfo = Get-Content -LiteralPath (Join-Path $installRoot 'App/AppInfo/appinfo.ini')
        if (!(Test-Path -LiteralPath $launcher -PathType Leaf) -or $appInfo -cnotcontains 'DisplayVersion=0.1.0' -or
            $appInfo -cnotcontains 'PackageVersion=0.1.0.65535') {
            throw 'PortableApps launcher or 0.1.0 package metadata is missing.'
        }
        $installed.launcher = $launcher
        $installed.displayVersion = '0.1.0'
        $installed.packageVersion = '0.1.0.65535'
    }
    $installed
}

function Get-ProfileTree([string]$Manifest) {
    $root = Get-Item -LiteralPath $profileDir -Force
    if (!$root.PSIsContainer -or ($root.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Profile root is not an ordinary directory.'
    }
    $items = @(Get-ChildItem -LiteralPath $profileDir -Recurse -Force | Sort-Object FullName)
    if (!$items.Count -or $items.Count -gt 5000) { throw 'Profile tree is empty or exceeds the evidence limit.' }
    $entries = foreach ($entry in $items) {
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Profile contains an unexpected reparse point.' }
        [ordered]@{
            path = [IO.Path]::GetRelativePath($profileDir, $entry.FullName)
            sha256 = if (!$entry.PSIsContainer) { (Get-FileHash -LiteralPath $entry.FullName).Hash }
            directory = $entry.PSIsContainer
        }
    }
    [IO.File]::WriteAllText($Manifest, (ConvertTo-Json -InputObject @($entries) -Depth 5))
    [ordered]@{ entries = $items.Count; manifest = $Manifest; sha256 = (Get-FileHash -LiteralPath $Manifest).Hash }
}

function Invoke-NodeFixture([string]$Name, [string[]]$Arguments) {
    $info = [Diagnostics.ProcessStartInfo]::new($node)
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.WorkingDirectory = $destinationPath
    $info.Environment['QUIVER_UPGRADE_PORTABLE'] = if ($Mode -eq 'paf') { '1' } else { '0' }
    foreach ($argument in $Arguments) { $info.ArgumentList.Add($argument) }
    Invoke-Owned $info $Name 120
    if (Get-Process Quiver,QuiverPortable -ErrorAction SilentlyContinue) {
        throw "$Name left a Quiver process running."
    }
}

function Assert-PassedEvidence([string]$Path) {
    $result = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    if ($result.passed -ne $true) { throw "Runtime fixture did not pass: $Path" }
}

try {
    $evidence.checks.rc1 = Install-PublishedPackage $verified[0]
    Invoke-NodeFixture 'RC 1 baseline runtime' @($RuntimeScript, 'baseline', $exePath, $profileDir, $baselinePath)
    Assert-PassedEvidence $baselinePath
    $evidence.checks.before = Get-ProfileTree (Join-Path $destinationPath 'profile-before.json')

    $evidence.checks.rc2 = Install-PublishedPackage $verified[1]
    $evidence.checks.after = Get-ProfileTree (Join-Path $destinationPath 'profile-after.json')
    if ($evidence.checks.before.sha256 -cne $evidence.checks.after.sha256) {
        throw 'Installer changed the closed RC 1 profile before RC 2 launched.'
    }
    $evidence.checks.closedProfilePreserved = $true

    Invoke-NodeFixture 'RC 2 restored runtime' @($RuntimeScript, 'reopen', $exePath, $profileDir, $reopenPath, $baselinePath)
    Assert-PassedEvidence $reopenPath
    $evidence.checks.reopen = $reopenPath
    foreach ($scenario in 'paused-close','disconnect') {
        $resumePath = Join-Path $destinationPath "resume-$scenario.json"
        Invoke-NodeFixture "RC 2 $scenario" @($ResumeScript, $exePath, $resumePath, $scenario, $profileDir)
        Assert-PassedEvidence $resumePath
        $evidence.checks[$scenario] = $resumePath
    }
    $evidence.passed = $true
    Write-Host 'PASS: published same-version installer upgrade and restored RC 2 behavior.'
} catch {
    $evidence.error = $_.Exception.Message
    throw
} finally {
    [IO.File]::WriteAllText($evidencePath, ($evidence | ConvertTo-Json -Depth 10))
    Write-Host "Installer evidence: $evidencePath"
}
