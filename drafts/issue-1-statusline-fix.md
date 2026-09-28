# Issue draft #1 — Bug Report (template: bug_report.yml)

Title: `bug(statusline): context meter subtracts the auto-compact buffer even when autoCompactEnabled is false`

## Pre-submission checklist
- [x] I have searched existing issues and this bug has not already been reported
- [x] I have reviewed all pasted output for PII and redacted where necessary

## GSD Version
1.14.0 (`next`)

## Runtime
Claude Code

## Operating System
Windows 11 (also reproduced on Linux/WSL)

## Node.js Version
v24.19.0

## Shell
Git Bash / PowerShell

## Installation Method
`npx gsd-core install` (global)

## What happened?
`hooks/gsd-statusline.js` always subtracts the ~16.5% auto-compact buffer (or the `CLAUDE_CODE_AUTO_COMPACT_WINDOW` share) from `remaining` and shows used% against the "usable" range. With `"autoCompactEnabled": false` in `settings.json` (or `DISABLE_AUTOCOMPACT=1`) Claude Code never reserves that buffer, so it is ordinary context:

- raw 40% used is shown as 48%
- raw 83.5% used pins the bar at 100%
- the last sixth of the window is invisible — the meter says "full" while `/context` still shows ~16% free

The bridge file `<tmpdir>/claude-ctx-<sid>.json` already carries the raw `used_pct`, so every consumer of that file (e.g. `gsd-context-monitor.js`) disagrees with the bar.

## What did you expect?
When auto-compact is disabled the meter shows `round(100 − remaining)`, matching Claude Code's own `/context` output. When it is enabled, current behaviour is unchanged.

## Steps to reproduce
1. Put `{ "autoCompactEnabled": false }` in `~/.claude/settings.json` (or export `DISABLE_AUTOCOMPACT=1`).
2. Install the GSD statusline and work until `/context` reports ~40% used.
3. Compare the GSD bar (≈48%) with `/context` (40%).
4. Continue to ~84%: the bar reads 100%.

## Error output / logs
(none — display defect)

## GSD Configuration
default

## How often does this happen?
Always (whenever auto-compact is disabled)

## Impact
Medium — the meter is the only per-turn signal the user has; a bar pinned at 100% one sixth early makes them pause/compact too soon, and hides the real exhaustion point.

## Workaround
Unset `autoCompactEnabled` (i.e. accept auto-compact) or ignore the bar and use `/context`.

## Additional context
Proposed fix (PR ready once confirmed): `isAutoCompactDisabled(dir)` reads, fail-soft and first-definitive-wins, `DISABLE_AUTOCOMPACT` / `CLAUDE_CODE_DISABLE_AUTO_COMPACT`, then `<project>/.claude/settings.local.json`, `settings.json`, then `(CLAUDE_CONFIG_DIR || ~/.claude)/settings.local.json`, `settings.json` for the boolean `autoCompactEnabled`; when disabled the buffer is 0. Tests cover the settings / env / precedence cases and pin `CLAUDE_CONFIG_DIR` to a scratch dir for the existing #2219 / #1194 spawn tests so a developer's real `settings.json` cannot steer expected percentages.

## Privacy Checklist
- [x] No PII in this report
