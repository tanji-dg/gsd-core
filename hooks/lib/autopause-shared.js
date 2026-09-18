'use strict';
// hooks/lib/autopause-shared.js — hand-written, NOT generated. The pieces the
// two `autopause` capability hooks (hooks/gsd-pause-hook.js on Stop,
// hooks/gsd-resume-hook.js on SessionStart(clear)) and gsd-context-monitor.js
// share: the autopause.* config view, the state-directory layout next to
// autopause.pending_file, the role-keyed handoff filename, and a few
// best-effort fs / git helpers. Everything here is synchronous and never
// throws on a missing or unreadable file — a hook must never fail because a
// helper did.
//
// Requires only its own siblings (hooks/lib/), like hook-exit.js: the file is
// shipped by scripts/build-hooks.js (HOOKS_SUBDIRS_TO_COPY) and bin/install.js
// recurses one level into hooks/dist/lib/.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { classifyGitProbe } = require('./git-probe.js');

const DEFAULT_PENDING_FILE = '.claude/gsd-resume/pending.json';
const DEFAULT_THRESHOLD_USED_PCT = 75;
const HANDOFF_LATEST_RE = /^HANDOFF\.latest\.([a-z0-9-]+)\.json$/;
const GIT_PROBE_TIMEOUT_MS = 15000;

/**
 * Registry defaults of the autopause.* keys (capabilities/autopause/capability.json)
 * — mirrored here so a hook needs no registry load per turn. threshold_used_pct
 * is intentionally absent: when unset it is DERIVED from the context monitor's
 * CRITICAL point (see resolveThreshold).
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

// ---------------------------------------------------------------------------
// small helpers (fs only; every read is best-effort)
// ---------------------------------------------------------------------------

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

/** tmp + rename in the target directory. No Windows EPERM retry: both hooks
 *  write into a directory only they touch, so a rename race is not expected. */
function writeJsonAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p);
}

function sid8(s) { return String(s || '').slice(0, 8); }

function toPosix(p) { return p.replace(/\\/g, '/'); }

/** Claude Code's config root — CLAUDE_CONFIG_DIR when set and non-blank, else
 *  ~/.claude (the same rule as gsd-ensure-canonical-path.js resolveConfigDir). */
function claudeHome() {
  const envDir = process.env.CLAUDE_CONFIG_DIR;
  if (typeof envDir === 'string' && envDir.trim().length > 0) return envDir;
  return path.join(os.homedir(), '.claude');
}

