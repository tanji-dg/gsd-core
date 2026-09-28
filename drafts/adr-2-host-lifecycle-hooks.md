# ADR-4963: A Capability may own a host lifecycle hook — a second, narrower extension axis beside the Loop Extension Points [Proposed]

- **Status:** Proposed — design lock for [#4846](https://github.com/open-gsd/gsd-core/issues/4846). Ratify to `Accepted` once #4846 has shipped and the §3 declaration guard is green in CI.
- **Date:** <TODAY>
- **Issue:** #4963 — the architectural decision behind [#4846](https://github.com/open-gsd/gsd-core/issues/4846)
- **Amends:** [ADR-857](857-capability-system.md) (Capability system) — extends its extension-point model with a second axis; ADR-857's own model is unchanged and remains in force. *(Reciprocal `Amended by` back-link lands in ADR-857 in the same PR, per `docs/adr/README.md` rule 3a.)*
- **Builds on:** [ADR-3889](3889-process-exit-contract.md) (process-exit contract — §5 crash policy), [ADR-1016](1016-runtime-capability-descriptor.md) (runtime capability descriptor — §4 runtime binding), ADR-4962 (per-session pause — the handoff contract this capability consumes)

## Context

[ADR-857](857-capability-system.md) defines Capability integration as three hook kinds — `step`, `contribution`, `gate` — over ~12 named **Loop Extension Points** (`discuss:pre/post` … `ship:post`). That model has one shape of event in mind: *a point in the five-step loop*. It is deliberately host-agnostic, and the names are a stability contract.

The `autopause` capability ([#4846](https://github.com/open-gsd/gsd-core/issues/4846)) needs a different shape of event. Its job is to pause a session at the context ceiling, let the session be cleared, and resume it — so it fires on **session lifecycle**: Claude Code's `Stop` (end of a turn) and `SessionStart(source=clear)`. Neither is a point in the loop. There is no loop step at which "this session is about to end" or "this session just started after a `/clear`" happens; a session boundary can fall in the middle of any step, or outside the loop entirely.

Two facts make this a decision rather than an implementation detail:

- **Every `capability.json` in the tree declares `"hooks": []`** (30+ descriptors, checked). No capability has ever owned a host-level hook. The field exists and is universally empty, which means its meaning is undefined by practice.
- **Core already owns host lifecycle hooks, on both of the events this ADR is about.** As of `next`, `hooks/hooks.json` registers `gsd-ensure-canonical-path.js` and `gsd-check-update.js` on `SessionStart` (no matcher), and `gsd-context-monitor.js` on `Stop` — as well as on `PostToolUse`, `SubagentStop` and `PreCompact`, but **not** on `SessionStart`. `hooks/managed-hooks-registry.cjs` tracks every managed hook for staleness and `{{GSD_VERSION}}` stamping; `bin/install.js` stages them.

  So the mechanism exists, is core-owned, and already carries a hook on each of `SessionStart` and `Stop`. The open question is narrower than "can this be done at all": it is whether a *capability* may put something there, and if so who registers it. *(An earlier draft of this issue put `gsd-context-monitor.js` on `SessionStart`; that was wrong, and the triage review on [#4963](https://github.com/open-gsd/gsd-core/issues/4963) caught it. The corrected rows are above — the framing survives, but on the two scripts that are actually there rather than on one that is not.)*

Left unresolved, the next contributor reads `"hooks": []` in a manifest whose capability demonstrably ships two hooks and concludes the manifest is unreliable. That is the failure this ADR exists to prevent.

## Decision

### 1. Host lifecycle hooks are a second extension axis, named and bounded

GSD has two extension axes, not one:

| Axis | Events | Contract | Portability |
|---|---|---|---|
| **Loop Extension Points** ([ADR-857](857-capability-system.md)) | the ~12 named loop points | `step` / `contribution` / `gate`, expressed as data | host-agnostic by construction |
| **Host lifecycle hooks** (this ADR) | a host CLI's own session-lifecycle events (`Stop`, `SessionStart`, …) | a script the host invokes, registered in `hooks/hooks.json` | **host-specific by nature** |

The second axis is not a widening of the first. ADR-857's model is unchanged: nothing here lets a capability attach loop behaviour outside the 12 points, and the three hook kinds keep their meaning. What is added is a narrow, explicitly less portable place for behaviour that is *about the host session rather than about the loop*.

The axis is **not** the preferred one. A capability that can express itself as a `step` / `contribution` / `gate` must do so; a host lifecycle hook is admissible only when **both** hold: the trigger is a host session boundary with no loop equivalent, *and* the behaviour is about the session rather than about the work inside it. `autopause` qualifies on both: there is no loop point at which a session is cleared, and what it does — hand this session's work to its successor — is about the session itself.

The rule earns its keep by what it **refuses**, so here are the cases it refuses, each with the Loop Extension Point that owns it instead:

| A capability that wants to… | Belongs at | Why not a host hook |
|---|---|---|
| run after each execute wave (build+test, a review lane) | `execute:wave:post`, as a `step` or `gate` | `Stop` fires at the end of every turn — mid-wave and between waves alike — so the hook would have to re-derive "did a wave just finish", which the loop already knows |
| add threat-model or TDD text to the planning prompt | `plan:pre`, as a `contribution` | prompt weaving is what `contribution` is for; no session event corresponds to "a plan is being written" |
| refuse to ship when verification did not pass | `ship:pre`, as a `gate` | a gate blocks the step it guards; a `Stop` hook can only block the *turn*, which is a different thing and would fire on turns that are not shipping |
| notice that a phase finished | `execute:post` | `SubagentStop` correlates with a phase boundary only by accident |

The distinguishing question is not "is my trigger a host event?" — `PostToolUse` is a host event and the context monitor uses it for a loop-shaped purpose — but "**is there a loop point that already knows what I am waiting for?**" If there is, the axis is closed.

### 2. `hooks/hooks.json` remains the single owner of registration

A capability's host hooks are registered exactly like core's: an entry in `hooks/hooks.json`, a row in `hooks/managed-hooks-registry.cjs`, a file in `hooks/` shipped by `scripts/build-hooks.js`. They get the same staleness tracking, the same version stamping, the same install/uninstall path.

The alternative — generating `hooks.json` from the capabilities' own `hooks` fields — was rejected. `hooks.json` is read by the host at startup for *every* user including those who installed no capability; making it a generated artifact means a capability with a malformed descriptor can break hook loading for everyone, and it splits "what hooks exist" across N descriptors plus a generator. One hand-maintained registration file that a human can read in full is worth more than derivation here.

### 3. The descriptor declares what it ships, and a guard proves the declaration true

Registration in `hooks.json` is not permission to leave the manifest silent. A capability that ships host hooks **declares them** in its descriptor:

```json
"hostHooks": [
  { "event": "Stop", "script": "hooks/gsd-pause-hook.js" },
  { "event": "SessionStart", "matcher": "clear", "script": "hooks/gsd-resume-hook.js" }
]
```

`hooks` keeps its ADR-857 meaning (Loop Extension Point hooks) and stays `[]` for such a capability — the two fields describe different axes and are not interchangeable. A **drift guard** asserts the two directions agree: every `hostHooks` entry has a matching `hooks.json` registration and `managed-hooks-registry.cjs` row, and every registered hook whose script belongs to a capability is declared by exactly one descriptor. A hook that is registered but undeclared, or declared but unregistered, fails CI by name.

This is the repository's established answer to "two surfaces that must agree" (the generated-artifact `--check` family, `lint-*-drift.cjs`): keep one owner, and make the other a checked claim rather than a second source.

### 4. A host lifecycle hook is inert unless activated, and declares its runtime

Three obligations, all CI-checkable:

- **Activation.** The hook's first action is to read its capability's activation key from the project config and return immediately when it is off — no state written, no log line, no decision emitted. A capability on this axis is default-off. The hook reads the raw config key rather than resolving full capability state (`isCapabilityActive`) because it runs on every turn and must not load the registry; installed ∧ surfaced is implied by the hook being registered at all. That shortcut is stated here so it is a decision, not an oversight.
- **Runtime binding.** `runtimeCompat.supported` names exactly the runtimes whose host events the hook uses ([ADR-1016](1016-runtime-capability-descriptor.md)). `autopause` is `["claude"]`: `Stop` / `SessionStart(source=clear)` are Claude Code's events, and it additionally depends on the statusline bridge file, which only Claude Code installs ([#2586](https://github.com/open-gsd/gsd-core/issues/2586)). A capability on this axis is expected to be runtime-bound; that is the cost of the axis, not a defect of a particular capability.
- **Crash policy.** `HOOK_ON_CRASH.ALLOW` ([ADR-3889](3889-process-exit-contract.md)): a bug in an opt-in capability's hook must never block a session. A host lifecycle hook may not use `DENY`.

### 5. Dependence on undocumented host internals is declared where it is read

`autopause`'s resume hook answers "is this pending record addressed to my host process" using `<CLAUDE_CONFIG_DIR>/sessions/<pid>.json` — a Claude Code internal file with no published contract. The rule this ADR sets is not "don't", because the capability cannot do its job without knowing which process it is; it is:

- the dependency is named in the capability's reference doc and at the call site, as unpublished host behaviour that may change without notice;
- it is **never the only path**: there is a fallback (here, walking the hook's own process ancestry to a `claude` executable), and when every path fails the hook **claims nothing and says so** rather than guessing;
- a failure to resolve identity degrades to the manual path, never to a wrong claim.

### 6. Correctness comes from atomic operations, not from timing heuristics

The pause→clear→resume cycle has two moments that look like races. The decision is that **no correctness claim rests on a timing heuristic**:

- **"The handoff is settled"** (unchanged for 10 s, both files present, JSON parses, markdown non-empty) decides only *when it is polite to spawn the clear command*. If it fires early, the consequence is a "handoff in progress" log line and a retry on the next `Stop` — not a corrupt claim — because the claim itself is the atomic rename of ADR-4962 §3 and the resume hook validates what it claimed. A slow filesystem or clock skew costs a turn, never a lost handoff.
- **Two roles clearing within seconds of each other** must not be able to collide at all, so the pending record is **per host process**: `pending.<claude_pid>.json`, and a resume hook reads only the file naming its own pid. A single `pending.json` is last-writer-wins, and under this capability that stops being an edge case — unattended operation makes it routine, which is exactly why it is closed here in the design rather than deferred. The record additionally names the handoff path and the old session id, and the resume hook requires both to match before it claims, so a stale or foreign record cannot take a handoff.

### 7. Everything environment-specific stays outside GSD

How `/clear` is typed into a session (tmux `send-keys`, an IDE macro, …), what registration a new session id needs, how the operator is notified: each is a `*_command` extension point the project supplies. GSD ships none of them and has no default. This is what keeps the axis narrow — the capability owns the *decision* to pause, clear and resume; the environment owns the *mechanism*.

## Open question for the maintainer: does §6 belong here?

The triage review on [#4963](https://github.com/open-gsd/gsd-core/issues/4963) asked for an explicit call on this rather than leaving it to the PR, so it is stated as a question and not settled unilaterally.

§6 (the `pending.<claude_pid>.json` record and the demotion of the settle window from a correctness boundary to a politeness heuristic) and §7 (the `*_command` seam) are closer to mechanism than the rest of this ADR. Two defensible placements:

- **Keep them here** — which is how this draft stands. The argument: condition 3 of #4846 asked for the race to be *designed*, not deferred, and "an atomic rename is the correctness boundary; timing is never load-bearing" is an architectural claim that outlives any one implementation. Leaving it in the issue would let a later PR quietly reintroduce a timing-dependent handshake without amending anything.
- **Move them to [#4846](https://github.com/open-gsd/gsd-core/issues/4846)** and narrow this ADR to the axis-and-ownership question (§1–§5). The argument: an ADR that names a filename pattern is pinning an implementation detail, and a future host with a different process model would have to amend an ADR to change a file name.

I lean to the first for the reason in its favour — the deferral is exactly what the review refused — but the cost is real and this is a maintainer call. Say which, and the ADR PR will carry that shape; if the answer is the second, §6–§7 move to #4846's body verbatim and the "What makes this decision done" items that depend on them move with it.

## Consequences

- One new, deliberately less portable extension axis, with a declaration guard so a descriptor cannot lie about what it ships.
- `hooks.json` stays hand-maintained and readable in full; adding a capability's host hook is a visible edit to a core file, reviewed like any other.
- A capability on this axis is runtime-bound, and its behaviour on every other runtime is "absent", not "degraded".
- A permanent dependency on an unpublished Claude Code file, contained by §5's declare-plus-fallback-plus-refuse rule.
- The per-pid pending record (§6) is part of the first shipped design rather than a follow-up, which costs a little more surface now and removes a class of unattended-operation failure.
- If a future host exposes equivalent session events, a sibling capability (or a `runtimeCompat` extension) is the path — not a widening of ADR-857's 12 points.

## Alternatives considered

- **Stretch ADR-857 and add session events to the Loop Extension Points.** Rejected: the 12 names are a host-agnostic stability contract about loop steps. A `Stop` event is neither a loop step nor portable, and admitting it would make the contract mean two different things.
- **Generate `hooks.json` from capability descriptors.** Rejected in §2: it lets one malformed descriptor break hook loading for users who installed no capability, and it scatters "what hooks exist" across N files plus a generator.
- **Leave `hooks: []` and document nothing.** Rejected: that is the state the #4846 review flagged. A manifest that omits the capability's primary mechanism teaches contributors not to trust manifests.
- **Ship autopause outside `capabilities/` as a standalone plugin.** Rejected: it would lose config federation, the install/uninstall lifecycle, `docs/FEATURES.md` generation and `/gsd-config` discoverability, and the maintainers would end up special-casing it anyway. The precedent for a default-off, single-runtime capability already exists (`claude-orchestration`).
- **Make the settle window an atomic handshake between the two hooks.** Rejected as unnecessary: §6 removes the need by making the atomic rename the correctness boundary. A handshake would add a second protocol whose failure modes (a half-written handshake file) are no easier than the one it replaces.

## What makes this decision done

- A capability's host hooks are declared in its descriptor and registered in `hooks.json`, and the §3 guard fails when the two disagree.
- The §1 table of refused cases is in the reference doc, not only here, so a contributor proposing a host hook meets the negative space before writing one — and each row names the Loop Extension Point that owns that case instead.
- With the activation key off, both hooks write nothing, log nothing and emit no decision — asserted by test, not by inspection.
- The pending record is per host process, and a resume hook provably ignores a record naming another pid, another handoff, or its own session id.
- An early settle decision produces a retry, not a claim — asserted by test.
- `runtimeCompat.supported` and the crash policy are asserted for both hooks.
- ADR-857 carries the reciprocal `Amended by` back-link.
