#!/usr/bin/env node
// gsd-hook-version: {{GSD_VERSION}}
// Pause hook - Stop hook (runs at the end of every turn; nothing resident).
// Part of the `autopause` capability (capabilities/autopause/capability.json):
// every setting is an `autopause.*` key and the hook is a no-op unless
// `autopause.enabled` is true.
//
// The pause half of the unattended "pause → /clear → resume" cycle
// (docs/session-resume-hook.md; the resume half is gsd-resume-hook.js).
// stdin: { session_id, stop_hook_active, cwd, transcript_path }
//
//   (a) context used% ≥ threshold ∧ not already requested (30 min TTL)
//       ∧ !stop_hook_active ∧ `autopause.guard_command` allows
//       → record `pause-requested` in the state file and answer
//         {"decision":"block","reason":"…"} so THIS session runs
//         /gsd-pause-work now (unattended: no questions, measured state).
//   (b) the requested pause is done — a HANDOFF.latest.<role_id>.json with
//       session_id == ours, committed (git clean), timestamp ≥ requested_at − 60 s
//       → spawn `autopause.clear_command` DETACHED (stdio ignore, unref) and record
//         `clear-spawned`. The command is the project's way of typing /clear
//         into this session (tmux send-keys, …) — GSD ships no such thing.
//       A MANUAL pause (nothing requested) is never used here: above the
//       threshold (a) re-requests so the handoff is rewritten from measured,
//       current state; below it the session simply stays paused (logged).
//       No clear_command → logged ("set autopause.clear_command …"), the manual
//       /clear → /gsd-resume-work path applies.
//   (c) `--request-now` (CLI, no stdin; CLAUDE_CODE_SESSION_ID): write
//       `pause-requested` (manual: true) only — the entry point that puts a
//       hand-started pause onto the automatic path. Run it, then
//       /gsd-pause-work in the same turn.
//
// stop_hook_active == true is the Stop that follows our own block; blocking
// again there would loop, so (a) is skipped — (b) still runs (the Stop after
// a completed pause is exactly that one).
//
// used% comes from <tmpdir>/claude-ctx-<sid>.json (written by gsd-statusline.js,
// raw used_pct). Threshold: autopause.threshold_used_pct, else
// 100 − hooks.context_warning_threshold (the monitor's WARNING point), else 65.
//
// State + log live next to autopause.pending_file (default
// .claude/gsd-resume/): state.<sid>.json { phase, requested_at, used,
// threshold, manual?, spawned_at?, child_pid? } and gsd-pause-hook.log.
// Never throws, never blocks a session by accident: an exception logs and
// exits 0 with no decision.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { HOOK_ON_CRASH, allow, crash } = require('./lib/hook-exit.js');
const { resolvePendingPath, readAutopauseConfig } = require('./gsd-resume-hook.js');

const ON_CRASH = HOOK_ON_CRASH.ALLOW;

const REQUEST_TTL_MS = 30 * 60 * 1000;
const HANDOFF_SLACK_MS = 60 * 1000;
const DEFAULT_THRESHOLD_USED_PCT = 65;
const GUARD_TIMEOUT_MS = 30000;

// ---------------------------------------------------------------------------
// helpers
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

