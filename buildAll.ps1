param(
    [string[]]$Targets = @(
        "x86_64-pc-windows-gnu"
        "x86_64-unknown-linux-gnu"
        "arm-unknown-linux-gnueabihf"
        "aarch64-unknown-linux-gnu"
    ),
    [string]$OutputDir = "./finalOutput"
)

$ErrorActionPreference = "Stop"

$metadataJson = cargo metadata --format-version 1 --no-deps
if ($LASTEXITCODE -ne 0) {
    throw "cargo metadata failed"
}
$metadata = $metadataJson | ConvertFrom-Json
$targetDir = $metadata.target_directory

New-Item -ItemType Directory $OutputDir -Force | Out-Null
$outputDir = (Resolve-Path $OutputDir).Path

$moonlightRoot = (Resolve-Path ".").Path
$moonlightFrontend = Join-Path -Path $moonlightRoot -ChildPath "moonlight-web/web-server"
$frontendStaticDir = Join-Path -Path $outputDir -ChildPath "_frontend-static"

function Get-BuildAssetHash {
    param(
        [Parameter(Mandatory = $true)]
        [string]$distDir
    )

    $fileHashes = Get-ChildItem -Path $distDir -Recurse -File |
        Sort-Object FullName |
        ForEach-Object { (Get-FileHash -Path $_.FullName -Algorithm SHA256).Hash }

    $combined = [string]::Join("", $fileHashes)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($combined)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $digest = $sha.ComputeHash($bytes)
    }
    finally {
        $sha.Dispose()
    }

    return ([System.BitConverter]::ToString($digest).Replace("-", "").ToLower()).Substring(0, 12)
}

function Add-CacheBustToReferences {
    param(
        [Parameter(Mandatory = $true)]
        [string]$distDir,

        [Parameter(Mandatory = $true)]
        [string]$versionHash
    )

    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    $textExt = @(".html", ".js", ".mjs", ".css")

    $appendVersion = {
        param($match)

        $prefix = $match.Groups["prefix"].Value
        $path = $match.Groups["path"].Value
        $query = $match.Groups["query"].Value
        $suffix = $match.Groups["suffix"].Value

        if ($path -match "^(https?:|data:|blob:|//|#)") {
            return $match.Value
        }

        $newQuery = ""
        if ([string]::IsNullOrEmpty($query)) {
            $newQuery = "?v=$versionHash"
        }
        elseif ($query -match "(^|[?&])v=") {
            $newQuery = $query
        }
        else {
            $newQuery = "$query&v=$versionHash"
        }

        return "$prefix$path$newQuery$suffix"
    }

    $assetExtensions = "(?:js|mjs|css|json|wasm|svg|png|wav)"
    $patterns = @(
        ('(?<prefix>(?:src|href)\s*=\s*["''])(?<path>(?!https?:|data:|blob:|//|#)[^"''\?]+?\.{0})(?<query>\?[^"'']*)?(?<suffix>["''])' -f $assetExtensions),
        ('(?<prefix>(?:from\s+|import\s*\(\s*)["''])(?<path>(?!https?:|data:|blob:|//|#)[^"''\?]+?\.{0})(?<query>\?[^"'']*)?(?<suffix>["''])' -f $assetExtensions),
        ('(?<prefix>url\(\s*["'']?)(?<path>(?!https?:|data:|blob:|//|#)[^"''\)\?]+?\.{0})(?<query>\?[^"''\)]*)?(?<suffix>["'']?\s*\))' -f $assetExtensions)
    )

    $files = Get-ChildItem -Path $distDir -Recurse -File | Where-Object { $textExt -contains $_.Extension.ToLower() }
    foreach ($file in $files) {
        $content = [System.IO.File]::ReadAllText($file.FullName)
        $updated = $content

        foreach ($pattern in $patterns) {
            $updated = [System.Text.RegularExpressions.Regex]::Replace($updated, $pattern, $appendVersion)
        }

        if ($updated -ne $content) {
            [System.IO.File]::WriteAllText($file.FullName, $updated, $utf8NoBom)
        }
    }
}

function Get-BuildExecutables {
    param(
        [Parameter(Mandatory = $true)]
        [object[]]$messages,

        [Parameter(Mandatory = $true)]
        [string]$target
    )

    $expectedNames = if ($target -like "*windows*") {
        @("web-server.exe", "streamer.exe")
    }
    else {
        @("web-server", "streamer")
    }

    $executables = $messages |
        Where-Object {
            $_.reason -eq "compiler-artifact" -and
            $_.executable -and
            @($_.target.kind) -contains "bin" -and
            -not $_.profile.test
        } |
        ForEach-Object { $_.executable } |
        Sort-Object -Unique

    $resolved = foreach ($expectedName in $expectedNames) {
        $match = $executables | Where-Object { [System.IO.Path]::GetFileName($_) -eq $expectedName }
        if (-not $match) {
            throw "Missing expected executable '$expectedName' for target '$target'"
        }
        @($match)[0]
    }

    return $resolved
}

