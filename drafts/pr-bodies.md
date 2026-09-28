# PR body drafts (fill `#NNN` with the issue numbers once they exist)

Open order: PR 1 (any time after `confirmed-bug`) · PR 2 (after `approved-feature`) · PR 3 (after `approved-feature` AND PR 2 merged; rebase onto `next` last, right before push).

Commands (per branch, once the issue number is known):
```
npm run changeset -- --type Fixed   --pr <PR1> --body "**Statusline context meter no longer subtracts the auto-compact buffer when \`autoCompactEnabled\` is false** — the bar shows the raw used% (matching \`/context\`) instead of pinning at 100% from raw 83.5%."
npm run changeset -- --type Added   --pr <PR2> --body "**\`/gsd-pause-work\` / \`/gsd-resume-work\` are per session** — handoffs are keyed by role (\`HANDOFF.latest.<role_id>.json\`) and claimed on resume; shipped workflows no longer set the project-wide \`paused_at\`; new \`state session-resume\` / \`state sessions\` verbs and \`.planning/sessions/<sid>.json\` records; the statusline shows \`paused\` only for its own session and \`⏸N\` for others."
npm run changeset -- --type Added   --pr <PR3> --body "**\`autopause\` capability (default off)** — an unattended pause → \`/clear\` → resume cycle: a Stop hook asks the session to \`/gsd-pause-work\` at a context threshold and hands the handoff to \`autopause.clear_command\`; a SessionStart(clear) hook claims it, runs \`state session-resume\` and injects it. Operated by \`/gsd-autopause\`; contract in docs/reference/autopause-contract.md."
GITHUB_BASE_REF=next node scripts/changeset/lint.cjs
gh pr create --base next --repo open-gsd/gsd-core --head tanji-dg:<branch> --template fix.md   # PR 2 and 3: feature.md
```

---

## PR 1 — `fix(#NNN): statusline skips the auto-compact buffer when autoCompactEnabled is false`

Template: fix.md · branch `fix/NNN-statusline-autocompact-buffer` · base `next`

**Linked Issue:** Fixes #NNN

**What was broken:** The context meter always subtracted the ~16.5% auto-compact buffer (or the `CLAUDE_CODE_AUTO_COMPACT_WINDOW` share) from `remaining`. With `"autoCompactEnabled": false` that buffer is ordinary context: raw 40% read as 48%, raw 83.5% pinned the bar at 100%, the last sixth of the window was invisible.

**What this fix does:** `isAutoCompactDisabled(dir)` reads, fail-soft and first-definitive-wins, `DISABLE_AUTOCOMPACT` / `CLAUDE_CODE_DISABLE_AUTO_COMPACT`, then `<project>/.claude/settings.local.json`, `settings.json`, then `(CLAUDE_CONFIG_DIR || ~/.claude)/settings.local.json`, `settings.json` for the boolean `autoCompactEnabled`; when disabled the buffer is 0 and the bar shows `round(100 − remaining)`. The bridge file's `used_pct` was already raw, so consumers are unchanged.

**Root cause:** The buffer was a constant chosen when auto-compact could not be turned off; the setting was added to Claude Code later and the meter never learned about it.

**Testing:** `tests/gsd-statusline.test.cjs` — `autoCompactEnabled:false` in project and config-dir settings, the env spellings, precedence (env > project > config dir), and the existing #2219 / #1194 spawn tests now pin `CLAUDE_CONFIG_DIR` to a scratch dir so a developer's real `settings.json` cannot steer expected percentages. Regression test added: yes. Platforms: Windows, Linux. Runtimes: Claude Code (statusline is Claude-only).

**Breaking changes:** none.

---

## PR 2 — `feat(#NNN): per-session pause — role-keyed handoffs, claim-on-resume, per-session records`

Template: feature.md · branch `feat/NNN-per-session-handoff` · base `next`

**Linked Issue:** Closes #NNN

**Feature summary:** `/gsd-pause-work` and `/gsd-resume-work` become correct for more than one session on one `.planning/`: per-session handoffs keyed by an optional role, claim-on-resume, per-session continuity records, and `paused` derived from the session's own handoff instead of the project-wide `paused_at`.

**Before / After:**
- Before: one `HANDOFF.json` per repo (second pause overwrites the first); `paused` derived from STATE.md `paused_at`, a project-wide preserve-when-unchanged field no shipped workflow writes or clears; session-id-keyed files never reclaimed after `/clear` (18+ stale handoffs observed).
- After: pause == "my handoff file exists"; `HANDOFF.latest.<role_id>.json` + `.continue-here.latest.<role_id>.md` (one slot per role), claim by atomic rename on resume, `.planning/sessions/<sid>.json` records beside the legacy `## Session` block, `state session-resume` / `state sessions`, statusline `paused` (own) / `⏸N` (others). No shipped workflow sets `paused_at` / `status: paused`; the STATE.md schema and `normalizeStateStatus` are unchanged; a legacy frontmatter-only `status: paused` is repaired on resume (`repairLegacyPausedStatus`, ADR-3408 §8.3 `authoritativeFm`).

