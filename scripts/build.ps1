param([string]$Go = 'go')

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent

Push-Location (Join-Path $projectRoot 'web')
try {
    pnpm build:web
    if ($LASTEXITCODE) { throw '音乐站构建失败' }
} finally { Pop-Location }

Push-Location (Join-Path $projectRoot 'backend/ui')
try {
    $workboxTarget = Join-Path (Get-Location) 'public/3rdparty/workbox'
    New-Item -ItemType Directory -Path $workboxTarget -Force | Out-Null
    foreach ($module in @('sw', 'core', 'strategies', 'routing', 'navigation-preload', 'precaching')) {
        $filename = if ($module -eq 'sw') { 'workbox-sw.js' } else { "workbox-$module.prod.js" }
        Copy-Item -LiteralPath "node_modules/workbox-$module/build/$filename" -Destination $workboxTarget
    }
    npm run build
    if ($LASTEXITCODE) { throw '管理界面构建失败' }
} finally { Pop-Location }

Push-Location (Join-Path $projectRoot 'backend')
try {
    & $Go build -v -tags 'netgo,sqlite_fts5' -o navidrome.exe .
    if ($LASTEXITCODE) { throw '后端构建失败' }
} finally { Pop-Location }
