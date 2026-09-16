# Session resume hook (`gsd-resume-hook.js`)

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
                                         6. hooks.resume_claim_command (project extension point)
                                         7. gsd-tools state session-resume --session --role --role-id
                                            --handoff <claimed json>  (JSON output; exit 0 ∧ resumed:true)
                                         8. git commit --only  — the two .latest deletions only
                                         9. additionalContext: handoff markdown (≤ 8 KB, else
                                            truncated + `git show` pointer) + STATE.md excerpt
                                            + "start from <next_action>, do not run /gsd-resume-work"
10. sees <resumed file>            ◄───  10. writes resumed.json next to the pending file
```

Pending file — path from `.planning/config.json` `hooks.resume_pending_file`
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
| `hooks.resume_pending_file` | hook | where the watcher writes the pending record |
| `hooks.resume_claim_command` | hook | runs after the claim, before `session-resume` — role registry registration, `milestone.lock` re-keying, anything project-specific. Env: `GSD_RESUME_SESSION_ID`, `GSD_RESUME_OLD_SESSION_ID`, `GSD_RESUME_ROLE`, `GSD_RESUME_ROLE_ID`, `GSD_RESUME_HANDOFF_JSON`, `GSD_RESUME_HANDOFF_MD`, `CLAUDE_CODE_SESSION_ID` |
| `hooks.pause_notify_command` | pause-work `notify` step | how to reach the user when a pause ends with something only they can act on |
| `hooks.context_warning_threshold` | watcher (recommended) | the same "remaining ≤ N %" fire-point the context monitor uses — a watcher that pauses at the WARNING point stays consistent with the agent-facing warning |

Both commands run through the platform shell (`cmd.exe` on Windows, `/bin/sh`
elsewhere); a small Node script that reads the environment is the portable
choice.

## Registration

The plugin manifest (`hooks/hooks.json`) registers the hook under
`SessionStart` with `"matcher": "clear"`. For a classic (non-plugin) install
add the same entry to `settings.json` yourself — the hook is inert without a
pending file, so registering it costs nothing:

```json
{ "hooks": { "SessionStart": [ { "matcher": "clear", "hooks": [
  { "type": "command", "command": "node \"$HOME/.claude/hooks/gsd-resume-hook.js\"", "timeout": 60 }
] } ] } }
```

`node hooks/gsd-resume-hook.js --dry-run < input.json` prints what a real run
would do (renames, commands, commit, injected size) without writing anything.
