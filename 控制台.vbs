Option Explicit
Dim shell, files, folder, node, entry, candidate, paths, p, native, compiler, result
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
folder = files.GetParentFolderName(WScript.ScriptFullName)
native = files.BuildPath(folder, "CodexLink.exe")
If Not files.FileExists(native) Then
 compiler = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
 result = shell.Run(Chr(34) & compiler & Chr(34) & " -NoProfile -ExecutionPolicy Bypass -File " & Chr(34) & files.BuildPath(folder, "scripts\build-launcher.ps1") & Chr(34), 0, True)
End If
If files.FileExists(native) Then
 shell.Run Chr(34) & native & Chr(34), 0, False
 WScript.Quit 0
End If
node = ""
paths = Split(shell.ExpandEnvironmentStrings("%PATH%"), ";")
For Each p In paths
 If Len(p) > 0 Then
  candidate = files.BuildPath(Replace(p, Chr(34), ""), "node.exe")
  If files.FileExists(candidate) Then
   node = candidate
   Exit For
  End If
 End If
Next
If node = "" Then node = shell.ExpandEnvironmentStrings("%USERPROFILE%") & "\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
If Not files.FileExists(node) Then
 MsgBox "Node.js 24 or later is required. Open Codex once, or install Node.js.", 48, "CodexLink"
 WScript.Quit 1
End If
entry = files.BuildPath(folder, "scripts\gui.mjs")
shell.CurrentDirectory = folder
shell.Run Chr(34) & node & Chr(34) & " " & Chr(34) & entry & Chr(34), 0, False