function makeLogger(logPath) {
  return (line) => {
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`, 'utf8');
    } catch (e) { /* logging must never break the hook */ }
  };
}

// ---------------------------------------------------------------------------
// pure pieces (exported for tests)
// ---------------------------------------------------------------------------

/** The used% at which a pause is requested: autopause.threshold_used_pct, else 100 − warning threshold, else 65. */
function resolveThreshold(config) {
  const explicit = Number(readAutopauseConfig('', config).threshold_used_pct);
  if (Number.isFinite(explicit) && explicit > 0 && explicit <= 100) return explicit;
  const hooks = (config && config.hooks) || {};
  const warning = Number(hooks.context_warning_threshold);
  if (Number.isFinite(warning) && warning > 0 && warning <= 100) return 100 - warning;
  return DEFAULT_THRESHOLD_USED_PCT;
}

function stateDir(root, config) {
  return path.dirname(resolvePendingPath(root, config));
}

function statePathFor(root, config, sid) {
  const safe = String(sid).replace(/[^A-Za-z0-9._-]+/g, '_');
  return path.join(stateDir(root, config), `state.${safe}.json`);
}

/** Is there a live (non-expired) pause request in this state? */
function isRequested(state, nowMs) {
  if (!state || (state.phase !== 'pause-requested' && state.phase !== 'clear-spawned')) return false;
  const at = Date.parse(state.requested_at || '');
  return Number.isFinite(at) && nowMs - at >= 0 && nowMs - at < REQUEST_TTL_MS;
}

/** Was this committed handoff written for the pause we requested (not an older manual one)? */
function isHandoffForRequest(handoffJson, state, nowMs) {
  if (!isRequested(state, nowMs)) return false;
  const at = Date.parse((handoffJson && handoffJson.timestamp) || '');
  const requestedAt = Date.parse(state.requested_at || '');
  return Number.isFinite(at) && at >= requestedAt - HANDOFF_SLACK_MS;
}

/**
 * Decide the turn's action from already-gathered facts. Returns one of
 *   { kind: 'spawn-clear' } | { kind: 'request', used, threshold }
 *   | { kind: 'none', reason }
 */
function decide({ stopHookActive, state, handoff, used, threshold, nowMs }) {
  const requested = isRequested(state, nowMs);
  if (handoff && isHandoffForRequest(handoff.json, state, nowMs)) {
    if (state.phase === 'clear-spawned') return { kind: 'none', reason: 'clear already spawned' };
    return { kind: 'spawn-clear' };
  }
  if (stopHookActive) return { kind: 'none', reason: 'stop_hook_active (the Stop after our own block)' };
  if (requested) return { kind: 'none', reason: `pause already requested at ${state.requested_at}` };
  if (used === null || !(used >= threshold)) {
    if (handoff) return { kind: 'none', reason: `manual pause on disk (${handoff.file}) and used=${used}% < ${threshold}% — staying paused` };
    return { kind: 'none', reason: `used=${used}% < ${threshold}%` };
  }
  return { kind: 'request', used, threshold };
}

/** The block reason: what the session must do now (generic, unattended). */
function blockReason(used, threshold, manualHandoffFile) {
  return `[gsd-pause-hook] Context is at ${used}% used (threshold ${threshold}%). `
    + 'Run the `gsd-pause-work` skill NOW and finish through the WIP commit; do nothing else this turn. '
    + 'Do not ask the user anything — write `unknown` for what you do not know. '
    + 'Do not describe state from memory: measure it now (processes, files, devices, last output) — state changes within minutes even after a manual pause. '
    + (manualHandoffFile ? `An older handoff (${manualHandoffFile}) exists; overwrite it with the current state. ` : '')
    + 'After the commit the session is cleared automatically and the handoff is injected into the next session.';
}

// ---------------------------------------------------------------------------
// facts (fs / git)
// ---------------------------------------------------------------------------

function readUsedPct(sid) {
  const j = readJson(path.join(os.tmpdir(), `claude-ctx-${sid}.json`));
  return j && Number.isFinite(j.used_pct) ? j.used_pct : null;
}

function findSession(sid) {
  let names = [];
  try { names = fs.readdirSync(path.join(claudeHome(), 'sessions')); } catch (e) { return null; }
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue;
    const j = readJson(path.join(claudeHome(), 'sessions', n));
    if (j && j.sessionId === sid) return { pid: Number(n.slice(0, -5)), name: typeof j.name === 'string' ? j.name : '' };
  }
  return null;
}

function gitClean(root, rel) {
  const a = spawnSync('git', ['-C', root, 'diff', '--quiet', 'HEAD', '--', rel], { stdio: 'ignore', timeout: 15000 });
  const b = spawnSync('git', ['-C', root, 'ls-files', '--error-unmatch', '--', rel], { stdio: 'ignore', timeout: 15000 });
  return a.status === 0 && b.status === 0;
}

/** Our own committed HANDOFF.latest.<role_id>.json, or null. */
function committedHandoffFor(root, sid) {
  const planning = path.join(root, '.planning');
  let names = [];
  try { names = fs.readdirSync(planning); } catch (e) { return null; }
  for (const n of names.sort()) {
    const m = /^HANDOFF\.latest\.([a-z0-9-]+)\.json$/.exec(n);
    if (!m) continue;
    const json = readJson(path.join(planning, n));
    if (!json || json.session_id !== sid) continue;
    const rel = `.planning/${n}`;
    if (gitClean(root, rel)) return { file: n, rel, role_id: m[1], json };
  }
  return null;
}

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
// main
// ---------------------------------------------------------------------------

function requestNow(root) {
  const sid = process.env.CLAUDE_CODE_SESSION_ID || '';
  if (!sid) {
    process.stderr.write('gsd-pause-hook --request-now: CLAUDE_CODE_SESSION_ID is not set — run it from the session\'s own Bash tool\n');
    process.exitCode = 1;
    return;
  }
  const config = readJson(path.join(root, '.planning', 'config.json')) || {};
  const used = readUsedPct(sid);
  const state = { phase: 'pause-requested', requested_at: new Date().toISOString(), manual: true, used, threshold: null };
  writeJsonAtomic(statePathFor(root, config, sid), state);
  makeLogger(path.join(stateDir(root, config), 'gsd-pause-hook.log'))(`${sid8(sid)} pause-requested manually (used=${used}%)`);
  process.stdout.write(`pause-requested written for ${sid8(sid)}. Now run the gsd-pause-work skill; the Stop after its commit spawns autopause.clear_command.\n`);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--request-now')) {
    requestNow(process.cwd());
    return;
  }
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch (e) { raw = ''; }
  let input = {};
  try { input = JSON.parse(raw || '{}'); } catch (e) { input = {}; }
  const root = input.cwd || process.cwd();
  const sid = input.session_id || process.env.CLAUDE_CODE_SESSION_ID || '';
  if (!sid) allow(undefined);
  const config = readJson(path.join(root, '.planning', 'config.json')) || {};
  const autopause = readAutopauseConfig(root, config);
  // Capability gate: off → nothing at all (no state, no log, no decision).
  if (!autopause.enabled) allow(undefined);
  const dir = stateDir(root, config);
  const log = makeLogger(path.join(dir, 'gsd-pause-hook.log'));
  const sp = statePathFor(root, config, sid);
  const state = readJson(sp) || {};
  const nowMs = Date.now();

  const handoff = committedHandoffFor(root, sid);
  const used = readUsedPct(sid);
  const threshold = resolveThreshold(config);
  const verdict = decide({ stopHookActive: input.stop_hook_active === true, state, handoff, used, threshold, nowMs });

  if (verdict.kind === 'none') {
    // Only the interesting no-ops are logged; "below threshold" every turn would drown the log.
    if (!/^used=/.test(verdict.reason)) log(`${sid8(sid)} no-op: ${verdict.reason}`);
    allow(undefined);
  }

  if (verdict.kind === 'spawn-clear') {
    const clearCmd = autopause.clear_command;
    if (!clearCmd) {
      writeJsonAtomic(sp, Object.assign({}, state, { phase: 'clear-spawned', spawned_at: new Date().toISOString(), child_pid: null, note: 'no autopause.clear_command' }));
      log(`${sid8(sid)} handoff committed (${handoff.file}); set autopause.clear_command to automate /clear — falling back to manual /clear → /gsd-resume-work`);
      allow(undefined);
    }
    const session = findSession(sid);
    const md = findLatestContinueHere(root, handoff.role_id, handoff.json.phase_dir);
    const env = Object.assign({}, process.env, {
      GSD_CLEAR_SESSION_ID: sid,
      GSD_CLEAR_CLAUDE_PID: session ? String(session.pid) : '',
      GSD_CLEAR_SESSION_NAME: session ? session.name : '',
      GSD_CLEAR_ROLE: typeof handoff.json.role === 'string' ? handoff.json.role : '',
      GSD_CLEAR_ROLE_ID: handoff.role_id,
      GSD_CLEAR_HANDOFF_JSON: handoff.rel,
      GSD_CLEAR_HANDOFF_MD: md ? toPosix(path.relative(root, md)) : '',
      GSD_CLEAR_STATE_DIR: toPosix(path.relative(root, dir)),
    });
    const child = spawn(clearCmd, { cwd: root, shell: true, detached: true, stdio: 'ignore', windowsHide: true, env });
    child.unref();
    writeJsonAtomic(sp, Object.assign({}, state, { phase: 'clear-spawned', spawned_at: new Date().toISOString(), child_pid: child.pid || null }));
    log(`${sid8(sid)} pause done (${handoff.file}) → spawned autopause.clear_command pid=${child.pid}${session ? '' : ' (no sessions/<pid>.json — GSD_CLEAR_CLAUDE_PID empty)'}`);
    allow(undefined);
  }

  // verdict.kind === 'request'
  const guard = autopause.guard_command;
  if (guard) {
    const session = findSession(sid);
    const r = spawnSync(guard, {
      cwd: root, shell: true, encoding: 'utf8', timeout: GUARD_TIMEOUT_MS,
      env: Object.assign({}, process.env, {
        GSD_PAUSE_SESSION_ID: sid,
        GSD_PAUSE_CLAUDE_PID: session ? String(session.pid) : '',
        GSD_PAUSE_USED_PCT: String(verdict.used),
      }),
    });
    if (r.status !== 0) {
      const why = ((r.stdout || '') + (r.stderr || '')).trim().split('\n')[0] || `rc=${r.status}`;
      log(`${sid8(sid)} used=${verdict.used}% ≥ ${verdict.threshold}% but guard_command refused: ${why}`);
      allow(undefined);
    }
  }
  writeJsonAtomic(sp, { phase: 'pause-requested', requested_at: new Date().toISOString(), used: verdict.used, threshold: verdict.threshold });
  log(`${sid8(sid)} used=${verdict.used}% ≥ ${verdict.threshold}% → requesting pause`);
  allow({ decision: 'block', reason: blockReason(verdict.used, verdict.threshold, handoff ? handoff.file : null) });
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    try { process.stderr.write(`[gsd-pause-hook] ${e && e.message}\n`); } catch (e2) { /* nothing */ }
    crash(ON_CRASH, undefined);
  }
}

module.exports = {
  REQUEST_TTL_MS, HANDOFF_SLACK_MS, DEFAULT_THRESHOLD_USED_PCT,
  resolveThreshold, stateDir, statePathFor, isRequested, isHandoffForRequest, decide, blockReason,
};
