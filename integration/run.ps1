# Installs the packaged .vsix into a throwaway VS Code profile and runs index.js inside that VS Code:
# a fixture repository with every reference form, then (optionally) a smoke test of a real pack.
# Your own VS Code profile and extensions are not touched.
#   .\integration\run.ps1 [-Pack C:\path\to\repo\docs\comprehension\pack.md] [-Insiders]
param(
  [string] $Pack,
  [string] $Vsix = (Get-ChildItem "$PSScriptRoot\..\*.vsix" | Sort-Object LastWriteTime | Select-Object -Last 1).FullName,
  # Test in VS Code - Insiders instead of stable.
  [switch] $Insiders
)
$ErrorActionPreference = 'Stop'
$cli = if ($Insiders) { 'code-insiders' } else { 'code' }
$CodeExe = Join-Path (Split-Path (Split-Path (Get-Command $cli).Source)) $(if ($Insiders) { 'Code - Insiders.exe' } else { 'Code.exe' })
$profileDir = Join-Path ([IO.Path]::GetTempPath()) 'comp-pack-reader-it'
Get-Process 'Code', 'Code - Insiders' -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'comp-pack-reader-it' } | Stop-Process -Force
Remove-Item -Recurse -Force $profileDir -ErrorAction SilentlyContinue
$userData = Join-Path $profileDir 'user'
$extDir = Join-Path $profileDir 'extensions'
& $cli --user-data-dir $userData --extensions-dir $extDir --install-extension $Vsix --force | Out-Host

$env:COMP_PACK = if ($Pack) { (Resolve-Path $Pack).Path } else { '' }
# VS Code opens the PARENT of the fixture repository, as when a whole GitHub folder is open.
$Folder = Join-Path $profileDir 'workspace'
New-Item -ItemType Directory -Force $Folder | Out-Null
$env:COMP_PACK_WORKSPACE = $Folder
Remove-Item "$PSScriptRoot\result.txt" -ErrorAction SilentlyContinue
$codeArgs = @(
  "--user-data-dir=`"$userData`"", "--extensions-dir=`"$extDir`"", '--disable-workspace-trust', '--new-window',
  "--extensionDevelopmentPath=`"$PSScriptRoot`"", "--extensionTestsPath=`"$PSScriptRoot\index.js`"", "`"$Folder`""
)
$proc = Start-Process -FilePath $CodeExe -ArgumentList $codeArgs -PassThru `
  -RedirectStandardOutput "$profileDir\stdout.txt" -RedirectStandardError "$profileDir\stderr.txt"
if (-not $proc.WaitForExit(180000)) { $proc | Stop-Process -Force; throw 'VS Code did not finish within 3 minutes' }
if (Test-Path "$PSScriptRoot\result.txt") { Get-Content "$PSScriptRoot\result.txt" } else { Get-Content "$profileDir\stderr.txt" -Tail 40 }
exit $proc.ExitCode
