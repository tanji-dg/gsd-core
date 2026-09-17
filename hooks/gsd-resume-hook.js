#!/usr/bin/env node
// gsd-hook-version: {{GSD_VERSION}}
// Resume hook - SessionStart(matcher: clear) hook. Part of the `autopause`
// capability (capabilities/autopause/capability.json): every setting below is
// an `autopause.*` config key and the automatic path runs only when
// `autopause.enabled` is true — otherwise the hook only lists unclaimed
// handoffs (safe without opt-in).
//
// Machinises the resume-project.md `check_incomplete_work` claim +
// `update_session` steps for the unattended "pause → /clear → resume" cycle:
// a project-side watcher (outside GSD — it needs a way to type `/clear` into
// the session, e.g. tmux send-keys) runs /gsd-pause-work, writes a PENDING
// file describing the pause, and sends `/clear`. Claude Code then fires this
// hook with source == "clear". When the pending file is addressed to THIS
// process, the hook:
//
//   1. claims the role-keyed handoff — HANDOFF.latest.<role_id>.json →
//      HANDOFF.claimed.<role_id>.<sid>.json and .continue-here.latest.<role_id>.md
//      → .continue-here.claimed.<role_id>.<sid>.md (rename, atomic)
//   2. runs the project's `autopause.claim_command` (extension point: role
//      registry registration, milestone.lock re-keying, … — nothing project-
//      specific lives here)
//   3. runs `gsd-tools state session-resume --session --role --role-id
//      --handoff <claimed>` (STATE.md `## Session`, .planning/sessions/<sid>.json,
//      deletion of the claimed JSON — the same contract resume-project.md uses).
//      NOTE: `--raw` prints only `true`; the JSON output is parsed and success
//      is exit 0 ∧ resumed:true (stderr warnings are not failures)
//   4. commits ONLY the two `.latest.*` deletions with `git commit --only` (a
//      temporary index — other sessions' staged work is untouched), then
//      unlinks the claimed markdown (its content is in the pause WIP commit)
//   4b. runs the project's `autopause.context_command` and appends its
//      stdout (≤ 4 KB) as "### Project context" — the extension point for
//      per-role lines the project keeps outside the handoff (e.g. a
//      coordinator's notes to a successor in STATE.md ## Session Continuity)
//   5. injects, as additionalContext: the handoff markdown (over 8 KB → the
//      first 8 KB + <!-- TRUNCATED --> + a `git show` pointer), a STATE.md
//      excerpt (frontmatter keys + the first 40 lines of ## Current Position)
//      and three lines of instructions — so /gsd-resume-work is NOT needed
//   6. writes a RESUMED file next to the pending file (the watcher's ack)
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
// Pending file (written by the watcher; path from .planning/config.json
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
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { HOOK_ON_CRASH, allow, crash } = require('./lib/hook-exit.js');

const ON_CRASH = HOOK_ON_CRASH.ALLOW;

const DEFAULT_PENDING_FILE = '.claude/gsd-resume/pending.json';

/**
 * Registry defaults of the autopause.* keys (capabilities/autopause/capability.json)
 * — mirrored here so a hook needs no registry load per turn. threshold_used_pct
 * is intentionally absent: when unset it is DERIVED (100 − hooks.context_warning_threshold).
 */
const AUTOPAUSE_DEFAULTS = Object.freeze({
  enabled: false,
  guard_command: '',
  clear_command: '',
  pending_file: DEFAULT_PENDING_FILE,
  claim_command: '',
  context_command: '',
  notify_command: '',
});
const PENDING_MAX_AGE_MS = 30 * 60 * 1000;
const MD_LIMIT_BYTES = 8 * 1024;
const POSITION_LINES = 40;
const CLAIM_COMMAND_TIMEOUT_MS = 30000;
const CONTEXT_COMMAND_TIMEOUT_MS = 10000;
const CONTEXT_LIMIT_BYTES = 4 * 1024;
const SESSION_RESUME_TIMEOUT_MS = 30000;
const COMMIT_RETRIES = 3;
const COMMIT_RETRY_MS = 2000;

const DRY = process.argv.includes('--dry-run');

// ---------------------------------------------------------------------------
// small helpers (fs only; every read is best-effort)
// ---------------------------------------------------------------------------

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

function writeJsonAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p);
}

function sid8(s) { return String(s || '').slice(0, 8); }

