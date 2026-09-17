# Autopause: the unattended pause → `/clear` → resume cycle

The `autopause` capability (`capabilities/autopause/capability.json`, default
off — `autopause.enabled`) is two host hooks and eight `autopause.*` config keys
([CONFIGURATION.md](CONFIGURATION.md#autopause-settings)); `/gsd-autopause` is
its operator skill. This page is the contract.

## Session resume hook (`gsd-resume-hook.js`)

`hooks/gsd-resume-hook.js` is a `SessionStart` hook (matcher `clear`) that
machinises the resume half of an **unattended pause → `/clear` → resume**
cycle for a session that shares one `.planning/` with other sessions and works
under a role (see [pause-work](../gsd-core/workflows/pause-work.md) — pause is
per session, represented by the session's own `HANDOFF*.json`).

GSD ships the hook and the two verbs it rides on (`state sessions`,
`state session-resume`, see [CLI-TOOLS.md](CLI-TOOLS.md)). GSD does **not**
ship the watcher that decides *when* to pause and types `/clear` into the
session — that needs a way to drive the terminal (tmux `send-keys`, …) and is
environment-specific. The contract between the two is one JSON file.

## Contract

```
watcher                                  gsd-resume-hook.js (SessionStart, source == "clear")
───────                                  ───────────────────────────────────────────────────
1. sends /gsd:pause-work                 
   → HANDOFF.latest.<role_id>.json
   → .continue-here.latest.<role_id>.md
2. writes <pending file>                 
3. sends /clear                    ───►  4. pending is < 30 min old ∧ addressed to THIS
                                            Claude Code process ∧ old_sid ≠ new sid
                                         5. claim: *.latest.<role_id>.* → *.claimed.<role_id>.<sid>.*
                                         6. autopause.claim_command (project extension point)
                                         6b. autopause.context_command → "### Project context" (≤ 4 KB)
                                         7. gsd-tools state session-resume --session --role --role-id
                                            --handoff <claimed json>  (JSON output; exit 0 ∧ resumed:true)
                                         8. git commit --only  — the two .latest deletions only
                                         9. additionalContext: handoff markdown (≤ 8 KB, else
                                            truncated + `git show` pointer) + STATE.md excerpt
                                            + "start from <next_action>, do not run /gsd-resume-work"
10. sees <resumed file>            ◄───  10. writes resumed.json next to the pending file
```

Pending file — path from `.planning/config.json` `autopause.pending_file`
(default `.claude/gsd-resume/pending.json`, always inside the project):

```json
{
  "version": 1,
  "at": "2026-09-16T05:00:00.000Z",
  "claude_pid": 12345,
  "old_sid": "<session id that paused>",
  "role": "coordinator",
  "role_id": "coordinator",
  "handoff_json_path": ".planning/HANDOFF.latest.coordinator.json",
  "handoff_md_path": ".planning/phases/02-x/.continue-here.latest.coordinator.md",
  "only_clear": false
}
```

`claude_pid` is the Claude Code host process that will receive `/clear`
(its id survives `/clear`; the session id does not). The hook checks it via
`<CLAUDE_CONFIG_DIR>/sessions/<pid>.json` (`sessionId` must equal the new
session id) and falls back to walking its own process ancestry. `only_clear`
(or a missing `role_id`) means "clear only, claim nothing".

Resumed file — sibling `resumed.json`:

```json
{ "version": 1, "at": "…", "old_sid": "…", "new_sid": "…", "role_id": "coordinator",
  "role": "coordinator", "claimed": null, "commit": "8bad936", "ok": true, "injected_bytes": 1263 }
```

## When it does nothing

If any precondition fails — a different `source`, no or stale pending file, a
pending file addressed to another process, an unchanged session id — the hook
claims nothing. It only injects one line listing the unclaimed
`HANDOFF.latest.*.json` files, and the session falls back to the manual
`/gsd-resume-work`. Every failure inside the automatic path (rename, the
claim command, `session-resume`, the commit) is reported in the injected
text; the hook never blocks the session and always exits 0.

## Project extension points

| Key (`.planning/config.json`) | Used by | Purpose |
|---|---|---|
| `autopause.pending_file` | hook | where the watcher writes the pending record |
| `autopause.claim_command` | hook | runs after the claim, before `session-resume` — role registry registration, `milestone.lock` re-keying, anything project-specific. Env: `GSD_RESUME_SESSION_ID`, `GSD_RESUME_OLD_SESSION_ID`, `GSD_RESUME_ROLE`, `GSD_RESUME_ROLE_ID`, `GSD_RESUME_HANDOFF_JSON`, `GSD_RESUME_HANDOFF_MD`, `CLAUDE_CODE_SESSION_ID` |
| `autopause.context_command` | hook | runs after the claim; exit 0 → stdout (≤ 4 KB, else first 4 KB + `<!-- TRUNCATED -->`) is appended as `### Project context (autopause.context_command)`. Same env as `resume_claim_command`, 10 s timeout. For the lines a role keeps outside its handoff — e.g. `grep` the role / `successor` lines out of STATE.md `## Session Continuity` — without Reading the whole file back |
| `autopause.notify_command` | pause-work `notify` step | how to reach the user when a pause ends with something only they can act on |
| `hooks.context_warning_threshold` | pause hook (default source) | the same "remaining ≤ N %" fire-point the context monitor uses — a watcher that pauses at the WARNING point stays consistent with the agent-facing warning |

Both commands run through the platform shell (`cmd.exe` on Windows, `/bin/sh`
elsewhere); a small Node script that reads the environment is the portable
choice.

## Pause side

`hooks/gsd-pause-hook.js` is the **Stop** hook that turns the watcher's
"decide when to pause" step into a stateless per-turn check, so a project only
has to provide the two shell commands GSD cannot: an optional guard and the
`/clear` sender.

```
every Stop                      gsd-pause-hook.js
──────────                      ─────────────────
                                used% = <tmpdir>/claude-ctx-<sid>.json (gsd-statusline.js)
(b) our requested pause is      → spawn autopause.clear_command DETACHED (env below),
    committed on disk             state → clear-spawned
(a) used% ≥ threshold ∧ not     → autopause.guard_command (exit 0 = go)
    requested (30 min TTL) ∧      → state → pause-requested
    !stop_hook_active             → {"decision":"block","reason":"run gsd-pause-work now …"}
otherwise                       → nothing
```

- The block reason tells the session to run `gsd-pause-work` through the WIP
  commit, ask nothing (unknown → `unknown`) and **measure** state rather than
  recall it.
- (b) accepts only a handoff written for the request: `HANDOFF.latest.<role_id>.json`
  with `session_id` == ours, committed (`git diff --quiet HEAD`), timestamp ≥
  `requested_at − 60 s`. A **manual** pause is never cleared automatically:
  above the threshold (a) re-requests so the handoff is rewritten from current
  state; below it the session stays paused (logged).
- `node gsd-pause-hook.js --request-now` (from the session's own Bash;
  `CLAUDE_CODE_SESSION_ID`) writes `pause-requested` (`manual: true`) unless a
  live request exists; `--keep-session` writes `keep-session`. Both are no-ops
  with a message while autopause is off.
- State/log: `state.<sid>.json` and `gsd-pause-hook.log` next to
  `autopause.pending_file`. `stop_hook_active` (the Stop after our own
  block) never blocks again.

Threshold: `autopause.threshold_used_pct`, else `100 − hooks.context_critical_threshold`, else 75 — the
context monitor derives the same number and, with autopause on, its WARNING/CRITICAL text says
"Automatic pause will run at N% … Do NOT run /gsd-pause-work yourself" (one signal, not two).

**One path, not two.** `/gsd-pause-work` runs `gsd-pause-hook.js --request-now` at its start
whenever autopause is on (idempotent when the hook already requested), so a hand-started pause is
cleared and resumed exactly like a hook-requested one — the freshest handoff is the one written
right before the clear. `/gsd-pause-work --keep-session` writes `keep-session` (30 min) instead
and (b) leaves that pause alone.
Guard env: `GSD_PAUSE_SESSION_ID`, `GSD_PAUSE_CLAUDE_PID`, `GSD_PAUSE_USED_PCT`.
Clear env: `GSD_CLEAR_SESSION_ID` (old id), `GSD_CLEAR_CLAUDE_PID`, `GSD_CLEAR_SESSION_NAME`
(from `<CLAUDE_CONFIG_DIR>/sessions/<pid>.json`), `GSD_CLEAR_ROLE`, `GSD_CLEAR_ROLE_ID`,
`GSD_CLEAR_HANDOFF_JSON`, `GSD_CLEAR_HANDOFF_MD`, `GSD_CLEAR_STATE_DIR` (project-relative
POSIX). The clear command is expected to type `/clear` into the session and to
write the pending record described above, so `gsd-resume-hook.js` can finish
the cycle.

## Registration

Both hooks read `autopause.enabled` first: off, the pause hook exits silently and the
resume hook only prints the unclaimed-handoff listing.

The plugin manifest (`hooks/hooks.json`) registers the resume hook under
`SessionStart` with `"matcher": "clear"` and the pause hook under `Stop`.
For a classic (non-plugin) install add the same entries to `settings.json`
yourself — both are inert without a pending file / a threshold crossing, so
registering them costs nothing:

```json
{ "hooks": {
  "SessionStart": [ { "matcher": "clear", "hooks": [
    { "type": "command", "command": "node \"$HOME/.claude/hooks/gsd-resume-hook.js\"", "timeout": 60 } ] } ],
  "Stop": [ { "hooks": [
    { "type": "command", "command": "node \"$HOME/.claude/hooks/gsd-pause-hook.js\"", "timeout": 60 } ] } ]
} }
```

`node hooks/gsd-resume-hook.js --dry-run < input.json` prints what a real run
would do (renames, commands, commit, injected size) without writing anything.
