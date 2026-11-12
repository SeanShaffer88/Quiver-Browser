#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$InstallerRoot,
    [string]$UnpackedDirectory = 'release/win-unpacked',
    [string]$OutputDirectory,
    [string]$ExpectedVersion,
    [scriptblock]$SignFile,
    [string]$SignTool,
    [string]$PublisherSubject,
    [ValidatePattern('\A[0-9a-fA-F]{40}\z')][string]$CertificateThumbprint
)

$ErrorActionPreference = 'Stop'
if (!$IsWindows) { throw 'Windows is required to compile this installer.' }
$signingRequested = $PSBoundParameters.ContainsKey('SignFile') -or $PSBoundParameters.ContainsKey('SignTool') -or
    $PSBoundParameters.ContainsKey('PublisherSubject') -or $PSBoundParameters.ContainsKey('CertificateThumbprint')
if ($signingRequested -and (!$SignFile -or [string]::IsNullOrWhiteSpace($SignTool) -or [string]::IsNullOrWhiteSpace($PublisherSubject))) {
    throw 'Signing requires SignFile, SignTool, and PublisherSubject together.'
}
$repository = Split-Path -Parent $PSScriptRoot
$templates = Join-Path $repository 'build/portableapps'
$icon = Join-Path $repository 'build/icon.ico'
$banner = Join-Path $templates 'installerSidebar.bmp'
$unpacked = (Get-Item -LiteralPath $UnpackedDirectory).FullName
$sourceAsar = Join-Path $unpacked 'resources/app.asar'
$sourceExe = Join-Path $unpacked 'Quiver.exe'
$toolsRoot = (Get-Item -LiteralPath $InstallerRoot).FullName
$sourceWizard = Join-Path $toolsRoot 'PortableApps.comInstaller.exe'
$sourceCompiler = Join-Path $toolsRoot 'App/nsis/makensis.exe'
$sourceExtractor = Join-Path $toolsRoot 'App/7zip/7z.exe'
$installerLicense = Join-Path $toolsRoot 'Other/Source/License.txt'
foreach ($required in @($icon, $banner, $sourceAsar, $sourceExe, $sourceWizard, $sourceCompiler, $sourceExtractor, $installerLicense)) {
    if (!(Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required packaging input is missing. $required" }
}
$signature = Get-AuthenticodeSignature -LiteralPath $sourceWizard
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'RARE IDEAS, LLC') {
    throw 'The PortableApps.com Installer wizard must have a valid Authenticode signature.'
}

$asarModule = Join-Path $repository 'node_modules/@electron/asar'
$displayVersion = & node -e 'console.log(JSON.parse(require(process.argv[1]).extractFile(process.argv[2], "package.json")).version)' $asarModule $sourceAsar
if ($LASTEXITCODE -ne 0) { throw "Could not read the embedded package version. node exit code $LASTEXITCODE." }
if (!$ExpectedVersion) {
    $ExpectedVersion = (Get-Content -Raw -LiteralPath (Join-Path $repository 'package.json') | ConvertFrom-Json).version
}
if ($displayVersion -cne $ExpectedVersion) { throw "The payload is $displayVersion and the expected build is $ExpectedVersion." }
if ($displayVersion -notmatch '^(?<base>[0-9]+\.[0-9]+\.[0-9]+)(?:-beta\.(?<beta>[1-9][0-9]*))?$') {
    throw "Unsupported package version $displayVersion."
}
$baseVersion = $Matches.base
$revision = if ($Matches.beta) { [int]$Matches.beta } else { 65535 }
if (($Matches.beta -and $revision -ge 65535) -or ($baseVersion.Split('.') | Where-Object { [int]$_ -gt 65535 })) {
    throw "The version fields exceed PortableApps.com's numeric range."
}
$packageVersion = "$baseVersion.$revision"
if (!$OutputDirectory) { $OutputDirectory = Join-Path $repository "release/portableapps/$displayVersion" }
$destination = [IO.Path]::GetFullPath($OutputDirectory, (Get-Location).Path)
foreach ($inputRoot in @($unpacked, $toolsRoot)) {
    $relative = [IO.Path]::GetRelativePath($inputRoot, $destination)
    if ($relative -eq '.' -or (![IO.Path]::IsPathRooted($relative) -and $relative -notmatch '^\.\.([\\/]|$)')) {
        throw "Choose an output directory outside $inputRoot."
    }
}
if (Test-Path -LiteralPath $destination) { throw "Choose a new output directory. $destination already exists." }
if (Get-ChildItem -LiteralPath $unpacked -Recurse -Force -Attributes ReparsePoint | Select-Object -First 1) {
    throw 'The unpacked application contains a reparse point.'
}

$signatureVerifier = Join-Path $PSScriptRoot 'Test-WindowsSignatures.ps1'
$signatureOptions = @{ SignTool = $SignTool; PublisherSubject = $PublisherSubject }
if ($CertificateThumbprint) { $signatureOptions.CertificateThumbprint = $CertificateThumbprint }
$signatureEvidence = [ordered]@{}
if ($signingRequested) {
    $signatureEvidence.quiver_exe = & $signatureVerifier -Path $sourceExe @signatureOptions
}

$null = New-Item -ItemType Directory -Path $destination
$packageRoot = Join-Path $destination 'QuiverPortable'
$applicationRoot = Join-Path $packageRoot 'App/Quiver'
$appInfo = Join-Path $packageRoot 'App/AppInfo'
$sourceRoot = Join-Path $packageRoot 'Other/Source'
$stagedTool = Join-Path $destination 'installer-tool'
$manifestPath = Join-Path $destination 'build-manifest.json'
$artifactPath = Join-Path $destination "QuiverPortable_${displayVersion}_English.paf.exe"
$manifest = [ordered]@{
    schema_version = 1
    application = 'Quiver Portable'
    version = $displayVersion
    package_version = $packageVersion
    preflight = [ordered]@{
        operating_system = [Environment]::OSVersion.VersionString
        host_architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
        unpacked_application = $unpacked
        output_directory = $destination
        free_bytes = ([IO.DriveInfo]::new([IO.Path]::GetPathRoot($destination))).AvailableFreeSpace
    }
    inputs = [ordered]@{
        exe_sha256 = (Get-FileHash -LiteralPath $sourceExe).Hash
        asar_sha256 = (Get-FileHash -LiteralPath $sourceAsar).Hash
        icon_sha256 = (Get-FileHash -LiteralPath $icon).Hash
        banner_sha256 = (Get-FileHash -LiteralPath $banner).Hash
    }
    dependencies = '64-bit Windows. Electron runtime is included.'
    settings_map = 'The launcher sets PORTABLE_EXECUTABLE_DIR for the child process. Quiver stores its profile in Data.'
    tools = @(
        @{ path = $sourceWizard; version = (Get-Item -LiteralPath $sourceWizard).VersionInfo.ProductVersion; sha256 = (Get-FileHash -LiteralPath $sourceWizard).Hash }
        @{ path = $sourceCompiler; sha256 = (Get-FileHash -LiteralPath $sourceCompiler).Hash }
        @{ path = $sourceExtractor; sha256 = (Get-FileHash -LiteralPath $sourceExtractor).Hash }
    )
    build_steps = [Collections.Generic.List[object]]::new()
    configurations = [ordered]@{}
    verification = [ordered]@{
        installer_archive = 'unrun'
        installer_icons = 'unrun'
        installer_banner = 'unrun'
        installation = 'unrun'
        runtime_portability = 'unrun'
    }
    artifact = $null
    result_level = $null
}
if ($signingRequested) { $manifest.signatures = $signatureEvidence }

function Invoke-SigningStep([string]$Path) {
    $PSNativeCommandUseErrorActionPreference = $true
    & $SignFile $Path | Out-Null
    & $signatureVerifier -Path $Path @signatureOptions
}

function Invoke-PackagingStep {
    param([string]$Name, [string]$Executable, [string[]]$Arguments, [string]$Directory, [int]$Seconds = 600)
    $stdoutPath = Join-Path $destination "$Name.stdout.log"
    $stderrPath = Join-Path $destination "$Name.stderr.log"
    $record = [ordered]@{ step = $Name; executable = $Executable; arguments = $Arguments; directory = $Directory; stdout = $stdoutPath; stderr = $stderrPath; exit_code = $null }
    $manifest.build_steps.Add($record)
    $info = [Diagnostics.ProcessStartInfo]::new($Executable)
    $info.WorkingDirectory = $Directory
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    foreach ($arg in $Arguments) { $info.ArgumentList.Add($arg) }
    $process = [Diagnostics.Process]::Start($info)
    try {
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (!$process.WaitForExit($Seconds * 1000)) {
            $process.Kill($true)
            $process.WaitForExit()
            throw "$Name exceeded $Seconds seconds."
        }
        $record.exit_code = $process.ExitCode
        if ($process.ExitCode -ne 0) { throw "$Name exited $($process.ExitCode). See $stderrPath and $stdoutPath." }
    } finally {
        [IO.File]::WriteAllText($stdoutPath, $stdout.GetAwaiter().GetResult())
        [IO.File]::WriteAllText($stderrPath, $stderr.GetAwaiter().GetResult())
        $process.Dispose()
    }
}

function Write-MenuIcon {
    param([Drawing.Image]$Image, [int]$Size)
    $bitmap = [Drawing.Bitmap]::new($Size, $Size, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.CompositingMode = [Drawing.Drawing2D.CompositingMode]::SourceCopy
        $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.DrawImage($Image, [Drawing.Rectangle]::new(0, 0, $Size, $Size))
        $bitmap.Save((Join-Path $appInfo "appicon_${Size}.png"), [Drawing.Imaging.ImageFormat]::Png)
    } finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

try {
    $null = New-Item -ItemType Directory -Path $appInfo, $sourceRoot, (Join-Path $packageRoot 'Data'), $stagedTool
    Copy-Item -LiteralPath $unpacked -Destination $applicationRoot -Recurse
    if ($signingRequested -and
        (Get-FileHash -LiteralPath (Join-Path $applicationRoot 'Quiver.exe')).Hash -cne $signatureEvidence.quiver_exe.sha256) {
        throw 'The staged Quiver.exe differs from the signature-verified input.'
    }
    Copy-Item -LiteralPath (Join-Path $toolsRoot 'App'), $sourceWizard -Destination $stagedTool -Recurse
    Copy-Item -LiteralPath (Join-Path $repository 'LICENSE'), (Join-Path $templates 'QuiverPortable.nsi') -Destination $sourceRoot
    Copy-Item -LiteralPath $installerLicense -Destination (Join-Path $sourceRoot 'PortableApps.comInstaller-License.txt')
    Copy-Item -LiteralPath (Join-Path $templates 'help.html') -Destination $packageRoot
    Copy-Item -LiteralPath $icon -Destination (Join-Path $appInfo 'appicon.ico')
    Copy-Item -LiteralPath (Join-Path $templates 'installer.ini') -Destination $appInfo
    $appMetadata = (Get-Content -Raw -LiteralPath (Join-Path $templates 'appinfo.ini')).Replace('@PACKAGE_VERSION@', $packageVersion).Replace('@DISPLAY_VERSION@', $displayVersion)
    Set-Content -LiteralPath (Join-Path $appInfo 'appinfo.ini') -Value $appMetadata -Encoding ascii

    Add-Type -AssemblyName System.Drawing
    $image = [Drawing.Image]::FromFile((Join-Path $repository 'build/icon.png'))
    try { foreach ($size in @(16, 32, 75, 128, 256)) { Write-MenuIcon $image $size } }
    finally { $image.Dispose() }

    $wizard = Join-Path $stagedTool 'PortableApps.comInstaller.exe'
    $compiler = Join-Path $stagedTool 'App/nsis/makensis.exe'
    $extractor = Join-Path $stagedTool 'App/7zip/7z.exe'
    $launcher = Join-Path $packageRoot 'QuiverPortable.exe'
    $launcherSource = Join-Path $sourceRoot 'QuiverPortable.nsi'
    Invoke-PackagingStep 'compile-launcher' $compiler @("/DOUTPUT=$launcher", "/DAPP_ICON=$icon", $launcherSource) $sourceRoot
    if ($signingRequested) { $signatureEvidence.launcher = Invoke-SigningStep $launcher }
    Invoke-PackagingStep 'generate-installer' $wizard @($packageRoot) $stagedTool
    $installerSource = Join-Path $sourceRoot 'PortableApps.comInstaller.nsi'
    $generatedConfig = Join-Path $sourceRoot 'PortableApps.comInstallerConfig.nsh'
    if (!(Test-Path -LiteralPath $artifactPath -PathType Leaf)) { throw 'The wizard did not produce the expected installer. See installer-tool/Data/PortableApps.comInstallerLog.txt.' }
    foreach ($file in @($installerSource, $generatedConfig, $launcherSource, (Join-Path $appInfo 'appinfo.ini'), (Join-Path $appInfo 'installer.ini'))) {
        $manifest.configurations[[IO.Path]::GetRelativePath($packageRoot, $file)] = (Get-FileHash -LiteralPath $file).Hash
    }

    # Recompile with Quiver artwork using the wizard's generated source and configuration.
    Copy-Item -LiteralPath $icon -Destination (Join-Path $sourceRoot 'PortableApps.comInstaller.ico') -Force
    Copy-Item -LiteralPath $banner -Destination (Join-Path $sourceRoot 'PortableApps.comInstaller.bmp') -Force
    Invoke-PackagingStep 'compile-installer' $compiler @($installerSource) $sourceRoot
    if ($signingRequested) { $signatureEvidence.installer = Invoke-SigningStep $artifactPath }
    Invoke-PackagingStep 'inspect-installer' $extractor @('l', '-slt', $artifactPath) $destination
    $listing = Get-Content -Raw -LiteralPath (Join-Path $destination 'inspect-installer.stdout.log')
    if ($listing -notmatch '(?m)^Type = Nsis\s*$' -or
        $listing -notmatch 'QuiverPortable\.exe' -or
        $listing -notmatch 'App[\\/]Quiver[\\/]resources[\\/]app\.asar') {
        throw 'The compiled installer does not contain the expected NSIS payload.'
    }
    $installerIconRoot = Join-Path $destination 'installer-icons'
    $launcherIconRoot = Join-Path $destination 'launcher-icons'
    $iconPatterns = @('.rsrc\ICON\*', '.rsrc\GROUP_ICON\*')
    Invoke-PackagingStep 'extract-installer-icons' $extractor (@('x', '-tPE', "-o$installerIconRoot", $artifactPath) + $iconPatterns) $destination
    Invoke-PackagingStep 'extract-launcher-icons' $extractor (@('x', '-tPE', "-o$launcherIconRoot", $launcher) + $iconPatterns) $destination
    $launcherIcons = @(Get-ChildItem -LiteralPath $launcherIconRoot -File -Recurse)
    $installerIcons = @(Get-ChildItem -LiteralPath $installerIconRoot -File -Recurse)
    if ($launcherIcons.Count -lt 2 -or $launcherIcons.Count -ne $installerIcons.Count) {
        throw 'The launcher and installer expose different icon resources.'
    }
    foreach ($frame in $launcherIcons) {
        $matching = Join-Path $installerIconRoot ([IO.Path]::GetRelativePath($launcherIconRoot, $frame.FullName))
        if ((Get-FileHash -LiteralPath $frame.FullName).Hash -cne (Get-FileHash -LiteralPath $matching).Hash) {
            throw "Installer icon resource differs from the Quiver launcher. $($frame.Name)"
        }
    }
    $manifest.verification.installer_icons = 'passed'

    $bannerRoot = Join-Path $destination 'installer-banner'
    Invoke-PackagingStep 'extract-installer-banner' $extractor @('x', '-tNsis', "-o$bannerRoot", $artifactPath, '$PLUGINSDIR\modern-wizard.bmp') $destination
    $embeddedBanner = Join-Path $bannerRoot '$PLUGINSDIR/modern-wizard.bmp'
    if ((Get-FileHash -LiteralPath $embeddedBanner).Hash -cne $manifest.inputs.banner_sha256) {
        throw 'The welcome and finish banner differs from Quiver artwork.'
    }
    $manifest.verification.installer_banner = 'passed'
    $artifact = Get-Item -LiteralPath $artifactPath
    $manifest.artifact = @{ path = $artifact.FullName; size = $artifact.Length; sha256 = (Get-FileHash -LiteralPath $artifact.FullName).Hash }
    $manifest.verification.installer_archive = 'passed'
    $manifest.result_level = 'Built'
    [pscustomobject]$manifest.artifact
} catch {
    $manifest.error = $_.Exception.Message
    throw
} finally {
    $manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding utf8
    Write-Host "Build manifest $manifestPath"
}
