$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$HostRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'data'))
$StatePath = Join-Path $HostRoot 'state'
$LogPath = Join-Path $StatePath 'host.log'
$OldLogPath = Join-Path $StatePath 'host.previous.log'
$ConfigPath = Join-Path $PSScriptRoot 'config.dpapi'
$HostScript = Join-Path $PSScriptRoot 'code-host.mjs'
$PathSnapshot = Join-Path $PSScriptRoot 'execution-path.txt'
$WrapperLogPath = Join-Path $PSScriptRoot 'wrapper.log'

New-Item -ItemType Directory -Path $StatePath -Force | Out-Null
try {
  if (-not (Test-Path -LiteralPath $PathSnapshot)) { throw "Installed execution path is missing: $PathSnapshot" }
  $env:PATH = [System.IO.File]::ReadAllText($PathSnapshot, [System.Text.Encoding]::UTF8)
  $NodePath = (Get-Command node.exe -ErrorAction Stop).Source
  if (-not (Test-Path -LiteralPath $ConfigPath)) { throw "Protected host config is missing: $ConfigPath" }
  if (-not (Test-Path -LiteralPath $HostScript)) { throw "Installed host runtime is missing: $HostScript" }
  $ProtectedConfig = [System.IO.File]::ReadAllBytes($ConfigPath)
  $ConfigBytes = [System.Security.Cryptography.ProtectedData]::Unprotect($ProtectedConfig, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  $ConfigText = [System.Text.Encoding]::UTF8.GetString($ConfigBytes)
  foreach ($RawLine in $ConfigText -split "`r?`n") {
    $Line = $RawLine.Trim()
    if (-not $Line -or $Line.StartsWith('#')) { continue }
    $Separator = $Line.IndexOf('=')
    if ($Separator -lt 1) { continue }
    $Name = $Line.Substring(0, $Separator).Trim()
    $Value = $Line.Substring($Separator + 1).Trim()
    [System.Environment]::SetEnvironmentVariable($Name, $Value, [System.EnvironmentVariableTarget]::Process)
  }
  [Array]::Clear($ProtectedConfig, 0, $ProtectedConfig.Length)
  [Array]::Clear($ConfigBytes, 0, $ConfigBytes.Length)
  $ConfigText = $null
  $env:CODE_HOST_ENV_ONLY = '1'
  $env:CODE_HOST_DATA_ROOT = $HostRoot
  Remove-Item Env:CODE_HOST_CONFIG -ErrorAction SilentlyContinue
  if ((Test-Path -LiteralPath $LogPath) -and (Get-Item -LiteralPath $LogPath).Length -gt 5MB) {
    Move-Item -LiteralPath $LogPath -Destination $OldLogPath -Force
  }

  Set-Location -LiteralPath $PSScriptRoot
  while ($true) {
    & $NodePath $HostScript *>> $LogPath
    Start-Sleep -Seconds 5
  }
} catch {
  $Timestamp = [DateTime]::UtcNow.ToString('o')
  [System.IO.File]::AppendAllText($WrapperLogPath, "[$Timestamp] Host wrapper failed: $($_.Exception.Message)`r`n", [System.Text.UTF8Encoding]::new($false))
  throw
}