function toPosix(p) { return p.replace(/\\/g, '/'); }

function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}

function makeLogger(logPath) {
  return (line) => {
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`, 'utf8');
    } catch (e) { /* logging must never break the hook */ }
  };
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ---------------------------------------------------------------------------
// pure pieces (exported for tests)
// ---------------------------------------------------------------------------

/**
 * The effective autopause.* settings for a project: the raw root
 * `.planning/config.json` `autopause` block over AUTOPAUSE_DEFAULTS. Only the
 * capability's own keys are read — the pre-capability `hooks.resume_*` /
 * `hooks.pause_*` spellings are NOT consulted (one config surface, not two).
 * Fail-soft: an unreadable config is the defaults (enabled: false).
 */
function readAutopauseConfig(root, config) {
  const cfg = config === undefined ? (readJson(path.join(root, '.planning', 'config.json')) || {}) : (config || {});
  const raw = cfg && cfg.autopause && typeof cfg.autopause === 'object' ? cfg.autopause : {};
  const out = Object.assign({}, AUTOPAUSE_DEFAULTS);
  for (const key of Object.keys(AUTOPAUSE_DEFAULTS)) {
    if (raw[key] === undefined || raw[key] === null) continue;
    if (key === 'enabled') out.enabled = raw[key] === true;
    else if (typeof raw[key] === 'string') out[key] = raw[key].trim();
  }
  out.threshold_used_pct = Number.isFinite(Number(raw.threshold_used_pct)) ? Number(raw.threshold_used_pct) : undefined;
  return out;
}

/**
 * Resolve the pending-file location from `.planning/config.json`
 * (`autopause.pending_file`, relative to the project root). Always inside
 * the project: an absolute or traversing value falls back to the default.
 */
function resolvePendingPath(root, config) {
  let rel = DEFAULT_PENDING_FILE;
  const v = readAutopauseConfig(root, config).pending_file;
  if (typeof v === 'string' && v.trim()) rel = v.trim();
  const abs = path.resolve(root, rel);
  const inside = path.relative(root, abs);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return path.resolve(root, DEFAULT_PENDING_FILE);
  return abs;
}

/** Why the hook must NOT auto-claim, or null when every precondition holds. */
function decideSkipReason(input, pending, nowMs, sid) {
  if ((input.source || '') !== 'clear') return `source=${input.source || ''}`;
  if (!pending) return 'no pending file';
  const age = nowMs - Date.parse(pending.at || '');
  if (!(age >= 0 && age < PENDING_MAX_AGE_MS)) return `pending is stale (${pending.at || '?'})`;
  if (pending.old_sid && sid && pending.old_sid === sid) return 'session id unchanged';
  return null;
}

/** Trim the handoff markdown to MD_LIMIT_BYTES with a pointer to the full text. */
function truncateMarkdown(mdText, gitRef, relPath) {
  if (Buffer.byteLength(mdText, 'utf8') <= MD_LIMIT_BYTES) return mdText;
  const cut = Buffer.from(mdText, 'utf8').subarray(0, MD_LIMIT_BYTES).toString('utf8').replace(/�+$/, '');
  return `${cut}\n<!-- TRUNCATED: full text via \`git show ${gitRef}:${relPath}\` -->\n`;
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
    const m = /^HANDOFF\.latest\.([a-z0-9-]+)\.json$/.exec(n);
    if (!m) continue;
    const j = readJson(path.join(planningDir, n)) || {};
    items.push(`${m[1]}${j.role ? `(${j.role})` : ''} ${j.timestamp ? String(j.timestamp).slice(0, 16) : '?'}`);
  }
  if (!items.length) return '';
  return `[gsd-resume-hook] unclaimed handoffs: ${items.join(' / ')}. Not auto-claimed (${reason}). Pick the role and run /gsd-resume-work.`;
}