function makeLogger(logPath) {
  return (line) => {
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`, 'utf8');
    } catch (e) { /* logging must never break the hook */ }
  };
}

/** Synchronous sleep — the hooks are sync end-to-end, so setTimeout would not work. */
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The hook's stdin as parsed JSON ({} when empty or malformed). Read
 *  synchronously from fd 0: the hooks do all their work before the first
 *  await would ever resolve, so the event-loop pattern the other hooks use
 *  would only add a callback around the same code. */
function readStdinJson() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch (e) { raw = ''; }
  try { return JSON.parse(raw || '{}') || {}; } catch (e) { return {}; }
}

function readProjectConfig(root) {
  return readJson(path.join(root, '.planning', 'config.json')) || {};
}

// ---------------------------------------------------------------------------
// autopause.* config view
// ---------------------------------------------------------------------------

/**
 * The effective autopause.* settings for a project: the raw root
 * `.planning/config.json` `autopause` block over AUTOPAUSE_DEFAULTS. Only the
 * capability's own keys are read — the pre-capability `hooks.resume_*` /
 * `hooks.pause_*` spellings are NOT consulted (one config surface, not two).
 * Fail-soft: an unreadable config is the defaults (enabled: false).
 *
 * Deliberately a raw config read rather than the registry's
 * isCapabilityActive(): a hook runs on every turn and must not load the
 * capability registry; the installed + surfaced legs are implied by the hook
 * being registered at all.
 */
function readAutopauseConfig(root, config) {
  const cfg = config === undefined ? readProjectConfig(root) : (config || {});
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
 * The used% at which a pause is requested: autopause.threshold_used_pct, else
 * 100 − the context monitor's CRITICAL point, else 75. `resolvedCritical` is
 * the monitor's already-validated `hooks.context_critical_threshold`; when
 * omitted the raw config value is read.
 */
function resolveThreshold(config, resolvedCritical) {
  const explicit = Number(readAutopauseConfig('', config).threshold_used_pct);
  if (Number.isFinite(explicit) && explicit > 0 && explicit <= 100) return explicit;
  const hooks = (config && config.hooks) || {};
  const critical = Number.isFinite(resolvedCritical) ? resolvedCritical : Number(hooks.context_critical_threshold);
  if (Number.isFinite(critical) && critical >= 0 && critical < 100) return 100 - critical;
  return DEFAULT_THRESHOLD_USED_PCT;
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

/** The directory the pending record, both hooks' state files and logs live in. */
function stateDir(root, config) {
  return path.dirname(resolvePendingPath(root, config));
}

/** Per-session state file of the pause → clear → resume cycle: state.<sid>.json. */
function statePathFor(root, config, sid) {
  const safe = String(sid).replace(/[^A-Za-z0-9._-]+/g, '_');
  return path.join(stateDir(root, config), `state.${safe}.json`);
}

// ---------------------------------------------------------------------------
// handoff files
// ---------------------------------------------------------------------------

/**
 * `.continue-here.latest.<role_id>.md`, searched under .planning to depth 3
 * (resume-project.md's `find .planning -maxdepth 3`); a hint dir (the
 * handoff JSON's phase_dir) is tried first. The same walk as
 * src/session-store.cts findContinueHere — a hook cannot require the compiled
 * CLI, so the walk lives here for the hooks.
 */
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
// git (informational only — no hook decision depends on these)
// ---------------------------------------------------------------------------

/**
 * Does this project commit its planning docs? GSD's own switch:
 * `commit_docs: false` / `planning.commit_docs: false`, or a .gitignored
 * .planning/ (checked only when a repository exists). Off → the hooks make
 * no git call at all. A deliberate subset of src/config-loader.cts's
 * resolver (no sub_repos / phase_commit_docs handling — a hook cannot
 * require the compiled CLI).
 */
function commitDocsEnabled(root, config) {
  const cfg = config === undefined ? readProjectConfig(root) : (config || {});
  if (cfg.commit_docs === false) return false;
  if (cfg.planning && typeof cfg.planning === 'object' && cfg.planning.commit_docs === false) return false;
  if (!fs.existsSync(path.join(root, '.git'))) return false;
  const r = spawnSync('git', ['-C', root, 'check-ignore', '-q', '--no-index', '--', '.planning'], { stdio: 'ignore', timeout: GIT_PROBE_TIMEOUT_MS });
  return r.status !== 0;
}

/**
 * Is `rel` tracked AND unmodified in git? Only asked when commit_docs is on.
 * A probe that could not run (timeout, spawn failure — #3911) is "no": the
 * callers only ever use "yes" to commit a deletion, so an unknown answer must
 * not become one.
 */
function trackedAndClean(root, rel) {
  const a = spawnSync('git', ['-C', root, 'ls-files', '--error-unmatch', '--', rel], { stdio: 'ignore', timeout: GIT_PROBE_TIMEOUT_MS });
  if (!classifyGitProbe(a).determined || a.status !== 0) return false;
  const b = spawnSync('git', ['-C', root, 'diff', '--quiet', 'HEAD', '--', rel], { stdio: 'ignore', timeout: GIT_PROBE_TIMEOUT_MS });
  return classifyGitProbe(b).determined && b.status === 0;
}

/** gsd-tools.cjs next to this hook bundle: <root>/gsd-core/bin/ in the repo and
 *  <config>/gsd-core/bin/ once installed — the same resolution as
 *  gsd-context-monitor.js. null when absent (a hook then degrades, never fails). */
function findGsdTools() {
  const p = path.join(__dirname, '..', '..', 'gsd-core', 'bin', 'gsd-tools.cjs');
  return fs.existsSync(p) ? p : null;
}

module.exports = {
  DEFAULT_PENDING_FILE, DEFAULT_THRESHOLD_USED_PCT, HANDOFF_LATEST_RE, AUTOPAUSE_DEFAULTS,
  readJson, writeJsonAtomic, sid8, toPosix, claudeHome, makeLogger, sleepMs, readStdinJson, readProjectConfig,
  readAutopauseConfig, resolveThreshold, resolvePendingPath, stateDir, statePathFor,
  findLatestContinueHere, commitDocsEnabled, trackedAndClean, findGsdTools,
};
