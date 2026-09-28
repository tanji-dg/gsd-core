# Issue draft #3 — Feature Request (template: feature_request.yml)

Title: `feat(autopause): capability for the unattended pause → /clear → resume cycle`

Depends on the per-session pause proposal (#4845: role-keyed `HANDOFF.latest.<role_id>.json`, claim-on-resume, `state session-resume`) — the PR will be opened after that one merges. "Role" has the meaning defined there: an optional free-text label a human gives a session, whose slug survives `/clear`; GSD assigns none.

## Pre-submission checklist
- [x] I have searched existing issues and discussions — this has not been proposed and declined before (closest: #1452 "Long workflows should checkpoint before context exhaustion", and the `external-job` capability from #1105 / #1164, which commits a handoff and returns `external_job_waiting` for a long compute job — the trigger there is an external job, here it is context exhaustion, and neither existing path clears and resumes the session)
- [x] I have read CONTRIBUTING.md and understand that I must wait for `approved-feature` before writing any code
- [x] I have read the existing GSD commands and workflows and confirmed this feature does not duplicate existing behavior
- [x] This feature solves a problem for solo developers using AI coding tools, not a personal preference or workflow I happen to like

## Feature name
Autopause capability — unattended pause → `/clear` → resume

## Type of addition
New capability (default off) with two host hooks (`Stop`, `SessionStart(clear)`), one operator skill/command (`/gsd-autopause`), eight `autopause.*` config keys

## The solo developer problem
A long GSD run (execute-phase over many plans, an autonomous milestone, a coordinator session driving workers) reaches the context ceiling. Today the context monitor warns, and then a **human** has to (1) tell the session to `/gsd-pause-work`, (2) type `/clear`, (3) run `/gsd-resume-work` and answer its questions. If nobody is watching — overnight runs, a coordinator with several worker sessions, a session left to grind through a phase — the run either stalls at the warning or is auto-compacted into a lossy summary. The pieces GSD already owns (pause-work writes a handoff; resume-project claims it; `state session-resume` records it) are not wired into a loop, and GSD cannot type `/clear` into its own session.

## What this feature adds
- `hooks/gsd-pause-hook.js` (**Stop**): when `autopause.enabled`, at `autopause.threshold_used_pct` used (default 100 − `hooks.context_critical_threshold` = 75) it answers the Stop with `decision: block` asking the session to run `/gsd-pause-work` unattended (measure, do not ask; `autopause.guard_command` can say "not now"). Once the session's own handoff pair (`HANDOFF.latest.<role_id>.json` + `.continue-here.latest.<role_id>.md`) is written and settled and newer than the session, it spawns `autopause.clear_command` **detached** — the project's way of typing `/clear` (tmux `send-keys`, an IDE macro, …), which GSD does not ship. A hand-run `/gsd-pause-work` goes through the same path (`--request-now` arms it); `/gsd-pause-work --keep-session` is the opt-out.
- `hooks/gsd-resume-hook.js` (**SessionStart**, matcher `clear`): when a fresh pending record addressed to **this** Claude Code process exists, claims the role-keyed handoff (atomic rename), runs `autopause.claim_command`, `state session-resume`, consumes the two `.latest` files (committed with `git commit --only` when `commit_docs` is on and they are tracked+clean, plain removal otherwise), appends `autopause.context_command` output, and injects the handoff markdown + a STATE.md excerpt as `additionalContext` — no `/gsd-resume-work` needed. Otherwise it only lists unclaimed handoffs. Never blocks; every failure is reported in the injected text.
- `hooks/lib/autopause-shared.js`: the config view / state directory / handoff lookup both hooks and the context monitor share.
- Context monitor: with autopause on, one signal — WARNING says "wrap up, the pause runs at N%", CRITICAL is the pause.
- `capabilities/autopause/capability.json` + registry entry, `/gsd-autopause` (status, request now, logs), `docs/reference/autopause-contract.md` (the pending/resumed file contract and env of each `*_command`).

Everything environment-specific — how `/clear` is typed, per-session registration, notifications — is a `*_command` extension point; GSD ships none of it.

Two design points a reviewer will ask about:
- **Hook registration.** `capability.json` declares `"hooks": []` although the capability ships two hooks: they are registered through `hooks/hooks.json` + `hooks/managed-hooks-registry.cjs` like every other managed hook (staleness tracking, `{{GSD_VERSION}}` stamping, install/uninstall), so `hooks.json` stays the single owner of hook registration. If the maintainers prefer the capability's `hooks` field to own them, that is a small change.
- **Process identity.** The resume hook decides "is this pending record for me" by the Claude Code host pid. Its fast path reads `<CLAUDE_CONFIG_DIR>/sessions/<pid>.json` (`sessionId`, `startedAt`, optional `name`) — a Claude Code internal file with no published contract. When it is absent or disagrees, the slow path walks the hook's own process ancestry (`/proc` or CIM on Windows) to a `claude` executable; when both fail the hook claims nothing and prints the listing. The pause hook uses the same file only for `startedAt` (the session floor) and `GSD_CLEAR_CLAUDE_PID` / `GSD_CLEAR_SESSION_NAME`, with documented fallbacks.

## Full scope of changes
- New: `hooks/gsd-pause-hook.js`, `hooks/gsd-resume-hook.js`, `hooks/lib/autopause-shared.js`, `capabilities/autopause/capability.json`, `commands/gsd/autopause.md`, `skills/gsd-autopause/SKILL.md`, `docs/reference/autopause-contract.md`, `docs/features/autopause.md`, `tests/gsd-pause-hook.test.cjs`, `tests/gsd-resume-hook.test.cjs`
- Modified: `hooks/hooks.json` (Stop + SessionStart(clear) entries), `hooks/managed-hooks-registry.cjs`, `scripts/build-hooks.js`, `hooks/gsd-context-monitor.js`, `gsd-core/bin/lib/capability-registry.cjs` (generated), `src/clusters.cts`, `gsd-core/workflows/pause-work.md` (arm step, notify step, unattended rule), `docs/CONFIGURATION.md`, `docs/COMMANDS.md`, `docs/FEATURES.md` (generated), `docs/INVENTORY.md`, `docs/features/hook-system.md`, `docs/reference/capability-matrix.md`, `tests/fixtures/install-tree/*.json`, `scripts/lib/platform-conformance-tier.generated.cjs`
- ~35 files, ≈ +2000

## User stories
- As a solo developer running `/gsd-execute-phase` on a long phase, I want the session to pause itself at the context ceiling, clear, and continue from its own handoff, so that an overnight run finishes instead of stalling at a warning.
- As a developer driving several role-holding sessions on one repo, I want each session to resume under its own role without me typing `/clear` and `/gsd-resume-work` into each pane, so that the coordinator never loses a worker to context exhaustion.
- As a developer who has not opted in, I want both hooks to be inert (`autopause.enabled: false`), so that installing GSD changes nothing about how my sessions stop.

## Acceptance criteria
- [ ] With `autopause.enabled` unset/false: the Stop hook writes nothing and emits no decision; the SessionStart(clear) hook only prints the one-line unclaimed-handoff listing.
- [ ] With it on: at ≥ threshold used%, the Stop hook blocks once per 30 min with a reason that names `gsd-pause-work`; `stop_hook_active` never blocks again; a non-zero `guard_command` exit skips the request.
- [ ] A settled handoff pair of this session newer than the session floor spawns `clear_command` detached exactly once, with the documented `GSD_CLEAR_*` env; `--keep-session` prevents it; an older handoff never does.
- [ ] The resume hook claims only a pending record < 30 min old addressed to its own Claude Code process with a different `old_sid`; on success `state session-resume` has run, the two `.latest` files are gone (committed only when `commit_docs` is on and they were tracked+clean), `resumed.json` is written, and the injected text carries the handoff markdown (full ≤ 32 KB, else 8 KB + the file left on disk) and a STATE.md excerpt.
- [ ] Neither hook ever exits non-zero or blocks a session on an internal error (crash policy ALLOW).
- [ ] `/gsd-pause-work` arms the cycle (`--request-now`) when autopause is on and prints the activation hint when off.
- [ ] Tests: `tests/gsd-pause-hook.test.cjs`, `tests/gsd-resume-hook.test.cjs` (unit + end-to-end on a scratch git project), context-monitor one-signal text.

## Which area does this primarily affect?
Hooks / capabilities

## Applicable runtimes
Claude Code only — it rides on Claude Code's `Stop` / `SessionStart(source=clear)` hook events, the statusline bridge file `claude-ctx-<sid>.json` (which only `gsd-statusline.js` writes, and which Codex for instance never installs — #2586), and the `sessions/<pid>.json` internal noted above. `runtimeCompat.supported: ["claude"]` in the manifest, like the other runtime-bound capabilities.

## Breaking changes assessment
None. Default off; no existing file, verb or workflow changes behaviour unless `autopause.enabled` is true. Two new managed hooks are registered (inert when off). Config keys are namespaced `autopause.*`.

## Maintenance burden
Two hooks (~480 + ~630 lines) plus a ~200-line shared lib (`hooks/lib/autopause-shared.js`), all fs/spawn-only (no dependency on the compiled CLI beyond spawning `gsd-tools state session-resume`), with 60+ tests including an end-to-end scratch-repo cycle. The environment-specific part is deliberately outside GSD. Coupling points a maintainer should know: the statusline bridge file format (`claude-ctx-<sid>.json` `used_pct`), Claude Code's unpublished `sessions/<pid>.json`, and the `HANDOFF.latest.<role_id>` filename from #4845. Both hooks declare `HOOK_ON_CRASH.ALLOW` (ADR-3889 / #3911) — a hook bug can never block a session.

## Alternatives considered
- Rely on Claude Code's auto-compact: lossy, and GSD's handoff (measured state, next action, role) is exactly what a compaction summary drops.
- A resident watcher process outside GSD (the original prototype): works, but every project re-implements "when to pause" and "how to recognise my handoff"; the generic half belongs next to `pause-work` / `resume-project`.
- Have the Stop hook run `/gsd-pause-work` itself: a hook cannot run a skill; the `decision: block` reason is the sanctioned way to make the session do it.

## Prior art and references
#1452 (checkpoint before exhaustion); `external-job` capability (#1105 / #1164, `docs/reference/long-running-operations.md`) — the same handoff-and-resume primitive driven by an external job rather than by context; ADR-3889 / #3911 hook crash policy (`hooks/lib/hook-exit.js`); `docs/context-monitor.md` (the WARNING / CRITICAL fire-points this reuses); #2586 (statusline bridge file is Claude-only).

## Additional context
Implementation exists on a fork and is exercised daily on a multi-session setup; it will be opened as a PR (feature template) once this issue carries `approved-feature` and the per-session handoff PR (#2) has merged. Known follow-ups deliberately left out of the first PR: per-process pending records when two roles clear within seconds of each other (today the single `pending.json` is last-writer-wins), a configurable `context_command` size cap (4 KB today), `state session-resume` re-keying `milestone.lock` to the new session id.
