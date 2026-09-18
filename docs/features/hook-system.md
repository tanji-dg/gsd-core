---
id: 37
title: Hook System
group: Infrastructure Features
---

**Purpose:** Runtime event hooks for context monitoring, status display, and update checking.

**Requirements:**
- REQ-HOOK-01: Statusline MUST display model, current task, directory, and context usage
- REQ-HOOK-02: Context monitor MUST inject agent-facing warnings at threshold levels
- REQ-HOOK-03: Update checker MUST run in background on session start
- REQ-HOOK-04: All hooks MUST respect `CLAUDE_CONFIG_DIR` env var
- REQ-HOOK-05: All hooks MUST include 3-second stdin timeout guard
- REQ-HOOK-06: All hooks MUST fail silently on any error
- REQ-HOOK-07: Context usage MUST normalize for autocompact buffer (16.5% reserved, or the `CLAUDE_CODE_AUTO_COMPACT_WINDOW` share) — and MUST skip the buffer entirely when auto-compact is off (`autoCompactEnabled: false` in settings, or `DISABLE_AUTO_COMPACT` / `DISABLE_COMPACT`), so the bar shows the raw used%
- REQ-HOOK-08: Update banner MUST be opt-in and silent unless an update is available (PR #2795)
- REQ-HOOK-10: The Stop pause hook (autopause capability) MUST be inert unless `autopause.enabled`, MUST only request a pause above the configured used% (guarded by `autopause.guard_command`, once per 30 min, never on `stop_hook_active`), and MUST hand a settled handoff of this session that is newer than the session itself to `autopause.clear_command` (detached) — hook-requested or hand-started alike, `--keep-session` being the only opt-out
- REQ-HOOK-11: With the autopause capability enabled the context monitor MUST emit one signal — its WARNING/CRITICAL text names the automatic pause threshold (`autopause.threshold_used_pct`, default 100 − critical) and tells the agent not to pause by hand — and `/gsd-pause-work` MUST arm the automatic resume itself (`--request-now`), `--keep-session` being the only way to stay paused
- REQ-HOOK-09: The SessionStart(clear) resume hook MUST claim nothing unless a fresh pending record addressed to its own Claude Code process exists; on success it MUST route through `state session-resume` and commit only the two `.latest` deletions (`git commit --only`); it MUST never block the session (see `docs/reference/autopause-contract.md`)

**Statusline Display:**
```text
[⬆ /gsd-update │] model │ [current task │] directory [█████░░░░░ 50%]
```

Color coding: <50% green, <65% yellow, <80% orange, ≥80% red with skull emoji

**Update Banner (opt-in, when GSD statusline isn't used):**

When the user declines (or keeps a non-GSD) statusline, the installer offers a SessionStart banner that surfaces update availability without occupying statusline real estate. The banner reads `~/.cache/gsd/gsd-update-check.json` (written by `gsd-check-update-worker.js`) and emits one line only when an update is available:

```text
GSD update available: 1.39.0 → 1.40.0. Run /gsd-update.
```

The banner is silent when up-to-date and rate-limits "check failed" diagnostics to once per 24 hours. Removed cleanly by `npx @opengsd/gsd-core --uninstall` or by deleting the SessionStart entry that references `gsd-update-banner.js`.
