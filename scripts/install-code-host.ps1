$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$HostRoot = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'CursosBiblicosCodeHost'))
$RepositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$RuntimeParent = [System.IO.Path]::GetFullPath((Join-Path $RepositoryRoot '..'))
$RuntimeRoot = [System.IO.Path]::GetFullPath((Join-Path $RuntimeParent '.cursos-biblicos-code-host-runtime'))
$ConfigPath = [System.IO.Path]::GetFullPath((Join-Path $HostRoot 'config.env'))
$EncryptedConfigPath = [System.IO.Path]::GetFullPath((Join-Path $RuntimeRoot 'config.dpapi'))
$PathSnapshot = [System.IO.Path]::GetFullPath((Join-Path $RuntimeRoot 'execution-path.txt'))
$ExpectedRoot = [System.IO.Path]::GetFullPath((Join-Path $RuntimeParent '.cursos-biblicos-code-host-runtime'))
$TaskName = 'Cursos Biblicos Code Host'

if (-not $RuntimeRoot.StartsWith($ExpectedRoot, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Runtime path escaped the private host directory.' }
if (-not (Test-Path -LiteralPath $ConfigPath)) { throw 'Run npm run code-host:setup before installing the background host.' }
$ExistingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($ExistingTask -and $ExistingTask.State -eq 'Running') {
  Stop-ScheduledTask -TaskName $TaskName
  $StopDeadline = [DateTime]::UtcNow.AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 250
    $ExistingTask = Get-ScheduledTask -TaskName $TaskName
  } while ($ExistingTask.State -eq 'Running' -and [DateTime]::UtcNow -lt $StopDeadline)
  if ($ExistingTask.State -eq 'Running') { throw 'The existing code host did not stop before the update.' }
}
$InstalledHostScript = [System.IO.Path]::GetFullPath((Join-Path $RuntimeRoot 'code-host.mjs'))
$OrphanedHosts = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine.IndexOf($InstalledHostScript, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
}
foreach ($HostProcess in $OrphanedHosts) {
  Stop-Process -Id $HostProcess.ProcessId -Force
}
New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'code-host.mjs') -Destination (Join-Path $RuntimeRoot 'code-host.mjs') -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'start-code-host.ps1') -Destination (Join-Path $RuntimeRoot 'start-code-host.ps1') -Force
[System.IO.File]::WriteAllText($PathSnapshot, $env:PATH, [System.Text.UTF8Encoding]::new($false))
$ConfigBytes = [System.IO.File]::ReadAllBytes($ConfigPath)
$ProtectedConfig = [System.Security.Cryptography.ProtectedData]::Protect($ConfigBytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[System.IO.File]::WriteAllBytes($EncryptedConfigPath, $ProtectedConfig)
[Array]::Clear($ConfigBytes, 0, $ConfigBytes.Length)
[Array]::Clear($ProtectedConfig, 0, $ProtectedConfig.Length)

$Starter = Join-Path $RuntimeRoot 'start-code-host.ps1'
$PowerShellPath = (Get-Command powershell.exe -ErrorAction Stop).Source
$Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Starter`""
$Action = New-ScheduledTaskAction -Execute $PowerShellPath -Argument $Arguments
$CurrentAccount = (whoami.exe).Trim()
$AclResult = & icacls.exe $RuntimeRoot '/inheritance:r' '/grant:r' "${CurrentAccount}:(OI)(CI)(F)" '*S-1-5-18:(OI)(CI)(F)' '*S-1-5-32-544:(OI)(CI)(F)'
if ($LASTEXITCODE -ne 0) { throw "Could not secure the installed runtime root: $AclResult" }
$ChildAclResult = & icacls.exe (Join-Path $RuntimeRoot '*') '/reset' '/t' '/c' '/q'
if ($LASTEXITCODE -ne 0) { throw "Could not secure the installed runtime files: $ChildAclResult" }
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $CurrentAccount
$Principal = New-ScheduledTaskPrincipal -UserId $CurrentAccount -LogonType Interactive -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 0)

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Description 'Runs the private Cursos Biblicos coding bridge for the family editor.' -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Output "Installed immutable runtime and started scheduled task: $TaskName"
