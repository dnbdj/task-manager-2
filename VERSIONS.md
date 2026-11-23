# Version policy

Task Manager 2 ships in public betas. Nothing here is stable until the owner says so.

## Rules

1. **Every notable version is a beta.** The sequence is `beta 1.0`, `beta 1.1`, `beta 1.2`, and so on. A release only counts as notable when it changes behaviour a user can see: new features, changed protection rules, interface changes, bug fixes worth knowing about.
2. **Every beta is published as a pre-release.** On GitHub that means `prerelease: true` and never `Latest`. The repository's "Latest" marker stays empty, because there is no stable release to point at.
3. **Betas are never removed, renamed or force-pushed over.** If a beta is wrong, the fix ships as the next beta. History stays readable.
4. **I do not promote a beta myself.** No beta becomes stable, and no beta is relabelled, until the owner confirms in their own words that the version is good. Until then the badge in the app reads `BETA`, the README says pre-release, and every release is a prerelease.
5. **A stable release needs an explicit instruction.** "Make beta 1.3 stable" from the owner is the only thing that turns a pre-release into a release; it is never inferred from time passing, download counts or test results.

## Version history

| Version | Date | Tag | State | Notes |
|---|---|---|---|---|
| beta 1.0 | 2026-11-23 | `beta-1.0` | Pre-release | First published build. Unfiltered process list, five protection tiers with typed confirmation for critical processes, stacked multi-column sorting, group by app, Quick Clean, JSON report. |
| beta 1.1 | 2026-11-23 | `beta-1.1` | Pre-release | Desktop shell hardened and proven: startup diagnostics written to `.desktop.log`, server spawn failures surfaced instead of hanging, a readable in-window failure page, and a Content-Security-Policy so the renderer no longer ships without one. |
| beta 1.2 | 2026-11-23 | `beta-1.2` | Pre-release | Folder-style grouped process list on by default, the way Task Manager's Processes tab nests apps. Clean becomes a dropdown with CPU / GPU / RAM / Internet / Storage tickboxes in the style of memory-cleaner utilities, each reporting what it found before it runs. |
| beta 1.3 | 2026-11-23 | `beta-1.3` | Pre-release | Fixes the Clean dropdown rendering underneath the process table (the top bar's backdrop filter trapped it in its own stacking context). Report moves into a ⋯ menu alongside Settings, and the refresh interval becomes a slider in Settings instead of a select in the status bar. |
| beta 1.4 | 2026-11-23 | `beta-1.4` | Pre-release | The sidebar becomes page navigation — Processes and Graphs — and everything that used to fill that column (views, sort presets, group by app, show system, interval, live updates) moves into a tabbed Settings dialog with Processes / Graphs / About tabs. New Graphs page plots CPU, memory and disk history from samples taken on every refresh, with its own settings tab for history window and chart style. |
| beta 1.5 | 2026-11-23 | `beta-1.5` | Pre-release | Simplification pass. The Refresh button is gone (the list is always live), Settings leaves the sidebar and lives only in the ⋯ menu, and the second text line under every process becomes a 32-sample CPU sparkline — folders show the summed trace. The table drops Threads, Handles, Session and Started, which stay in the detail panel. |
| beta 1.6 | 2026-11-23 | `beta-1.6` | Pre-release | Graphs get their own 10 ms sampler in the local server (`/api/samples`): CPU and memory are read from the OS ~63 times a second instead of once per process refresh, buffered for 10 minutes and drawn at 30 fps. The header reports the measured rate, not the configured one. Disk busy time still comes from the WMI refresh because no cheaper counter exists. |

## Numbering

`MAJOR.MINOR` inside the beta series. `package.json` carries the same number as `1.0.0-beta.1`, so the app, the tag and the package never disagree. A beta that only fixes internal details without changing visible behaviour does not get a new number; it is folded into the next notable one.
