# Task Manager 2 - long-lived PowerShell sampler host.
#
# Spawning powershell.exe per poll costs half a second and re-initialises the
# WMI providers every time. This host stays up and answers one command per
# stdin line, framed on stdout so the Node side can match replies to requests.
#
# Frames:  @@J@@<json>   success
#          @@E@@<text>   failure

param([string]$Collector)

$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$ProgressPreference = 'SilentlyContinue'

. $Collector

try { [Console]::Out.WriteLine('@@R@@ready') } catch {}

$stdin = [Console]::In
while ($true) {
  $line = $stdin.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq '') { continue }
  if ($line -eq 'quit') { break }

  try {
    if ($line -eq 'elevated') {
      $value = Test-TmElevated
      [Console]::Out.WriteLine('@@J@@' + (ConvertTo-Json -Compress -InputObject @{ elevated = [bool]$value }))
    }
    elseif ($line -like 'snapshot*') {
      $counters = 0
      if ($line -match 'counters=(\d)') { $counters = [int]$Matches[1] }
      [Console]::Out.WriteLine('@@J@@' + (Get-TmSnapshot -Counters $counters))
    }
    elseif ($line -like 'detail*') {
      $target = 0
      if ($line -match 'pid=(\d+)') { $target = [int]$Matches[1] }
      [Console]::Out.WriteLine('@@J@@' + (Get-TmDetail -TargetPid $target))
    }
    else {
      [Console]::Out.WriteLine('@@E@@unknown command')
    }
  } catch {
    [Console]::Out.WriteLine('@@E@@' + ($_.Exception.Message -replace '\r?\n', ' '))
  }
  try { [Console]::Out.Flush() } catch {}
}
