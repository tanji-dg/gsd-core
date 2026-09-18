---
name: gsd:autopause
description: Operate the unattended pause → /clear → resume cycle (status, request a pause now, read the logs)
argument-hint: "[status|request|log]"
allowed-tools:
  - Read
  - Bash
  - Grep
requires: [pause-work, resume-work]
---

**STOP -- DO NOT READ THIS FILE. You are already reading it. This prompt was injected into your context by Claude Code's command system. Using the Read tool on this file wastes tokens. Begin executing Step 0 immediately.**

## Step 0 -- Banner

**Before ANY tool calls**, display this banner:

```
GSD > AUTOPAUSE
```

Then proceed to Step 1.

## Step 1 -- Config Gate

Check whether autopause is enabled by reading `.planning/config.json` with the Read tool.

**DO NOT use the gsd-tools config get-value command** -- it hard-exits on missing keys.

1. Read `.planning/config.json`
2. If the file does not exist, or `config.autopause && config.autopause.enabled === true` does not hold: display the disabled message below and **STOP**
3. Otherwise proceed to Step 2

**Disabled message:**

```
GSD > AUTOPAUSE

autopause is disabled. To activate:

  node <runtime-home>/gsd-core/bin/gsd-tools.cjs config-set autopause.enabled true

Then set autopause.clear_command (how /clear is typed into this session) — see
docs/features/autopause.md. Without it the Stop hook still asks for a pause at the
threshold, but the session stays paused until you /clear and /gsd-resume-work by hand.
```

---

## Step 2 -- Parse Argument

| Argument | Action |
|----------|--------|
| `status` (default) | Step 2a |
| `request` | Step 2b |
| `keep` | Step 2b with `--keep-session` (write the handoff, stay paused) |
| `log` | Step 2c |
| unknown | Show the usage message |

**Usage message:**

```
GSD > AUTOPAUSE

Usage: /gsd:autopause <mode>

Modes:
  status    This session's autopause state, unclaimed handoffs, effective config
  request   Pause now and let the hooks clear + resume this session
  keep      Pause now and STAY paused (no automatic /clear for 30 min)
  log       Tail the pause/resume hook logs
```

### Step 2a -- status

Read, with the Read tool (all paths relative to the project root; `<dir>` is the
directory of `autopause.pending_file`, default `.claude/gsd-resume/`):

- `.planning/config.json` → report the effective `autopause.*` values (`threshold_used_pct`
  defaults to `100 − hooks.context_critical_threshold`, i.e. 75; empty `*_command` keys mean
  "that step is manual")
- `<dir>/state.$CLAUDE_CODE_SESSION_ID.json` → `phase` (`pause-requested` / `clear-spawned`),
  `requested_at`, `used`, `manual`
- `<dir>/pending.json` and `<dir>/resumed.json` if present (a pending record addressed to
  another `claude_pid` is another session's business — say so, do not touch it)
- the unclaimed handoffs: run `gsd_run state sessions --raw` (fallback:
  `find .planning -maxdepth 1 -name 'HANDOFF.latest.*.json'`) and list `role_id` + timestamp

Present a short table. Then explain in one line what the next Stop will do
(request / spawn clear / nothing) based on the state and the current context meter.

### Step 2b -- request

Run, from this session's own Bash (the hook identifies the session by
`CLAUDE_CODE_SESSION_ID`):

```bash
node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hooks/gsd-pause-hook.js" --request-now   # keep: --keep-session
```

Then **immediately run the `gsd-pause-work` skill in this same turn** and finish through its WIP
commit. The Stop after that commit sees the requested handoff and spawns
`autopause.clear_command`. Do not ask the user for confirmation — they invoked this mode.

### Step 2c -- log

```bash
tail -n 40 "<dir>/gsd-pause-hook.log" "<dir>/gsd-resume-hook.log" 2>/dev/null || true
```

Summarise: last request, last spawn, last resume, any line starting with `★`.

---

## What the operator needs to know

- **Every pause resumes automatically** while autopause is enabled — the next Stop after a
  handoff of this session is committed (newer than the session's start / last resume) clears
  and resumes, hook-requested or hand-run alike. To stay paused, say so first:
  `/gsd:pause-work --keep-session` (30 min). `request` only records the request (and is
  the fallback when the host's `sessions/<pid>.json` has no `startedAt`).
- **The context monitor knows.** Its CONTEXT WARNING / CRITICAL text says the automatic pause
  will run at the threshold and asks the agent to finish the current step instead of running
  `/gsd:pause-work` early; the threshold defaults to `100 − hooks.context_critical_threshold`.
- **If the resume hook stops** (another session claimed the role first, the rename failed,
  `state session-resume` failed), the `.latest.*` files are still there — the fresh session
  gets a one-line listing and `/gsd:resume-work` picks up by hand.
- **`stop_hook_active`**: the Stop that follows the hook's own block never blocks again, so
  a session cannot be caught in a request loop.
- Every step is logged; every failure lands in the injected context line starting with `★`.
