$ErrorActionPreference='Stop'
$runner=Join-Path $PSScriptRoot 'run.ps1'
if(-not(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'config.json'))){throw 'Copy config.example.json to config.json first.'}
$node=Get-Command node -ErrorAction Stop
$action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$runner+'"') -WorkingDirectory $PSScriptRoot
$trigger=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 55) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'Codex-Shorts-Workroom-Sync' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description '숏츠 카드 재료·완성본 동기화. PC 로그인 중 5분마다. 발행·렌더는 수행하지 않음.' -Force | Out-Null
Write-Output 'Registered Codex-Shorts-Workroom-Sync (5 minutes, current interactive user).'
