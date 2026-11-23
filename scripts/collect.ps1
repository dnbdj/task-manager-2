# Task Manager 2 - collector functions, dot-sourced by snapshot.ps1 (one shot)
# and host.ps1 (the long-lived sampler).
#
# Nothing is filtered here. Every process the OS will describe is returned,
# including protected system processes, so the UI can never pretend something
# does not exist.

function Tm-Str($value) {
  if ($null -eq $value) { return '' }
  return [string]$value
}

function Get-TmSnapshot {
  param([int]$Counters = 0)

  $cores = [Environment]::ProcessorCount

  $totalRam = 0
  $freeRam = 0
  $bootTime = ''
  $osName = ''
  $osVersion = ''
  $osBuild = ''
  try {
    $os = Get-CimInstance -ClassName Win32_OperatingSystem
    $totalRam = [long]$os.TotalVisibleMemorySize * 1024
    $freeRam = [long]$os.FreePhysicalMemory * 1024
    if ($os.LastBootUpTime) { $bootTime = $os.LastBootUpTime.ToUniversalTime().ToString('o') }
    $osName = Tm-Str $os.Caption
    $osVersion = Tm-Str $os.Version
    $osBuild = Tm-Str $os.BuildNumber
  } catch {}

  $cpuLoad = -1
  $diskLoad = -1
  if ($Counters -eq 1) {
    try {
      $perf = Get-CimInstance -ClassName Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'"
      if ($null -ne $perf.PercentProcessorTime) { $cpuLoad = [double]$perf.PercentProcessorTime }
    } catch {}
    try {
      $disk = Get-CimInstance -ClassName Win32_PerfFormattedData_PerfDisk_LogicalDisk -Filter "Name='_Total'"
      if ($null -ne $disk.PercentDiskTime) { $diskLoad = [double]$disk.PercentDiskTime }
    } catch {}
  }

  $hostName = ''
  $userName = ''
  try { $hostName = [Environment]::MachineName } catch {}
  try { $userName = [Environment]::UserName } catch {}

  # Parent PIDs, command lines and image paths only come through CIM.
  $cimMap = @{}
  try {
    foreach ($c in (Get-CimInstance -ClassName Win32_Process)) {
      $cimMap[[int]$c.ProcessId] = $c
    }
  } catch {}

  $list = New-Object System.Collections.ArrayList
  $processes = @(Get-Process)
  foreach ($p in $processes) {
    $c = $cimMap[[int]$p.Id]
    $window = ''
    try { $window = Tm-Str $p.MainWindowTitle } catch {}
    $start = ''
    try { if ($p.StartTime) { $start = $p.StartTime.ToUniversalTime().ToString('o') } } catch {}
    $cpu = 0.0
    try { if ($null -ne $p.CPU) { $cpu = [double]$p.CPU } } catch {}
    $responding = $true
    if ($window -ne '') {
      try { $responding = [bool]$p.Responding } catch {}
    }

    $parent = 0
    $cmd = ''
    $exe = ''
    if ($null -ne $c) {
      $parent = [int]$c.ParentProcessId
      $cmd = Tm-Str $c.CommandLine
      $exe = Tm-Str $c.ExecutablePath
    }

    [void]$list.Add([pscustomobject]@{
      pid        = [int]$p.Id
      name       = [string]$p.ProcessName
      cpuSeconds = [math]::Round($cpu, 3)
      ws         = [long]$p.WorkingSet64
      priv       = [long]$p.PrivateMemorySize64
      threads    = [int]$p.Threads.Count
      handles    = [int]$p.HandleCount
      window     = $window
      responding = $responding
      start      = $start
      session    = [int]$p.SessionId
      priority   = Tm-Str $p.PriorityClass
      path       = $exe
      parent     = $parent
      cmd        = $cmd
    })
  }

  $payload = [pscustomobject]@{
    ok           = $true
    sampledAt    = (Get-Date).ToUniversalTime().ToString('o')
    host         = $hostName
    user         = $userName
    os           = [pscustomobject]@{
      name    = $osName
      version = $osVersion
      build   = $osBuild
      cores   = $cores
      booted  = $bootTime
    }
    memory       = [pscustomobject]@{ total = $totalRam; free = $freeRam }
    load         = [pscustomobject]@{ cpu = $cpuLoad; disk = $diskLoad }
    processCount = $list.Count
    processes    = $list
  }

  return ($payload | ConvertTo-Json -Depth 5 -Compress)
}

# Company, description and version reads open a file handle per process, so
# they only happen for the single row the user expanded.
function Get-TmDetail {
  param([int]$TargetPid = 0)

  $result = [pscustomobject]@{
    ok          = $false
    pid         = $TargetPid
    company     = ''
    description = ''
    version     = ''
    product     = ''
    fileSize    = 0
    user        = ''
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
    $p = Get-Process -Id $TargetPid -ErrorAction Stop
    $result.ok = $true
    $result.window = Tm-Str $p.MainWindowTitle
    $result.cpuSeconds = [double]$p.CPU
    $result.threads = [int]$p.Threads.Count
    $result.handles = [int]$p.HandleCount
    $result.priority = Tm-Str $p.PriorityClass
    $result.path = Tm-Str $p.Path
    if ($p.StartTime) { $result.start = $p.StartTime.ToUniversalTime().ToString('o') }

    if ($result.path) {
      $info = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($result.path)
      $result.company = Tm-Str $info.CompanyName
      $result.description = Tm-Str $info.FileDescription
      $result.version = Tm-Str $info.FileVersion
      $result.product = Tm-Str $info.ProductName
      $len = 0
      try { $len = (Get-Item -LiteralPath $result.path).Length } catch {}
      $result.fileSize = [long]$len
    }

    $cim = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$TargetPid"
    if ($cim) {
      $result.parent = [int]$cim.ParentProcessId
      $result.cmd = Tm-Str $cim.CommandLine
      try {
        $owner = Invoke-CimMethod -InputObject $cim -MethodName GetOwner
        if ($owner -and $owner.User) { $result.user = (Tm-Str $owner.Domain) + '\' + (Tm-Str $owner.User) }
      } catch {}
    }
  } catch {
    $result.error = $_.Exception.Message
  }

  return ($result | ConvertTo-Json -Depth 3 -Compress)
}

function Test-TmElevated {
  try {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    return [bool]$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  } catch {
    return $false
  }
}
