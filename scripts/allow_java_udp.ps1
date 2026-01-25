param(
    [string]$JavaPath = ""
)

$ErrorActionPreference = "Stop"

function Require-Admin {
    $isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) {
        Write-Host "Execute este script como Administrador." -ForegroundColor Red
        exit 1
    }
}

function Find-JavaForJForex {
    # Try pid file first (server managed by dukascopy-api)
    $root = Split-Path -Parent $PSScriptRoot
    $pidFile = Join-Path $root ".runtime\\run\\server.pid"
    if (Test-Path $pidFile) {
        try {
            $pid = (Get-Content $pidFile -ErrorAction Stop | Select-Object -First 1).Trim()
            if ($pid -match "^[0-9]+$") {
                $p = Get-CimInstance Win32_Process -Filter "ProcessId=$pid" | Select-Object -First 1
                if ($p -and $p.ExecutablePath) { return $p.ExecutablePath }
            }
        } catch { }
    }

    # Fallback: search by command line containing the JAR
    $proc = Get-CimInstance Win32_Process | Where-Object {
        $_.CommandLine -match "jforex-websocket-api-1.0.0.jar"
    } | Select-Object -First 1
    if (-not $proc) { return $null }
    return $proc.ExecutablePath
}

Require-Admin

$javaPath = if ($JavaPath) { $JavaPath } else { Find-JavaForJForex }
if (-not $javaPath) {
    # Try JAVA_HOME or PATH
    if ($env:JAVA_HOME) {
        $candidate = Join-Path $env:JAVA_HOME "bin\\java.exe"
        if (Test-Path $candidate) { $javaPath = $candidate }
    }
    if (-not $javaPath) {
        $cmd = Get-Command java -ErrorAction SilentlyContinue
        if ($cmd -and $cmd.Source) { $javaPath = $cmd.Source }
    }
}
if (-not $javaPath) {
    Write-Host "Nao encontrei o java.exe do servidor." -ForegroundColor Red
    Write-Host "Opcoes:"
    Write-Host "1) Inicie o servidor: node .\\bin\\dukascopy-api.js server up"
    Write-Host "2) Ou rode passando o caminho: .\\scripts\\allow_java_udp.ps1 -JavaPath \"C:\\\\caminho\\\\java.exe\""
    exit 1
}

Write-Host "Java detectado: $javaPath"

# UDP outbound
New-NetFirewallRule -DisplayName "Dukascopy Java UDP Out" `
    -Direction Outbound -Program $javaPath -Protocol UDP -Action Allow -Profile Any `
    -ErrorAction SilentlyContinue | Out-Null

# TCP outbound (opcional)
New-NetFirewallRule -DisplayName "Dukascopy Java TCP Out" `
    -Direction Outbound -Program $javaPath -Protocol TCP -Action Allow -Profile Any `
    -ErrorAction SilentlyContinue | Out-Null

Write-Host "Regras criadas/atualizadas."