function New-PackageDirectory {
    param(
        [Parameter(Mandatory = $true)]
        [string]$packageDir,

        [Parameter(Mandatory = $true)]
        [string[]]$binaryPaths,

        [Parameter(Mandatory = $true)]
        [string]$staticDir,

        [Parameter(Mandatory = $true)]
        [bool]$includeWindowsScripts
    )

    if (Test-Path $packageDir) {
        Remove-Item -Path $packageDir -Recurse -Force
    }
    New-Item -ItemType Directory $packageDir -Force | Out-Null

    foreach ($binaryPath in $binaryPaths) {
        if (-not (Test-Path $binaryPath)) {
            throw "Binary not found: $binaryPath"
        }
        Copy-Item -Path $binaryPath -Destination (Join-Path $packageDir ([System.IO.Path]::GetFileName($binaryPath))) -Force
    }

    Copy-Item -Path $staticDir -Destination (Join-Path $packageDir "static") -Recurse -Force

    if ($includeWindowsScripts) {
        Copy-Item -Path (Join-Path $moonlightRoot "setup.ps1") -Destination (Join-Path $packageDir "setup.ps1") -Force
        Copy-Item -Path (Join-Path $moonlightRoot "acme-certificate.ps1") -Destination (Join-Path $packageDir "acme-certificate.ps1") -Force
    }
}

function Assert-PackageLayout {
    param(
        [Parameter(Mandatory = $true)]
        [string]$packageDir,

        [Parameter(Mandatory = $true)]
        [string]$target
    )

    $required = @(
        "static"
        if ($target -like "*windows*") { "web-server.exe" } else { "web-server" }
        if ($target -like "*windows*") { "streamer.exe" } else { "streamer" }
    )

    if ($target -like "*windows*") {
        $required += @("setup.ps1", "acme-certificate.ps1")
    }

    foreach ($name in $required) {
        $path = Join-Path $packageDir $name
        if (-not (Test-Path $path)) {
            throw "Package for '$target' is missing '$name'"
        }
    }
}

function New-ArchiveFromPackageDirectory {
    param(
        [Parameter(Mandatory = $true)]
        [string]$packageDir,

        [Parameter(Mandatory = $true)]
        [string]$archiveBasePath,

        [Parameter(Mandatory = $true)]
        [string]$target
    )

    Push-Location $packageDir
    try {
        if ($target -like "*windows*") {
            $zipDestination = "${archiveBasePath}.zip"
            if (Test-Path $zipDestination) {
                Remove-Item $zipDestination -Force
            }
            7z a -tzip $zipDestination ./* -y
            if ($LASTEXITCODE -ne 0) {
                throw "7z zip failed for '$target'"
            }
            return $zipDestination
        }

        $tarDestination = "${archiveBasePath}.tar"
        $gzDestination = "${archiveBasePath}.tar.gz"
        if (Test-Path $tarDestination) {
            Remove-Item $tarDestination -Force
        }
        if (Test-Path $gzDestination) {
            Remove-Item $gzDestination -Force
        }

        7z a -ttar $tarDestination ./* -y
        if ($LASTEXITCODE -ne 0) {
            throw "7z tar failed for '$target'"
        }
        7z a -tgzip $gzDestination $tarDestination -y
        if ($LASTEXITCODE -ne 0) {
            throw "7z gzip failed for '$target'"
        }
        Remove-Item $tarDestination -Force
        return $gzDestination
    }
    finally {
        Pop-Location
    }
}

if (-not $moonlightRoot -or -not $moonlightFrontend) {
    throw "No root directory found"
}

Write-Output "Target directory at $targetDir"
Write-Output "Putting final output into $outputDir"
Write-Output "Moonlight Root Directory $moonlightRoot"

Get-ChildItem -Path $outputDir -Force | Remove-Item -Recurse -Force

Write-Output "------------- Starting Build for Frontend -------------"
Set-Location $moonlightFrontend

if (Test-Path "$moonlightFrontend/dist") {
    Remove-Item -Path "$moonlightFrontend/dist" -Recurse -Force
}
$env:CARGO_TERM_COLOR = "never"
npm run build
if ($LASTEXITCODE -ne 0) {
    throw "Frontend build failed"
}

$frontendDist = Join-Path -Path $moonlightFrontend -ChildPath "dist"
$assetHash = Get-BuildAssetHash -distDir $frontendDist
Write-Output "Applying frontend cache-bust hash: $assetHash"
Add-CacheBustToReferences -distDir $frontendDist -versionHash $assetHash

if (Test-Path $frontendStaticDir) {
    Remove-Item -Path $frontendStaticDir -Recurse -Force
}
Copy-Item -Path $frontendDist -Destination $frontendStaticDir -Recurse -Force
Write-Output "------------- Finished Build for Frontend -------------"

Set-Location $moonlightRoot

foreach ($target in $Targets) {
    Write-Output "------------- Starting Build for $target -------------"
    $messages = cross build --release --target $target --message-format=json 2>&1 | ForEach-Object {
        if ($_ -is [System.Management.Automation.ErrorRecord]) {
            Write-Host $_.Exception.Message
            return
        }
        try { $_ | ConvertFrom-Json } catch { Write-Host $_; return }
    }
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
    Write-Output "------------- Finished Build for $target -------------"

    $binaryPaths = Get-BuildExecutables -messages $messages -target $target
    $binaryPaths | ForEach-Object { Write-Host "Binary: $_" }

    Write-Output "------------- Starting Packaging for $target -------------"
    $packageDir = Join-Path $outputDir "$target-package"
    New-PackageDirectory `
        -packageDir $packageDir `
        -binaryPaths $binaryPaths `
        -staticDir $frontendStaticDir `
        -includeWindowsScripts ($target -like "*windows*")

    Assert-PackageLayout -packageDir $packageDir -target $target

    $archiveName = Join-Path $outputDir "moonlight-web-$target"
    $archivePath = New-ArchiveFromPackageDirectory -packageDir $packageDir -archiveBasePath $archiveName -target $target
    Write-Output "Created archive at $archivePath"
    Write-Output "------------- Finished Packaging for $target -------------"
}

Write-Output "Finished!"
