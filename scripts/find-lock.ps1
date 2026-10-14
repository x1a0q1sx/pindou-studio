# 查出占用指定文件的进程（Windows Restart Manager）
param([string]$TargetPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\release2\win-unpacked\resources\app.asar")))

Add-Type @'
using System;
using System.Runtime.InteropServices;
public class RMTool {
  [StructLayout(LayoutKind.Sequential)] public struct RM_UNIQUE_PROCESS { public int dwProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
    public int ApplicationType; public uint AppStatus; public uint TSSessionId; [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] public static extern int RmStartSession(out int pSessionHandle, int dwSessionFlags, string strSessionKey);
  [DllImport("rstrtmgr.dll")] public static extern int RmEndSession(int pSessionHandle);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] public static extern int RmRegisterResources(int pSessionHandle, uint nFiles, string[] rgsFilenames, uint nApplications, RM_UNIQUE_PROCESS[] rgApplications, uint nServices, string[] rgsServiceNames);
  [DllImport("rstrtmgr.dll")] public static extern int RmGetList(int dwSessionHandle, out uint pnProcInfoNeeded, ref uint pnProcInfo, [In, Out] RM_PROCESS_INFO[] rgAffectedApps, ref uint lpdwRebootReasons);
}
'@

$session = 0
$key = [Guid]::NewGuid().ToString()
$res = [RMTool]::RmStartSession([ref]$session, 0, $key)
if ($res -ne 0) { Write-Output "RmStartSession failed: $res"; exit 1 }
try {
  $res = [RMTool]::RmRegisterResources($session, 1, @($TargetPath), 0, $null, 0, $null)
  if ($res -ne 0) { Write-Output "RmRegisterResources failed: $res"; exit 1 }
  $needed = 0; $count = 10; $reasons = 0
  $info = New-Object RMTool+RM_PROCESS_INFO[] $count
  $res = [RMTool]::RmGetList($session, [ref]$needed, [ref]$count, $info, [ref]$reasons)
  if ($res -ne 0) { Write-Output "RmGetList failed: $res"; exit 1 }
  Write-Output "锁定进程数: $needed"
  for ($i = 0; $i -lt $count; $i++) {
    $pid = $info[$i].Process.dwProcessId
    $name = $info[$i].strAppName
    $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
    $exe = if ($proc) { $proc.Path } else { '?' }
    Write-Output "PID $pid | $name | $exe"
  }
} finally { [void][RMTool]::RmEndSession($session) }
