# Task Manager 2 - working set trimmer.
#
# EmptyWorkingSet asks Windows to page a process's resident pages out to the
# standby list. Nothing is closed and no data is lost; it is the same mechanism
# memory-cleaner utilities use. Processes we are not allowed to touch simply
# come back as failures instead of silently doing nothing.

param([string]$Pids = '')

$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$ProgressPreference = 'SilentlyContinue'

$signature = @'
using System;
using System.Runtime.InteropServices;

public static class Tm2Mem {
    [DllImport("psapi.dll", SetLastError = true)]
    public static extern bool EmptyWorkingSet(IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint access, bool inherit, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr handle);
}
'@

try { Add-Type -TypeDefinition $signature -ErrorAction Stop } catch {}

$ok = 0
$failed = 0

foreach ($raw in ($Pids -split ',')) {
  $id = 0
  if (-not [int]::TryParse($raw.Trim(), [ref]$id)) { continue }
  if ($id -le 0) { continue }

  # PROCESS_SET_QUOTA (0x0100) | PROCESS_QUERY_INFORMATION (0x0400)
  $handle = [Tm2Mem]::OpenProcess(0x0500, $false, $id)
  if ($handle -eq [IntPtr]::Zero) { $failed++; continue }

  try {
    if ([Tm2Mem]::EmptyWorkingSet($handle)) { $ok++ } else { $failed++ }
  } finally {
    [void][Tm2Mem]::CloseHandle($handle)
  }
}

@{ ok = $ok; failed = $failed } | ConvertTo-Json -Compress
