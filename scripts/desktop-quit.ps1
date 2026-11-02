# Loaded by desktop-control.ps1. Inspecting windows never sends input.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class CodexQuitInput {
 public delegate bool EnumCallback(IntPtr window, IntPtr data);
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumCallback callback, IntPtr data);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder text, int count);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
 [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr window);
 [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int command);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
 [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
 [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
 [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
 [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, uint size, out uint needed);
 [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, INPUT[] input, int size);
 [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION data; }
 [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public KEYBOARD keyboard; [FieldOffset(0)] public MOUSE mouse; }
 [StructLayout(LayoutKind.Sequential)] struct KEYBOARD { public ushort key,scan; public uint flags,time; public UIntPtr extra; }
 [StructLayout(LayoutKind.Sequential)] struct MOUSE { public int x,y; public uint data,flags,time; public UIntPtr extra; }
 public static IntPtr[] Windows(int pid) {
  var windows=new List<IntPtr>();
  EnumWindows((window,unused)=>{
   uint owner; GetWindowThreadProcessId(window,out owner);
   if(owner!=pid)return true;
   var title=new StringBuilder(256);var cls=new StringBuilder(128);
   GetWindowText(window,title,title.Capacity);GetClassName(window,cls,cls.Capacity);
   if(cls.ToString()=="Chrome_WidgetWin_1" && (title.ToString()=="ChatGPT" || title.ToString()=="Codex"))windows.Add(window);
   return true;
  },IntPtr.Zero);
  return windows.ToArray();
 }
 public static bool Interactive() {
  var desktop=OpenInputDesktop(0,false,1);
  if(desktop==IntPtr.Zero)return false;
  try {var name=new StringBuilder(256);uint needed;return GetUserObjectInformation(desktop,2,name,512,out needed)&&name.ToString()=="Default";}
  finally{CloseDesktop(desktop);}
 }
 public static bool ModifiersReleased() {
  foreach(var key in new[]{0x10,0x11,0x12,0x5B,0x5C})if((GetAsyncKeyState(key)&0x8000)!=0)return false;
  return true;
 }
 public static bool Focus(IntPtr window, int pid) {
  uint owner;GetWindowThreadProcessId(window,out owner);
  if(owner!=pid || !Interactive() || !ModifiersReleased())return false;
  if(SetForegroundWindow(window) && GetForegroundWindow()==window)return true;
  uint unused;var foreground=GetWindowThreadProcessId(GetForegroundWindow(),out unused);var current=GetCurrentThreadId();
  bool attached=foreground!=0 && foreground!=current && AttachThreadInput(current,foreground,true);
  try {SetForegroundWindow(window);return GetForegroundWindow()==window;}
  finally {if(attached)AttachThreadInput(current,foreground,false);}
 }
 public static uint Quit(IntPtr window, int pid) {
  uint owner;GetWindowThreadProcessId(window,out owner);
  if(owner!=pid || GetForegroundWindow()!=window || !IsWindowEnabled(window) || !Interactive() || !ModifiersReleased())return 0;
  var keys=new ushort[]{0x11,0x51,0x51,0x11};var inputs=new INPUT[4];
  for(int i=0;i<4;i++){inputs[i].type=1;inputs[i].data.keyboard.key=keys[i];inputs[i].data.keyboard.flags=i>=2?2u:0u;}
  uint sent=SendInput(4,inputs,Marshal.SizeOf(typeof(INPUT)));
  // A partial injection must not leave Ctrl held down. Never retry the quit chord.
  if(sent>0 && sent<4){var release=new INPUT[2];for(int i=0;i<2;i++){release[i].type=1;release[i].data.keyboard.key=i==0?(ushort)0x51:(ushort)0x11;release[i].data.keyboard.flags=2;}SendInput(2,release,Marshal.SizeOf(typeof(INPUT)));}
  return sent;
 }
}
'@

function Request-DesktopQuit($process) {
 $started=$process.StartTime.ToUniversalTime().Ticks.ToString()
 $script:failureCode='DESKTOP_NOT_INTERACTIVE'
 if(![CodexQuitInput]::Interactive()){throw 'Desktop is locked or not interactive'}
 $windows=@([CodexQuitInput]::Windows($process.Id))
 $script:failureCode='DESKTOP_QUIT_UNAVAILABLE'
 if(!$windows.Count){throw 'No supported desktop app window'}
 # Prefer the current visible window; restore a hidden tray window when needed.
 $window=@($windows | Where-Object {[CodexQuitInput]::IsWindowVisible($_) -and [CodexQuitInput]::IsWindowEnabled($_)} | Select-Object -First 1)
 if(!$window.Count){$window=@($windows | Select-Object -First 1)}
 $targetWindow=[IntPtr]$window[0]
 [void][CodexQuitInput]::ShowWindowAsync($targetWindow,9)
 $script:failureCode='DESKTOP_FOCUS_FAILED'
 for($attempt=0;$attempt -lt 8;$attempt++){
  [void][CodexQuitInput]::Focus($targetWindow,$process.Id)
  if([CodexQuitInput]::GetForegroundWindow() -eq $targetWindow){break}
  Start-Sleep -Milliseconds 100
 }
 if([CodexQuitInput]::GetForegroundWindow() -ne $targetWindow){throw 'Cannot focus the verified desktop window'}
 # Ctrl+Q is the installed app's File > Quit command, unlike WM_CLOSE (tray hide).
 # Recheck identity and focus immediately before sending the single input batch.
 $process.Refresh()
 $script:failureCode='DESKTOP_CHANGED'
 if($process.HasExited -or $process.StartTime.ToUniversalTime().Ticks.ToString() -cne $started){throw 'Desktop process identity changed before quit'}
 $script:failureCode='DESKTOP_QUIT_INPUT_FAILED'
 if([CodexQuitInput]::Quit($targetWindow,$process.Id) -ne 4){throw 'Quit shortcut not delivered safely'}
}
