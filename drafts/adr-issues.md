# ADR issue drafts (template: chore.yml)

Both ADRs are **condition 1** of an already-`approved-feature` issue, and both deliverables are a single docs-only file. `CONTRIBUTING.md` routes "policy/docs decisions" to the chore template, so that is what these use; each body says so and offers to re-file under the feature template if the maintainers would rather the ADR carry its own `approved-feature`.

Per `CONTRIBUTING.md` — one issue = one ADR = one PR. File name `docs/adr/<issue#>-<slug>.md`, branch `docs/<issue#>-<slug>`, PR closes the issue.

---

## ADR issue A — per-session pause

Title: `chore(adr): record the per-session pause model — handoff file as the marker, role as the identity (condition 1 of #4845)`

### Pre-submission checklist
- [x] I have searched existing issues and this task is not already tracked
- [x] I have read CONTRIBUTING.md

### What is the maintenance task?
Write the ADR that the triage review on [#4845](https://github.com/open-gsd/gsd-core/issues/4845) made condition 1 of that feature: record the architectural decision behind per-session pause — a handoff file's existence is the pause marker, and a session's role is the identity that survives `/clear`.

Docs-only. One new file, `docs/adr/<this issue#>-per-session-pause-and-handoff-claim.md`, plus the regenerated `docs/adr/README.md` index. No production code; #4845's implementation is a separate PR that will cite this ADR.

### Type of maintenance
Documentation / architecture decision record

### Current state
#4845 carries `approved-feature`. Its review set four merge conditions, the first being: *"file an ADR under CONTRIBUTING.md's new-architectural-surface rule, calibrated against whatever governed `milestone.lock`/#3311."*

That calibration point has now been checked, and the answer is worth recording here: **there is no milestone-lock ADR.** `grep -rl "milestone.lock\|milestone-lock" docs/adr/` returns nothing, so [#3311](https://github.com/open-gsd/gsd-core/issues/3311) shipped a structurally identical advisory-claim primitive without one. I am not citing that as a reason to skip this ADR — the review asked for one and the model deserves to be written down — but it does mean this ADR is recording a pattern the codebase already has two instances of, rather than proposing a novel one. If the maintainers would rather it also cover `milestone.lock` retroactively, say so and I will widen the scope; as drafted it names the boundary between the three primitives without claiming to document #3311's decision for it.

Nothing in the current tree states why pause is per session, why the role rather than the session id is the identity, why the claim is a rename, or why the session-identity resolution deliberately narrows `getWorkstreamSessionKey()`. Those four are re-derivable from the diff but not from the docs.

### Proposed work
One ADR (`Proposed`, ratify to `Accepted` once #4845 ships) deciding:

1. Pause is per session and the marker is the handoff file, not a STATE.md field.
2. `role_id` is the identity; session id is the fallback; the legacy unkeyed name still resolves.
3. Resume claims by atomic rename **before** reading, so two sessions cannot resume one role.
4. Session identity comes from `--session` or a runtime env key only — the terminal-identity keys are deliberately excluded, because they survive `/clear` and a wrong "this is mine" deletes another session's handoff.
5. `paused` / `paused_at` stay in the schema with [ADR-2207](https://github.com/open-gsd/gsd-core/blob/next/docs/adr/2207-status-field-lifecycle-ownership.md)'s lifecycle unchanged; no shipped workflow writes them, and `state session-resume` repairs a legacy value through [ADR-3408](https://github.com/open-gsd/gsd-core/blob/next/docs/adr/3408-state-write-path-preservation.md) §8.3's sanctioned `authoritativeFm` seam, declining with a reported reason whenever the case is ambiguous.
6. The boundary between the three advisory `.planning/` primitives — workstream store, `milestone.lock`, session store — stated as a table, since the review named "which primitive for which coordination problem" as the conceptual cost.
7. `src/session-store.cts` is the single owner of the handoff filename grammar; the two hook-side copies are sanctioned, named, and held to it by a **parity guard** (condition 2 of #4845) that fails when a reader is added without being registered in the shared case table.
8. Why this is core rather than a Capability under [ADR-857](https://github.com/open-gsd/gsd-core/blob/next/docs/adr/857-capability-system.md).

A complete draft exists and will be the PR; I can paste it into this issue first if that is the preferred review order.

### Done when
- [ ] `docs/adr/<issue#>-per-session-pause-and-handoff-claim.md` exists, `Status: Proposed`, id matching the filename, `Builds on` links to ADR-2207 / ADR-3408 / ADR-857 as file links.
- [ ] `docs/adr/README.md` regenerated (`scripts/gen-adr-index.cjs`), `npm run lint:generated-sync` green.
- [ ] Every decision above is stated with the failure it prevents, not just the rule.
- [ ] The three-primitive boundary is a table a contributor can act on.
- [ ] The ADR states what makes it ratifiable, so the `Proposed` label does not go stale.

### Area affected
Documentation (`docs/adr/`)

### Additional context
Blocks: the #4845 implementation PR. Related: #4846 needs a separate ADR (host-lifecycle hooks) filed alongside this one. Both were requested by the same triage sweep.

---

## ADR issue B — capability-owned host lifecycle hooks

Title: `chore(adr): decide whether a Capability may own a host lifecycle hook, and who registers it (condition 2 of #4846)`

### Pre-submission checklist
- [x] I have searched existing issues and this task is not already tracked
- [x] I have read CONTRIBUTING.md

### What is the maintenance task?
Write the ADR that the triage review on [#4846](https://github.com/open-gsd/gsd-core/issues/4846) made a merge condition: decide whether a Capability may own a Claude-host lifecycle hook (`Stop`, `SessionStart`) outside [ADR-857](https://github.com/open-gsd/gsd-core/blob/next/docs/adr/857-capability-system.md)'s Loop Extension Point contract, and settle the `hooks.json`-vs-capability-`hooks`-field ownership question.

Docs-only: one new ADR, the reciprocal `Amended by` back-link in ADR-857 (`docs/adr/README.md` rule 3a), and the regenerated index.

### Type of maintenance
Documentation / architecture decision record

### Current state
The review established two facts I had not stated in #4846 and which make this a decision rather than an implementation detail:

- **Every `capability.json` in the tree declares `"hooks": []`** (30+ descriptors). The field's meaning is undefined by practice, so a capability that ships two host hooks while declaring `[]` teaches readers that manifests are unreliable.
- **ADR-857 defines Capability integration exclusively as `step` / `contribution` / `gate` over ~12 named Loop Extension Points** — a host-agnostic contract about *loop steps*. `Stop` and `SessionStart(clear)` are Claude Code's own session-lifecycle events and sit outside it entirely: there is no loop point at which a session is cleared.

Core already owns host lifecycle hooks (`hooks/hooks.json` registers `gsd-context-monitor.js` on `Stop` / `SessionStart` / `PostToolUse`, tracked in `hooks/managed-hooks-registry.cjs`), so the mechanism exists — the open questions are whether a capability may use it and who registers the entry.

### Proposed work
One ADR (`Proposed`, ratify to `Accepted` once #4846 ships) deciding:

1. **Two extension axes, named and bounded.** Loop Extension Points (ADR-857, host-agnostic, preferred) and *host lifecycle hooks* (this ADR, host-specific, admissible only for behaviour triggered by a host session event with no loop equivalent). ADR-857's model is amended, not widened: nothing here lets a capability attach loop behaviour outside the 12 points.
2. **`hooks/hooks.json` stays the single owner of registration** — same staleness tracking, version stamping and install path as core's hooks. Generating it from descriptors is rejected: `hooks.json` is read at startup by every user including those who installed no capability, so one malformed descriptor must not be able to break hook loading for them.
3. **The descriptor declares what it ships, and a drift guard proves the declaration true.** A new `hostHooks` field (leaving `hooks` with its ADR-857 meaning) plus a guard asserting both directions: every declared hook is registered, and every registered capability-owned hook is declared by exactly one descriptor.
4. **Three CI-checkable obligations**: inert unless the activation key is on (and why the hook reads the raw config key rather than resolving full capability state — it runs every turn and must not load the registry); `runtimeCompat.supported` naming exactly the runtimes whose events it uses; `HOOK_ON_CRASH.ALLOW` per [ADR-3889](https://github.com/open-gsd/gsd-core/blob/next/docs/adr/3889-process-exit-contract.md), never `DENY`.
5. **How dependence on undocumented host internals is governed** — `<CLAUDE_CONFIG_DIR>/sessions/<pid>.json` is declared as unpublished at the call site and in the reference doc, is never the only path, and a failure to resolve identity degrades to the manual path rather than to a wrong claim.
6. **Correctness rests on atomic operations, not timing heuristics** — this is condition 3 of #4846, answered in the design rather than deferred:
   - the "handoff settled" window decides only when it is polite to spawn the clear command; if it fires early the result is a retry on the next `Stop`, because the correctness boundary is the atomic claim-rename and the resume hook validates what it claimed;
   - the pending record becomes **per host process** (`pending.<claude_pid>.json`) and additionally names the handoff path and the old session id, all three of which the resume hook requires to match. A single last-writer-wins `pending.json` is an edge case under manual use and a routine hazard under unattended use, which is why it is closed here and not listed as a follow-up.
7. Everything environment-specific (typing `/clear`, per-session registration, notification) stays outside GSD as a `*_command` extension point.

A complete draft exists and will be the PR.

### Done when
- [ ] `docs/adr/<issue#>-capability-owned-host-lifecycle-hooks.md` exists, `Status: Proposed`, `Amends: [ADR-857](857-capability-system.md)`.
- [ ] ADR-857 carries the reciprocal `Amended by` back-link **in the same PR** (`docs/adr/README.md` rule 3a).
- [ ] `docs/adr/README.md` regenerated; `npm run lint:generated-sync` green.
- [ ] The ADR states, as prose a reviewer can hold GSD to, when the second axis may **not** be used.
- [ ] The `pending.<pid>.json` decision is recorded as part of the first shipped design, with the race it closes named.

### Area affected
Documentation (`docs/adr/`), capability descriptor schema (decided here, implemented in #4846)

### Additional context
Sequenced behind ADR issue A (the per-session handoff contract this capability consumes) and behind #4845 itself, per #4846's own condition 1. Note that decision 3 adds a descriptor field, so the ADR decides a schema change that #4846 implements — if the maintainers would rather that part be split out, say so and I will narrow this ADR to the axis-and-ownership question alone.
