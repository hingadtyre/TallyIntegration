param([ValidateSet('Live','Demo','Build','Test','Check','Format','Lint','Verify')][string]$Mode = 'Live')
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$originalPath = $env:PATH
Push-Location -LiteralPath $repoRoot
try {
    $localNode = Join-Path $repoRoot '.tools\node-v24.22.2-win-x64\node.exe'
    $nodeCommand = if (Test-Path -LiteralPath $localNode) { $localNode } else { (Get-Command node -ErrorAction Stop).Source }
    $nodeVersion = & $nodeCommand --version
    if ($nodeVersion -notmatch '^v24\.') { throw 'This app requires Node.js 24 LTS. Your other projects do not need to change.' }
    if (-not (Test-Path -LiteralPath 'node_modules\typescript\bin\tsc')) { throw 'Install the dependencies with Node.js 24 and npm ci first. See README.md.' }
    $nodeFolder = Split-Path -Parent $nodeCommand
    $npmCli = Join-Path $nodeFolder 'node_modules\npm\bin\npm-cli.js'
    if (-not (Test-Path -LiteralPath $npmCli)) { throw 'The selected Node.js installation must include npm.' }
    # npm scripts must use the same Node version, without changing the user's global PATH.
    $env:PATH = $nodeFolder + ';' + $originalPath
    $scriptName = switch ($Mode) {
        'Live' { 'start' }
        'Demo' { 'demo' }
        default { $Mode.ToLowerInvariant() }
    }
    if ($Mode -in @('Live','Demo') -and -not (Test-Path -LiteralPath 'dist\web\index.html')) {
        throw 'Build the app first: .\scripts\app.ps1 -Mode Build'
    }
    & $nodeCommand $npmCli run $scriptName
    if ($LASTEXITCODE -ne 0) { throw "$Mode failed." }
} finally {
    $env:PATH = $originalPath
    Pop-Location
}
