#requires -Version 7.0
param([Parameter(Mandatory)][string]$Workspace)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
if (!$IsWindows -or $env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted') {
    throw 'This fixture requires a disposable GitHub-hosted Windows runner.'
}
$testRoot = (Get-Item -LiteralPath $env:RUNNER_TEMP).FullName
$relative = [IO.Path]::GetRelativePath($testRoot, [IO.Path]::GetFullPath($Workspace))
if ($relative -eq '.' -or $relative -match '^\.\.([\\/]|$)' -or [IO.Path]::IsPathRooted($relative)) {
    throw 'The test workspace must be inside RUNNER_TEMP.'
}

$quiverProfile = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Quiver'
$chromeProfile = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data\Profile 98765'
foreach ($path in $Workspace, $quiverProfile, $chromeProfile) {
    if (Test-Path -LiteralPath $path) { throw 'Unexpected pre-existing test path.' }
}

$null = New-Item -ItemType Directory -Path $Workspace
$setup = Join-Path $Workspace 'Quiver-v0.1.0-beta.2-x64-Setup.exe'
$url = 'https://github.com/SeanShaffer88/Quiver-Browser/releases/download/v0.1.0-beta.2/Quiver-v0.1.0-beta.2-x64-Setup.exe'
curl.exe --fail --location --silent --show-error --proto '=https' --proto-redir '=https' --retry 2 --max-time 150 --output $setup $url
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $setup).Hash.ToLowerInvariant()
if ($hash -cne '962cab97ae034f5357c940bafdc412b19f5451e73e1c49937edbf82bb66e7f10') {
    throw 'Released installer SHA-256 mismatch.'
}

$null = New-Item -ItemType Directory -Path $quiverProfile, $chromeProfile
@'
{"version":1,"spaces":[{"id":"space-main","name":"Main","color":"#5b8cff","isolated":false}],"activeSpaceId":"space-main","tabsBySpace":{},"activeIndexBySpace":{},"settings":{"devServerScan":false}}
'@ | Set-Content -LiteralPath (Join-Path $quiverProfile 'quiver-state.json') -Encoding utf8

@'
{"roots":{"bookmark_bar":{"type":"folder","children":[{"type":"url","name":"Quiver fixture profile one","url":"https://example.invalid/chrome-one"},{"type":"url","name":"Quiver fixture profile two","url":"https://example.invalid/chrome-two"},{"type":"url","name":"Duplicate profile one","url":"https://example.invalid/chrome-one"},{"type":"url","name":"Unsupported local file","url":"file:///C:/fixture.txt"}]}}}
'@ | Set-Content -LiteralPath (Join-Path $chromeProfile 'Bookmarks') -Encoding utf8

@'
<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><A HREF="https://example.invalid/html-one">Quiver fixture export &amp; one</A>
    <DT><A HREF="https://example.invalid/chrome-two">Duplicate profile two</A>
    <DT><A HREF="file:///C:/fixture.txt">Unsupported local file</A>
</DL><p>
'@ | Set-Content -LiteralPath (Join-Path $Workspace 'bookmarks.html') -Encoding utf8

[pscustomobject]@{
    installerSha256 = $hash
    source = $url
    chromeProfile = 'Profile 98765'
    installedProfile = $quiverProfile
    expectedProfileBookmarks = 2
    expectedNewHtmlBookmarks = 1
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Workspace 'fixture.json') -Encoding utf8
Write-Host "Verified published setup SHA-256 $hash and wrote synthetic bookmark fixtures."
