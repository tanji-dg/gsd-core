---
id: 183
title: Autopause Capability
group: v1.7.0 Features
---

**Purpose:** A default-off capability that lets a role-holding session pause itself at a context threshold, be `/clear`ed, and resume in a fresh session without a human in the loop — `gsd-pause-hook.js` (Stop) requests `/gsd-pause-work` and spawns `autopause.clear_command`; `gsd-resume-hook.js` (SessionStart, clear) claims the handoff, runs `state session-resume` and injects it. `/gsd-autopause` operates it. **A pause always resumes automatically** while the capability is on — the moment a handoff newer than the session is committed, the next Stop clears and resumes (the arm step in `/gsd-pause-work` only records the request), and the context monitor's warnings point at the automatic pause instead of asking for a manual one; to stay paused, `/gsd-pause-work --keep-session`. **A commit is not a precondition**: a pause is complete when its two files (`HANDOFF.latest.<role_id>.json` + `.continue-here.latest.<role_id>.md`) are written and settled; the capability behaves identically with `commit_docs: false` or an ignored `.planning/` — git is never consulted there, the handoff is consumed by removal. Injection is decided by size alone: full text ≤ 32 KB, else the first 8 KB with the file left on disk to Read. GSD's WIP commit is its default behaviour, not autopause's contract.

**Configuration:** `autopause.enabled`, `autopause.threshold_used_pct`, `autopause.guard_command`, `autopause.clear_command`, `autopause.pending_file`, `autopause.claim_command`, `autopause.context_command`, `autopause.notify_command`
