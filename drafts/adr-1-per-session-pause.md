# ADR-4962: Pause is per session — the handoff file is the marker, the role is the identity that survives `/clear` [Proposed]

- **Status:** Proposed — design lock for [#4845](https://github.com/open-gsd/gsd-core/issues/4845). Ratify to `Accepted` once #4845 has shipped and the parity guard (§7) is green in CI.
- **Date:** <TODAY>
- **Issue:** #4962 — the architectural decision behind [#4845](https://github.com/open-gsd/gsd-core/issues/4845)
- **Builds on:** [ADR-3408](3408-state-write-path-preservation.md) — its classification table is where `paused_at` is declared `preserve-when-unchanged`, which is why a legacy value is otherwise immortal (§5); [ADR-1769](1769-state-md-transition-module.md) (the Transition Module that preserves `stopped_at`/`paused_at` across transitions); [ADR-857](857-capability-system.md) (the loop is core; this decision is core, not a capability — see §8)
- **Does not touch:** [ADR-2207](2207-status-field-lifecycle-ownership.md). It governs one thing — that phase-completion writes an intermediate `Status` and milestone-close owns termination — and it never mentions `paused` or `paused_at`. It is named here only to say that this ADR leaves that ownership split, and the `Status` vocabulary, exactly as they are.
- **Relationship to prior work:** `src/milestone-lock.cts` ([#3311](https://github.com/open-gsd/gsd-core/issues/3311)) solved the structurally identical "two sessions, one slot" problem for STATE.md's single `## Current Position` and shipped **without an ADR** (there is no `docs/adr/*milestone*` file; the triage review on #4845 asked for that calibration point and this is the answer). This ADR records the model that #3311 established de facto and extends it to the pause artifact, so the next contributor does not have to re-derive it from two implementations.

## Context

`/gsd-pause-work` and `/gsd-resume-work` were designed for one session per project, and two of their load-bearing assumptions are now false.

**One handoff slot per repository.** `gsd-core/workflows/pause-work.md`'s `write_structured` step hardcodes `.planning/HANDOFF.json`, and `resume-project.md`'s `check_incomplete_work` / `load_state` steps read that same single path and delete it after resume as "a one-shot artifact". Two sessions on one `.planning/` — a coordinator plus a worker, or two terminals on one repository — therefore destroy each other's handoff silently: the second pause overwrites the first, and the first session's measured state is gone with no error anywhere.

**Project-wide "paused".** `paused_at` / `Paused At:` is a `preserve-when-unchanged` field (`src/state-md-schema.cts`) and `normalizeStateStatus` (`src/state-document.cts`) returns `paused` unconditionally when it is truthy. `smart-entry.cts` derives its `paused` flag from it and `/gsd-next` Route 8 keys on it. So one session's pause reads as *every* session's pause in every statusline, and — because the field is preserved across `state sync` and no shipped workflow clears it — there is no GSD path back out once it is set. The value is a project-wide fact being used to describe a per-session condition.

**Session id does not survive the boundary that matters.** Keying the handoff by `CLAUDE_CODE_SESSION_ID` was tried first and fails for the exact case pause exists to serve: `/clear` and restarts issue a new id, so the session that comes back never recognises its own handoff, never deletes it, and the files accumulate — 18+ stale `HANDOFF*.json` in one repository before this was diagnosed.

The third point is the architectural one. **Pause is a promise to a future session that has a different id than the one that made the promise.** Any design that identifies the pausing session by its id cannot keep that promise.

## Decision

### 1. Pause is per session, and the marker is the file, not a field

A session is paused **iff a handoff file that belongs to it exists under `.planning/`**. There is no project-wide pause state. Nothing in a shipped workflow writes `paused_at` or `status: paused`.

The marker is the file rather than a field because the file is the thing a resume actually needs. A field can say "paused" while the handoff it refers to is missing (the state we shipped), and a handoff can exist while the field was never written (a WIP commit that failed). One artifact, one truth.

### 2. `role_id` is the identity; session id is the fallback; the legacy name still resolves

Three filename forms, in precedence order for a resuming session:

| Form | Owner | Survives `/clear` |
|---|---|---|
| `HANDOFF.latest.<role_id>.json` + `.continue-here.latest.<role_id>.md` | a session operating under a role | **yes** |
| `HANDOFF.<session_id>.json` | a session with no role | no (see below) |
| `HANDOFF.json` + `.continue-here.md` | legacy; still read and still resumable | n/a |

A **role** is an optional free-text label the operator gives a session; GSD assigns none and infers none. `role_id` is its ASCII slug (`[a-z0-9-]+`, ≤ 80 chars, `sanitizeRoleId`) because it becomes part of a filename. One slot per role: the role's next pause overwrites its own file, so the set of role slots is bounded by the number of roles rather than growing with the number of pauses.

A role-less session keeps the session-id form knowingly: it cannot be reclaimed after `/clear`, and that is the honest outcome — without a role there is no identity to reclaim it *with*. Such a file is visible in `state sessions` and can be adopted explicitly (`session-resume --handoff`), which is the only sanctioned way one session takes another's handoff.

### 3. Resume claims by atomic rename, before it reads

`HANDOFF.latest.<role_id>.json` → `HANDOFF.claimed.<role_id>.<session_id>.json`, and the markdown twin likewise, **before** the content is read. `fs.rename` over one directory is the atomicity primitive: exactly one of two racing sessions gets the file, and the loser gets `ENOENT` and falls back to the manual path with a message.

The presence of a `.latest.*` file therefore means "this role is paused **and unclaimed**". This is why the claim precedes the read: a read-then-rename design lets two sessions both resume the same role, each believing it owns the work.

### 4. Session identity is explicit or from a runtime env key — never from the terminal

`SESSION_ID_ENV_KEYS` (`GSD_SESSION_KEY`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_SESSION_ID`, `CODEX_THREAD_ID`, `OPENCODE_SESSION_ID`, `GEMINI_SESSION_ID`, `CURSOR_SESSION_ID`, `WINDSURF_SESSION_ID`) is a **strict subset** of `WORKSTREAM_SESSION_ENV_KEYS`: the terminal-identity keys (`WT_SESSION`, `TMUX_PANE`, …) are deliberately excluded.

This narrows `getWorkstreamSessionKey()`'s behaviour for this Module's callers rather than reusing it verbatim, and the narrowing is the point. A terminal key survives `/clear`, so two consecutive sessions in one pane look like the same session — and a wrong "this is mine" **deletes another session's handoff**. Where workstreams can tolerate a heuristic (a wrong guess picks the wrong directory, recoverably), this cannot. With no explicit `--session` and no runtime key, the verbs resolve `session_id: null` and delete nothing.

### 5. `paused` stays in the schema; the legacy value is repaired, not redefined

The `Status` vocabulary is **unchanged**: `STATUS_LIFECYCLE_ENUM` (`src/state-md-schema.cts`) keeps `paused` as a valid value, `normalizeStateStatus` (`src/state-document.cts`) keeps returning it whenever `paused_at` is truthy, and [ADR-2207](2207-status-field-lifecycle-ownership.md)'s phase-completion-versus-milestone-close ownership split is untouched. `paused` remains a valid STATE.md status and `paused_at` remains a schema field with its `preserve-when-unchanged` classification: a project or a future capability may still have a legitimate project-wide pause.

What changes is who writes it: no shipped workflow does. And because [ADR-3408](3408-state-write-path-preservation.md) classifies `paused_at` as `preserve-when-unchanged`, an already-set legacy value would otherwise be immortal — preservation is doing its job, which is precisely why nothing clears it. So `state session-resume` repairs it: when the frontmatter says `paused` and no explicit `Paused At:` line under `## Session` claims it, the status is re-derived from the body `Status:` line. Anything ambiguous (an explicit `Paused At:`, a body `Status:` that is itself `paused`, no body line at all) is **left alone with the reason reported**, never guessed.

**This repair is not a new write-path exception.** It runs *through* the ordinary write seam — `readModifyWriteStateMd` plus the preservation pipeline — and declares its one intended value with that seam's own `authoritativeFm` option, the intent-first mechanism added for exactly this shape of case ([#2736](https://github.com/open-gsd/gsd-core/issues/2736)). [ADR-3408](3408-state-write-path-preservation.md) §8.3's list of sanctioned-permanent exceptions stays **closed at two** — `state sync` and `/gsd-health --repair`'s `REGENERATE_STATE`, both of which exist to let the body beat the frontmatter wholesale. `state session-resume` wants the opposite: the pipeline, with one field declared. A reviewer should not read §5 as asking for a third entry on that list, and this ADR does not amend §8.3.

### 6. Three advisory primitives, three questions — the boundary is stated, not inferred

This ADR adds a third advisory `.planning/`-scoped primitive. The cost the #4845 review named is real ("which primitive for which coordination problem"), so the boundary is declared here rather than left for the next contributor to reverse-engineer:

| Primitive | Answers | Keyed by | Conflict behaviour |
|---|---|---|---|
| Workstream store (`.planning/workstreams/<name>/`) | *which milestone area am I working in* | workstream name | directory isolation — no conflict to resolve |
| `milestone.lock` ([#3311](https://github.com/open-gsd/gsd-core/issues/3311)) | *who holds STATE.md's single `## Current Position` slot* | (phase, session id) | warn, never steal; TTL liveness |
| Session store (this ADR) | *whose paused work is this, and has anyone taken it* | role_id, else session id | claim by rename — exactly one winner |

They compose and do not overlap: a session in a workstream may hold a milestone lock and have a handoff, and none of the three can answer another's question.

### 7. One owner for "find this session's handoff", and a guard that proves the copies agree

`src/session-store.cts` is the single owner of the handoff filename grammar, `HandoffKind` classification and ownership test. Two copies exist and are **sanctioned, named, and guarded**:

- `hooks/gsd-statusline.js`'s inline `readHandoffs` — the [#3582](https://github.com/open-gsd/gsd-core/issues/3582) build seam: this hook must load with no new `require`, so it cannot reach the compiled CLI.
- the `.continue-here.latest.<role_id>.md` lookup in `hooks/lib/` — same reason, for the hooks that need the markdown twin.

Two independent re-implementations of an ownership test is precisely this repository's *generative fix divergence* class, so **a parity guard is part of the decision, not a review nicety**: a test asserts all readers agree on a shared table of filename cases (each `HandoffKind`, own vs. foreign session, own vs. foreign role, the legacy unkeyed body-read case, and non-handoff names that must not match). A new reader is added to the table or the guard fails. `CONTEXT.md`'s Session Store Module entry names the owner and both copies, so the direction of the dependency is documented where a contributor will look.

### 8. This is core, not a capability

Under [ADR-857](857-capability-system.md) a Feature Capability attaches to one of the 12 Loop Extension Points. Pause/resume is neither: `/gsd-pause-work` and `/gsd-resume-work` are shipped core workflows, and this decision changes their file naming and adds `state` verbs. A capability wrapping it would still have to modify the core STATE.md write path and add CLI surface, so it would add indirection without reducing the integration surface. Decided as core, consistent with `milestone.lock`.

## Consequences

- Two sessions on one `.planning/` stop destroying each other's handoff, and the statusline distinguishes "I am paused" from "someone else is paused" (`⏸N`).
- The stuck project-wide `paused` is gone as a class, and an existing one is repaired on the next resume.
- Stale handoffs stop accumulating: a role has one slot, and a claim is consumed on resume.
- Permanent surface added: two `state` verbs (`session-resume`, `sessions`), one artifact type (`.planning/sessions/<session_id>.json`), one module. Two sanctioned copies of the ownership test, held together by the §7 guard.
- A role-less session's handoff still cannot be auto-reclaimed after `/clear`. This is a stated limit of the model, not a defect to fix later: the fix is to give the session a role.
- Anything that read `status: paused` from STATE.md frontmatter expecting GSD to have written it will no longer see it set. `state sessions` is the replacement query.

## Alternatives considered

- **Project-wide pause plus a lock.** Still one handoff per repository; a lock serialises the overwrite instead of preventing it, and nothing survives `/clear`.
- **Session-id keys only.** Implemented first. Fails at `/clear`, which is the boundary pause exists for.
- **A workstream per session.** Workstreams isolate milestone areas (REQ-WS-01); handoffs are written to the literal project-root `.planning/`, and two sessions in one workstream stay indistinguishable. Forcing a workstream per session would also mean a milestone area per session, which is not what a coordinator and a worker are doing.
- **Terminal-derived identity** (reusing `getWorkstreamSessionKey()` verbatim). Rejected in §4: a wrong guess deletes another session's handoff.
- **Read-then-rename on resume.** Rejected in §3: it permits two sessions to resume one role.

## What makes this decision done

- No shipped workflow writes `paused_at` / `status: paused`; `state session-resume` repairs a legacy one and reports when it declines to.
- A role's pause is reclaimable after `/clear` by the same role and by no one else; the losing side of a claim race gets a message, not a corrupted resume.
- The §7 parity guard exists, covers every reader, and fails when a reader is added without being registered. It is an acceptance item of the implementation, not of this ADR: [#4845](https://github.com/open-gsd/gsd-core/issues/4845) carries it as a checklist line, so nothing can satisfy #4845 while leaving the three readers unguarded.
- `docs/features/session-management.md` (REQ-SESSION-01..07) and the `docs/<locale>/` mirrors that reference `HANDOFF.json` describe the per-session model.
- `CONTEXT.md` carries the Session Store Module entry naming the owner, the `HandoffKind` vocabulary and both sanctioned copies.