// `.continue-here.latest.<role_id>.md`, searched under .planning to depth 3
// (resume-project.md's `find .planning -maxdepth 3`); a hint dir is tried first.
function findLatestContinueHere(root, roleId, hintDir) {
  const name = `.continue-here.latest.${roleId}.md`;
  if (hintDir) {
    const p = path.resolve(root, hintDir, name);
    if (fs.existsSync(p)) return p;
  }
  const stack = [[path.join(root, '.planning'), 0]];
  while (stack.length) {
    const [d, depth] = stack.pop();
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isFile() && e.name === name) return p;
      if (e.isDirectory() && depth < 3 && e.name !== 'node_modules') stack.push([p, depth + 1]);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// process identity: is pending.claude_pid our host?
// ---------------------------------------------------------------------------

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
// gsd-tools + git + extension point
// ---------------------------------------------------------------------------

function findGsdTools(root) {
  const cands = [
    path.join(root, 'gsd-core', 'bin', 'gsd-tools.cjs'),
    path.join(root, '.claude', 'gsd-core', 'bin', 'gsd-tools.cjs'),
    path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs'),
    path.join(claudeHome(), 'gsd-core', 'bin', 'gsd-tools.cjs'),
  ];
  for (const p of cands) { if (fs.existsSync(p)) return p; }
  return null;
}

function git(root, args) {
  return spawnSync('git', ['-C', root].concat(args), { encoding: 'utf8', timeout: 30000 });
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
// main
// ---------------------------------------------------------------------------

function emit(text) {
  allow({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } });
}

function main() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch (e) { raw = ''; }
  let input = {};
  try { input = JSON.parse(raw || '{}'); } catch (e) { input = {}; }
  const root = input.cwd || process.cwd();
  const planningDir = path.join(root, '.planning');
  const sid = input.session_id || process.env.CLAUDE_CODE_SESSION_ID || '';
  const config = readJson(path.join(planningDir, 'config.json')) || {};
  const autopause = readAutopauseConfig(root, config);
  const pendingPath = resolvePendingPath(root, config);
  const resumedPath = path.join(path.dirname(pendingPath), 'resumed.json');
  const log = makeLogger(path.join(path.dirname(pendingPath), 'gsd-resume-hook.log'));
  const rel = (p) => toPosix(path.relative(root, p));

  // Capability gate: without autopause.enabled the only output is the
  // unclaimed-handoff listing (no claim, no commit, nothing written).
  if (!autopause.enabled) {
    const l = listingLine(planningDir, 'autopause.enabled is false');
    if (l) emit(l);
    allow(undefined);
  }

  const pending = readJson(pendingPath);
  const skip = decideSkipReason(input, pending, Date.now(), sid);
  if (skip) {
    log(`skip: ${skip} (sid ${sid8(sid)})`);
    const l = listingLine(planningDir, skip);
    if (l) emit(l);
    allow(undefined);
  }
  const mine = isMine(pending, sid);
  if (!mine) {
    const reason = `pending is for pid ${pending.claude_pid}, not this session`;
    log(`skip: ${reason}`);
    const l = listingLine(planningDir, reason);
    if (l) emit(l);
    allow(undefined);
  }
  log(`pending matched (${mine}) role_id=${pending.role_id} old=${sid8(pending.old_sid)} new=${sid8(sid)}${DRY ? ' dry-run' : ''}`);

  const notes = [];
  const result = {
    version: 1, at: new Date().toISOString(), old_sid: pending.old_sid, new_sid: sid,
    role_id: pending.role_id || null, role: pending.role || null, claimed: null, commit: null, ok: false,
  };
  const finish = (note) => {
    result.note = note;
    if (!DRY) { writeJsonAtomic(resumedPath, result); try { fs.unlinkSync(pendingPath); } catch (e) { /* gone */ } }
  };

  if (pending.only_clear || !pending.role_id) {
    result.ok = true;
    finish(pending.only_clear ? 'only-clear' : 'no role_id');
    const msg = `[gsd-resume-hook] /clear was automatic. ${pending.only_clear ? 'only-clear mode: nothing claimed.' : `the previous session's handoff carries no role_id — not auto-claimed. ${listingLine(planningDir, 'no role_id')}`}`;
    log(`done: ${result.note}`);
    emit(msg);
  }

  // 1. claim (rename)
  const jsonLatest = path.resolve(root, pending.handoff_json_path || `.planning/HANDOFF.latest.${pending.role_id}.json`);
  const jsonClaimed = path.join(path.dirname(jsonLatest), `HANDOFF.claimed.${pending.role_id}.${sid}.json`);
  let mdLatest = pending.handoff_md_path ? path.resolve(root, pending.handoff_md_path) : null;
  if (!mdLatest || !fs.existsSync(mdLatest)) {
    const hint = (readJson(jsonLatest) || {}).phase_dir;
    mdLatest = findLatestContinueHere(root, pending.role_id, typeof hint === 'string' ? hint : null);
  }
  const mdClaimed = mdLatest ? path.join(path.dirname(mdLatest), `.continue-here.claimed.${pending.role_id}.${sid}.md`) : null;
  if (!fs.existsSync(jsonLatest)) {
    finish('latest json missing');
    log('stop: latest json missing');
    emit(`[gsd-resume-hook] ★ ${rel(jsonLatest)} is missing (another session claimed it first, or the pause did not commit). Auto-claim stopped — use /gsd-resume-work.`);
  }
  const handoffJson = readJson(jsonLatest) || {};
  let mdText = '';
  try { mdText = mdLatest ? fs.readFileSync(mdLatest, 'utf8') : ''; } catch (e) { mdText = ''; }
  if (DRY) {
    notes.push(`mv ${rel(jsonLatest)} → ${rel(jsonClaimed)}`);
    notes.push(mdLatest ? `mv ${rel(mdLatest)} → ${rel(mdClaimed)}` : `★ .continue-here.latest.${pending.role_id}.md not found`);
  } else {
    try { fs.renameSync(jsonLatest, jsonClaimed); } catch (e) {
      finish('claim rename failed');
      log(`stop: rename failed ${e.message}`);
      emit(`[gsd-resume-hook] ★ claim (rename) failed: ${e.message}. Auto-claim stopped — use /gsd-resume-work.`);
    }
    if (mdLatest) { try { fs.renameSync(mdLatest, mdClaimed); } catch (e) { notes.push(`★ markdown rename failed: ${e.message}`); } }
    else notes.push(`★ .continue-here.latest.${pending.role_id}.md not found (resuming from the JSON only)`);
    result.claimed = rel(jsonClaimed);
  }

  // 2. project extension point (role registry, milestone.lock, …)
  const claimCmd = autopause.claim_command;
  const hookEnv = Object.assign({}, process.env, {
    CLAUDE_CODE_SESSION_ID: sid,
    GSD_RESUME_SESSION_ID: sid,
    GSD_RESUME_OLD_SESSION_ID: pending.old_sid || '',
    GSD_RESUME_ROLE: pending.role || '',
    GSD_RESUME_ROLE_ID: pending.role_id || '',
    GSD_RESUME_HANDOFF_JSON: DRY ? rel(jsonLatest) : rel(jsonClaimed),
    GSD_RESUME_HANDOFF_MD: mdLatest ? (DRY ? rel(mdLatest) : rel(mdClaimed)) : '',
  });
  if (claimCmd) {
    if (DRY) notes.push(`claim_command: ${claimCmd}`);
    else {
      const r = runClaimCommand(claimCmd, root, hookEnv);
      notes.push(`${r.ok ? 'claim_command ok' : '★ claim_command failed'}${r.out ? ` — ${r.out}` : ''}`);
      log(`claim_command ${r.ok ? 'ok' : 'FAIL'}: ${r.out}`);
    }
  }

  // 3. state session-resume (the GSD contract; JSON output, not --raw)
  const gsdTools = findGsdTools(root);
  let sessionResumed = false;
  if (DRY) {
    notes.push(`gsd-tools state session-resume --session ${sid8(sid)} --role-id ${pending.role_id} --handoff ${rel(jsonClaimed)}${gsdTools ? '' : ' (★ gsd-tools.cjs not found → would fall back to unlink)'}`);
  } else if (gsdTools) {
    const args = [gsdTools, 'state', 'session-resume', '--session', sid, '--role-id', pending.role_id, '--handoff', rel(jsonClaimed), '--action', resumeAction(handoffJson)];
    if (pending.role) args.push('--role', pending.role);
    const r = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: SESSION_RESUME_TIMEOUT_MS, env: hookEnv });
    let out = null;
    try { out = JSON.parse(r.stdout || ''); } catch (e) { out = null; }
    if (r.status === 0 && out && out.resumed) {
      sessionResumed = true;
      notes.push(`state session-resume: ${(out.updated || []).join(',')}${out.session_record ? ` record=${out.session_record}` : ''} removed=${(out.handoff_removed || []).join(',')}${out.status && out.status.cleared ? ` status ${out.status.before}→${out.status.after}` : ''}`);
      log(`session-resume ok: ${JSON.stringify(out).slice(0, 300)}`);
    } else {
      notes.push(`★ state session-resume failed (${((r.stderr || r.stdout || '').trim().split('\n')[0]) || `rc=${r.status}`}) → unlinking the claimed JSON directly`);
      log(`session-resume FAIL: ${(r.stderr || r.stdout || '').replace(/\n/g, ' | ').slice(0, 300)}`);
    }
  } else {
    notes.push('★ gsd-tools.cjs not found → state session-resume skipped, unlinking the claimed JSON directly');
  }

  // 4. commit only the two .latest deletions; then drop the claimed twins
  const delPaths = [rel(jsonLatest)].concat(mdLatest ? [rel(mdLatest)] : []);
  const commitMsg = `chore: [${pending.role_id}] handoff consumed by ${sid8(sid)} (gsd-resume-hook)`;
  if (DRY) {
    notes.push(`git commit --only -m "${commitMsg}" -- ${delPaths.join(' ')}`);
  } else {
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
    // session-resume already removed the claimed JSON; remove it ourselves only when it did not.
    if (!sessionResumed) { try { fs.unlinkSync(jsonClaimed); } catch (e) { /* gone */ } }
    if (mdClaimed) { try { fs.unlinkSync(mdClaimed); } catch (e) { /* gone */ } }
    result.claimed = null;
  }

  // 4b. project context (per-role lines the project keeps outside the handoff)
  const contextCmd = autopause.context_command;
  let projectContext = '';
  if (contextCmd) {
    const r = runContextCommand(contextCmd, root, hookEnv);
    if (!r.ok) notes.push(`★ context_command failed (${r.why}) — nothing appended`);
    else if (!r.text) notes.push('context_command produced no output');
    else {
      projectContext = r.text;
      notes.push(`context_command: ${Buffer.byteLength(projectContext, 'utf8')} bytes appended`);
    }
    log(`context_command ${r.ok ? 'ok' : 'FAIL'}: ${r.ok ? `${Buffer.byteLength(r.text, 'utf8')} bytes` : r.why}`);
  }

  // 5. injected context
  let stateText = '';
  try { stateText = fs.readFileSync(path.join(planningDir, 'STATE.md'), 'utf8'); } catch (e) { stateText = ''; }
  const mdBody = truncateMarkdown(mdText, result.commit ? `${result.commit}^` : 'HEAD', mdLatest ? rel(mdLatest) : '?');
  const head = [
    `# Automatic resume (gsd-resume-hook) — role: ${pending.role || pending.role_id}  previous session ${sid8(pending.old_sid)} → ${sid8(sid)}`,
    '',
    '- The handoff claim, `state session-resume` and the consumed commit are **done** (record below). **Do not run `/gsd-resume-work`.**',
    '- **Start from `<next_action>`.** The handoff markdown is the primary source; Read STATE.md `### Decisions` / `### Blockers/Concerns` / `## Session Continuity` and PROJECT.md only when the work needs them.',
    `- \`next_action\`: ${handoffJson.next_action || '(not in the JSON)'}`,
    `- record: ${notes.join(' / ')}`,
    '',
  ].join('\n');
  const text = `${head}${stateExcerpt(stateText)}\n---\n### Handoff markdown (${mdLatest ? rel(mdLatest) : 'none'})\n\n${mdBody}`
    + (projectContext ? `\n---\n### Project context (autopause.context_command)\n\n${projectContext}\n` : '');
  result.ok = true;
  result.injected_bytes = Buffer.byteLength(text, 'utf8');
  if (DRY) {
    process.stdout.write(`[dry-run] ${notes.join('\n[dry-run] ')}\n[dry-run] injected ${result.injected_bytes} bytes\n`);
    allow(undefined);
  }
  finish(undefined);
  // The pause hook's (b) lower bound for THIS session: a handoff must be newer
  // than this resume to clear us again (the one we just consumed never will).
  try {
    const safe = String(sid).replace(/[^A-Za-z0-9._-]+/g, '_');
    writeJsonAtomic(path.join(path.dirname(pendingPath), `state.${safe}.json`), { phase: 'resumed', resumed_at: result.at, old_sid: pending.old_sid, role_id: pending.role_id });
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
  DEFAULT_PENDING_FILE, PENDING_MAX_AGE_MS, MD_LIMIT_BYTES, AUTOPAUSE_DEFAULTS,
  readAutopauseConfig, resolvePendingPath, decideSkipReason, truncateMarkdown, stateExcerpt, listingLine, findLatestContinueHere, resumeAction,
  trimContextOutput, CONTEXT_LIMIT_BYTES,
};
