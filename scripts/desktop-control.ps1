param([ValidateSet('inspect','close')][string]$Action='inspect')
$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$failureCode='DESKTOP_CONTROL_FAILED'
try {
 . (Join-Path $PSScriptRoot 'desktop-quit.ps1')
 $request=[Console]::In.ReadToEnd() | ConvertFrom-Json
 $bridgePid=[int]$request.bridgePid
 $bridgeProcess=Get-Process -Id $bridgePid -ErrorAction Stop
 if($bridgeProcess.ProcessName -ine 'node'){throw 'Invalid bridge process identity'}
 $sessionId=$bridgeProcess.SessionId
 $userSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
 $paths=@{}
 foreach($package in @(Get-AppxPackage -Name 'OpenAI.Codex')) {
  foreach($exe in @('ChatGPT.exe','Codex.exe')) {
   $candidate=Join-Path $package.InstallLocation ('app\'+$exe)
   if(Test-Path -LiteralPath $candidate){$paths[$candidate.ToLowerInvariant()]=$true}
  }
 }
 $inventory=@(Get-CimInstance Win32_Process)
 $byId=@{};foreach($row in $inventory){$byId[[int]$row.ProcessId]=$row}
 function Is-Descendant([int]$childId,[int]$rootId) {
  $seen=@{};$currentId=$childId
  while($currentId -gt 0 -and $byId.ContainsKey($currentId) -and !$seen.ContainsKey($currentId)) {
   if($currentId -eq $rootId){return $true}
   $seen[$currentId]=$true;$child=$byId[$currentId];$parentId=[int]$child.ParentProcessId
   if($byId.ContainsKey($parentId) -and $byId[$parentId].CreationDate -gt $child.CreationDate){return $false}
   $currentId=$parentId
  }
  return $false
 }
 $protected=@($bridgePid)+@($request.protectedPids | ForEach-Object {[int]$_})
 if($Action -eq 'close'){$protected+= $PID}
 $desktops=@()
 foreach($row in $inventory) {
  if(!$row.ExecutablePath -or !$paths.ContainsKey($row.ExecutablePath.ToLowerInvariant())){continue}
  if($row.CommandLine -match '(?:^|\s)--type(?:=|\s)'){continue}
  $desktopPid=[int]$row.ProcessId
  $process=Get-Process -Id $desktopPid -ErrorAction SilentlyContinue
  if(!$process -or $process.SessionId -ne $sessionId){continue}
  if((Invoke-CimMethod -InputObject $row -MethodName GetOwnerSid).Sid -ne $userSid){continue}
  $safe=$true
  foreach($protectedId in $protected){if(Is-Descendant $protectedId $desktopPid){$safe=$false}}
  if(!$safe){continue}
  $backends=@($inventory | Where-Object { $_.Name -ieq 'codex.exe' -and $_.CommandLine -match '(?:^|\s)app-server(?:\s|$)' -and (Is-Descendant ([int]$_.ProcessId) $desktopPid) } | ForEach-Object {
   $backendProcess=Get-Process -Id ([int]$_.ProcessId) -ErrorAction Stop
   [pscustomobject]@{pid=[int]$_.ProcessId;started=$backendProcess.StartTime.ToUniversalTime().Ticks.ToString()}
  })
  if(!$backends.Count){continue}
  $desktops+= [pscustomobject]@{pid=$desktopPid;path=$row.ExecutablePath;started=$process.StartTime.ToUniversalTime().Ticks.ToString();closable=(@([CodexQuitInput]::Windows($desktopPid)).Count -gt 0);backends=$backends}
 }
 if($Action -eq 'inspect') {
  [pscustomobject]@{desktops=@($desktops)} | ConvertTo-Json -Depth 6 -Compress
  exit 0
 }
 $expected=@($request.desktops)
 $failureCode='DESKTOP_CHANGED'
 if(!$expected.Count -or $expected.Count -ne $desktops.Count){throw 'Desktop processes changed; prepare takeover again'}
 $handles=@()
 # Validate every target before requesting an app quit. Never kill by name/PID alone.
 foreach($target in $expected) {
  $actual=@($desktops | Where-Object { $_.pid -eq $target.pid -and $_.started -ceq $target.started -and $_.path -ieq $target.path })
  if($actual.Count -ne 1 -or !$actual[0].closable){throw 'Desktop changed or has no closable main window'}
  $oldBackends=(@($target.backends | ForEach-Object {"$($_.pid):$($_.started)"}) | Sort-Object) -join ','
  $newBackends=(@($actual[0].backends | ForEach-Object {"$($_.pid):$($_.started)"}) | Sort-Object) -join ','
  if($oldBackends -cne $newBackends){throw 'Desktop backend changed; prepare takeover again'}
  $handle=Get-Process -Id ([int]$target.pid) -ErrorAction Stop
  if($handle.StartTime.ToUniversalTime().Ticks.ToString() -cne $target.started){throw 'Desktop process identity changed'}
  $handles+=$handle
 }
 foreach($handle in $handles){Request-DesktopQuit $handle}
 $failureCode='DESKTOP_EXIT_TIMEOUT'
 $deadline=[DateTime]::UtcNow.AddSeconds(12)
 do {
  $alive=$false
  foreach($target in $expected) {
   foreach($identity in (@($target)+@($target.backends))) {
    try{$process=Get-Process -Id ([int]$identity.pid) -ErrorAction SilentlyContinue
     if($process -and $process.StartTime.ToUniversalTime().Ticks.ToString() -ceq $identity.started){$alive=$true}
    }catch [InvalidOperationException] {}
   }
  }
  if(!$alive){[pscustomobject]@{closed=$true} | ConvertTo-Json -Compress;exit 0}
  Start-Sleep -Milliseconds 200
 }while([DateTime]::UtcNow -lt $deadline)
 throw 'Desktop did not fully exit. No process was forcibly terminated.'
}catch {
 [pscustomobject]@{error=$_.Exception.Message;errorCode=$failureCode} | ConvertTo-Json -Compress
 exit 1
}
