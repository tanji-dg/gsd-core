# Autopause: the unattended pause → `/clear` → resume cycle

The `autopause` capability (`capabilities/autopause/capability.json`, default
off — `autopause.enabled`) is two host hooks and eight `autopause.*` config keys
([CONFIGURATION.md](../CONFIGURATION.md#autopause-settings)); `/gsd-autopause` is
its operator skill. This page is the contract: the files the two hooks and the
project's `*_command` extension points exchange.

## Session resume hook (`gsd-resume-hook.js`)

`hooks/gsd-resume-hook.js` is a `SessionStart` hook (matcher `clear`) that
automates the resume half of an **unattended pause → `/clear` → resume**
cycle for a session that shares one `.planning/` with other sessions and works
under a role (see [pause-work](../../gsd-core/workflows/pause-work.md) — pause is
per session, represented by the session's own `HANDOFF*.json`).

GSD ships both hooks and the two verbs they ride on (`state sessions`,
`state session-resume`, see [CLI-TOOLS.md](../CLI-TOOLS.md)). The Stop hook
([pause side](#pause-side)) decides *when* to pause. GSD does **not** ship the
command that types `/clear` into the session — that needs a way to drive the
terminal (tmux `send-keys`, …) and is environment-specific; it is
`autopause.clear_command`. The contract between it and the resume hook is one
JSON file.

## Contract

```
gsd-pause-hook.js (Stop) + clear_command   gsd-resume-hook.js (SessionStart, source == "clear")
────────────────────────────────────────   ───────────────────────────────────────────────────
1. Stop hook has the session run
   /gsd-pause-work (decision: block)
   → HANDOFF.latest.<role_id>.json
   → .continue-here.latest.<role_id>.md
2. Stop hook spawns autopause.clear_command
   (detached) once both files are settled
3. clear_command writes <pending file>
   and types /clear               ───►  4. pending is < 30 min old ∧ addressed to THIS
                                            Claude Code process ∧ old_sid ≠ new sid
                                         5. claim: *.latest.<role_id>.* → *.claimed.<role_id>.<sid>.*
                                         6. autopause.claim_command (project extension point)
                                         6b. autopause.context_command → "### Project context" (≤ 4 KB)
                                         7. gsd-tools state session-resume --session --role --role-id
                                            --handoff <claimed json>  (JSON output; exit 0 ∧ resumed:true)
                                         8. consume: commit_docs on ∧ both files tracked+clean →
                                            git commit --only (the two .latest deletions);
                                            otherwise remove the files, no git call
                                         9. additionalContext: handoff markdown in full (≤ 32 KB);
                                            over that, 8 KB + the claimed MD stays on disk to Read
                                            (size only — git plays no part) + STATE.md excerpt
                                            + "start from <next_action>, do not run /gsd-resume-work"
10. clear_command may wait for      ◄───  10. writes resumed.json next to the pending file
    <resumed file> (its ack)
```

Pending file — written by `autopause.clear_command`; path from
`.planning/config.json` `autopause.pending_file` (default
`.claude/gsd-resume/pending.json`, always inside the project):

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
| `autopause.pending_file` | both hooks | where `autopause.clear_command` writes the pending record; the state files and logs of both hooks live in the same directory |
| `autopause.claim_command` | hook | runs after the claim, before `session-resume` — whatever registration of the new session id the project needs (a per-session role file, a project lock keyed by session id, …); nothing project-specific lives in the hook. Env: `GSD_RESUME_SESSION_ID`, `GSD_RESUME_OLD_SESSION_ID`, `GSD_RESUME_ROLE`, `GSD_RESUME_ROLE_ID`, `GSD_RESUME_HANDOFF_JSON`, `GSD_RESUME_HANDOFF_MD`, `CLAUDE_CODE_SESSION_ID` |
| `autopause.context_command` | hook | runs after the claim; exit 0 → stdout (≤ 4 KB, else first 4 KB + `<!-- TRUNCATED -->`) is appended as `### Project context (autopause.context_command)`. Same env as `autopause.claim_command`, 10 s timeout. For the lines a role keeps outside its handoff — e.g. `grep` the role / `successor` lines out of STATE.md `## Session Continuity` — without Reading the whole file back |
| `autopause.notify_command` | pause-work `notify` step; pause hook | how to reach the user when a pause ends with something only they can act on, and the pause hook's one-time report of a requested pause that produced no handoff within 10 min (`GSD_PAUSE_MESSAGE`, `GSD_PAUSE_SESSION_ID`) |
| `hooks.context_critical_threshold` | pause hook (default source of `autopause.threshold_used_pct`) | the context monitor's CRITICAL fire-point ("remaining ≤ N %"): the pause runs at `100 − N` used, so WARNING means "wrap up" and CRITICAL means "the pause runs" — one signal |

Both commands run through the platform shell (`cmd.exe` on Windows, `/bin/sh`
elsewhere); a small Node script that reads the environment is the portable
choice.

## Pause side

`hooks/gsd-pause-hook.js` is the **Stop** hook that decides when to pause as a
stateless per-turn check, so a project only has to provide the two shell
commands GSD cannot: an optional guard and the `/clear` sender.

```
every Stop                      gsd-pause-hook.js
──────────                      ─────────────────
                                used% = <tmpdir>/claude-ctx-<sid>.json (gsd-statusline.js)
(b) OUR handoff is committed    → spawn autopause.clear_command DETACHED (env below),
    and newer than this session   state → clear-spawned
(a) used% ≥ threshold ∧ not     → autopause.guard_command (exit 0 = go)
    requested (30 min TTL) ∧      → state → pause-requested
    !stop_hook_active             → {"decision":"block","reason":"run gsd-pause-work now …"}
otherwise                       → nothing
```

- The block reason tells the session to run `gsd-pause-work` through the WIP
  commit, ask nothing (unknown → `unknown`) and **measure** state rather than
  recall it.
- (b) accepts a `HANDOFF.latest.<role_id>.json` with `session_id` == ours whose
  `.continue-here.latest.<role_id>.md` twin exists and is non-empty, both files
  settled (unchanged for 10 s — a Stop that arrives earlier waits out the rest, so an
  idle session's only Stop is not missed), and whose timestamp is **newer than this session** —
  `max(<config>/sessions/<pid>.json.startedAt, state.spawned_at, state.resumed_at)`,
  the last written by the resume hook. Whether the hook requested the pause or
  the user ran `/gsd-pause-work` by hand makes no difference: **a pause
  committed in this session is the decision to hand over** — the arm step is not
  a precondition. The floor is what keeps a previous session's handoff, or one
  already spawned for, from clearing us. Only `keep-session` (30 min) opts out.
  When neither `startedAt` nor `resumed_at` is known the hook falls back to the
  stricter requested-pause rule (timestamp ≥ `requested_at − 60 s`) — it never
  guesses. **git is not consulted** — a WIP commit is GSD's default (`commit_docs`),
  not this capability's contract; a pause whose commit failed, a project with
  `commit_docs: false`, or one without git hands over the same way (the log notes
  whether the files happened to be committed). A half-written pair (JSON without its
  twin, still changing) is logged as "handoff in progress"; a requested pause with no
  complete handoff after 10 min is reported once through `autopause.notify_command`.
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
(the session's optional display name from `<CLAUDE_CONFIG_DIR>/sessions/<pid>.json`, empty when never set), `GSD_CLEAR_ROLE`, `GSD_CLEAR_ROLE_ID`,
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
yourself (`$HOME/.claude` below is the config root — `CLAUDE_CONFIG_DIR`, or the
project's `.claude/` for a `--local` install) — both are inert without a pending file / a threshold crossing, so
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
