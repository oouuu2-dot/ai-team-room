$ErrorActionPreference='Stop'
$key=Read-Host '회의실 API 키 (화면에 표시되지 않음)' -AsSecureString
$key | ConvertFrom-SecureString | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'room-key.dpapi') -Encoding ascii
Write-Output 'Saved encrypted credential for this Windows user only.'
