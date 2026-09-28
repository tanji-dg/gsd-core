# Issue draft #2 — Feature Request (template: feature_request.yml)

Title: `feat(pause-work): per-session pause — role-keyed handoffs, claim-on-resume, per-session records`

## Pre-submission checklist
- [x] I have searched existing issues and discussions — this has not been proposed and declined before (closest: #3311 milestone.lock, which already gives GSD a `(phase, session id)` claim; workstreams #REQ-WS, which isolate *milestone areas*, not sessions)
- [x] I have read CONTRIBUTING.md and understand that I must wait for `approved-feature` before writing any code
- [x] I have read the existing GSD commands and workflows and confirmed this feature does not duplicate existing behavior
- [x] This feature solves a problem for solo developers using AI coding tools, not a personal preference or workflow I happen to like

## Feature name
Per-session pause: role-keyed handoffs, claim-on-resume, per-session continuity records

## Type of addition
Two new `state` CLI verbs (`session-resume`, `sessions`), one new module (`src/session-store.cts`), a new `.planning/sessions/<session_id>.json` artifact, and a change to how `/gsd-pause-work` / `/gsd-resume-work` name and consume their handoff files. No new slash command or workflow.

## The solo developer problem
A solo developer increasingly runs **more than one Claude Code session on the same repository** — a coordinator session plus one or two workers, or simply two terminals on one `.planning/`. Today pause/resume assumes one session per project:

1. `/gsd-pause-work` writes one project-wide `.planning/HANDOFF.json` + `.continue-here.md`. The second session to pause silently overwrites the first session's handoff; the first session's state is gone.
2. "paused" is derived from STATE.md's project-wide `paused_at` / `Paused At:` field (`smart-entry.cts` `paused`, `next.md` Route 8, `normalizeStateStatus`), a `preserve-when-unchanged` field that no shipped workflow writes **or clears**. Once an agent or an older STATE.md puts it there, every session on that `.planning/` reads as `PAUSED` in the statusline and `/gsd-next` routes to resume, with no GSD path back out.
3. Keying the handoff by session id does not help: `/clear` and restarts issue a new `CLAUDE_CODE_SESSION_ID`, so a resuming session never recognises a handoff as its own, nothing is deleted, and stale `HANDOFF*.json` accumulate (18+ observed in one repository).

**Why workstreams do not solve this:** workstreams isolate *milestone areas* (`.planning/workstreams/<name>/`, REQ-WS-01). Handoffs are written to the literal project-root `.planning/`, and two sessions working the **same** workstream are still indistinguishable. The session-id concept itself already exists in GSD — `milestone.lock` (#3311) is a `(phase, session id)` claim — this proposal extends it to the pause artifact.

**"Role" in this proposal** is nothing GSD assigns: it is an optional free-text label a human gives a session (e.g. "coordinator", "implementer", "reviewer" — any string), and `role_id` is its ASCII slug. A session without a role is handled by session id. The role matters because it is the only identity that survives `/clear`.

## What this feature adds
- **Pause is per session.** "This session is paused" == "a handoff file that belongs to this session exists under `.planning/`". No shipped workflow sets `paused_at` / `status: paused` any more; the STATE.md schema, `STATUS_LIFECYCLE_ENUM` and `normalizeStateStatus` are **unchanged** (`paused` stays a valid value — `state session-resume` repairs a legacy frontmatter-only `status: paused` from the body `Status:` line when no `Paused At:` line claims it, via the sanctioned `authoritativeFm` write path, ADR-3408 §8.3).
- **Filenames:** `HANDOFF.latest.<role_id>.json` + `.continue-here.latest.<role_id>.md` for a session with a role (one slot per role, overwritten by that role's next pause); `HANDOFF.<session_id>.json` for a role-less session; `HANDOFF.json` / `.continue-here.md` remain the legacy fallback and stay resumable.
- **Claim on resume:** `resume-project.md` renames `HANDOFF.latest.<role_id>.json` → `HANDOFF.claimed.<role_id>.<session_id>.json` atomically *before* reading, so two sessions cannot resume the same role; the consumed files are removed (committed when `commit_docs` is on).
- **Per-session record** `.planning/sessions/<session_id>.json` (`stopped_at`, `last_session`, `role`, `role_id`, `resume_file`), written **alongside** — not instead of — the STATE.md `## Session` block, which many callers and tests pin.
- **CLI:** `state record-session --session/--role/--role-id` also writes the record (output without `--session` is byte-identical to today); `state session-resume` (new) records "Session resumed, proceeding to <action>", repairs the legacy status, unlinks only this session's handoff (`--handoff` adopts another's, `--keep-handoff` deletes nothing, best-effort on Windows EBUSY); `state sessions` (new, read-only) lists every session's handoff/record with `is_self` / `role` / `continue_here_path` and `paused` for the caller.
- **Consumers:** statusline shows `paused` for its own session's handoff and `⏸N` for other sessions' (inline `readHandoffs`, fs-only — the #3582 no-new-require seam); `/gsd-next` Route 8 keys on the own handoff; the context-monitor CRITICAL breadcrumb passes `--session` so exhaustion is attributed to the right session; `discuss-phase` / `execute-phase` / `forensic-audit` match `HANDOFF*.json` / `.continue-here*.md` in their blocking-constraint checks.
- Session identity resolves from `--session` or a runtime env key only — deliberately **no** controlling-TTY / tmux fallback (unlike `getWorkstreamSessionKey`): two panes of one terminal are two sessions, and a wrong guess would delete another session's handoff.

## Full scope of changes
- New: `src/session-store.cts`, `tests/session-continuity.test.cjs`, `tests/session-continuity-workflows.test.cjs`
- Modified: `src/state.cts` (`record-session` options, `session-resume`, `sessions`, `repairLegacyPausedStatus`), `src/state-command-router.cts`, `src/command-aliases.cts`, `src/smart-entry.cts` (`paused` from the own handoff), `src/artifacts.cts` (`HANDOFF*.json` known), `src/active-workstream-store.cts`, `gsd-core/bin/gsd-tools.cjs`, `eslint.config.mjs`, `.gitignore`
- Hooks: `hooks/gsd-statusline.js` (`readHandoffs`, `⏸N`), `hooks/gsd-context-monitor.js` (`--session`)
- Workflows: `gsd-core/workflows/pause-work.md`, `resume-project.md`, `next.md`, `discuss-phase.md`, `execute-phase.md`, `progress/steps/forensic-audit.md`; `gsd-core/references/artifact-types.md`, `gsd-core/templates/README.md`
- Commands / skills: `commands/gsd/pause-work.md`, `resume-work.md`, `skills/gsd-pause-work`, `gsd-resume-work`
- Docs: `docs/CLI-TOOLS.md`, `docs/INVENTORY.md`, `docs/INVENTORY-MANIFEST.json`, `CONTEXT.md` (Session Store Module entry)
- Tests touched: `tests/state.test.cjs`, `tests/gsd-statusline.test.cjs`, `tests/gsd-statusline-state.property.test.cjs`
- ≈ 32 files, +2000 / −270

## User stories
- As a solo developer running a coordinator session and a worker session on one repo, I want each session's `/gsd-pause-work` to write its own handoff, so that pausing one never destroys the other's state.
- As a developer whose statusline says `PAUSED` in every terminal after one session paused, I want "paused" to mean *this* session, so that the other sessions keep working and the indicator clears when I resume.
- As a developer who `/clear`s and resumes under the same role, I want `/gsd-resume-work` to find and claim my handoff (and delete it afterwards), so that stale handoffs stop accumulating and two sessions cannot both resume the same role.
- As an existing user with a legacy `HANDOFF.json`, I want resume to keep working unchanged, so that upgrading costs nothing.

## Acceptance criteria
- [ ] `/gsd-pause-work` in a session with a role writes `HANDOFF.latest.<role_id>.json` + `.continue-here.latest.<role_id>.md`; without a role, `HANDOFF.<session_id>.json`; it never writes `paused_at` / `status: paused` to STATE.md.
- [ ] `/gsd-resume-work` claims by atomic rename before reading, restores `role`, and removes the consumed files; a second session resuming the same role finds no `.latest` file and is told so.
- [ ] `state record-session --session S` writes `.planning/sessions/S.json` and still writes the STATE.md `## Session` block; without `--session` the STATE.md output is byte-identical to today.
- [ ] `state session-resume` unlinks only the caller's handoff, repairs a legacy frontmatter-only `status: paused` from the body `Status:` (and leaves it alone when a `Paused At:` line exists), reports `status.before/after/cleared`.
- [ ] `state sessions` lists every `HANDOFF*.json` / `sessions/*.json` with `is_self` and `paused`.
- [ ] Statusline: own handoff → `paused` / `PAUSED`; other sessions' handoffs → `⏸N`; no handoff → unchanged output. `/gsd-next` routes to resume only for the own handoff.
- [ ] Legacy `HANDOFF.json` + `.continue-here.md` remain readable and resumable; STATE.md schema and `normalizeStateStatus` unchanged.
- [ ] Session identity never falls back to TTY/tmux; with no `--session` and no runtime env key the verbs report `session_id: null` and delete nothing.

## Which area does this primarily affect?
Workflows (`pause-work`, `resume-project`, `next`), CLI (`state`), hooks (statusline, context-monitor)

## Applicable runtimes
All runtimes for the verbs and workflows — session id comes from `--session` or a runtime session-id env key (`GSD_SESSION_KEY`, `CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`, `OPENCODE_SESSION_ID`, `GEMINI_SESSION_ID`, `CURSOR_SESSION_ID`, `WINDSURF_SESSION_ID`; a strict subset of the existing `WORKSTREAM_SESSION_ENV_KEYS` without the terminal-identity keys, which survive `/clear`). The statusline / context-monitor pieces apply where those hooks are installed (Claude Code).

## Breaking changes assessment
None intended. Legacy filenames stay supported; `state record-session` output is byte-identical without `--session`; the STATE.md `## Session` block keeps being written; the schema keeps `paused` / `paused_at`. What changes: shipped workflows stop setting `paused_at`, so a project that relied on GSD writing it will see `paused` derived from the handoff file instead.

## Maintenance burden
One ~500-line module (best-effort reads modelled on `milestone-lock.cts`, nothing throws into a state command), two verbs in `state.cts`, workflow prose, ~90 tests. Two deliberate copies exist and are named in `CONTEXT.md` as followers of the module: the statusline's inline `readHandoffs` (#3582 seam) and the `.continue-here` lookup in `hooks/lib/` (a hook cannot require the compiled CLI). Emitted-drift growth on three workflows is acknowledged with `Emitted-Drift-Ack-Growth` trailers.

## Alternatives considered
- Keep project-wide pause and add a lock: still one handoff per repo; does not survive `/clear`.
- Session-id-keyed files only: implemented first, rejected — the id changes on every `/clear`, so files were never reclaimed.
- Workstreams per session: they isolate milestone areas, not sessions on one area; handoffs are not workstream-scoped.
- TTY/tmux-derived identity: rejected — two panes of one terminal are two sessions, and a wrong guess deletes another session's handoff.

## Prior art and references
`milestone.lock` (#3311, `(phase, session id)` claim), ADR-2207 (status lifecycle — unchanged here), ADR-3408 §8.3 (`authoritativeFm` for the legacy repair), `docs/reference/state-md.md` (`paused_at`), REQ-SESSION-01..07 (`docs/features/session-management.md`, all still met), REQ-WS-01.

## Additional context
Implementation is complete and tested on a fork (`next`-based); it will be opened as a PR (feature template) once this issue carries `approved-feature`. It is also the base of a second proposal (autopause: unattended pause → `/clear` → resume), filed separately.
