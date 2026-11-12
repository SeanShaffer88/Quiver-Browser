#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Installer,
    [Parameter(Mandatory)][ValidatePattern('\A[0-9a-fA-F]{64}\z')][string]$AsarSha256,
    [Parameter(Mandatory)][string]$PreviousInstaller
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
$previousArtifact = Get-Item -LiteralPath $PreviousInstaller
$previousHash = 'A21E135F0971269AA61734439C3AB7B6561303616AA6C47A6FDCA9DD1E81F761'
if ($previousArtifact -isnot [IO.FileInfo] -or $previousArtifact.Name -cne 'QuiverPortable_0.1.0-beta.2_English.paf.exe' -or
    (Get-FileHash -LiteralPath $previousArtifact.FullName -Algorithm SHA256).Hash -cne $previousHash) {
    throw 'The previous installer does not match the published Beta 2 portable asset.'
}

$runnerTemp = (Get-Item -LiteralPath $env:RUNNER_TEMP).FullName
$destination = Join-Path $runnerTemp ('Quiver portable ' + [guid]::NewGuid().ToString('N'))
$package = Join-Path $destination 'QuiverPortable'
$profileDir = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Quiver'
$evidencePath = Join-Path $runnerTemp 'quiver-portable-runtime-evidence.json'
$evidence = [ordered]@{ installer = $artifact.Name; installerSha256 = (Get-FileHash -LiteralPath $artifact.FullName).Hash;
    asarSha256 = $AsarSha256; previousInstaller = $previousArtifact.Name; previousInstallerSha256 = $previousHash; checks = [ordered]@{} }
$startupPaths = @('Startup','CommonStartup') | ForEach-Object {
    Join-Path ([Environment]::GetFolderPath($_)) 'Quiver Browser.lnk'
}
$registrationPaths = foreach ($hive in 'HKCU:','HKLM:','HKLM:\Software\WOW6432Node') {
    $software = if ($hive.EndsWith(':')) { "$hive\Software" } else { $hive }
    "$software\Clients\StartMenuInternet\Quiver"
    "$software\Classes\Quiver.Url"
}

