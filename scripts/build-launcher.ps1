param([switch]$Preview)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if(-not (Test-Path -LiteralPath $compiler)){throw 'Windows .NET Framework C# compiler was not found. Use the VBS launcher instead.'}
$output=Join-Path $root 'CodexLink.exe'
$options=@('/nologo','/target:winexe','/codepage:65001','/reference:System.Windows.Forms.dll')
$automation=Get-ChildItem (Join-Path $env:WINDIR 'Microsoft.NET\assembly\GAC_MSIL\System.Management.Automation') -Filter System.Management.Automation.dll -Recurse | Select-Object -First 1
if(-not $automation){throw 'Windows PowerShell runtime was not found.'}
$options+=('/reference:'+$automation.FullName)
if($Preview){$output=Join-Path $root '.gui-test\CodexLink-Preview.exe';New-Item -ItemType Directory -Path (Split-Path $output) -Force|Out-Null;$options+='/define:PREVIEW'}
& $compiler @options ('/out:'+$output) (Join-Path $PSScriptRoot 'launcher.cs')
if($LASTEXITCODE -ne 0){throw 'Launcher build failed.'}
Write-Output $output
