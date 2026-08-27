$ErrorActionPreference = 'Stop'
$HostRoot = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'CursosBiblicosCodeHost'))
$RuntimeRoot = [System.IO.Path]::GetFullPath((Join-Path $HostRoot 'runtime'))
$ConfigPath = [System.IO.Path]::GetFullPath((Join-Path $HostRoot 'config.env'))
$ExpectedRoot = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'CursosBiblicosCodeHost'))
$TaskName = 'Cursos Biblicos Code Host'

if (-not $RuntimeRoot.StartsWith($ExpectedRoot, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Runtime path escaped the private host directory.' }
if (-not (Test-Path -LiteralPath $ConfigPath)) { throw 'Run npm run code-host:setup before installing the background host.' }
New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'code-host.mjs') -Destination (Join-Path $RuntimeRoot 'code-host.mjs') -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'start-code-host.ps1') -Destination (Join-Path $RuntimeRoot 'start-code-host.ps1') -Force

$Starter = Join-Path $RuntimeRoot 'start-code-host.ps1'
$PowerShellPath = (Get-Command powershell.exe -ErrorAction Stop).Source
$Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Starter`""
$Action = New-ScheduledTaskAction -Execute $PowerShellPath -Argument $Arguments -WorkingDirectory $RuntimeRoot
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 0)

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Description 'Runs the private Cursos Biblicos coding bridge for the family editor.' -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Output "Installed immutable runtime and started scheduled task: $TaskName"
