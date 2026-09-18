#!/usr/bin/env node
// gsd-hook-version: {{GSD_VERSION}}
// Resume hook - SessionStart(matcher: clear) hook. Part of the `autopause`
// capability (capabilities/autopause/capability.json): every setting below is
// an `autopause.*` config key and the automatic path runs only when
// `autopause.enabled` is true — otherwise the hook only lists unclaimed
// handoffs (safe without opt-in). Shared pieces (config view, state
// directory, handoff lookup) live in hooks/lib/autopause-shared.js.
//
// Automates the resume-project.md `check_incomplete_work` claim +
// `update_session` steps for the unattended "pause → /clear → resume" cycle
// (docs/reference/autopause-contract.md): the Stop hook (gsd-pause-hook.js)
// has the session run /gsd-pause-work and, once the handoff is written,
// spawns `autopause.clear_command` — the project's way of typing `/clear`
// into the session, which also writes a PENDING file describing the pause.
// Claude Code then fires this hook with source == "clear". When the pending
// file is addressed to THIS process, the hook:
//
//   1. claims the role-keyed handoff — HANDOFF.latest.<role_id>.json →
//      HANDOFF.claimed.<role_id>.<sid>.json and .continue-here.latest.<role_id>.md
//      → .continue-here.claimed.<role_id>.<sid>.md (rename, atomic)
//   2. runs the project's `autopause.claim_command` (extension point for
//      whatever project-specific registration a new session id needs —
//      nothing project-specific lives here)
//   3. runs `gsd-tools state session-resume --session --role --role-id
//      --handoff <claimed>` (STATE.md `## Session`, .planning/sessions/<sid>.json,
//      deletion of the claimed JSON — the same contract resume-project.md uses).
//      NOTE: `--raw` prints only `true`; the JSON output is parsed and success
//      is exit 0 ∧ resumed:true (stderr warnings are not failures)
//   4. consumes the two `.latest.*` files. Committing is NOT a precondition of
//      this capability — GSD's own `commit_docs: false` (or an ignored
//      .planning/) means pause-work never commits, and a WIP commit can fail —
//      so: when commit_docs is on AND both files are tracked and clean, the
//      deletions are committed with `git commit --only` (a temporary index —
//      other sessions' staged work is untouched); otherwise the files are just
//      removed and the record says "uncommitted handoff consumed; content is
//      only in the injected text". No git call is made on the latter path.
//   4b. runs the project's `autopause.context_command` and appends its
//      stdout (≤ 4 KB) as "### Project context" — the extension point for
//      per-role lines the project keeps outside the handoff (e.g. a
//      coordinator's notes to a successor in STATE.md ## Session Continuity)
//   5. injects, as additionalContext: the handoff markdown in FULL (up to
//      32 KB); over that, the first 8 KB and the claimed markdown is left on
//      disk with "Read <path> and delete it" — decided by size only, so a
//      handoff is never lost —, a STATE.md excerpt (frontmatter keys + the
//      first 40 lines of ## Current Position) and three lines of
//      instructions — so /gsd-resume-work is NOT needed
//   6. writes a RESUMED file next to the pending file (the clear command's ack)
//
// Any condition below not met → NO automatic claim; the hook only lists the
// unclaimed `.latest.*` handoffs in one line and the session falls back to the
// manual /gsd-resume-work:
//   source == "clear"  ∧  pending file exists and is < 30 min old
//   ∧  pending.claude_pid is this process's Claude Code host
//      (fast path: <config>/sessions/<pid>.json.sessionId == our session id;
//       slow path: walk our process ancestry to a claude executable)
//   ∧  pending.old_sid != our session id
//
// Pending file (written by the clear command; path from .planning/config.json
// `autopause.pending_file`, default `.claude/gsd-resume/pending.json`):
//   { version: 1, at: ISO, claude_pid, old_sid, role, role_id,
//     handoff_json_path?, handoff_md_path?, only_clear? }
// Resumed file: sibling `resumed.json` — { at, old_sid, new_sid, role_id, role,
//   claimed, commit, ok, note?, injected_bytes? }
//
// Never throws, never blocks: every failure is reported inside the injected
// text (and the log) and the session continues. Subagents never fire
// SessionStart. Only THIS session's new id is ever registered/claimed.

