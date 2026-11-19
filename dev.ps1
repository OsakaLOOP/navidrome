<#
.SYNOPSIS
    ndFork 本地开发服务器启动入口。
.EXAMPLE
    ./dev.ps1              # 同时启动后端与 Web 前端
    ./dev.ps1 api          # 仅启动后端（别名: backend）
    ./dev.ps1 web          # 仅启动 Web 前端（别名: frontend）
#>
param(
    [Parameter(Position = 0)]
    [ValidateSet('all', 'api', 'backend', 'web', 'frontend')]
    [string]$Target = 'all',

    [string]$Config
)

$ErrorActionPreference = 'Stop'
$repoRoot = $PSScriptRoot

function Resolve-ConfigPath {
    param([string]$InputPath)

    if (-not $InputPath) {
        $resolved = Join-Path $repoRoot '.local/navidrome.toml'
    } elseif ([System.IO.Path]::IsPathRooted($InputPath)) {
        $resolved = $InputPath
    } else {
        $resolved = Join-Path $repoRoot $InputPath
    }

    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
        throw "未找到配置文件: $resolved（可复制 backend/ndfork.example.toml 或通过 -Config 指定）"
    }
    return (Resolve-Path -LiteralPath $resolved).Path
}

function Set-BackendEnv {
    $saved = @{
        Path       = $env:Path
        CgoEnabled = $env:CGO_ENABLED
    }

    $toolBins = @(
        (Join-Path $repoRoot '.tools/go/bin'),
        (Join-Path $repoRoot '.tools/w64devkit/bin')
    ) | Where-Object { Test-Path -LiteralPath $_ -PathType Container }

    if ($toolBins.Count -gt 0) {
        $currentEntries = $env:Path -split ';'
        $prepend = $toolBins | Where-Object { $currentEntries -notcontains $_ }
        if ($prepend.Count -gt 0) {
            $env:Path = ($prepend -join ';') + ';' + $env:Path
        }
    }

    $env:CGO_ENABLED = '1'
    return $saved
}

function Restore-BackendEnv {
    param([hashtable]$Saved)

    if (-not $Saved) { return }
    $env:Path = $Saved.Path
    if ($null -eq $Saved.CgoEnabled) {
        Remove-Item Env:CGO_ENABLED -ErrorAction SilentlyContinue
    } else {
        $env:CGO_ENABLED = $Saved.CgoEnabled
    }
}

function Resolve-ToolCommand {
    param([string[]]$Candidates, [string]$Label)

    foreach ($name in $Candidates) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($cmd) { return $cmd.Source }
    }
    throw "未找到 $Label，请检查本机环境或 .tools 工具链"
}

function Stop-ProcessTree {
    param([System.Diagnostics.Process]$Process)

    if ($null -eq $Process) { return }
    try {
        if (-not $Process.HasExited) {
            & taskkill.exe /T /F /PID $Process.Id *> $null
        }
    } catch {
        # 进程可能已在退出途中
    }
}

$normalizedTarget = switch ($Target) {
    'backend'  { 'api' }
    'frontend' { 'web' }
    default    { $Target }
}

$savedEnv = $null
try {
    if ($normalizedTarget -in @('all', 'api')) {
        $savedEnv = Set-BackendEnv
        $configPath = Resolve-ConfigPath -InputPath $Config
        $goExe = Resolve-ToolCommand -Candidates @('go.exe', 'go') -Label 'Go'
        $backendArgs = @('-C', 'backend', 'run', '-tags', 'netgo,sqlite_fts5', '.', '--configfile', $configPath)
    }

    if ($normalizedTarget -in @('all', 'web')) {
        $pnpmExe = Resolve-ToolCommand -Candidates @('pnpm.cmd', 'pnpm.exe', 'pnpm') -Label 'pnpm'
        $webArgs = @('--dir', 'web', 'dev:web')
    }

    if ($normalizedTarget -eq 'api') {
        Write-Host "启动后端开发服务 (配置: $configPath)" -ForegroundColor Cyan
        Write-Host '管理界面: http://127.0.0.1:4533/app/' -ForegroundColor DarkGray
        Push-Location $repoRoot
        try {
            & $goExe @backendArgs
            exit $LASTEXITCODE
        } finally {
            Pop-Location
        }
    }

    if ($normalizedTarget -eq 'web') {
        Write-Host '启动 Web 前端开发服务: http://127.0.0.1:5173' -ForegroundColor Cyan
        Push-Location $repoRoot
        try {
            & $pnpmExe @webArgs
            exit $LASTEXITCODE
        } finally {
            Pop-Location
        }
    }

    Write-Host '同时启动后端与 Web 前端开发服务...' -ForegroundColor Cyan
    Write-Host '  Web 前端 (Vite HMR): http://127.0.0.1:5173' -ForegroundColor Green
    Write-Host '  后端接口与管理界面:   http://127.0.0.1:4533/app/' -ForegroundColor Green
    Write-Host '  按 Ctrl+C 停止全部服务' -ForegroundColor DarkGray

    $apiProc = $null
    $webProc = $null
    try {
        $apiProc = Start-Process -FilePath $goExe -ArgumentList $backendArgs -WorkingDirectory $repoRoot -NoNewWindow -PassThru
        $webProc = Start-Process -FilePath $pnpmExe -ArgumentList $webArgs -WorkingDirectory $repoRoot -NoNewWindow -PassThru

        while (-not $apiProc.HasExited -and -not $webProc.HasExited) {
            Start-Sleep -Milliseconds 250
        }

        if ($apiProc.HasExited) {
            Write-Warning "后端进程已退出 (退出码: $($apiProc.ExitCode))"
        }
        if ($webProc.HasExited) {
            Write-Warning "Web 前端进程已退出 (退出码: $($webProc.ExitCode))"
        }
    } finally {
        Stop-ProcessTree -Process $webProc
        Stop-ProcessTree -Process $apiProc
    }
} finally {
    Restore-BackendEnv -Saved $savedEnv
}
