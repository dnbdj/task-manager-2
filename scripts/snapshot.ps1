# Task Manager 2 - one-shot snapshot, kept for debugging and for the report
# exporter when the host is unavailable.

param([int]$Counters = 1)

$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$ProgressPreference = 'SilentlyContinue'

. (Join-Path $PSScriptRoot 'collect.ps1')

Get-TmSnapshot -Counters $Counters
