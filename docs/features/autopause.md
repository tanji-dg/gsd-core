---
id: 183
title: Autopause Capability
group: v1.7.0 Features
---

**Purpose:** A default-off capability that lets a role-holding session pause itself at a context threshold, be `/clear`ed, and resume in a fresh session without a human in the loop — `gsd-pause-hook.js` (Stop) requests `/gsd-pause-work` and spawns `autopause.clear_command`; `gsd-resume-hook.js` (SessionStart, clear) claims the handoff, runs `state session-resume` and injects it. `/gsd-autopause` operates it.

**Configuration:** `autopause.enabled`, `autopause.threshold_used_pct`, `autopause.guard_command`, `autopause.clear_command`, `autopause.pending_file`, `autopause.claim_command`, `autopause.context_command`, `autopause.notify_command`