const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { HOOK_ON_CRASH, allow, crash } = require('./lib/hook-exit.js');
const {
  DEFAULT_PENDING_FILE, HANDOFF_LATEST_RE, AUTOPAUSE_DEFAULTS,
  readJson, writeJsonAtomic, sid8, toPosix, claudeHome, makeLogger, sleepMs, readStdinJson, readProjectConfig,
  readAutopauseConfig, resolvePendingPath, statePathFor, findLatestContinueHere, commitDocsEnabled, trackedAndClean, findGsdTools,
} = require('./lib/autopause-shared.js');

const ON_CRASH = HOOK_ON_CRASH.ALLOW;

const PENDING_MAX_AGE_MS = 30 * 60 * 1000;
// The handoff markdown is injected in full up to MD_FULL_LIMIT_BYTES; beyond
// that only the first MD_LIMIT_BYTES go in and the claimed markdown stays on
// disk for the session to Read.
const MD_LIMIT_BYTES = 8 * 1024;
const MD_FULL_LIMIT_BYTES = 32 * 1024;
const POSITION_LINES = 40;
const CLAIM_COMMAND_TIMEOUT_MS = 30000;
const CONTEXT_COMMAND_TIMEOUT_MS = 10000;
const CONTEXT_LIMIT_BYTES = 4 * 1024;
const SESSION_RESUME_TIMEOUT_MS = 30000;
const COMMIT_RETRIES = 3;
const COMMIT_RETRY_MS = 2000;

const DRY = process.argv.includes('--dry-run');

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}

// ---------------------------------------------------------------------------
// pure pieces (exported for tests)
// ---------------------------------------------------------------------------

/** Why the hook must NOT auto-claim, or null when every precondition holds. */
function decideSkipReason(input, pending, nowMs, sid) {
  if ((input.source || '') !== 'clear') return `source=${input.source || ''}`;
  if (!pending) return 'no pending file';
  const age = nowMs - Date.parse(pending.at || '');
  if (!(age >= 0 && age < PENDING_MAX_AGE_MS)) return `pending is stale (${pending.at || '?'})`;
  if (pending.old_sid && sid && pending.old_sid === sid) return 'session id unchanged';
  return null;
}

/**
 * The markdown as injected — by SIZE only (git is irrelevant here): the full
 * text up to MD_FULL_LIMIT_BYTES; beyond that the first MD_LIMIT_BYTES plus an
 * instruction to Read `keepPath` (left on disk) and delete it.
 * Returns { text, keepFile } — keepFile true when the claimed MD must stay.
 */
function injectableMarkdown(mdText, { keepPath }) {
  const bytes = Buffer.byteLength(mdText, 'utf8');
  if (bytes <= MD_FULL_LIMIT_BYTES) return { text: mdText, keepFile: false };
  const cut = Buffer.from(mdText, 'utf8').subarray(0, MD_LIMIT_BYTES).toString('utf8').replace(/�+$/, '');
  return {
    text: `${cut}\n<!-- TRUNCATED: ${bytes} bytes — the full handoff is still on disk at \`${keepPath}\`. Read it now, then delete that file yourself. -->\n`,
    keepFile: true,
  };
}

