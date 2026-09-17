// allow-test-rule: source-text-is-the-product
// Reads .json product files whose deployed text IS what the runtime loads —
// testing text content tests the deployed contract.
'use strict';

/**
 * hooks/gsd-pause-hook.js — the Stop half of the unattended pause → /clear →
 * resume cycle (docs/session-resume-hook.md#pause-side).
 *
 * Contract: request a pause only above the threshold, once per TTL, never on
 * stop_hook_active, only when the guard allows; hand ONLY a handoff written
 * for that request to hooks.clear_command (detached); never clear a manual
 * pause on its own; --request-now puts a manual pause on the automatic path.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cleanup, waitFor } = require('./helpers.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { runHook: runHookSeam } = require('./helpers/process-seam.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
const hook = require('../hooks/gsd-pause-hook.js');
const { MANAGED_HOOKS } = require('../hooks/managed-hooks-registry.cjs');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'gsd-pause-hook.js');
// One hook spawn that may itself spawn git + a guard command.
const HOOK_TIMEOUT_MS = 60000;
const NOW = Date.parse('2026-09-17T01:00:00Z');
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

describe('pure pieces', () => {
  test('resolveThreshold: explicit > derived from the CRITICAL threshold > 75 (one signal)', () => {
    assert.equal(hook.resolveThreshold({}), 75);
    assert.equal(hook.resolveThreshold({ hooks: { context_critical_threshold: 20 } }), 80);
    assert.equal(hook.resolveThreshold({ hooks: { context_warning_threshold: 20 } }), 75, 'the WARNING point no longer drives the pause');
    assert.equal(hook.resolveThreshold({ autopause: { threshold_used_pct: 80 }, hooks: { context_critical_threshold: 25 } }), 80);
    assert.equal(hook.resolveThreshold({ autopause: { threshold_used_pct: 0 } }), 75);
    assert.equal(hook.resolveThreshold({ autopause: { threshold_used_pct: 'abc' }, hooks: { context_critical_threshold: 150 } }), 75);
    assert.equal(hook.resolveThreshold({ hooks: { pause_threshold_used_pct: 80 } }), 75, 'the pre-capability spelling is not read');
    const monitor = require('../hooks/gsd-context-monitor.js');
    assert.equal(hook.resolveThreshold({}), monitor.resolveAutopause({}, monitor.resolveThresholds({})).threshold, 'pause hook and context monitor derive the same default');
  });

  test('isRequested: phase + TTL', () => {
    assert.equal(hook.isRequested(null, NOW), false);
    assert.equal(hook.isRequested({ phase: 'pause-requested', requested_at: iso(-60000) }, NOW), true);
    assert.equal(hook.isRequested({ phase: 'clear-spawned', requested_at: iso(-60000) }, NOW), true);
    assert.equal(hook.isRequested({ phase: 'pause-requested', requested_at: iso(-hook.REQUEST_TTL_MS - 1) }, NOW), false);
    assert.equal(hook.isRequested({ phase: 'pause-requested', requested_at: 'garbage' }, NOW), false);
    assert.equal(hook.isRequested({ phase: 'other', requested_at: iso(-1000) }, NOW), false);
    assert.equal(hook.isRequested({ phase: 'keep-session', requested_at: iso(-60000) }, NOW), true);
  });

  test('isHandoffForRequest: only a handoff written after the request (60 s slack)', () => {
    const state = { phase: 'pause-requested', requested_at: iso(-120000) };
    assert.equal(hook.isHandoffForRequest({ timestamp: iso(-60000) }, state, NOW), true);
    assert.equal(hook.isHandoffForRequest({ timestamp: iso(-170000) }, state, NOW), true, 'inside the slack');
    assert.equal(hook.isHandoffForRequest({ timestamp: iso(-200000) }, state, NOW), false, 'older manual handoff');
    assert.equal(hook.isHandoffForRequest({ timestamp: iso(-60000) }, null, NOW), false, 'nothing requested');
    assert.equal(hook.isHandoffForRequest({}, state, NOW), false);
  });

  test('decide: the (a)/(b) matrix', () => {
    const base = { stopHookActive: false, state: {}, handoff: null, used: 70, threshold: 65, nowMs: NOW };
    const requested = { phase: 'pause-requested', requested_at: iso(-120000) };
    const fresh = { file: 'HANDOFF.latest.coordinator.json', complete: true, json: { timestamp: iso(-60000) } };
    const old = { file: 'HANDOFF.latest.coordinator.json', complete: true, json: { timestamp: iso(-3600000) } };
    // an incomplete (still being written) handoff never clears, and is reported as in progress
    const partial = { file: 'HANDOFF.latest.coordinator.json', complete: false, reason: 'markdown twin is empty', json: { timestamp: iso(-1000) } };
    assert.match(hook.decide({ ...base, state: requested, handoff: partial }).reason, /handoff in progress \(HANDOFF\.latest\.coordinator\.json: markdown twin is empty\)/);
    assert.match(hook.decide({ ...base, handoff: partial, floorMs: NOW - 60000 }).reason, /handoff in progress/);

    assert.deepEqual(hook.decide(base), { kind: 'request', used: 70, threshold: 65 });
    assert.equal(hook.decide({ ...base, used: 64 }).kind, 'none');
    assert.equal(hook.decide({ ...base, used: null }).kind, 'none');
    assert.equal(hook.decide({ ...base, stopHookActive: true }).kind, 'none');
    assert.match(hook.decide({ ...base, state: requested }).reason, /already requested/);
    // (b): requested + fresh committed handoff → spawn, even on stop_hook_active; once only
    assert.equal(hook.decide({ ...base, state: requested, handoff: fresh, stopHookActive: true }).kind, 'spawn-clear');
    assert.match(hook.decide({ ...base, state: { ...requested, phase: 'clear-spawned' }, handoff: fresh }).reason, /already spawned/);
    // manual pause (nothing requested): above threshold → re-request; below → stay paused
    assert.equal(hook.decide({ ...base, handoff: old }).kind, 'request');
    assert.match(hook.decide({ ...base, handoff: old, used: 30 }).reason, /manual pause on disk .* staying paused/);
    // requested but the handoff on disk predates the request → not (b); TTL still blocks (a)
    assert.match(hook.decide({ ...base, state: requested, handoff: old }).reason, /already requested/);
    // keep-session: the committed pause is NOT cleared, and no re-request within the TTL
    const keep = { phase: 'keep-session', requested_at: iso(-120000) };
    assert.match(hook.decide({ ...base, state: keep, handoff: fresh, stopHookActive: true }).reason, /keep-session .* staying paused by request/);
    assert.match(hook.decide({ ...base, state: keep, handoff: fresh, used: 95 }).reason, /keep-session/);
    assert.match(hook.decide({ ...base, state: keep }).reason, /already requested/);
  });

  test('sessionFloorMs / isHandoffToClear: newest of startedAt, spawned_at, resumed_at; fallback when unknown', () => {
    assert.equal(hook.sessionFloorMs(null, {}), null);
    assert.equal(hook.sessionFloorMs({ startedAt: NOW - 1000 }, {}), NOW - 1000);
    assert.equal(hook.sessionFloorMs({ startedAt: NOW - 5000 }, { spawned_at: iso(-2000), resumed_at: iso(-3000) }), NOW - 2000);
    assert.equal(hook.sessionFloorMs({ startedAt: null }, { resumed_at: iso(-3000) }), NOW - 3000);
    const requested = { phase: 'pause-requested', requested_at: iso(-120000) };
    assert.equal(hook.isHandoffToClear({ timestamp: iso(-1000) }, {}, NOW - 5000, NOW), true, 'newer than the floor, no request needed');
    assert.equal(hook.isHandoffToClear({ timestamp: iso(-9000) }, requested, NOW - 5000, NOW), false, 'older than the floor even though requested');
    assert.equal(hook.isHandoffToClear({ timestamp: iso(-60000) }, requested, null, NOW), true, 'unknown floor → requested-pause rule');
    assert.equal(hook.isHandoffToClear({ timestamp: iso(-60000) }, {}, null, NOW), false, 'unknown floor, nothing requested → not cleared');
  });

  test("decide (b'): a committed handoff newer than the session clears without a request; older never; keep-session opts out; not twice", () => {
    const base = { stopHookActive: false, state: {}, handoff: null, used: 30, threshold: 75, nowMs: NOW };
    const fresh = { file: 'HANDOFF.latest.coordinator.json', complete: true, json: { timestamp: iso(-1000) } };
    const floor = NOW - 60000;
    assert.equal(hook.decide({ ...base, handoff: fresh, floorMs: floor }).kind, 'spawn-clear', 'manual pause, no request');
    assert.equal(hook.decide({ ...base, handoff: fresh, floorMs: floor, stopHookActive: true }).kind, 'spawn-clear');
    assert.match(hook.decide({ ...base, handoff: { ...fresh, json: { timestamp: iso(-120000) } }, floorMs: floor }).reason, /manual pause on disk/);
    assert.match(hook.decide({ ...base, handoff: fresh, floorMs: floor, state: { phase: 'keep-session', requested_at: iso(-30000) } }).reason, /keep-session/);
    // already spawned for this handoff: spawned_at is folded into the floor by the caller
    assert.match(hook.decide({ ...base, handoff: fresh, floorMs: NOW - 500, state: { phase: 'clear-spawned', requested_at: iso(-30000), spawned_at: iso(-500) } }).reason, /already requested/);
  });

  test('blockReason carries the two unattended rules', () => {
    const r = hook.blockReason(81, 80, null);
    assert.match(r, /Do not ask the user anything/);
    assert.match(r, /`unknown`/);
    assert.match(r, /measure it now/);
    assert.match(r, /gsd-pause-work/);
    assert.doesNotMatch(r, /older handoff/);
    assert.match(hook.blockReason(81, 80, 'HANDOFF.latest.x.json'), /older handoff \(HANDOFF\.latest\.x\.json\) exists; overwrite it/);
  });

  test('statePathFor lives next to the pending file and sanitises the id', () => {
    const root = path.resolve(os.tmpdir(), 'proj');
    assert.equal(hook.statePathFor(root, {}, 'a/b'), path.resolve(root, '.claude', 'gsd-resume', 'state.a_b.json'));
    assert.equal(hook.statePathFor(root, { autopause: { pending_file: '.claude/autoclear/pending.json' } }, 'S'), path.resolve(root, '.claude', 'autoclear', 'state.S.json'));
  });
});

describe('context monitor: one signal', () => {
  const monitor = require('../hooks/gsd-context-monitor.js');

  test('resolveAutopause: enabled flag + threshold derived from CRITICAL', () => {
    const th = monitor.resolveThresholds({});
    assert.deepEqual(monitor.resolveAutopause({}, th), { enabled: false, threshold: 75 });
    assert.deepEqual(monitor.resolveAutopause({ autopause: { enabled: true } }, monitor.resolveThresholds({ context_warning_threshold: 40, context_critical_threshold: 20 })), { enabled: true, threshold: 80 });
    assert.deepEqual(monitor.resolveAutopause({ autopause: { enabled: true, threshold_used_pct: 80 } }, th), { enabled: true, threshold: 80 });
    assert.equal(monitor.resolveAutopause({ autopause: { enabled: 'true' } }, th).enabled, false);
  });

  test('buildWarningMessage: autopause on → points at the automatic pause; off → the classic text', () => {
    const on = { enabled: true, threshold: 80 };
    const off = { enabled: false, threshold: 75 };
    const w = monitor.buildWarningMessage({ isCritical: false, isGsdActive: true, usedPct: 69, remaining: 31, autopause: on });
    assert.match(w, /^CONTEXT WARNING: Usage at 69%\. Remaining: 31%\. Automatic pause will run at 80% used \(autopause\)\. Do NOT run \/gsd-pause-work yourself/);
    assert.match(w, /Finish the current step/);
    const c = monitor.buildWarningMessage({ isCritical: true, isGsdActive: true, usedPct: 78, remaining: 22, autopause: on });
    assert.match(c, /^CONTEXT CRITICAL: .*Automatic pause will run at 80% used/);
    assert.match(c, /let the pause hook take over/);
    assert.doesNotMatch(c, /Inform the user so they can run/);
    const classicW = monitor.buildWarningMessage({ isCritical: false, isGsdActive: true, usedPct: 69, remaining: 31, autopause: off });
    assert.match(classicW, /inform the user so they can prepare to pause/);
    const classicC = monitor.buildWarningMessage({ isCritical: true, isGsdActive: true, usedPct: 78, remaining: 22, autopause: off });
    assert.match(classicC, /\/gsd:pause-work at the next natural stopping point/);
    // autopause never changes the non-GSD text
    const nonGsd = monitor.buildWarningMessage({ isCritical: true, isGsdActive: false, usedPct: 78, remaining: 22, autopause: on });
    assert.match(nonGsd, /ask how they want to proceed/);
  });
});

describe('registration', () => {
  test('shipped: managed registry, build list, plugin hooks.json (Stop), config keys', () => {
    assert.ok(MANAGED_HOOKS.includes('gsd-pause-hook.js'));
    const build = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-hooks.js'), 'utf8');
    assert.ok(build.includes("'gsd-pause-hook.js'"));
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks', 'hooks.json'), 'utf8'));
    assert.ok(manifest.hooks.Stop.some((g) => g.hooks.some((h) => /gsd-pause-hook\.js/.test(h.command))));
    const cap = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'capabilities', 'autopause', 'capability.json'), 'utf8'));
    for (const k of ['autopause.threshold_used_pct', 'autopause.guard_command', 'autopause.clear_command']) assert.ok(cap.config[k], k);
  });
});

describe('end to end (scratch git project)', () => {
  // Every E2E project opts in; the disabled case has its own test below.
  function makeProject(t, config) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-pause-hook-e2e-'));
    t.after(() => cleanup(dir));
    const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-pause-hook-cfg-'));
    t.after(() => cleanup(cfg));
    fs.mkdirSync(path.join(dir, '.planning', 'phases', '02-x'), { recursive: true });
    fs.mkdirSync(path.join(cfg, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(cfg, 'sessions', '4242.json'), JSON.stringify({ sessionId: 'SID', name: 'coordinator-pane' }));
    gitOrThrow(['init', '-q', '.'], { cwd: dir });
    gitOrThrow(['config', 'user.email', 't@t'], { cwd: dir });
    gitOrThrow(['config', 'user.name', 't'], { cwd: dir });
    const merged = Object.assign({}, config || {});
    merged.autopause = Object.assign({ enabled: true }, (config && config.autopause) || {});
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify(merged));
    fs.writeFileSync(path.join(dir, '.planning', 'STATE.md'), '---\nstatus: executing\n---\n');
    gitOrThrow(['add', '-A'], { cwd: dir });
    gitOrThrow(['commit', '-q', '-m', 'init'], { cwd: dir });
    return { dir, cfg };
  }

  function writeCtx(sid, usedPct) {
    const p = path.join(os.tmpdir(), `claude-ctx-${sid}.json`);
    fs.writeFileSync(p, JSON.stringify({ session_id: sid, used_pct: usedPct, remaining_percentage: 100 - usedPct, timestamp: Math.floor(Date.now() / 1000) }));
    return p;
  }

  function commitHandoff(dir, sid, roleId, timestamp) {
    const rel = `.planning/HANDOFF.latest.${roleId}.json`;
    fs.writeFileSync(path.join(dir, rel), JSON.stringify({ session_id: sid, role: 'coordinator', role_id: roleId, timestamp, phase_dir: '.planning/phases/02-x' }));
    fs.writeFileSync(path.join(dir, '.planning', 'phases', '02-x', `.continue-here.latest.${roleId}.md`), '# h');
    gitOrThrow(['add', '-A'], { cwd: dir });
    gitOrThrow(['commit', '-q', '-m', 'wip: paused'], { cwd: dir });
  }

  function run(dir, cfg, input, args = [], extraEnv = {}) {
    // Settle window: 10 s in production; 1 s here unless a test overrides it.
    const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg, GSD_AUTOPAUSE_SETTLE_MS: '1000' };
    delete env.CLAUDE_CODE_SESSION_ID;
    Object.assign(env, extraEnv);
    const r = runHookSeam(HOOK_PATH, args, { input: input === undefined ? '' : JSON.stringify({ cwd: dir, ...input }), env, timeoutMs: HOOK_TIMEOUT_MS, cwd: dir });
    let json = null;
    try { json = JSON.parse(r.stdout); } catch { json = null; }
    return { ...r, json };
  }

  const statePath = (dir) => path.join(dir, '.claude', 'gsd-resume', 'state.SID.json');
  const readState = (dir) => JSON.parse(fs.readFileSync(statePath(dir), 'utf8'));
  const readLog = (dir) => { try { return fs.readFileSync(path.join(dir, '.claude', 'gsd-resume', 'gsd-pause-hook.log'), 'utf8'); } catch { return ''; } };

  test('below threshold → no decision, nothing written', (t) => {
    const { dir, cfg } = makeProject(t);
    const ctx = writeCtx('SID', 40);
    t.after(() => { try { fs.unlinkSync(ctx); } catch { /* gone */ } });
    const r = run(dir, cfg, { session_id: 'SID', stop_hook_active: false });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout.trim(), '');
    assert.ok(!fs.existsSync(statePath(dir)));
  });

  test('(a) above threshold → block with the unattended rules; state pause-requested; not twice; not on stop_hook_active', (t) => {
    const { dir, cfg } = makeProject(t, { hooks: { context_warning_threshold: 35 } });
    const ctx = writeCtx('SID', 76);
    t.after(() => { try { fs.unlinkSync(ctx); } catch { /* gone */ } });
    const r = run(dir, cfg, { session_id: 'SID', stop_hook_active: false });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.json.decision, 'block');
    assert.match(r.json.reason, /Context is at 76% used \(threshold 75%\)/);
    assert.match(r.json.reason, /Do not ask the user anything/);
    assert.match(r.json.reason, /measure it now/);
    const st = readState(dir);
    assert.equal(st.phase, 'pause-requested');
    assert.equal(st.used, 76);
    assert.equal(st.threshold, 75);

    const again = run(dir, cfg, { session_id: 'SID', stop_hook_active: false });
    assert.equal(again.stdout.trim(), '', 'requested within the TTL → silent');
    fs.unlinkSync(statePath(dir));
    const active = run(dir, cfg, { session_id: 'SID', stop_hook_active: true });
    assert.equal(active.stdout.trim(), '', 'stop_hook_active never blocks');
  });

  test('(a) pause_guard_command: non-zero exit refuses (logged), zero allows; env is passed', (t) => {
    const script = path.join(os.tmpdir(), `gsd-pause-hook-guard-${process.pid}-${Date.now()}.cjs`);
    t.after(() => { try { fs.unlinkSync(script); } catch { /* gone */ } });
    fs.writeFileSync(script, "console.log('busy ' + process.env.GSD_PAUSE_USED_PCT + ' pid=' + process.env.GSD_PAUSE_CLAUDE_PID + ' sid=' + process.env.GSD_PAUSE_SESSION_ID); process.exit(Number(process.env.GUARD_RC || 0));\n");
    const guard = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
    const { dir, cfg } = makeProject(t, { autopause: { threshold_used_pct: 80, guard_command: guard } });
    const ctx = writeCtx('SID', 85);
    t.after(() => { try { fs.unlinkSync(ctx); } catch { /* gone */ } });
    const refused = run(dir, cfg, { session_id: 'SID', stop_hook_active: false }, [], { GUARD_RC: '3' });
    assert.equal(refused.stdout.trim(), '');
    assert.ok(!fs.existsSync(statePath(dir)));
    assert.match(readLog(dir), /guard_command refused: busy 85 pid=4242 sid=SID/);
    const allowed = run(dir, cfg, { session_id: 'SID', stop_hook_active: false }, [], { GUARD_RC: '0' });
    assert.equal(allowed.json.decision, 'block');
    assert.match(allowed.json.reason, /threshold 80%/);
  });

  test('(b) requested pause committed → clear_command spawned detached with the env; once', async (t) => {
    const marker = path.join(os.tmpdir(), `gsd-pause-hook-clear-${process.pid}-${Date.now()}.json`);
    t.after(() => { try { fs.unlinkSync(marker); } catch { /* gone */ } });
    // A script file rather than `-e`: the command runs through the platform
    // shell, and nested quoting differs between cmd.exe and sh.
    const script = path.join(os.tmpdir(), `gsd-pause-hook-clear-${process.pid}-${Date.now()}.cjs`);
    t.after(() => { try { fs.unlinkSync(script); } catch { /* gone */ } });
    fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('GSD_CLEAR_')))));
