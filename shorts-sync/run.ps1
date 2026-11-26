$ErrorActionPreference='Stop'
$credentialPath=Join-Path $PSScriptRoot 'room-key.dpapi'
if(-not(Test-Path -LiteralPath $credentialPath)){throw 'Run setup-key.ps1 first.'}
$secret=Get-Content -LiteralPath $credentialPath -Raw | ConvertTo-SecureString
$ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
try {
 $env:SHORTS_ROOM_KEY=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
 & node (Join-Path $PSScriptRoot 'sync.mjs')
 if($LASTEXITCODE -ne 0){throw "Sync exit code $LASTEXITCODE"}
} finally {
 [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
 Remove-Item Env:SHORTS_ROOM_KEY -ErrorAction SilentlyContinue
}