/** STATE.md excerpt: the frontmatter keys that matter + the head of ## Current Position. */
function stateExcerpt(stateText) {
  if (!stateText) return '';
  const lines = stateText.split(/\r?\n/);
  const fm = [];
  if (lines[0] === '---') {
    for (let i = 1; i < lines.length && lines[i] !== '---'; i++) {
      if (/^(current_phase|current_phase_name|status|stopped_at|last_updated):/.test(lines[i])) fm.push(lines[i]);
      if (/^progress:/.test(lines[i])) {
        fm.push(lines[i]);
        for (let k = i + 1; k < i + 5 && /^\s+\w/.test(lines[k] || ''); k++) fm.push(lines[k]);
      }
    }
  }
  const pos = [];
  const start = lines.findIndex((l) => /^## Current Position/.test(l));
  if (start !== -1) {
    for (let i = start; i < lines.length && pos.length < POSITION_LINES; i++) {
      if (i > start && /^## /.test(lines[i])) break;
      pos.push(lines[i]);
    }
    if (pos.length >= POSITION_LINES) pos.push(`(… the rest of \`## Current Position\` is at .planning/STATE.md:${start + 1} — Read it if needed)`);
  }
  return `### STATE.md excerpt (machine-extracted)\n${fm.join('\n')}\n\n${pos.join('\n')}\n`;
}

/** One-line listing of unclaimed role-keyed handoffs (the no-auto-claim output). */
function listingLine(planningDir, reason) {
  let names = [];
  try { names = fs.readdirSync(planningDir); } catch (e) { return ''; }
  const items = [];
  for (const n of names.sort()) {
    const m = HANDOFF_LATEST_RE.exec(n);
    if (!m) continue;
    const j = readJson(path.join(planningDir, n)) || {};
    items.push(`${m[1]}${j.role ? `(${j.role})` : ''} ${j.timestamp ? String(j.timestamp).slice(0, 16) : '?'}`);
  }
  if (!items.length) return '';
  return `[gsd-resume-hook] unclaimed handoffs: ${items.join(' / ')}. Not auto-claimed (${reason}). Pick the role and run /gsd-resume-work.`;
}

/** The `--action` text for state session-resume: the handoff's next_action, one line, capped. */
function resumeAction(handoffJson) {
  const na = handoffJson && typeof handoffJson.next_action === 'string' ? handoffJson.next_action.replace(/\s+/g, ' ').trim() : '';
  return na ? na.slice(0, 120) : 'next action';
}

/**
 * Trim a command's stdout for injection: ≤ CONTEXT_LIMIT_BYTES, else the
 * first 4 KB + a TRUNCATED marker. Empty/whitespace → ''.
 */
function trimContextOutput(text) {
  const body = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!body) return '';
  if (Buffer.byteLength(body, 'utf8') <= CONTEXT_LIMIT_BYTES) return body;
  const cut = Buffer.from(body, 'utf8').subarray(0, CONTEXT_LIMIT_BYTES).toString('utf8').replace(/�+$/, '');
  return `${cut}\n<!-- TRUNCATED -->`;
}

// ---------------------------------------------------------------------------
// process identity: is pending.claude_pid our host?
// ---------------------------------------------------------------------------

/** The pid of the claude executable above us (slow path; win32 via CIM, else /proc). */
function resolveClaudePid() {
  if (process.platform === 'win32') {
    const ps =
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${process.ppid}";` +
      'while ($p) {' +
      '  if ($p.Name -match "^claude(\\.exe)?$") { $p.ProcessId; break }' +
      '  if ($p.ParentProcessId -eq 0) { break }' +
      '  $p = Get-CimInstance Win32_Process -Filter "ProcessId = $($p.ParentProcessId)" -ErrorAction SilentlyContinue' +
      '}';
    try {
      const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
        { timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      if (/^\d+$/.test(out)) return Number(out);
    } catch (e) { /* unknown */ }
    return null;
  }
  try {
    let pid = process.ppid;
    for (let i = 0; i < 12 && pid > 1; i++) {
      const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const m = st.match(/^\d+ \((.*)\) \S+ (\d+)/);
      if (!m) break;
      if (m[1].indexOf('claude') !== -1) return pid;
      pid = Number(m[2]);
    }
  } catch (e) { /* unknown */ }
  return null;
}

/** How pending.claude_pid was matched to this process, or null when it is not ours. */
function isMine(pending, sid) {
  const wanted = Number(pending.claude_pid);
  if (!wanted) return null;
  const s = readJson(path.join(claudeHome(), 'sessions', `${wanted}.json`));
  if (s && s.sessionId === sid) return `sessions/${wanted}.json`;
  if (!pidAlive(wanted)) return null;
  const pid = resolveClaudePid();
  if (pid !== null && pid === wanted) return `ancestry pid ${pid}`;
  return null;
}

// ---------------------------------------------------------------------------
// subprocesses
// ---------------------------------------------------------------------------

function git(root, args) {
  return spawnSync('git', ['-C', root].concat(args), { encoding: 'utf8', timeout: 30000 });
}

function runContextCommand(cmd, root, env) {
  const r = spawnSync(cmd, { cwd: root, shell: true, encoding: 'utf8', timeout: CONTEXT_COMMAND_TIMEOUT_MS, env });
  if (r.error || r.status !== 0) {
    const why = r.error ? (r.error.code === 'ETIMEDOUT' ? 'timeout' : r.error.message) : `rc=${r.status}`;
    return { ok: false, why, text: '' };
  }
  return { ok: true, why: '', text: trimContextOutput(r.stdout) };
}

function runClaimCommand(cmd, root, env) {
  const r = spawnSync(cmd, { cwd: root, shell: true, encoding: 'utf8', timeout: CLAIM_COMMAND_TIMEOUT_MS, env });
  const out = ((r.stdout || '') + (r.stderr || '')).trim().split('\n')[0] || '';
  return { ok: r.status === 0, out };
}

// ---------------------------------------------------------------------------
// the steps of an automatic resume. Each takes the run context `ctx`
// (root, sid, pending, rel(), notes[], log, DRY-aware `stop`) and either
// returns its facts for the next step or terminates through ctx.stop().
// ---------------------------------------------------------------------------

/** 1. claim: rename the two .latest files to .claimed.<sid>. */
function claimHandoff(ctx) {
  const { root, sid, pending, config, rel, notes, log, stop } = ctx;
  const jsonLatest = path.resolve(root, pending.handoff_json_path || `.planning/HANDOFF.latest.${pending.role_id}.json`);
  const jsonClaimed = path.join(path.dirname(jsonLatest), `HANDOFF.claimed.${pending.role_id}.${sid}.json`);
  let mdLatest = pending.handoff_md_path ? path.resolve(root, pending.handoff_md_path) : null;
  if (!mdLatest || !fs.existsSync(mdLatest)) {
    const hint = (readJson(jsonLatest) || {}).phase_dir;
    mdLatest = findLatestContinueHere(root, pending.role_id, typeof hint === 'string' ? hint : null);
  }
  const mdClaimed = mdLatest ? path.join(path.dirname(mdLatest), `.continue-here.claimed.${pending.role_id}.${sid}.md`) : null;
  if (!fs.existsSync(jsonLatest)) {
    log('stop: latest json missing');
    stop('latest json missing', `[gsd-resume-hook] ★ ${rel(jsonLatest)} is missing (another session claimed it first, or the pause did not commit). Auto-claim stopped — use /gsd-resume-work.`);
  }
  const handoffJson = readJson(jsonLatest) || {};
  let mdText = '';
  try { mdText = mdLatest ? fs.readFileSync(mdLatest, 'utf8') : ''; } catch (e) { mdText = ''; }
  // Before the rename: are these files something git can give back? Only
  // asked when the project commits its docs at all.
  const docsCommitted = commitDocsEnabled(root, config);
  const committedPair = docsCommitted
    && trackedAndClean(root, rel(jsonLatest))
    && (!mdLatest || trackedAndClean(root, rel(mdLatest)));
  if (DRY) {
    notes.push(`mv ${rel(jsonLatest)} → ${rel(jsonClaimed)}`);
    notes.push(mdLatest ? `mv ${rel(mdLatest)} → ${rel(mdClaimed)}` : `★ .continue-here.latest.${pending.role_id}.md not found`);
  } else {
    try { fs.renameSync(jsonLatest, jsonClaimed); } catch (e) {
      log(`stop: rename failed ${e.message}`);
      stop('claim rename failed', `[gsd-resume-hook] ★ claim (rename) failed: ${e.message}. Auto-claim stopped — use /gsd-resume-work.`);
    }
    if (mdLatest) { try { fs.renameSync(mdLatest, mdClaimed); } catch (e) { notes.push(`★ markdown rename failed: ${e.message}`); } }
    else notes.push(`★ .continue-here.latest.${pending.role_id}.md not found (resuming from the JSON only)`);
    ctx.result.claimed = rel(jsonClaimed);
  }
  return { jsonLatest, jsonClaimed, mdLatest, mdClaimed, handoffJson, mdText, docsCommitted, committedPair };
}

/** The env every project command and gsd-tools call sees. */
function resumeEnv(ctx, claim) {
  const { sid, pending, rel } = ctx;
  return Object.assign({}, process.env, {
    CLAUDE_CODE_SESSION_ID: sid,
    GSD_RESUME_SESSION_ID: sid,
    GSD_RESUME_OLD_SESSION_ID: pending.old_sid || '',
    GSD_RESUME_ROLE: pending.role || '',
    GSD_RESUME_ROLE_ID: pending.role_id || '',
    GSD_RESUME_HANDOFF_JSON: DRY ? rel(claim.jsonLatest) : rel(claim.jsonClaimed),
    GSD_RESUME_HANDOFF_MD: claim.mdLatest ? (DRY ? rel(claim.mdLatest) : rel(claim.mdClaimed)) : '',
  });
}

/** 2. the project's claim_command (registration of the new session id, …). */
function runClaimStep(ctx, env) {
  const { root, autopause, notes, log } = ctx;
  const claimCmd = autopause.claim_command;
  if (!claimCmd) return;
  if (DRY) { notes.push(`claim_command: ${claimCmd}`); return; }
  const r = runClaimCommand(claimCmd, root, env);
  notes.push(`${r.ok ? 'claim_command ok' : '★ claim_command failed'}${r.out ? ` — ${r.out}` : ''}`);
  log(`claim_command ${r.ok ? 'ok' : 'FAIL'}: ${r.out}`);
}

/** 3. `gsd-tools state session-resume` — the GSD contract. Returns true when it ran and resumed. */
function runSessionResume(ctx, claim, env) {
  const { root, sid, pending, rel, notes, log } = ctx;
  const gsdTools = findGsdTools();
  if (DRY) {
    notes.push(`gsd-tools state session-resume --session ${sid8(sid)} --role-id ${pending.role_id} --handoff ${rel(claim.jsonClaimed)}${gsdTools ? '' : ' (★ gsd-tools.cjs not found → would fall back to unlink)'}`);
    return false;
  }
  if (!gsdTools) {
    notes.push('★ gsd-tools.cjs not found → state session-resume skipped, unlinking the claimed JSON directly');
    return false;
  }
  const args = [gsdTools, 'state', 'session-resume', '--session', sid, '--role-id', pending.role_id, '--handoff', rel(claim.jsonClaimed), '--action', resumeAction(claim.handoffJson)];
  if (pending.role) args.push('--role', pending.role);
  const r = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: SESSION_RESUME_TIMEOUT_MS, env });
  let out = null;
  try { out = JSON.parse(r.stdout || ''); } catch (e) { out = null; }
  if (r.status === 0 && out && out.resumed) {
    notes.push(`state session-resume: ${(out.updated || []).join(',')}${out.session_record ? ` record=${out.session_record}` : ''} removed=${(out.handoff_removed || []).join(',')}${out.status && out.status.cleared ? ` status ${out.status.before}→${out.status.after}` : ''}`);
    log(`session-resume ok: ${JSON.stringify(out).slice(0, 300)}`);
    return true;
  }
  notes.push(`★ state session-resume failed (${((r.stderr || r.stdout || '').trim().split('\n')[0]) || `rc=${r.status}`}) → unlinking the claimed JSON directly`);
  log(`session-resume FAIL: ${(r.stderr || r.stdout || '').replace(/\n/g, ' | ').slice(0, 300)}`);
  return false;
}