`);
    const clearCmd = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
    const { dir, cfg } = makeProject(t, { autopause: { clear_command: clearCmd } });
    const ctx = writeCtx('SID', 10);
    t.after(() => { try { fs.unlinkSync(ctx); } catch { /* gone */ } });
    fs.mkdirSync(path.dirname(statePath(dir)), { recursive: true });
    fs.writeFileSync(statePath(dir), JSON.stringify({ phase: 'pause-requested', requested_at: new Date(Date.now() - 120000).toISOString(), used: 70, threshold: 65 }));
    commitHandoff(dir, 'SID', 'coordinator', new Date().toISOString());

    const r = run(dir, cfg, { session_id: 'SID', stop_hook_active: true });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout.trim(), '', 'no decision on the spawn turn');
    const st = readState(dir);
    assert.equal(st.phase, 'clear-spawned');
    assert.ok(st.child_pid > 0);
    // detached child: wait briefly for its marker
    await waitFor(() => fs.existsSync(marker), { timeoutMs: PROBE_TIMEOUT_MS, message: 'detached clear_command did not write its marker' });
    const env = JSON.parse(fs.readFileSync(marker, 'utf8'));
    assert.equal(env.GSD_CLEAR_SESSION_ID, 'SID');
    assert.equal(env.GSD_CLEAR_CLAUDE_PID, '4242');
    assert.equal(env.GSD_CLEAR_SESSION_NAME, 'coordinator-pane');
    assert.equal(env.GSD_CLEAR_ROLE, 'coordinator');
    assert.equal(env.GSD_CLEAR_ROLE_ID, 'coordinator');
    assert.equal(env.GSD_CLEAR_HANDOFF_JSON, '.planning/HANDOFF.latest.coordinator.json');
    assert.equal(env.GSD_CLEAR_HANDOFF_MD, '.planning/phases/02-x/.continue-here.latest.coordinator.md');
    assert.equal(env.GSD_CLEAR_STATE_DIR, '.claude/gsd-resume');

    fs.unlinkSync(marker);
    const again = run(dir, cfg, { session_id: 'SID', stop_hook_active: false });
    assert.equal(again.stdout.trim(), '');
    assert.ok(!fs.existsSync(marker), 'clear-spawned → not spawned twice');
  });

  function clearMarker(t, prefix) {
    const marker = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    t.after(() => { try { fs.unlinkSync(marker); } catch { /* gone */ } });
    const script = `${marker}.cjs`;
    t.after(() => { try { fs.unlinkSync(script); } catch { /* gone */ } });
    fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(marker)}, process.env.GSD_CLEAR_SESSION_ID || '');\n`);
    return { marker, cmd: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}` };
  }

  test("(b') manual pause (no request) committed after the session started → clear_command runs; never twice", async (t) => {
    const { marker, cmd } = clearMarker(t, 'gsd-pause-hook-manual');
    const { dir, cfg } = makeProject(t, { autopause: { clear_command: cmd } });
    fs.writeFileSync(path.join(cfg, 'sessions', '4242.json'), JSON.stringify({ sessionId: 'SID', name: 'coordinator-pane', startedAt: Date.now() - 600000 }));
    const ctx = writeCtx('SID', 30);
    t.after(() => { try { fs.unlinkSync(ctx); } catch { /* gone */ } });
    commitHandoff(dir, 'SID', 'coordinator', new Date().toISOString());
    const r = run(dir, cfg, { session_id: 'SID', stop_hook_active: false });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout.trim(), '');
    assert.equal(readState(dir).phase, 'clear-spawned');
    assert.match(readLog(dir), /newer than session floor .*, not requested, committed: yes\) → spawned/);
    await waitFor(() => fs.existsSync(marker), { timeoutMs: PROBE_TIMEOUT_MS, message: 'clear_command did not run' });
    assert.equal(fs.readFileSync(marker, 'utf8'), 'SID');
    // the same handoff never clears twice: spawned_at is now the floor
    fs.unlinkSync(marker);
    const again = run(dir, cfg, { session_id: 'SID', stop_hook_active: true });
    assert.equal(again.stdout.trim(), '');
    assert.ok(!fs.existsSync(marker));
  });

  test("(b') a previous session's handoff (older than startedAt) never clears; resumed_at from the resume hook counts too", (t) => {
    const { marker, cmd } = clearMarker(t, 'gsd-pause-hook-old');
    const { dir, cfg } = makeProject(t, { autopause: { clear_command: cmd } });
    fs.writeFileSync(path.join(cfg, 'sessions', '4242.json'), JSON.stringify({ sessionId: 'SID', name: 'x', startedAt: Date.now() - 60000 }));
    const ctx = writeCtx('SID', 30);
    t.after(() => { try { fs.unlinkSync(ctx); } catch { /* gone */ } });
    commitHandoff(dir, 'SID', 'coordinator', new Date(Date.now() - 3600000).toISOString());
    const r = run(dir, cfg, { session_id: 'SID', stop_hook_active: false });
    assert.equal(r.stdout.trim(), '');
    assert.ok(!fs.existsSync(statePath(dir)));
    assert.match(readLog(dir), /manual pause on disk .* staying paused/);
    assert.ok(!fs.existsSync(marker));
    // no startedAt, but a resumed_at written by the resume hook after the handoff → still not cleared
    fs.writeFileSync(path.join(cfg, 'sessions', '4242.json'), JSON.stringify({ sessionId: 'SID', name: 'x' }));
    fs.mkdirSync(path.dirname(statePath(dir)), { recursive: true });
    fs.writeFileSync(statePath(dir), JSON.stringify({ phase: 'resumed', resumed_at: new Date(Date.now() - 60000).toISOString() }));
    const r2 = run(dir, cfg, { session_id: 'SID', stop_hook_active: false });
    assert.equal(r2.stdout.trim(), '');
    assert.equal(readState(dir).phase, 'resumed');
    assert.ok(!fs.existsSync(marker));
  });

  function writeHandoffPair(dir, sid, roleId, timestamp, opts = {}) {
    const json = path.join(dir, '.planning', `HANDOFF.latest.${roleId}.json`);
    const md = path.join(dir, '.planning', 'phases', '02-x', `.continue-here.latest.${roleId}.md`);
    fs.writeFileSync(json, JSON.stringify({ session_id: sid, role: 'coordinator', role_id: roleId, timestamp, phase_dir: '.planning/phases/02-x' }));
    if (!opts.noMd) fs.writeFileSync(md, opts.mdText === undefined ? '# h' : opts.mdText);
    if (opts.settled) {
      const old = new Date(Date.now() - 60000);
      fs.utimesSync(json, old, old);
      if (!opts.noMd) fs.utimesSync(md, old, old);
    }
    return { json, md };
  }

  test("(b'') an UNTRACKED (never committed) handoff pair clears — git is not consulted", async (t) => {
    const { marker, cmd } = clearMarker(t, 'gsd-pause-hook-untracked');
    const { dir, cfg } = makeProject(t, { autopause: { clear_command: cmd } });
    fs.writeFileSync(path.join(cfg, 'sessions', '4242.json'), JSON.stringify({ sessionId: 'SID', name: 'x', startedAt: Date.now() - 600000 }));
    const ctx = writeCtx('SID', 30);
    t.after(() => { try { fs.unlinkSync(ctx); } catch { /* gone */ } });
    writeHandoffPair(dir, 'SID', 'coordinator', new Date().toISOString(), { settled: true });
    assert.match(gitOrThrow(['status', '--porcelain'], { cwd: dir }), /\?\? \.planning\/HANDOFF\.latest\.coordinator\.json/, 'precondition: untracked');
    const r = run(dir, cfg, { session_id: 'SID', stop_hook_active: false });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(readState(dir).phase, 'clear-spawned');
    assert.match(readLog(dir), /committed: no\) → spawned/);
    await waitFor(() => fs.existsSync(marker), { timeoutMs: PROBE_TIMEOUT_MS, message: 'clear_command did not run' });
  });

  test("(b'') JSON without its markdown twin → 'handoff in progress', nothing spawned", (t) => {
    const { marker, cmd } = clearMarker(t, 'gsd-pause-hook-nomd');
    const { dir, cfg } = makeProject(t, { autopause: { clear_command: cmd } });
    fs.writeFileSync(path.join(cfg, 'sessions', '4242.json'), JSON.stringify({ sessionId: 'SID', name: 'x', startedAt: Date.now() - 600000 }));
    const ctx = writeCtx('SID', 30);
    t.after(() => { try { fs.unlinkSync(ctx); } catch { /* gone */ } });
    writeHandoffPair(dir, 'SID', 'coordinator', new Date().toISOString(), { settled: true, noMd: true });
    const r = run(dir, cfg, { session_id: 'SID', stop_hook_active: false });
    assert.equal(r.stdout.trim(), '');
    assert.ok(!fs.existsSync(statePath(dir)));
    assert.match(readLog(dir), /handoff in progress \(HANDOFF\.latest\.coordinator\.json: \.continue-here\.latest\.coordinator\.md not written yet\)/);
    assert.ok(!fs.existsSync(marker));
    // an empty twin is not written either
    writeHandoffPair(dir, 'SID', 'coordinator', new Date().toISOString(), { settled: true, mdText: '' });
    run(dir, cfg, { session_id: 'SID', stop_hook_active: false });
    assert.match(readLog(dir), /markdown twin is empty/);
    assert.ok(!fs.existsSync(marker));
  });

  test("(b'') a pair still being written waits out the settle window inside the Stop, then clears", async (t) => {
    const { marker, cmd } = clearMarker(t, 'gsd-pause-hook-settle');
    const { dir, cfg } = makeProject(t, { autopause: { clear_command: cmd } });
    fs.writeFileSync(path.join(cfg, 'sessions', '4242.json'), JSON.stringify({ sessionId: 'SID', name: 'x', startedAt: Date.now() - 600000 }));
    const ctx = writeCtx('SID', 30);
    t.after(() => { try { fs.unlinkSync(ctx); } catch { /* gone */ } });
    writeHandoffPair(dir, 'SID', 'coordinator', new Date().toISOString()); // fresh mtimes
    const started = Date.now();
    const r = run(dir, cfg, { session_id: 'SID', stop_hook_active: false }, [], { GSD_AUTOPAUSE_SETTLE_MS: '2000' });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.ok(Date.now() - started >= 1500, 'the hook waited for the files to settle');
    assert.match(readLog(dir), /waited for the handoff to settle → complete/);
    assert.equal(readState(dir).phase, 'clear-spawned');
    await waitFor(() => fs.existsSync(marker), { timeoutMs: PROBE_TIMEOUT_MS, message: 'clear_command did not run' });
  });

  test('a requested pause with no complete handoff after 10 min is reported once via autopause.notify_command', (t) => {
    const marker = path.join(os.tmpdir(), `gsd-pause-hook-notify-${process.pid}-${Date.now()}.txt`);
    t.after(() => { try { fs.unlinkSync(marker); } catch { /* gone */ } });
    const script = `${marker}.cjs`;
    t.after(() => { try { fs.unlinkSync(script); } catch { /* gone */ } });
    fs.writeFileSync(script, `require('fs').appendFileSync(${JSON.stringify(marker)}, process.env.GSD_PAUSE_MESSAGE + '|' + process.argv[2] + '\\n');\n`);
    const { dir, cfg } = makeProject(t, { autopause: { notify_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}` } });
    const ctx = writeCtx('SID', 30);
    t.after(() => { try { fs.unlinkSync(ctx); } catch { /* gone */ } });
    fs.mkdirSync(path.dirname(statePath(dir)), { recursive: true });
    fs.writeFileSync(statePath(dir), JSON.stringify({ phase: 'pause-requested', requested_at: new Date(Date.now() - 11 * 60000).toISOString(), used: 80, threshold: 75 }));
    // half-written handoff on disk (JSON only)
    writeHandoffPair(dir, 'SID', 'coordinator', new Date().toISOString(), { settled: true, noMd: true });
    run(dir, cfg, { session_id: 'SID', stop_hook_active: false });
    const lines = splitLines(fs.readFileSync(marker, 'utf8').trim());
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^⏸ autopause \[SID\]: pause requested at .* but no complete handoff after 1[01] min — check the session\|⏸ autopause/);
    assert.ok(readState(dir).notified_at, 'notified_at recorded');
    run(dir, cfg, { session_id: 'SID', stop_hook_active: false });
    assert.equal(splitLines(fs.readFileSync(marker, 'utf8').trim()).length, 1, 'reported once');
    // fresh request (< 10 min) → no report
    fs.writeFileSync(statePath(dir), JSON.stringify({ phase: 'pause-requested', requested_at: new Date().toISOString() }));
    run(dir, cfg, { session_id: 'SID', stop_hook_active: false });
    assert.equal(splitLines(fs.readFileSync(marker, 'utf8').trim()).length, 1);
  });

  test('(b) half-written handoff is not "done"; handoff older than the request is not "done"', (t) => {
    const { dir, cfg } = makeProject(t, { autopause: { clear_command: 'echo never' } });
    const ctx = writeCtx('SID', 10);
    t.after(() => { try { fs.unlinkSync(ctx); } catch { /* gone */ } });
    fs.mkdirSync(path.dirname(statePath(dir)), { recursive: true });
    const requestedAt = new Date(Date.now() - 120000).toISOString();
    fs.writeFileSync(statePath(dir), JSON.stringify({ phase: 'pause-requested', requested_at: requestedAt, used: 70, threshold: 65 }));
    // JSON written, markdown twin not yet → in progress, not done (commit is irrelevant)
    fs.writeFileSync(path.join(dir, '.planning', 'HANDOFF.latest.coordinator.json'), JSON.stringify({ session_id: 'SID', role_id: 'coordinator', timestamp: new Date().toISOString() }));
    run(dir, cfg, { session_id: 'SID', stop_hook_active: true });
    assert.equal(readState(dir).phase, 'pause-requested');
    assert.match(readLog(dir), /handoff in progress/);
    // committed but older than the request (a leftover manual pause)
    commitHandoff(dir, 'SID', 'coordinator', new Date(Date.now() - 3600000).toISOString());
    run(dir, cfg, { session_id: 'SID', stop_hook_active: true });
    assert.equal(readState(dir).phase, 'pause-requested');
  });

  test('manual pause: below threshold stays paused (logged); above threshold is re-requested', (t) => {
    const { dir, cfg } = makeProject(t, { autopause: { clear_command: 'echo never' } });
    commitHandoff(dir, 'SID', 'coordinator', new Date().toISOString());
    const ctx = writeCtx('SID', 30);
    t.after(() => { try { fs.unlinkSync(ctx); } catch { /* gone */ } });
    const low = run(dir, cfg, { session_id: 'SID', stop_hook_active: false });
    assert.equal(low.stdout.trim(), '');
    assert.match(readLog(dir), /manual pause on disk \(HANDOFF\.latest\.coordinator\.json\) and used=30% < 75% — staying paused/);
    assert.ok(!fs.existsSync(statePath(dir)));
    writeCtx('SID', 90);
    const high = run(dir, cfg, { session_id: 'SID', stop_hook_active: false });
    assert.equal(high.json.decision, 'block');
    assert.match(high.json.reason, /older handoff \(HANDOFF\.latest\.coordinator\.json\) exists; overwrite it/);
    assert.equal(readState(dir).phase, 'pause-requested');
  });

  test('(b) without clear_command → logged, state clear-spawned with a note', (t) => {
    const { dir, cfg } = makeProject(t);
    const ctx = writeCtx('SID', 10);
    t.after(() => { try { fs.unlinkSync(ctx); } catch { /* gone */ } });
    fs.mkdirSync(path.dirname(statePath(dir)), { recursive: true });
    fs.writeFileSync(statePath(dir), JSON.stringify({ phase: 'pause-requested', requested_at: new Date(Date.now() - 120000).toISOString() }));
    commitHandoff(dir, 'SID', 'coordinator', new Date().toISOString());
    const r = run(dir, cfg, { session_id: 'SID', stop_hook_active: true });
    assert.equal(r.stdout.trim(), '');
    assert.match(readLog(dir), /set autopause\.clear_command to automate \/clear/);
    assert.equal(readState(dir).note, 'no autopause.clear_command');
  });

  test('autopause.enabled false → no decision, no state, no log, even above the threshold with a committed request', (t) => {
    const { dir, cfg } = makeProject(t, { autopause: { enabled: false, clear_command: 'echo never' } });
    const ctx = writeCtx('SID', 95);
    t.after(() => { try { fs.unlinkSync(ctx); } catch { /* gone */ } });
    const r = run(dir, cfg, { session_id: 'SID', stop_hook_active: false });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout.trim(), '');
    assert.ok(!fs.existsSync(path.join(dir, '.claude')));
  });

  test('--request-now writes pause-requested (manual) from CLAUDE_CODE_SESSION_ID', (t) => {
    const { dir, cfg } = makeProject(t);
    const ctx = writeCtx('SID', 42);
    t.after(() => { try { fs.unlinkSync(ctx); } catch { /* gone */ } });
    const r = run(dir, cfg, undefined, ['--request-now'], { CLAUDE_CODE_SESSION_ID: 'SID' });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /pause-requested written for SID/);
    const st = readState(dir);
    assert.equal(st.phase, 'pause-requested');
    assert.equal(st.manual, true);
    assert.equal(st.used, 42);
    const noSid = run(dir, cfg, undefined, ['--request-now']);
    assert.notEqual(noSid.exitCode, 0);
    // idempotent: a live request (hook-initiated) is kept, not overwritten
    fs.writeFileSync(statePath(dir), JSON.stringify({ phase: 'pause-requested', requested_at: new Date(Date.now() - 60000).toISOString(), used: 80, threshold: 75 }));
    const again = run(dir, cfg, undefined, ['--request-now'], { CLAUDE_CODE_SESSION_ID: 'SID' });
    assert.match(again.stdout, /already requested/);
    assert.equal(readState(dir).used, 80);
  });

  test('--request-now with autopause disabled → message only, nothing written', (t) => {
    const { dir, cfg } = makeProject(t, { autopause: { enabled: false } });
    const r = run(dir, cfg, undefined, ['--request-now'], { CLAUDE_CODE_SESSION_ID: 'SID' });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /autopause\.enabled is false/);
    assert.ok(!fs.existsSync(path.join(dir, '.claude')));
  });

  test('--keep-session → the committed pause is not cleared (the explicit opt-out)', (t) => {
    const marker = path.join(os.tmpdir(), `gsd-pause-hook-keep-${process.pid}-${Date.now()}.txt`);
    t.after(() => { try { fs.unlinkSync(marker); } catch { /* gone */ } });
    const script = path.join(os.tmpdir(), `gsd-pause-hook-keep-${process.pid}-${Date.now()}.cjs`);
    t.after(() => { try { fs.unlinkSync(script); } catch { /* gone */ } });
    fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'cleared');\n`);
    const { dir, cfg } = makeProject(t, { autopause: { clear_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}` } });
    fs.writeFileSync(path.join(cfg, 'sessions', '4242.json'), JSON.stringify({ sessionId: 'SID', name: 'x', startedAt: Date.now() - 600000 }));
    const ctx = writeCtx('SID', 90);
    t.after(() => { try { fs.unlinkSync(ctx); } catch { /* gone */ } });
    const keep = run(dir, cfg, undefined, ['--keep-session'], { CLAUDE_CODE_SESSION_ID: 'SID' });
    assert.equal(keep.exitCode, 0, keep.stderr);
    assert.match(keep.stdout, /keep-session written/);
    assert.equal(readState(dir).phase, 'keep-session');
    // the pause is written and committed after arming, as pause-work.md does
    commitHandoff(dir, 'SID', 'coordinator', new Date().toISOString());
    const r = run(dir, cfg, { session_id: 'SID', stop_hook_active: true });
    assert.equal(r.stdout.trim(), '', 'no block, no spawn');
    assert.equal(readState(dir).phase, 'keep-session');
    assert.match(readLog(dir), /keep-session .* staying paused by request/);
    assert.ok(!fs.existsSync(marker), 'clear_command must not run');
    // and even at 90% used, no re-request while keep-session is live
    const r2 = run(dir, cfg, { session_id: 'SID', stop_hook_active: false });
    assert.equal(r2.stdout.trim(), '');
  });

  test('pause-work path end to end: arm (--request-now) → write + commit handoff → the Stop spawns clear', async (t) => {
    const marker = path.join(os.tmpdir(), `gsd-pause-hook-arm-${process.pid}-${Date.now()}.txt`);
    t.after(() => { try { fs.unlinkSync(marker); } catch { /* gone */ } });
    const script = path.join(os.tmpdir(), `gsd-pause-hook-arm-${process.pid}-${Date.now()}.cjs`);
    t.after(() => { try { fs.unlinkSync(script); } catch { /* gone */ } });
    fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(marker)}, process.env.GSD_CLEAR_ROLE_ID || '');\n`);
    const { dir, cfg } = makeProject(t, { autopause: { clear_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}` } });
    const ctx = writeCtx('SID', 40);
    t.after(() => { try { fs.unlinkSync(ctx); } catch { /* gone */ } });
    // a hand-started /gsd-pause-work well below the threshold
    const arm = run(dir, cfg, undefined, ['--request-now'], { CLAUDE_CODE_SESSION_ID: 'SID' });
    assert.equal(arm.exitCode, 0, arm.stderr);
    assert.equal(readState(dir).manual, true);
    commitHandoff(dir, 'SID', 'coordinator', new Date().toISOString());
    const r = run(dir, cfg, { session_id: 'SID', stop_hook_active: false });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout.trim(), '');
    assert.equal(readState(dir).phase, 'clear-spawned');
    await waitFor(() => fs.existsSync(marker), { timeoutMs: PROBE_TIMEOUT_MS, message: 'clear_command did not run' });
    assert.equal(fs.readFileSync(marker, 'utf8'), 'coordinator');
  });
});
