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

## Numbering

`MAJOR.MINOR` inside the beta series. `package.json` carries the same number as `1.0.0-beta.1`, so the app, the tag and the package never disagree. A beta that only fixes internal details without changing visible behaviour does not get a new number; it is folded into the next notable one.