/**
 * 4. consume the two .latest files. Committed only when the project commits
 * its docs AND both files were tracked + clean (decided BEFORE the rename
 * moved them — claim.committedPair); otherwise plain removal, no git.
 */
function consumeLatest(ctx, claim) {
  const { root, sid, pending, rel, notes, log, result } = ctx;
  const delPaths = [rel(claim.jsonLatest)].concat(claim.mdLatest ? [rel(claim.mdLatest)] : []);
  const commitMsg = `chore: [${pending.role_id}] handoff consumed by ${sid8(sid)} (gsd-resume-hook)`;
  if (DRY) {
    notes.push(claim.committedPair ? `git commit --only -m "${commitMsg}" -- ${delPaths.join(' ')}` : 'uncommitted handoff: files removed, no git');
    return;
  }
  if (!claim.committedPair) {
    notes.push(`uncommitted handoff consumed (${claim.docsCommitted ? 'files were not tracked+clean' : 'commit_docs is off'}); content is only in the injected text`);
    return;
  }
  let done = false;
  let err = '';
  for (let i = 0; i < COMMIT_RETRIES && !done; i++) {
    const r = git(root, ['commit', '--only', '-q', '-m', commitMsg, '--'].concat(delPaths));
    if (r.status === 0) done = true;
    else { err = (r.stderr || r.stdout || '').trim(); if (i + 1 < COMMIT_RETRIES) sleepMs(COMMIT_RETRY_MS); }
  }
  if (done) {
    result.commit = (git(root, ['rev-parse', '--short', 'HEAD']).stdout || '').trim();
    notes.push(`consumed commit ${result.commit}`);
  } else {
    notes.push(`★ consumed commit failed (${err.split('\n')[0]}) — stage/commit the deletions yourself: ${delPaths.join(' ')}`);
    log(`commit FAIL: ${err.replace(/\n/g, ' | ')}`);
  }
}