. (Join-Path $PSScriptRoot 'Test-PortableNative.ps1')

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
    $wer = Get-Item -LiteralPath 'HKCU:\Software\Microsoft\Windows\Windows Error Reporting\RuntimeExceptionHelperModules' -ErrorAction SilentlyContinue
    $quiverWer = if ($wer) {
        $wer.GetValueNames() | Where-Object { [IO.Path]::GetFileName($_) -ieq 'Quiver_wer.dll' } | Sort-Object |
            ForEach-Object { [ordered]@{ name = $_; kind = $wer.GetValueKind($_).ToString(); value = $wer.GetValue($_) } }
    }
    [ordered]@{ keys = @($keys); browsers = @($browserValues); choices = @($choices); startup = @($startup); quiverWer = @($quiverWer); profileExists = Test-Path -LiteralPath $profileDir; profileHash = $profileHash } |
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
function Install-Package([IO.FileInfo]$File, [string]$Root, [string]$ExpectedAsar) {
    $parent = Split-Path -Parent $Root
    $info = [Diagnostics.ProcessStartInfo]::new($File.FullName)
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.WorkingDirectory = $parent
    # The official installer appends its AppID to this parent path.
    $info.Arguments = '/DESTINATION="' + $parent + '\"'
    $process = [Diagnostics.Process]::Start($info)
    try {
        foreach ($step in 'Next','Install','Finish') {
            $watch = [Diagnostics.Stopwatch]::StartNew()
            while (![QuiverPortableWizard]::TryAdvance($process.Id, $step, $Root)) {
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
        if (!(Test-Path -LiteralPath (Join-Path $Root $relative) -PathType Leaf)) { throw "Missing installed file $relative." }
    }
    $installedAsar = (Get-FileHash -LiteralPath (Join-Path $Root 'App/Quiver/resources/app.asar')).Hash
    if ($ExpectedAsar -and $installedAsar -ine $ExpectedAsar) {
        throw 'Installed PortableApps ASAR differs from the build output.'
    }
    if ($ExpectedAsar -and (Test-Path -LiteralPath (Join-Path $Root 'App/Quiver/Quiver_wer.dll'))) {
        throw 'The portable payload includes the WER helper that would register its path on the host.'
    }
    $installedAsar
}

function Get-TreeState([IO.FileSystemInfo[]]$Roots, [string]$RelativeTo) {
    $items = foreach ($root in $Roots) {
        $root
        if ($root.PSIsContainer -and !($root.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            Get-ChildItem -LiteralPath $root.FullName -Force -Recurse
        }
    }
    $items = @($items | Sort-Object FullName)
    if ($items.Count -gt 5000) { throw 'Portable footprint scope exceeded the 5,000-entry bound.' }
    $state = foreach ($item in $items) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw 'Portable footprint scope contains an unexpected reparse point.'
        }
        [ordered]@{
            path = if ($RelativeTo) { [IO.Path]::GetRelativePath($RelativeTo, $item.FullName) } else { $item.FullName }
            directory = $item.PSIsContainer
            hash = if (!$item.PSIsContainer) { (Get-FileHash -LiteralPath $item.FullName).Hash }
        }
    }
    ConvertTo-Json -InputObject @($state) -Compress
}

function Get-PackageOutsideData([string]$Root) {
    # Compare top-level path segments so names such as DataBackup stay in scope.
    $children = @(Get-ChildItem -LiteralPath $Root -Force | Where-Object Name -INE 'Data')
    Get-TreeState $children
}

function Get-QuiverHostFiles {
    $roots = @(foreach ($base in @([Environment]::GetFolderPath('ApplicationData'), [Environment]::GetFolderPath('LocalApplicationData'))) {
        foreach ($name in 'Quiver','Quiver Portable','QuiverPortable') {
            $entry = Get-Item -LiteralPath (Join-Path $base $name) -Force -ErrorAction SilentlyContinue
            if ($entry) { $entry }
        }
    })
    $temp = [IO.Path]::GetTempPath()
    $roots += @(Get-ChildItem -LiteralPath $temp -Force | Where-Object {
        $_.Name -match '^(Quiver([ ._-]|Portable|$)|electron_debug\.log$)' -and $_.FullName -ine $destination
    })
    $localDumps = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'CrashDumps'
    if (Test-Path -LiteralPath $localDumps -PathType Container) {
        $roots += @(Get-ChildItem -LiteralPath $localDumps -File -Force -Filter 'Quiver.exe*.dmp')
    }
    Get-TreeState @($roots)
}

function Wait-For([string]$Description, [scriptblock]$Probe, [int]$Seconds = 25) {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    while ($watch.Elapsed.TotalSeconds -lt $Seconds) {
        $value = & $Probe
        if ($value) { return $value }
        Start-Sleep -Milliseconds 250
    }
    throw "Timed out waiting for $Description."
}

function Invoke-PortableRuntime([string]$Root, [string]$Url, [string]$Pass, [string]$Records,
    [string]$ExpectedProbe = $Pass, [switch]$Restore, [switch]$PreviousBeta, [string]$SaveAsOrigin) {
    $launcherPath = (Get-Item -LiteralPath (Join-Path $Root 'QuiverPortable.exe')).FullName
    $browserPath = (Get-Item -LiteralPath (Join-Path $Root 'App/Quiver/Quiver.exe')).FullName
    $info = [Diagnostics.ProcessStartInfo]::new($launcherPath)
    $info.UseShellExecute = $false
    $info.WorkingDirectory = $destination
    $outsideLog = Join-Path $destination "escaped-$Pass.log"
    $outsideSwitchLog = Join-Path $destination "escaped-switch-$Pass.log"
    $outsideNetLog = Join-Path $destination "escaped-net-$Pass.json"
    if (!$PreviousBeta) {
        $info.Environment['ELECTRON_ENABLE_LOGGING'] = '1'
        $info.Environment['ELECTRON_LOG_FILE'] = $outsideLog
        $info.ArgumentList.Add("--log-file=$outsideSwitchLog")
        $info.ArgumentList.Add("--log-net-log=$outsideNetLog")
    }
    if (!$Restore) { $info.ArgumentList.Add($Url) }
    # A restored tab revisits the same probe URL. Clear prior results before each launch.
    [IO.File]::WriteAllText($Records, '')
    $launcher = [Diagnostics.Process]::Start($info)
    $browser = $null
    try {
        $browser = Wait-For 'owned browser process from QuiverPortable.exe' {
            if ($launcher.HasExited) { throw "QuiverPortable.exe exited early with $($launcher.ExitCode)." }
            $owned = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($launcher.Id) AND Name='Quiver.exe'" |
                Where-Object { $_.ExecutablePath -ieq $browserPath } | Select-Object -First 1
            if ($owned) {
                $candidate = Get-Process -Id $owned.ProcessId -ErrorAction SilentlyContinue
                if ($candidate) { [void]$candidate.Handle; $candidate }
            }
        }
        $record = Wait-For "loopback storage evidence for $Pass" {
            if ($browser.HasExited) { throw "Owned Quiver exited early with $($browser.ExitCode)." }
            if (Test-Path -LiteralPath $Records) {
                Get-Content -LiteralPath $Records | ForEach-Object {
                    try { $_ | ConvertFrom-Json -ErrorAction Stop } catch { }
                } | Where-Object pass -CEQ $ExpectedProbe | Select-Object -First 1
            }
        }
        $hasCookie = $Restore -or $Pass -ceq 'relocated'
        if ($record.cookie -ne $hasCookie -or $record.storage -ne $hasCookie) {
            throw "Unexpected cookie or localStorage persistence on $Pass launch."
        }
        $null = Wait-For 'owned Quiver window' {
            $browser.Refresh()
            $browser.MainWindowHandle -ne [IntPtr]::Zero
        }
        if ($SaveAsOrigin) { $evidence.checks.saveAs = Invoke-PortableSaveAs -Browser $browser -Root $Root -Origin $SaveAsOrigin }
        if (!$browser.CloseMainWindow() -or !$browser.WaitForExit(15000) -or $browser.ExitCode -ne 0 -or
            !$launcher.WaitForExit(10000) -or $launcher.ExitCode -ne 0) {
            throw 'Portable browser and launcher did not exit cleanly.'
        }
        $null = Wait-For 'all portable browser processes to exit' {
            !(Get-CimInstance Win32_Process -Filter "Name='Quiver.exe'" | Where-Object ExecutablePath -IEQ $browserPath)
        } -Seconds 10
        $data = Join-Path $Root 'Data'
        $state = Get-Content -LiteralPath (Join-Path $data 'quiver-state.json') -Raw | ConvertFrom-Json
        if ((!$PreviousBeta -and $state.sessionOpen -ne $false) -or !(@($state.tabsBySpace.'space-main'.url) -ccontains $Url)) {
            throw 'Portable browser did not save its visited fixture URL and clean session state under Data.'
        }
        if ($PreviousBeta) {
            return [ordered]@{ pass = $Pass; browserExit = $browser.ExitCode; launcherExit = $launcher.ExitCode;
                cookieRestored = $record.cookie; localStorageRestored = $record.storage; settings = 'Data/quiver-state.json' }
        }
        foreach ($relative in 'boosts','Partitions','Temp','Logs','CrashDumps','Downloads','Cache') {
            if (!(Test-Path -LiteralPath (Join-Path $data $relative))) { throw "Portable runtime did not produce Data/$relative." }
        }
        if (!(Get-ChildItem -LiteralPath (Join-Path $data 'Partitions') -File -Recurse -Force | Where-Object Name -CEQ 'Cookies')) {
            throw 'Chromium did not persist its partition cookies under Data.'
        }
        $cacheFiles = @(Get-ChildItem -LiteralPath (Join-Path $data 'Cache'), (Join-Path $data 'Partitions') -File -Recurse -Force |
            Where-Object { $_.Length -gt 0 -and [IO.Path]::GetRelativePath($data, $_.FullName) -match '(^|[\\/])Cache([\\/]|$)' })
        if (!$cacheFiles.Count) {
            throw 'Chromium did not persist cache files under Data.'
        }
        if (!(Test-Path -LiteralPath (Join-Path $data 'Logs/electron.log') -PathType Leaf) -or
            (Test-Path -LiteralPath $outsideLog) -or (Test-Path -LiteralPath $outsideSwitchLog) -or
            (Test-Path -LiteralPath $outsideNetLog)) {
            throw 'Electron file logging did not stay in Data/Logs.'
        }
        $cacheExamples = @($cacheFiles | Select-Object -First 4 | ForEach-Object { [IO.Path]::GetRelativePath($Root, $_.FullName) })
        [ordered]@{ pass = $Pass; browserExit = $browser.ExitCode; launcherExit = $launcher.ExitCode;
            cookieRestored = $record.cookie; localStorageRestored = $record.storage;
            settings = 'Data/quiver-state.json'; cookies = 'Data/Partitions'; cacheFileCount = $cacheFiles.Count;
            cacheExamples = $cacheExamples; logs = 'Data/Logs/electron.log' }
    } finally {
        if ($browser) {
            if (!$browser.HasExited -and (!$browser.CloseMainWindow() -or !$browser.WaitForExit(5000))) {
                $browser.Kill($true)
                [void]$browser.WaitForExit(5000)
            }
            $browser.Dispose()
        }
        if (!$launcher.HasExited -and !$launcher.WaitForExit(5000)) { $launcher.Kill($true); [void]$launcher.WaitForExit(5000) }
        $launcher.Dispose()
    }
}

function Assert-SeededPortableProfile([string]$Data, [string]$Url, [string]$BookmarkUrl) {
    $state = Get-Content -LiteralPath (Join-Path $Data 'quiver-state.json') -Raw | ConvertFrom-Json
    $bookmark = @($state.bookmarks | Where-Object { $_.url -ceq $BookmarkUrl -and $_.title -ceq 'Portable Beta 2 bookmark' })
    if ($bookmark.Count -ne 1 -or $state.settings.devServerScan -ne $false -or
        !(@($state.tabsBySpace.'space-main'.url) -ccontains $Url)) {
        throw 'The saved Beta 2 bookmark, setting, or tab did not survive.'
    }
}

function Test-UpgradeAndDriveChange([string]$Origin, [string]$Records) {
    # DiskPart creates only this new image. Destructive disk operations below use
    # the specific MSFT_Disk associated with that image, never a free disk guess.
    $imagePath = Join-Path $destination 'Quiver portable drive.vhdx'
    $diskpartScript = Join-Path $destination 'create-portable-drive.txt'
    if ($imagePath -notmatch '\A[\x20-\x7e]+\z' -or
        (Test-Path -LiteralPath $imagePath) -or (Test-Path -LiteralPath $diskpartScript)) {
        throw 'The disposable virtual disk paths must be new.'
    }
    $diskpart = (Get-Command diskpart.exe -CommandType Application).Source
    'create vdisk file="{0}" maximum=2048 type=expandable' -f $imagePath |
        Set-Content -LiteralPath $diskpartScript -Encoding ascii
    & $diskpart /s $diskpartScript | Write-Host
    if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $imagePath -PathType Leaf)) {
        throw "DiskPart could not create the disposable VHDX (exit $LASTEXITCODE)."
    }
    try {
        $occupied = @([IO.DriveInfo]::GetDrives().Name)
        $freeLetters = @('Q','R','S','T','U','V','W','X','Y','Z' | Where-Object { $occupied -inotcontains "${_}:\" })
        if ($freeLetters.Count -lt 2) { throw 'Two unused drive letters are required for the portable drive test.' }
        $oldLetter, $newLetter = $freeLetters[0], $freeLetters[1]
        $image = Mount-DiskImage -ImagePath $imagePath -NoDriveLetter -PassThru
        $disk = @($image | Get-Disk)
        if ($image.ImagePath -ine $imagePath -or $disk.Count -ne 1 -or $disk[0].PartitionStyle -ne 'RAW' -or
            $disk[0].IsBoot -or $disk[0].IsSystem -or $disk[0].Size -ne 2GB) {
            throw 'Refusing to initialize a disk without the expected new VHDX identity.'
        }
        $disk = $disk[0]
        if ($disk.IsOffline) { Set-Disk -InputObject $disk -IsOffline $false }
        $initializedDisk = Initialize-Disk -InputObject $disk -PartitionStyle GPT -PassThru
        $partition = New-Partition -InputObject $initializedDisk -UseMaximumSize -DriveLetter $oldLetter
        $null = Format-Volume -Partition $partition -FileSystem NTFS -NewFileSystemLabel 'Quiver QA' -Confirm:$false
        $oldRoot = "${oldLetter}:\"
        $newRoot = "${newLetter}:\"
        $null = Wait-For 'the disposable NTFS volume' { [IO.Directory]::Exists($oldRoot) }
        $partition = Get-Partition -DriveLetter $oldLetter
        $volume = Get-Volume -Partition $partition
        if ($partition.DiskNumber -ne $disk.Number -or !$partition.Guid -or !$volume.UniqueId -or $volume.FileSystem -ne 'NTFS') {
            throw 'The disposable NTFS volume identity was not established.'
        }

        $relativePackage = 'Quiver upgrade and relocation\QuiverPortable'
        $oldPackage = Join-Path $oldRoot $relativePackage
        $null = New-Item -ItemType Directory -Path (Split-Path -Parent $oldPackage)
        $oldAsar = Install-Package $previousArtifact $oldPackage
        $oldAppInfo = Get-Content -LiteralPath (Join-Path $oldPackage 'App/AppInfo/appinfo.ini')
        if ($oldAsar -ieq $AsarSha256 -or $oldAppInfo -cnotcontains 'DisplayVersion=0.1.0-beta.2') {
            throw 'The installed previous package does not identify Beta 2.'
        }
        $url = "$Origin/portable-check?pass=beta2"
        $bookmarkUrl = "$Origin/portable-bookmark-fixture"
        $evidence.checks.previousRuntime = Invoke-PortableRuntime $oldPackage $url 'beta2' $Records -PreviousBeta
        $oldData = Join-Path $oldPackage 'Data'
        $statePath = Join-Path $oldData 'quiver-state.json'
        $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
        # Seed harmless known state in the real, closed Beta 2 profile, then
        # require Beta 2 itself to reopen the tab and preserve the fixture.
        $state.settings.devServerScan = $false
        $state.bookmarks = @(@{ url = $bookmarkUrl; title = 'Portable Beta 2 bookmark' })
        [IO.File]::WriteAllText($statePath, ($state | ConvertTo-Json -Depth 30))
        $evidence.checks.previousProfileReload = Invoke-PortableRuntime $oldPackage $url 'beta2-reopen' $Records -ExpectedProbe 'beta2' -Restore -PreviousBeta
        Assert-SeededPortableProfile $oldData $url $bookmarkUrl

        $stateBeforeUpgrade = Get-TreeState @((Get-Item -LiteralPath $oldData))
        $hostBeforeUpgrade = Get-HostState
        $filesBeforeUpgrade = Get-QuiverHostFiles
        $null = Install-Package $artifact $oldPackage $AsarSha256
        if ((Get-TreeState @((Get-Item -LiteralPath $oldData))) -cne $stateBeforeUpgrade) {
            throw 'Upgrading the published Beta 2 package changed files under Data.'
        }
        $evidence.checks.previousBetaUpgradePreservedData = $true
        $packageBefore = Get-PackageOutsideData $oldPackage
        $evidence.checks.upgradedRuntime = Invoke-PortableRuntime $oldPackage $url 'upgraded' $Records -ExpectedProbe 'beta2' -Restore
        Assert-SeededPortableProfile $oldData $url $bookmarkUrl
        if ((Get-PackageOutsideData $oldPackage) -cne $packageBefore -or
            (Get-HostState) -cne $hostBeforeUpgrade -or (Get-QuiverHostFiles) -cne $filesBeforeUpgrade) {
            throw 'Upgrade or the upgraded runtime changed scoped host or package files.'
        }
        Write-Host 'PASS: upgraded the published Beta 2 PAF in place and restored its seeded profile and browser storage.'

        $treeBefore = Get-TreeState @((Get-Item -LiteralPath $oldPackage)) $oldPackage
        Set-Partition -InputObject $partition -NewDriveLetter $newLetter
        $null = Wait-For 'the new drive letter and disappearance of the old letter' {
            [IO.Directory]::Exists($newRoot) -and ![IO.Directory]::Exists($oldRoot)
        }
        $newPartition = Get-Partition -DriveLetter $newLetter
        $newVolume = Get-Volume -Partition $newPartition
        if ($newPartition.DiskNumber -ne $partition.DiskNumber -or $newPartition.Guid -ine $partition.Guid -or
            $newVolume.UniqueId -ine $volume.UniqueId) {
            throw 'The new drive letter did not refer to the same partition and volume.'
        }
        $newPackage = Join-Path $newRoot $relativePackage
        if ((Get-TreeState @((Get-Item -LiteralPath $newPackage)) $newPackage) -cne $treeBefore) {
            throw 'Changing the drive letter changed the package or Data bytes before launch.'
        }
        $packageBefore = Get-PackageOutsideData $newPackage
        $runtime = Invoke-PortableRuntime $newPackage $url 'new-drive-letter' $Records -ExpectedProbe 'beta2' -Restore
        Assert-SeededPortableProfile (Join-Path $newPackage 'Data') $url $bookmarkUrl
        if ([IO.Directory]::Exists($oldRoot) -or (Get-PackageOutsideData $newPackage) -cne $packageBefore -or
            (Get-HostState) -cne $hostBeforeUpgrade -or (Get-QuiverHostFiles) -cne $filesBeforeUpgrade) {
            throw 'The new-drive runtime changed scoped host or package files, or restored the previous letter.'
        }
        $evidence.checks.driveLetterChange = [ordered]@{ oldLetter = $oldLetter; newLetter = $newLetter; oldLetterUnavailable = $true;
            samePartitionAndVolume = $true; identicalTreeBeforeLaunch = $true; bookmarkRetained = $true; settingRetained = $true; tabRestored = $true; runtime = $runtime }
        Write-Host "PASS: the same VHDX volume changed from $oldLetter to $newLetter and restored bookmarks, settings, tabs, and browser storage."
    } finally {
        if ((Get-DiskImage -ImagePath $imagePath).Attached) { Dismount-DiskImage -ImagePath $imagePath | Out-Null }
        if ((Get-DiskImage -ImagePath $imagePath).Attached) { throw 'The disposable VHDX remained attached.' }
    }
}

$fixture = $null
try {
    $before = Get-HostState
    $null = New-Item -ItemType Directory -Path $destination
    $null = Install-Package $artifact $package $AsarSha256
    if ((Get-HostState) -cne $before) { throw 'Installation changed scoped host browser, startup, or installed-profile state.' }
    $hostFilesBefore = Get-QuiverHostFiles
    $data = Join-Path $package 'Data'
    if (Test-Path -LiteralPath $data) {
        $empty = Get-Item -LiteralPath $data -Force
        if (!$empty.PSIsContainer -or ($empty.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            $empty.FullName -ine [IO.Path]::GetFullPath($data) -or (Get-ChildItem -LiteralPath $empty.FullName -Force)) {
            throw 'Fresh PortableApps Data directory is not an owned empty directory.'
        }
        [IO.Directory]::Delete($empty.FullName, $false)
    }
    $packageBefore = Get-PackageOutsideData $package
    $fixturePath = Join-Path $destination 'portable-storage-fixture.cjs'
    $originFile = Join-Path $destination 'fixture-origin.txt'
    $records = Join-Path $destination 'fixture-storage.jsonl'
    @'
const fs = require('node:fs');
const http = require('node:http');
const [originFile, records] = process.argv.slice(2);
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.pathname === '/portable-check') {
    const pass = url.searchParams.get('pass');
    if (!['fresh', 'relocated', 'beta2'].includes(pass)) { response.writeHead(400).end(); return; }
    response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }).end(`<!doctype html><title>Quiver Portable verification</title>
    ${pass === 'fresh' ? '<a href="/portable-download?name=quiver-default.txt">Quiver Default Download</a><br><a href="/portable-download?name=quiver-custom.txt">Quiver Custom Download</a><br><a href="/portable-download?name=quiver-reopened.txt">Quiver Reopened Download</a>' : ''}
    <script>
      const stored = localStorage.getItem('quiver-portable-fixture') === 'present';
      localStorage.setItem('quiver-portable-fixture', 'present');
      fetch('/cacheable').then(r => r.text()).then(() => fetch('/probe'))
        .then(r => r.text()).then(cookie => fetch('/done?pass=${pass}&stored=' + stored + '&cookie=' + cookie));
    </script>`);
  } else if (url.pathname === '/portable-download') {
    const name = url.searchParams.get('name');
    if (!['quiver-default.txt', 'quiver-custom.txt', 'quiver-reopened.txt'].includes(name)) { response.writeHead(400).end(); return; }
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' })
      .end(`Quiver portable download: ${name}\n`);
  } else if (url.pathname === '/portable-crash') {
    response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' })
      .end('<!doctype html><title>Quiver portable crash fixture</title><h1>Quiver portable crash fixture</h1>');
  } else if (url.pathname === '/cacheable') {
    response.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'public, max-age=600' }).end('portable cache fixture '.repeat(2048));
  } else if (url.pathname === '/probe') {
    const cookie = /(?:^|;\s*)quiver_portable_fixture=present(?:;|$)/.test(request.headers.cookie ?? '');
    response.writeHead(200, { 'Cache-Control': 'no-store', 'Set-Cookie': 'quiver_portable_fixture=present; Path=/; Max-Age=3600; HttpOnly; SameSite=Strict' }).end(String(cookie));
  } else if (url.pathname === '/done') {
    fs.appendFileSync(records, JSON.stringify({ pass: url.searchParams.get('pass'), storage: url.searchParams.get('stored') === 'true', cookie: url.searchParams.get('cookie') === 'true' }) + '\n');
    response.writeHead(200, { 'Cache-Control': 'no-store' }).end('ok');
  } else {
    response.writeHead(404).end();
  }
});
server.listen(0, '127.0.0.1', () => fs.writeFileSync(originFile, 'http://127.0.0.1:' + server.address().port));
'@ | Set-Content -LiteralPath $fixturePath -Encoding utf8
    $node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
    $fixtureInfo = [Diagnostics.ProcessStartInfo]::new($node)
    $fixtureInfo.UseShellExecute = $false
    $fixtureInfo.CreateNoWindow = $true
    foreach ($argument in $fixturePath, $originFile, $records) { $fixtureInfo.ArgumentList.Add($argument) }
    $fixture = [Diagnostics.Process]::Start($fixtureInfo)
    $origin = Wait-For 'private loopback fixture' {
        if ($fixture.HasExited) { throw "Loopback fixture exited with $($fixture.ExitCode)." }
        if (Test-Path -LiteralPath $originFile) { Get-Content -LiteralPath $originFile -Raw }
    }
    if ($origin -notmatch '\Ahttp://127\.0\.0\.1:\d{1,5}\z') { throw 'Invalid loopback fixture origin.' }
    $evidence.checks.freshRuntime = Invoke-PortableRuntime $package "$origin/portable-check?pass=fresh" 'fresh' $records -SaveAsOrigin $origin
    if ((Get-PackageOutsideData $package) -cne $packageBefore) { throw 'First launch changed package files outside Data.' }
    if ((Get-QuiverHostFiles) -cne $hostFilesBefore -or (Get-HostState) -cne $before) { throw 'First launch changed scoped Quiver host state.' }
    Write-Host 'PASS: fresh launcher recreated Data and kept browser state, partition cookies, cache and logs inside it.'

    $dataBeforeReinstall = Get-TreeState @((Get-Item -LiteralPath $data))
    $null = Install-Package $artifact $package $AsarSha256
    if ((Get-TreeState @((Get-Item -LiteralPath $data))) -cne $dataBeforeReinstall) { throw 'Reinstallation changed the portable Data tree.' }
    if ((Get-HostState) -cne $before) { throw 'Reinstallation changed scoped host browser, startup, or installed-profile state.' }
    $evidence.checks.reinstallPreservedData = $true

    $relocated = Join-Path $destination 'Relocated Quiver Portable'
    $packageItem = Get-Item -LiteralPath $package -Force
    $source = $packageItem.FullName
    $destinationItem = Get-Item -LiteralPath $destination -Force
    if (!$packageItem.PSIsContainer -or ($packageItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        ($destinationItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        $destinationItem.Parent.FullName -ine $runnerTemp -or
        $source -ine (Join-Path $destinationItem.FullName 'QuiverPortable') -or (Test-Path -LiteralPath $relocated)) {
        throw 'Refusing to move a package outside the verified disposable destination.'
    }
    Move-Item -LiteralPath $source -Destination $relocated
    $packageBefore = Get-PackageOutsideData $relocated
    $evidence.checks.relocatedRuntime = Invoke-PortableRuntime $relocated "$origin/portable-check?pass=relocated" 'relocated' $records
    if ((Get-PackageOutsideData $relocated) -cne $packageBefore -or (Test-Path -LiteralPath $source)) {
        throw 'Relocated launch changed package files outside Data or recreated the old package path.'
    }
    if ((Get-QuiverHostFiles) -cne $hostFilesBefore -or (Get-HostState) -cne $before) {
        throw 'Relocated launch changed scoped host browser, startup, or app-file state.'
    }
    $evidence.checks.scopedHostAndPackageUnchanged = $true
    Write-Host 'PASS: reinstall preserved the Data tree and the relocated launcher restored cookie and localStorage without changing scoped host or package files.'

    $evidence.checks.crashDump = Invoke-PortableCrashDump -Root $relocated -Origin $origin
    if ((Get-PackageOutsideData $relocated) -cne $packageBefore -or
        (Get-QuiverHostFiles) -cne $hostFilesBefore -or (Get-HostState) -cne $before) {
        throw 'The crash and recovery changed scoped host or package files.'
    }
    Test-UpgradeAndDriveChange $origin $records
} catch {
    $evidence.failure = $_.Exception.Message
    throw
} finally {
    if ($fixture) {
        if (!$fixture.HasExited) { $fixture.Kill(); [void]$fixture.WaitForExit(5000) }
        $fixture.Dispose()
    }
    $evidence | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $evidencePath -Encoding utf8
    Write-Host "Portable runtime evidence $evidencePath"
}
