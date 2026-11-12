#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string[]]$Path,
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$SignTool,
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$PublisherSubject,
    [ValidatePattern('\A[0-9a-fA-F]{40}\z')][string]$CertificateThumbprint
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
if (!$IsWindows) { throw 'Windows is required for Authenticode verification.' }
if ([string]::IsNullOrWhiteSpace($PublisherSubject)) { throw 'Enter the full expected publisher certificate subject.' }

$tool = Get-Item -LiteralPath $SignTool
if ($tool -isnot [IO.FileInfo] -or $tool.Name -ine 'signtool.exe') {
    throw 'Specify the path to the installed Windows SDK signtool.exe.'
}

foreach ($filePath in $Path) {
    $file = Get-Item -LiteralPath $filePath
    if ($file -isnot [IO.FileInfo] -or $file.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) {
        throw "Expected an ordinary file to verify. $filePath"
    }
    # Keep the bytes stable while both Windows verifiers and the hash reader inspect them.
    $stream = [IO.File]::OpenRead($file.FullName)
    try {
        $signToolOutput = & $tool.FullName verify /pa /all /tw $file.FullName 2>&1
        $signToolExit = $LASTEXITCODE
        if ($signToolExit -ne 0) {
            throw "SignTool verification exited $signToolExit for $($file.FullName). $($signToolOutput -join ' ')"
        }
        $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
        $leaf = $signature.SignerCertificate
        if ($signature.Status -ne 'Valid' -or $signature.SignatureType -ne 'Authenticode' -or !$leaf) {
            throw "A valid embedded Authenticode signature is required. $($file.FullName)"
        }
        if ($leaf.Subject -ieq $leaf.Issuer) {
            throw "A non-self-issued signing certificate is required. $($file.FullName)"
        }
        if ($leaf.Subject -cne $PublisherSubject -or ($CertificateThumbprint -and $leaf.Thumbprint -ine $CertificateThumbprint)) {
            throw "The signing certificate does not match the expected publisher. $($file.FullName)"
        }
        if (!$signature.TimeStamperCertificate) {
            throw "A timestamp is required. $($file.FullName)"
        }

        [pscustomobject]@{
            path = $file.FullName
            sha256 = (Get-FileHash -InputStream $stream -Algorithm SHA256).Hash
            publisher_subject = $leaf.Subject
            certificate_thumbprint = $leaf.Thumbprint
            timestamped = $true
            sign_tool_exit_code = $signToolExit
        }
    } finally {
        $stream.Dispose()
    }
}