/** 4b. the project's context_command — its stdout, trimmed, or ''. */
function projectContextStep(ctx, env) {
  const { root, autopause, notes, log } = ctx;
  const contextCmd = autopause.context_command;
  if (!contextCmd) return '';
  const r = runContextCommand(contextCmd, root, env);
  log(`context_command ${r.ok ? 'ok' : 'FAIL'}: ${r.ok ? `${Buffer.byteLength(r.text, 'utf8')} bytes` : r.why}`);
  if (!r.ok) { notes.push(`★ context_command failed (${r.why}) — nothing appended`); return ''; }
  if (!r.text) { notes.push('context_command produced no output'); return ''; }
  notes.push(`context_command: ${Buffer.byteLength(r.text, 'utf8')} bytes appended`);
  return r.text;
}

/** 5. the injected text; removes the claimed files that are not kept for the session to Read. */
function buildInjection(ctx, claim, sessionResumed, projectContext) {
  const { planningDir, sid, pending, rel, notes, result } = ctx;
  let stateText = '';
  try { stateText = fs.readFileSync(path.join(planningDir, 'STATE.md'), 'utf8'); } catch (e) { stateText = ''; }
  const injected = injectableMarkdown(claim.mdText, { keepPath: claim.mdClaimed ? rel(claim.mdClaimed) : '?' });
  if (!DRY) {
    // session-resume already removed the claimed JSON; remove it ourselves only when it did not.
    if (!sessionResumed) { try { fs.unlinkSync(claim.jsonClaimed); } catch (e) { /* gone */ } }
    if (claim.mdClaimed && !injected.keepFile) { try { fs.unlinkSync(claim.mdClaimed); } catch (e) { /* gone */ } }
    if (claim.mdClaimed && injected.keepFile) notes.push(`★ handoff markdown kept on disk (${rel(claim.mdClaimed)}) — too large to inject in full`);
    result.claimed = injected.keepFile && claim.mdClaimed ? rel(claim.mdClaimed) : null;
  }
  const head = [
    `# Automatic resume (gsd-resume-hook) — role: ${pending.role || pending.role_id}  previous session ${sid8(pending.old_sid)} → ${sid8(sid)}`,
    '',
    '- The handoff claim, `state session-resume` and the removal of the handoff files are **done** (record below). **Do not run `/gsd-resume-work`.**',
    '- **Start from `<next_action>`.** The handoff markdown is the primary source; Read STATE.md `### Decisions` / `### Blockers/Concerns` / `## Session Continuity` and PROJECT.md only when the work needs them.',
    `- \`next_action\`: ${claim.handoffJson.next_action || '(not in the JSON)'}`,
    `- record: ${notes.join(' / ')}`,
    '',
  ].join('\n');
  return `${head}${stateExcerpt(stateText)}\n---\n### Handoff markdown (${claim.mdLatest ? rel(claim.mdLatest) : 'none'})\n\n${injected.text}`
    + (projectContext ? `\n---\n### Project context (autopause.context_command)\n\n${projectContext}\n` : '');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function emit(text) {
  allow({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } });
}

