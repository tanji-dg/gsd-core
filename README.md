# Contribution drafts — not upstream content

Working drafts for my contributions to [open-gsd/gsd-core](https://github.com/open-gsd/gsd-core),
parked on a branch of my fork so a cloud session can read them. **Nothing here is
upstream content or an upstream decision.** Each file is superseded by the issue,
ADR or PR it was drafted for, and the version on the upstream repo wins.

| File | Drafted for | Status |
|---|---|---|
| `drafts/adr-1-per-session-pause.md` | `docs/adr/4962-per-session-pause-and-handoff-claim.md` | ADR issue [#4962](https://github.com/open-gsd/gsd-core/issues/4962) approved; PR not open yet |
| `drafts/adr-2-host-lifecycle-hooks.md` | `docs/adr/4963-capability-owned-host-lifecycle-hooks.md` | ADR issue [#4963](https://github.com/open-gsd/gsd-core/issues/4963) approved; PR not open yet. Its "Open question" section is unresolved — do not treat §6 as settled |
| `drafts/adr-issues.md` | the two ADR issue bodies | posted as #4962 / #4963 |
| `drafts/issue-1-statusline-fix.md` | [#4844](https://github.com/open-gsd/gsd-core/issues/4844) | posted; PR [#4959](https://github.com/open-gsd/gsd-core/pull/4959) open |
| `drafts/issue-2-per-session-handoff.md` | [#4845](https://github.com/open-gsd/gsd-core/issues/4845) | posted |
| `drafts/issue-3-autopause.md` | [#4846](https://github.com/open-gsd/gsd-core/issues/4846) | posted |
| `drafts/pr-bodies.md` | the three PR bodies | PR 1 opened as #4959; PRs 2 and 3 not open |

Two placeholders remain in the ADR files: `<TODAY>` is the ADR's `Date:` field,
filled in on the day its PR opens. Cross-references written as `ADR-4962` must
become file links (`[ADR-4962](4962-….md)`) before the PR — `docs/adr/README.md`
rule 2 rejects bare ids.

Both ADR PRs must run `node scripts/gen-adr-index.cjs --write`, and the #4963 PR
must add the reciprocal `Amended by` link to `docs/adr/857-capability-system.md`
in the same PR (`docs/adr/README.md` rule 3a).
