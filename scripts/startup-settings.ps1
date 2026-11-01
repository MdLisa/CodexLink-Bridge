param(
 [ValidateSet('status','enable','disable')][string]$Action='status',
 [Parameter(Mandatory=$true)][string]$NodePath,
 [Parameter(Mandatory=$true)][string]$BridgePath,
 [Parameter(Mandatory=$true)][string]$DataDir
)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$runKey='HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$entryName='CodexLinkPhoneBridge'
$launcherPath=Join-Path $DataDir 'autostart.vbs'
$metadataPath=Join-Path $DataDir 'autostart.json'
$runnerPath=Join-Path $BridgePath 'scripts\autostart.mjs'
$wscriptPath=Join-Path $env:WINDIR 'System32\wscript.exe'
$command='"'+$wscriptPath+'" //B //Nologo "'+$launcherPath+'"'
if($Action -eq 'enable'){
 foreach($required in @($NodePath,$runnerPath,$wscriptPath)){if(-not (Test-Path -LiteralPath $required -PathType Leaf)){throw 'Required startup file was not found.'}}
 New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
 $childCommand=('"'+$NodePath+'" "'+$runnerPath+'"').Replace('"','""')
 $vbDataDir=$DataDir.Replace('"','""')
 $vbBridgePath=$BridgePath.Replace('"','""')
 $source=@"
Option Explicit
Dim shell, environment
Set shell = CreateObject("WScript.Shell")
Set environment = shell.Environment("PROCESS")
environment("BRIDGE_DATA_DIR") = "$vbDataDir"
shell.CurrentDirectory = "$vbBridgePath"
shell.Run "$childCommand", 0, False
"@
 [IO.File]::WriteAllText($launcherPath,$source,[Text.Encoding]::Unicode)
 if(-not (Test-Path -LiteralPath $runKey)){New-Item -Path $runKey | Out-Null}
 New-ItemProperty -LiteralPath $runKey -Name $entryName -PropertyType String -Value $command -Force | Out-Null
 # Clear only this application's old disabled flag when the user explicitly enables it.
 $approved='HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run'
 if(Test-Path -LiteralPath $approved){Remove-ItemProperty -LiteralPath $approved -Name $entryName -ErrorAction SilentlyContinue}
 $metadata=@{enabled=$true;bridgePath=$BridgePath;nodePath=$NodePath;registeredAt=[DateTime]::UtcNow.ToString('o')}
 [IO.File]::WriteAllText($metadataPath,($metadata|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
}
if($Action -eq 'disable'){
 if(Test-Path -LiteralPath $runKey){Remove-ItemProperty -LiteralPath $runKey -Name $entryName -ErrorAction SilentlyContinue}
 if(Test-Path -LiteralPath $metadataPath){[IO.File]::WriteAllText($metadataPath,'{"enabled":false}',[Text.UTF8Encoding]::new($false))}
}
$value=Get-ItemProperty -LiteralPath $runKey -Name $entryName -ErrorAction SilentlyContinue
$registered=$null -ne $value -and $value.$entryName -eq $command -and (Test-Path -LiteralPath $launcherPath)
$disabledByWindows=$false
$approval=Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run' -Name $entryName -ErrorAction SilentlyContinue
if($null -ne $approval){$flag=$approval.$entryName;if($flag -is [byte[]] -and $flag.Length -gt 0){$disabledByWindows=$flag[0] -in @(3,7)}}
@{enabled=($registered -and -not $disabledByWindows);registered=$registered;disabledByWindows=$disabledByWindows;launcher=$launcherPath}|ConvertTo-Json -Compress