/** The no-auto-claim exit: log the reason, list the unclaimed handoffs, allow. */
function skipWith(planningDir, log, reason, logDetail) {
  log(`skip: ${reason}${logDetail || ''}`);
  const l = listingLine(planningDir, reason);
  if (l) emit(l);
  allow(undefined);
}

function main() {
  const input = readStdinJson();
  const root = input.cwd || process.cwd();
  const planningDir = path.join(root, '.planning');
  const sid = input.session_id || process.env.CLAUDE_CODE_SESSION_ID || '';
  const config = readProjectConfig(root);
  const autopause = readAutopauseConfig(root, config);
  const pendingPath = resolvePendingPath(root, config);
  const resumedPath = path.join(path.dirname(pendingPath), 'resumed.json');
  const log = makeLogger(path.join(path.dirname(pendingPath), 'gsd-resume-hook.log'));

  // Capability gate: without autopause.enabled the only output is the
  // unclaimed-handoff listing (no claim, no commit, nothing written).
  if (!autopause.enabled) {
    const l = listingLine(planningDir, 'autopause.enabled is false');
    if (l) emit(l);
    allow(undefined);
  }

  const pending = readJson(pendingPath);
  const skip = decideSkipReason(input, pending, Date.now(), sid);
  if (skip) skipWith(planningDir, log, skip, ` (sid ${sid8(sid)})`);
  const mine = isMine(pending, sid);
  if (!mine) skipWith(planningDir, log, `pending is for pid ${pending.claude_pid}, not this session`);
  log(`pending matched (${mine}) role_id=${pending.role_id} old=${sid8(pending.old_sid)} new=${sid8(sid)}${DRY ? ' dry-run' : ''}`);

  const result = {
    version: 1, at: new Date().toISOString(), old_sid: pending.old_sid, new_sid: sid,
    role_id: pending.role_id || null, role: pending.role || null, claimed: null, commit: null, ok: false,
  };
  /** Write the resumed record (the clear command's ack) and consume the pending file. */
  const finish = (note) => {
    result.note = note;
    if (!DRY) { writeJsonAtomic(resumedPath, result); try { fs.unlinkSync(pendingPath); } catch (e) { /* gone */ } }
  };
  /** Stop the automatic path here: record `note`, tell the session `msg`, exit. */
  const stop = (note, msg) => { finish(note); emit(msg); };
  const ctx = {
    root, planningDir, sid, config, autopause, pending, result, notes: [], log, stop,
    rel: (p) => toPosix(path.relative(root, p)),
  };

  if (pending.only_clear || !pending.role_id) {
    result.ok = true;
    const note = pending.only_clear ? 'only-clear' : 'no role_id';
    log(`done: ${note}`);
    stop(note, `[gsd-resume-hook] /clear was automatic. ${pending.only_clear ? 'only-clear mode: nothing claimed.' : `the previous session's handoff carries no role_id — not auto-claimed. ${listingLine(planningDir, 'no role_id')}`}`);
  }

  const claim = claimHandoff(ctx);
  const env = resumeEnv(ctx, claim);
  runClaimStep(ctx, env);
  const sessionResumed = runSessionResume(ctx, claim, env);
  consumeLatest(ctx, claim);
  const projectContext = projectContextStep(ctx, env);
  const text = buildInjection(ctx, claim, sessionResumed, projectContext);

  result.ok = true;
  result.injected_bytes = Buffer.byteLength(text, 'utf8');
  if (DRY) {
    process.stdout.write(`[dry-run] ${ctx.notes.join('\n[dry-run] ')}\n[dry-run] injected ${result.injected_bytes} bytes\n`);
    allow(undefined);
  }
  finish(undefined);
  // The pause hook's (b) lower bound for THIS session: a handoff must be newer
  // than this resume to clear us again (the one we just consumed never will).
  try {
    writeJsonAtomic(statePathFor(root, config, sid), { phase: 'resumed', resumed_at: result.at, old_sid: pending.old_sid, role_id: pending.role_id });
  } catch (e) { /* best-effort — the pause hook falls back to the requested-pause rule */ }
  log(`done: role=${pending.role_id} commit=${result.commit} bytes=${result.injected_bytes}`);
  emit(text);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    crash(ON_CRASH, { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `[gsd-resume-hook] ★ stopped on an exception: ${e && e.message}. Use /gsd-resume-work manually.` } });
  }
}

module.exports = {
  DEFAULT_PENDING_FILE, PENDING_MAX_AGE_MS, MD_LIMIT_BYTES, MD_FULL_LIMIT_BYTES, AUTOPAUSE_DEFAULTS,
  readAutopauseConfig, resolvePendingPath, commitDocsEnabled, injectableMarkdown, decideSkipReason, stateExcerpt, listingLine, findLatestContinueHere, resumeAction,
  trimContextOutput, CONTEXT_LIMIT_BYTES,
};
