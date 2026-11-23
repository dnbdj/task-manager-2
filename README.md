# Task Manager 2

A Windows Task Manager replacement that shows every process, sorts on anything, and tells you what breaks before you end something important.

> **Status: beta 1.5 (pre-release).** Not confirmed stable. See [VERSIONS.md](VERSIONS.md).

## Why

Windows Task Manager hides processes it considers unimportant, gives one small confirmation before ending something that can reboot the machine, sorts on a single column, and buries "clean up memory" behind a right-click. Task Manager 2 fixes those four things specifically.

## What it does

**Nothing is hidden.** Every process the OS reports is listed by default, including session-0 service processes. Those carry a `SYSTEM` badge and a protection level in their own column. The status bar always states the arithmetic — `Showing 433 of 433 processes · nothing hidden by Task Manager 2` — and if you choose to hide system processes yourself, the number you hid stays on screen. The **⋯ → Export report** item saves the complete list as JSON.

**Warnings that match the risk.** Every process is classified before the End button becomes usable:

| Tier | Meaning | Confirmation |
|---|---|---|
| **Protected** | Windows cannot survive losing it: `system`, `registry`, `smss`, `csrss`, `wininit`, `winlogon`, `services`, `lsass`, `fontdrvhost` | Cannot be ended. The button is disabled and the dialog explains why. |
| **Critical** | Breaks or restarts the visible session: `explorer`, `dwm`, `sihost`, `ctfmon`, `audiodg`, Defender | You must **type the process name**. |
| **Important** | Something depends on it: `svchost`, `spoolsv`, `runtimebroker`, `dllhost`, `conhost`, session-0 services | Explicit checkbox acknowledging what breaks. |
| **App** | Has a visible window | Checkbox, plus "unsaved work will be lost". |
| **Normal** | Background process | Single confirmation. |

Warnings also fire automatically for an open window with unsaved work, for child processes that will die with their parent (`End process tree`), and for "you are not elevated, so Windows may refuse this".

The protection table is re-checked **on the server for every kill request**, so a stale or hand-edited tab cannot end a protected process.

**Sorting that holds up.** Click any column to sort, shift-click to stack up to three sorts (numbered chips show the stack), numeric-aware with stable tie-breaks so rows do not jitter between samples. Presets for busiest, biggest memory, newest and name. Search matches name, PID, window title, path, command line and parent.

**Folders, like Task Manager.** The list opens grouped: every app is a folder row with a chevron, an instance count and summed CPU and memory, and expanding it shows the processes inside. A folder checkbox selects the whole group at once. Turn the folder view off in Settings → Processes for a flat list. Every row carries a small live sparkline of that process's CPU on the line under its name; a folder shows the summed trace of its members.

**Two pages, and settings with tabs.** The left column is just page navigation — **Processes** and **Graphs** — and Settings lives in the ⋯ menu. Everything that used to fill it — views, sort presets, folder grouping, showing system processes, refresh interval, live updates — moved into a Settings dialog with **Processes**, **Graphs** and **About** tabs. The Graphs page plots CPU, memory and disk from a sample taken on every refresh, over a window of 30 seconds to 10 minutes, drawn on canvas with no chart library; its own settings tab sets the history window and chart style.

**Clean, with tickboxes.** The **Clean** button opens a dropdown with five categories, the way a memory cleaner does. Tick what you want and press Clean:

| Category | What it does |
|---|---|
| **CPU** | Finds background processes using CPU and opens the reviewed list so you choose what closes. Nothing is killed silently. |
| **GPU** | Deletes the DirectX shader cache (D3D, NVIDIA, AMD, Intel). The driver rebuilds it; nothing is lost. |
| **RAM** | Trims the working sets of idle background processes. Nothing is closed, and the freed amount is measured, not guessed. |
| **Internet** | Flushes the DNS resolver cache. |
| **Storage** | Deletes temp files older than 24 hours from your temp folder and `Windows\Temp`. Files still in use are skipped and reported. |

The dropdown shows what each ticked category actually found (process count, megabytes, file count) before you press anything, and your ticks are remembered between launches.

**Process review that explains itself.** The CPU category opens a reviewed list — idle browser helpers, leftover build tools, windowless apps, large background processes, apps not responding, orphaned processes — with the reason each was picked. Nothing is ended until you tick the acknowledgement and press the button.

## Running it

Requirements: Windows 10 or 11, and Node.js 20 or newer.

```
npm install          # optional, installs Electron for the desktop window
start.bat            # desktop window if Electron is installed, otherwise your browser
start-admin.bat      # same, elevated, with a UAC prompt
```

`start-admin.bat` lets the app end processes it does not own. Without elevation, Windows refuses those kills and the app reports each failure with the reason instead of silently doing nothing.

The app binds to `127.0.0.1` only and requires a per-launch token on every API call, so no other page or program can drive its kill endpoints.

## Layout

```
server/index.mjs        HTTP API, static files, session token, same-origin checks
server/win.mjs          sampler, CPU deltas, tree kill, kill validation
server/protection.mjs   tier table and warning copy
server/quickclean.mjs   Quick Clean candidate engine
scripts/host.ps1        long-lived PowerShell sampler (one process, warm WMI)
scripts/collect.ps1     snapshot and detail collectors
public/                 the interface (plain ES modules, no build step)
electron/main.js        desktop window around the same server
```

Process data comes from PowerShell: `Get-Process` for CPU, memory, threads, handles and window titles, `Win32_Process` for parent PIDs, command lines and image paths. A single long-lived PowerShell host answers commands over stdin so the WMI providers stay warm; the sampler runs on a 3 second loop and the UI reads the cached result, so the interface never waits on a shell.

## Beta policy

Every notable version ships as `beta 1.0`, `beta 1.1`, `beta 1.2`, … as a GitHub **pre-release**. Betas are never deleted or overwritten, and none is marked stable or "Latest" by the author. A version becomes stable only when the owner confirms it personally. Full policy in [VERSIONS.md](VERSIONS.md).

## License

MIT. See [LICENSE](LICENSE).