**How it was implemented:** `src/session-store.cts` (new; identity from `--session` / runtime env only — no TTY fallback; best-effort reads modelled on `milestone-lock.cts`), `state.cts` verbs, `smart-entry.cts` paused route, inline `readHandoffs` in the statusline (the #3582 no-new-require seam), `--session` on the context-monitor breadcrumb, workflow text in `pause-work.md` / `resume-project.md` / `next.md` (+ `discuss-phase`, `execute-phase`, `forensic-audit` match `HANDOFF*.json`), `CONTEXT.md` Session Store Module entry.

**Testing:** `tests/session-continuity.test.cjs` (store, verbs, statusline, smart-entry, in-process rows scrub the ambient session env), `tests/session-continuity-workflows.test.cjs` (workflow text contracts), `tests/state.test.cjs`, `tests/gsd-statusline*.test.cjs`. Platforms: Windows, Linux. Runtimes: Claude Code (statusline / env keys), verbs runtime-agnostic.

**New files:** `src/session-store.cts`, `tests/session-continuity.test.cjs`, `tests/session-continuity-workflows.test.cjs`. **Modified files:** see the issue's full scope (32 files).

**Spec compliance:** copy the acceptance criteria from the issue and tick each.

**Scope confirmation / Documentation:** matches the issue; `docs/CLI-TOOLS.md`, `docs/INVENTORY.md`, `gsd-core/references/artifact-types.md`, `gsd-core/templates/README.md`, `CONTEXT.md` updated; all English.

**Breaking changes:** none — legacy `HANDOFF.json` / `.continue-here.md` remain readable; `state record-session` output without `--session` is byte-identical; STATE.md `## Session` keeps being written.

---

## PR 3 — `feat(#NNN): autopause capability — unattended pause → /clear → resume`

Template: feature.md · branch `feat/NNN-autopause` · base `next` (after PR 2 merges)

**Linked Issue:** Closes #NNN

**Feature summary:** Default-off capability: `hooks/gsd-pause-hook.js` (Stop) requests `/gsd-pause-work` at a context threshold and, once this session's handoff is written and settled, spawns `autopause.clear_command` detached; `hooks/gsd-resume-hook.js` (SessionStart, clear) claims the role-keyed handoff addressed to its own Claude Code process, runs `autopause.claim_command`, `state session-resume`, consumes the two `.latest` files and injects the handoff + a STATE.md excerpt. Everything environment-specific is a `*_command` extension point.

**New files:**

| File | Purpose |
|---|---|
| `hooks/gsd-pause-hook.js` | Stop hook: threshold request (`decision: block`), settled-handoff detection, detached `clear_command`, `--request-now` / `--keep-session`, stall notification |
| `hooks/gsd-resume-hook.js` | SessionStart(clear) hook: pending-record match, claim, `claim_command`, `state session-resume`, consume, `context_command`, injection, `resumed.json` |
| `hooks/lib/autopause-shared.js` | Shared config view / state dir / handoff lookup / git probes for both hooks and the context monitor |
| `capabilities/autopause/capability.json` | Manifest: `autopause.*` keys, `runtimeCompat.supported: ["claude"]` |
| `commands/gsd/autopause.md`, `skills/gsd-autopause/SKILL.md` | `/gsd-autopause` — status, request now, logs |
| `docs/reference/autopause-contract.md`, `docs/features/autopause.md` | The pending/resumed file contract, env of each `*_command`, registration |
| `tests/gsd-pause-hook.test.cjs`, `tests/gsd-resume-hook.test.cjs` | Unit + end-to-end (scratch git project) |

**Modified files:** `hooks/hooks.json`, `hooks/managed-hooks-registry.cjs`, `scripts/build-hooks.js`, `hooks/gsd-context-monitor.js` (one-signal text; threshold via the shared lib), `gsd-core/bin/lib/capability-registry.cjs` (generated), `src/clusters.cts`, `gsd-core/workflows/pause-work.md` (arm / notify steps, unattended rule), `docs/CONFIGURATION.md`, `docs/COMMANDS.md`, `docs/FEATURES.md` (generated), `docs/INVENTORY.md`, `docs/features/hook-system.md`, `docs/reference/capability-matrix.md`, `tests/fixtures/install-tree/*.json`, `scripts/lib/platform-conformance-tier.generated.cjs`.

**Implementation notes:**
- Both hooks gate on a raw `config.autopause.enabled` read rather than `isCapabilityActive()`: a hook runs every turn and must not load the registry; installed ∧ surfaced is implied by the hook being registered.
- `capability.json` `"hooks": []` — the two hooks are registered through `hooks/hooks.json` + `managed-hooks-registry.cjs` like every other managed hook, not through the capability's `hooks` field, so `hooks.json` stays the single owner of hook registration.
- The statusline's inline handoff classification (#3582 seam) and the shared lib's `.continue-here` walk are deliberate copies of `session-store.cts`; `CONTEXT.md` names the module as the owner.
- Known follow-ups (out of the approved scope, listed in the issue): per-process pending records, configurable `context_command` cap, `milestone.lock` re-keying in `state session-resume`.

**Spec compliance:** copy the acceptance criteria from the issue and tick each.

**Testing:** 60+ tests across the two hook files incl. an end-to-end pause → clear → resume on a scratch repo, the `commit_docs: false` / untracked paths, the keep-session opt-out, the settle window, `--dry-run`. Platforms: Windows, Linux. Runtimes: Claude Code only (rides on its `Stop` / `SessionStart(source=clear)` events and the statusline bridge file); others excluded by `runtimeCompat`.

**Breaking changes:** none — inert unless `autopause.enabled: true`.

---
Issue numbers (posted 2026-09-18): PR 1 → #4844 (bug) · PR 2 → #4845 (feature-request) · PR 3 → #4846 (feature-request, depends on #4845).
Branch renames before push: `fix/4844-statusline-autocompact-buffer`, `feat/4845-per-session-handoff`, `feat/4846-autopause`.
