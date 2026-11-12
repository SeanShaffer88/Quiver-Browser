#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$Candidate,
    [Parameter(Mandatory)]
    [string]$Fixture,
    [Parameter(Mandatory)]
    [ValidatePattern('(?x)\A
        (?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)
        (?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)
            (?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?
        (?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?\z')]
    [string]$CandidateVersion,
    [Parameter(Mandatory)]
    [ValidatePattern('\A[0-9a-fA-F]{64}\z')]
    [string]$CandidateAsarSha256
)

$ErrorActionPreference = 'Stop'
if (!$IsWindows -or $env:GITHUB_ACTIONS -cne 'true' -or
    $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
    [string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
    throw 'This lifecycle test requires a disposable GitHub-hosted Windows runner.'
}

$runnerTemp = (Get-Item -LiteralPath $env:RUNNER_TEMP).FullName
$testRoot = Join-Path $runnerTemp ('Quiver lifecycle ' + [guid]::NewGuid().ToString('N'))
$installDir = Join-Path $testRoot 'Quiver'
$profileDir = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Quiver'
$registryRoot = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'

function Get-SetupPath([string]$Path, [string]$Version) {
    $item = Get-Item -LiteralPath $Path
    if ($item -isnot [IO.FileInfo] -or $item.Name -cne "Quiver-v$Version-x64-Setup.exe") {
        throw "Expected the Quiver $Version setup EXE."
    }
    $item.FullName
}

function Get-QuiverRegistration {
    if (Test-Path -LiteralPath $registryRoot) {
        Get-ItemProperty -Path "$registryRoot\*" -ErrorAction SilentlyContinue |
            Where-Object DisplayName -Match '^Quiver(?:\s|$)'
    }
}

function Invoke-Nsis([string]$File, [string]$Arguments, [string]$Step) {
    Write-Host $Step
    $info = [Diagnostics.ProcessStartInfo]::new($File)
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.WorkingDirectory = $testRoot
    $info.Arguments = $Arguments
    $process = [Diagnostics.Process]::Start($info)
    try {
        if (!$process.WaitForExit(120000)) {
            $process.Kill($true)
            throw "$Step exceeded 120 seconds."
        }
        if ($process.ExitCode -ne 0) {
            throw "$Step exited with code $($process.ExitCode)."
        }
    } finally {
        $process.Dispose()
    }
}

function Assert-Installed([string]$Version) {
    $registered = @(Get-QuiverRegistration)
    if ($registered.Count -ne 1 -or $registered[0].DisplayVersion -cne $Version) {
        throw "Expected one per-user uninstall registration for $Version. Observed: $($registered.DisplayVersion -join ', ')."
    }
    $registration = $registered[0]
    if ($registration.QuietUninstallString -notmatch '^"([^"]+)" /currentuser /S$') {
        throw 'Missing current-user quiet uninstall command.'
    }
    $uninstaller = Get-Item -LiteralPath $Matches[1]
    if ($uninstaller -isnot [IO.FileInfo] -or $uninstaller.DirectoryName -ine $installDir) {
        throw 'Registered uninstaller is outside the expected installation directory.'
    }
    $app = Get-Item -LiteralPath (Join-Path $installDir 'Quiver.exe')
    $asar = Get-Item -LiteralPath (Join-Path $installDir 'resources\app.asar')
    if ($app.Length -le 0 -or $asar.Length -le 0) {
        throw 'Installed application payload is empty.'
    }
    [pscustomobject]@{
        Uninstaller = $uninstaller.FullName
        AsarSha256 = (Get-FileHash -LiteralPath $asar.FullName -Algorithm SHA256).Hash
    }
}

function Assert-Removed {
    if ((Test-Path -LiteralPath $installDir) -or @(Get-QuiverRegistration).Count -gt 0) {
        throw 'The Quiver installation directory or its uninstall registration still exists.'
    }
}

function Remove-TestInstallation([string]$Uninstaller, [string]$Step) {
    Invoke-Nsis $Uninstaller '/currentuser /S' $Step
    # NSIS may hand uninstall off to a child after its original process exits.
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while (((Test-Path -LiteralPath $installDir) -or @(Get-QuiverRegistration).Count -gt 0) -and
        $timer.Elapsed.TotalSeconds -lt 45) {
        Start-Sleep -Milliseconds 250
    }
    Assert-Removed
}

$fixtureVersion = '0.0.9'
$candidatePath = Get-SetupPath $Candidate $CandidateVersion
$fixturePath = Get-SetupPath $Fixture $fixtureVersion
if ((Test-Path -LiteralPath $profileDir) -or @(Get-QuiverRegistration).Count -gt 0) {
    throw 'The runner already has a Quiver profile or installation.'
}

$null = New-Item -ItemType Directory -Path $testRoot
$installArguments = "/S /currentuser /D=$installDir"
Invoke-Nsis $candidatePath $installArguments 'Clean beta install'
$cleanInstall = Assert-Installed $CandidateVersion
if ($cleanInstall.AsarSha256 -ine $CandidateAsarSha256) {
    throw 'Clean installation ASAR differs from the build output.'
}
Remove-TestInstallation $cleanInstall.Uninstaller 'Clean beta uninstall'

Invoke-Nsis $fixturePath $installArguments 'Install synthetic 0.0.9 fixture'
$priorInstall = Assert-Installed $fixtureVersion
$null = New-Item -ItemType Directory -Path $profileDir
$sentinelPath = Join-Path $profileDir 'installer-lifecycle-sentinel.txt'
$sentinel = [guid]::NewGuid().ToString('N')
[IO.File]::WriteAllText($sentinelPath, $sentinel)

Invoke-Nsis $candidatePath $installArguments 'Upgrade fixture to beta'
$upgraded = Assert-Installed $CandidateVersion
if ($upgraded.AsarSha256 -ieq $priorInstall.AsarSha256 -or
    $upgraded.AsarSha256 -ine $cleanInstall.AsarSha256) {
    throw 'Upgrade did not replace the fixture payload with the verified beta payload.'
}
if ([IO.File]::ReadAllText($sentinelPath) -cne $sentinel) {
    throw 'Upgrade changed the synthetic profile sentinel.'
}
Remove-TestInstallation $upgraded.Uninstaller 'Uninstall upgraded beta'
if ([IO.File]::ReadAllText($sentinelPath) -cne $sentinel) {
    throw 'Normal uninstall changed the synthetic profile sentinel.'
}

Write-Host 'PASS: per-user clean install, synthetic-version upgrade, uninstall, payload and registration cleanup, and profile preservation.'
