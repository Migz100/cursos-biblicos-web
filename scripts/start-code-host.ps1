$ErrorActionPreference = 'Stop'
$HostRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$StatePath = Join-Path $HostRoot 'state'
$LogPath = Join-Path $StatePath 'host.log'
$OldLogPath = Join-Path $StatePath 'host.previous.log'
$ConfigPath = Join-Path $HostRoot 'config.env'
$NodePath = (Get-Command node.exe -ErrorAction Stop).Source
$HostScript = Join-Path $PSScriptRoot 'code-host.mjs'

if (-not (Test-Path -LiteralPath $ConfigPath)) { throw "Private host config is missing: $ConfigPath" }
if (-not (Test-Path -LiteralPath $HostScript)) { throw "Installed host runtime is missing: $HostScript" }
New-Item -ItemType Directory -Path $StatePath -Force | Out-Null
if ((Test-Path -LiteralPath $LogPath) -and (Get-Item -LiteralPath $LogPath).Length -gt 5MB) {
  Move-Item -LiteralPath $LogPath -Destination $OldLogPath -Force
}

Set-Location -LiteralPath $PSScriptRoot
while ($true) {
  $env:CODE_HOST_CONFIG = $ConfigPath
  & $NodePath $HostScript *>> $LogPath
  Start-Sleep -Seconds 5
}
