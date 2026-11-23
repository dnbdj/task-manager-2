# Task Manager 2 - single-process detail.
# Company/Description/version reads open a file handle per process, so they are
# only done for the one row the user actually expanded.

param([int]$ProcessId = 0)

$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$ProgressPreference = 'SilentlyContinue'

function Str($value) {
  if ($null -eq $value) { return '' }
  return [string]$value
}

$result = [pscustomobject]@{
  ok          = $false
  pid         = $ProcessId
  company     = ''
  description = ''
  version     = ''
  product     = ''
  fileSize    = 0
  user        = ''
  integrity   = ''
  window      = ''
  cpuSeconds  = 0
  threads     = 0
  handles     = 0
  priority    = ''
  path        = ''
  cmd         = ''
  parent      = 0
  start       = ''
  error       = ''
}

try {
  $p = Get-Process -Id $ProcessId -ErrorAction Stop
  $result.ok = $true
  $result.window = Str $p.MainWindowTitle
  $result.cpuSeconds = [double]$p.CPU
  $result.threads = [int]$p.Threads.Count
  $result.handles = [int]$p.HandleCount
  $result.priority = Str $p.PriorityClass
  $result.path = Str $p.Path
  if ($p.StartTime) { $result.start = $p.StartTime.ToUniversalTime().ToString('o') }

  if ($result.path) {
    $info = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($result.path)
    $result.company = Str $info.CompanyName
    $result.description = Str $info.FileDescription
    $result.version = Str $info.FileVersion
    $result.product = Str $info.ProductName
    $result.fileSize = (Get-Item -LiteralPath $result.path).Length
  }

  $cim = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$ProcessId"
  if ($cim) {
    $result.parent = [int]$cim.ParentProcessId
    $result.cmd = Str $cim.CommandLine
    $owner = $null
    try { $owner = Invoke-CimMethod -InputObject $cim -MethodName GetOwner } catch {}
    if ($owner -and $owner.User) { $result.user = Str $owner.Domain + '\' + Str $owner.User }
  }
} catch {
  $result.error = $_.Exception.Message
}

$result | ConvertTo-Json -Depth 3 -Compress
