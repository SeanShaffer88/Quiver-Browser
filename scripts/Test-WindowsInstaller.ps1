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

$registeredApplications = 'HKCU:\Software\RegisteredApplications'
$clientRoot = 'HKCU:\Software\Clients\StartMenuInternet\Quiver'
$progIdRoot = 'HKCU:\Software\Classes\Quiver.Url'
$startupShortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'Quiver Browser.lnk'
$userChoicePaths = @('http','https') | ForEach-Object {
    "HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\$_\UserChoice"
}

function Get-UserChoices {
    foreach ($registryPath in $userChoicePaths) {
        $choice = Get-ItemProperty -LiteralPath $registryPath -ErrorAction SilentlyContinue
        [pscustomobject]@{ ProgId=$choice.ProgId; Hash=$choice.Hash }
    }
}

function Get-QuiverBrowserRegistration {
    Get-ItemPropertyValue -LiteralPath $registeredApplications -Name 'Quiver' -ErrorAction SilentlyContinue
}

function Assert-BrowserIntegration([bool]$AtLogin) {
    if ((ConvertTo-Json -InputObject @(Get-UserChoices) -Compress) -cne $originalUserChoices) {
        throw 'Windows HTTP or HTTPS UserChoice changed during setup.'
    }
    if ((Get-QuiverBrowserRegistration) -cne 'Software\Clients\StartMenuInternet\Quiver\Capabilities') {
        throw 'Quiver is missing from Windows RegisteredApplications.'
    }
    $urls = Get-ItemProperty -LiteralPath "$clientRoot\Capabilities\URLAssociations"
    if ($urls.http -cne 'Quiver.Url' -or $urls.https -cne 'Quiver.Url') {
        throw 'Quiver URL capability mappings differ.'
    }
    $command = (Get-Item -LiteralPath "$progIdRoot\shell\open\command").GetValue('')
    $appPath = Join-Path $installDir 'Quiver.exe'
    if ($command -cne ('"{0}" -- "%1"' -f $appPath)) {
        throw 'Quiver URL command does not quote the installed executable and URL.'
    }
    if ((Test-Path -LiteralPath $startupShortcut -PathType Leaf) -ne $AtLogin) {
        throw "Unexpected sign-in startup shortcut state (expected $AtLogin)."
    }
    if ($AtLogin) {
        $shell = New-Object -ComObject WScript.Shell
        try {
            $shortcut = $shell.CreateShortcut($startupShortcut)
            try {
                if ($shortcut.TargetPath -ine $appPath) { throw 'Startup shortcut targets the wrong Quiver executable.' }
            } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shortcut) }
        } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell) }
    }
}

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

function Assert-BrowserIntegrationRemoved {
    if ((Get-QuiverBrowserRegistration) -or (Test-Path -LiteralPath $clientRoot) -or
        (Test-Path -LiteralPath $progIdRoot) -or (Test-Path -LiteralPath $startupShortcut)) {
        throw 'Uninstall left Quiver browser registration or a startup shortcut.'
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
    Assert-BrowserIntegrationRemoved
}

$fixtureVersion = '0.0.9'
$candidatePath = Get-SetupPath $Candidate $CandidateVersion
$fixturePath = Get-SetupPath $Fixture $fixtureVersion
if ((Test-Path -LiteralPath $profileDir) -or @(Get-QuiverRegistration).Count -gt 0) {
    throw 'The runner already has a Quiver profile or installation.'
}

Assert-BrowserIntegrationRemoved
$originalUserChoices = ConvertTo-Json -InputObject @(Get-UserChoices) -Compress
$null = New-Item -ItemType Directory -Path $testRoot
$installArguments = "/S /currentuser /D=$installDir"
Invoke-Nsis $candidatePath $installArguments 'Clean beta install'
$cleanInstall = Assert-Installed $CandidateVersion
Assert-BrowserIntegration $false
if ($cleanInstall.AsarSha256 -ine $CandidateAsarSha256) {
    throw 'Clean installation ASAR differs from the build output.'
}
Remove-TestInstallation $cleanInstall.Uninstaller 'Clean beta uninstall'

Invoke-Nsis $fixturePath "/STARTATLOGIN $installArguments" 'Install synthetic 0.0.9 fixture'
$priorInstall = Assert-Installed $fixtureVersion
Assert-BrowserIntegration $true
$null = New-Item -ItemType Directory -Path $profileDir
$sentinelPath = Join-Path $profileDir 'installer-lifecycle-sentinel.txt'
$sentinel = [guid]::NewGuid().ToString('N')
[IO.File]::WriteAllText($sentinelPath, $sentinel)

Invoke-Nsis $candidatePath $installArguments 'Upgrade fixture to beta'
$upgraded = Assert-Installed $CandidateVersion
Assert-BrowserIntegration $true
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

if ((ConvertTo-Json -InputObject @(Get-UserChoices) -Compress) -cne $originalUserChoices) {
    throw 'Windows HTTP or HTTPS UserChoice changed during installer lifecycle.'
}

Write-Host 'PASS: browser registration, unchanged Windows default choices, and opted-in startup shortcut lifecycle.'
Write-Host 'PASS: per-user clean install, synthetic-version upgrade, uninstall, payload and registration cleanup, and profile preservation.'
