param(
    [string]$OutDir = "$env:TEMP"
)

$ErrorActionPreference = "Stop"

function Require-Admin {
    $isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) {
        Write-Host "Execute este script como Administrador." -ForegroundColor Red
        exit 1
    }
}

Require-Admin

$api = "https://api.adoptium.net/v3/assets/feature_releases/17/ga?architecture=x64&heap_size=normal&image_type=jdk&jvm_impl=hotspot&os=windows"
$assets = Invoke-RestMethod $api
$asset = $assets | Select-Object -First 1
$installer = $asset.binaries | ForEach-Object { $_.installer } | Where-Object { $_ -and $_.link -match '\.msi$' } | Select-Object -First 1

if (-not $installer) {
    Write-Host "Nao foi possivel localizar o MSI do Temurin 17." -ForegroundColor Red
    exit 1
}

$msiUrl  = $installer.link
$msiName = $installer.name
$msiPath = Join-Path $OutDir $msiName

Write-Host "Baixando: $msiUrl"
Invoke-WebRequest -Uri $msiUrl -OutFile $msiPath

Write-Host "Instalando: $msiPath"
Start-Process msiexec.exe -Wait -ArgumentList "/i `"$msiPath`" ADDLOCAL=FeatureMain,FeatureEnvironment,FeatureJarFileRunWith,FeatureJavaHome /quiet /norestart"

Write-Host "OK. Se o PATH/JavaHome nao atualizar, feche e reabra o PowerShell."
