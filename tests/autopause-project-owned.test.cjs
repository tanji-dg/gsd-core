'use strict';

/**
 * autopause project customisation — pause_skill / pause_instructions /
 * done_command (pause side) and resume_skill / resume_command (resume side).
 *
 * Contract: every key is optional and empty = the built-in GSD behaviour,
 * byte for byte. A project that sets them owns its pause and resume
 * procedure; the hooks only name the skill, run the project's commands and
 * hand the session an instruction (a hook cannot run a skill itself).
 * (docs/reference/autopause-contract.md#project-owned-pause-and-resume)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cleanup, waitFor } = require('./helpers.cjs');
const { runHook } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const pauseHook = require('../hooks/gsd-pause-hook.js');
const shared = require('../hooks/lib/autopause-shared.js');

const PAUSE = path.join(__dirname, '..', 'hooks', 'gsd-pause-hook.js');
const RESUME = path.join(__dirname, '..', 'hooks', 'gsd-resume-hook.js');
const HOOK_TIMEOUT_MS = 60000;

describe('config view', () => {
  test('all customisation keys default to empty (built-in behaviour)', () => {
    const c = shared.readAutopauseConfig('', {});
    for (const k of ['pause_skill', 'pause_instructions', 'done_command', 'resume_skill', 'resume_command']) assert.equal(c[k], '', k);
  });

  test('pause_instructions: a string or an array of lines; skills are cleaned', () => {
    const arr = shared.readAutopauseConfig('', { autopause: { pause_instructions: ['one', 'two', 7] } });
    assert.equal(arr.pause_instructions, 'one\ntwo');
    const str = shared.readAutopauseConfig('', { autopause: { pause_instructions: '  just this ' } });
    assert.equal(str.pause_instructions, 'just this');
    const skills = shared.readAutopauseConfig('', { autopause: { pause_skill: '/kagefumi-pause', resume_skill: 'plugin:resume' } });
    assert.equal(skills.pause_skill, 'kagefumi-pause');
    assert.equal(skills.resume_skill, 'plugin:resume');
    const bad = shared.readAutopauseConfig('', { autopause: { pause_skill: 'x; rm -rf /', resume_skill: '$(id)' } });
    assert.equal(bad.pause_skill, '', 'not a skill name → ignored, the default applies');
    assert.equal(bad.resume_skill, '');
  });
});

describe('blockReason', () => {
  test('without customisation: unchanged built-in text', () => {
    const r = pauseHook.blockReason(80, 75, null);
    assert.match(r, /Run the `gsd-pause-work` skill NOW and finish through the WIP commit/);
    assert.match(r, /After the commit the session is cleared automatically and the handoff is injected/);
    assert.equal(r, pauseHook.blockReason(80, 75, null, { skill: '', instructions: '' }));
    assert.equal(r, pauseHook.blockReason(80, 75, null, { skill: 'gsd-pause-work', instructions: '' }));
  });

  test('custom skill and instructions replace the GSD-specific wording', () => {
    const r = pauseHook.blockReason(80, 75, '.planning/HANDOFF.latest.x.json', { skill: 'kagefumi-pause', instructions: 'Update the entry file.\nThen commit.' });
    assert.match(r, /Run the `kagefumi-pause` skill NOW/);
    assert.match(r, /Update the entry file\.\nThen commit\./);
    assert.match(r, /Do not ask the user anything/);
    assert.ok(!/gsd-pause-work/.test(r) && !/WIP commit/.test(r) && !/older handoff/.test(r));
  });
});

describe('end to end', () => {
  function makeProject(t, autopause) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-autopause-owned-'));
    t.after(() => cleanup(dir));
    const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-autopause-owned-cfg-'));
    t.after(() => cleanup(cfg));
    fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
    fs.mkdirSync(path.join(cfg, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(cfg, 'sessions', '4242.json'), JSON.stringify({ sessionId: 'OWNSID', name: 'pane' }));
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({ autopause: Object.assign({ enabled: true }, autopause) }));
    const tools = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-autopause-owned-tools-'));
    t.after(() => cleanup(tools));
    return { dir, cfg, tools };
  }

  function script(tools, name, body) {
    const p = path.join(tools, name);
    fs.writeFileSync(p, body);
    return `node "${p}"`;
  }

  function writeCtx(sid, usedPct) {
    const p = path.join(os.tmpdir(), `claude-ctx-${sid}.json`);
    fs.writeFileSync(p, JSON.stringify({ session_id: sid, used_pct: usedPct, remaining_percentage: 100 - usedPct, timestamp: Math.floor(Date.now() / 1000) }));
    return p;
  }

  function run(hook, dir, cfg, input, args = []) {
    const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg };
    delete env.CLAUDE_CODE_SESSION_ID;
    const r = runHook(hook, args, { input: JSON.stringify({ cwd: dir, ...input }), env, timeoutMs: HOOK_TIMEOUT_MS, cwd: dir });
    let json = null;
    try { json = JSON.parse(r.stdout); } catch { json = null; }
    return { ...r, json };
  }

  const stateDir = (dir) => path.join(dir, '.claude', 'gsd-resume');
  const readState = (dir) => JSON.parse(fs.readFileSync(path.join(stateDir(dir), 'state.OWNSID.json'), 'utf8'));
  const readLog = (dir, name) => { try { return fs.readFileSync(path.join(stateDir(dir), name), 'utf8'); } catch { return ''; } };

  test('pause_skill + pause_instructions reach the block reason; guard sees the project dir', (t) => {
    const { dir, cfg, tools } = makeProject(t, {});
    const seen = path.join(tools, 'guard-env.txt');
    const guard = script(tools, 'guard.js', `require('fs').writeFileSync(${JSON.stringify(seen)}, process.env.GSD_PAUSE_PROJECT_DIR || '')`);
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({ autopause: { enabled: true, pause_skill: 'kagefumi-pause', pause_instructions: ['Update the entry file.', 'Then commit.'], guard_command: guard } }));
    const ctx = writeCtx('OWNSID', 90);
    t.after(() => { try { fs.unlinkSync(ctx); } catch { /* gone */ } });
    const r = run(PAUSE, dir, cfg, { session_id: 'OWNSID', stop_hook_active: false });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.json.decision, 'block');
    assert.match(r.json.reason, /Run the `kagefumi-pause` skill NOW/);
    assert.match(r.json.reason, /Update the entry file\.\nThen commit\./);
    assert.equal(fs.readFileSync(seen, 'utf8'), dir);
    assert.equal(readState(dir).phase, 'pause-requested');
  });

  test('--request-now names the project skill', (t) => {
    const { dir, cfg } = makeProject(t, { pause_skill: 'kagefumi-pause' });
    const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg, CLAUDE_CODE_SESSION_ID: 'OWNSID' };
    const r = runHook(PAUSE, ['--request-now'], { input: '', env, timeoutMs: HOOK_TIMEOUT_MS, cwd: dir });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /Now run the kagefumi-pause skill/);
  });

  test('done_command: not done → nothing; done (exit 0) → clear_command spawned once, role from the JSON line', async (t) => {
    const { dir, cfg, tools } = makeProject(t, {});
    const flag = path.join(tools, 'done.flag');
    const doneEnv = path.join(tools, 'done-env.json');
    const marker = path.join(tools, 'clear-env.json');
    const done = script(tools, 'done.js', `
      const fs = require('fs');
      fs.writeFileSync(${JSON.stringify(doneEnv)}, JSON.stringify({ sid: process.env.GSD_PAUSE_SESSION_ID, pid: process.env.GSD_PAUSE_CLAUDE_PID, at: process.env.GSD_PAUSE_REQUESTED_AT, dir: process.env.GSD_PAUSE_PROJECT_DIR }));
      if (!fs.existsSync(${JSON.stringify(flag)})) { console.log('not yet'); process.exit(1); }
      console.log(JSON.stringify({ role_id: 'impl-1', role: 'implementer', note: 'entry file committed' }));`);
    const clear = script(tools, 'clear.js', `require('fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ role: process.env.GSD_CLEAR_ROLE, role_id: process.env.GSD_CLEAR_ROLE_ID, json: process.env.GSD_CLEAR_HANDOFF_JSON, md: process.env.GSD_CLEAR_HANDOFF_MD, sid: process.env.GSD_CLEAR_SESSION_ID, pid: process.env.GSD_CLEAR_CLAUDE_PID }))`);
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({ autopause: { enabled: true, done_command: done, clear_command: clear, pause_skill: 'kagefumi-pause' } }));
    const ctx = writeCtx('OWNSID', 90);
    t.after(() => { try { fs.unlinkSync(ctx); } catch { /* gone */ } });

    const first = run(PAUSE, dir, cfg, { session_id: 'OWNSID', stop_hook_active: false });
    assert.equal(first.json.decision, 'block');
    assert.equal(readState(dir).phase, 'pause-requested');
    assert.ok(!fs.existsSync(doneEnv), 'done_command is not consulted before a pause is requested');

    const notYet = run(PAUSE, dir, cfg, { session_id: 'OWNSID', stop_hook_active: true });
    assert.equal(notYet.stdout.trim(), '');
    assert.equal(readState(dir).phase, 'pause-requested', 'not done → still requested');
    assert.match(readLog(dir, 'gsd-pause-hook.log'), /done_command: not done \(rc=1: not yet\)/);
    const e = JSON.parse(fs.readFileSync(doneEnv, 'utf8'));
    assert.equal(e.sid, 'OWNSID');
    assert.equal(e.pid, '4242');
    assert.equal(e.dir, dir);
    assert.ok(Date.parse(e.at) > 0, 'GSD_PAUSE_REQUESTED_AT is the request time');
    assert.ok(!fs.existsSync(marker));

    fs.writeFileSync(flag, '1');
    const done1 = run(PAUSE, dir, cfg, { session_id: 'OWNSID', stop_hook_active: true });
    assert.equal(done1.exitCode, 0, done1.stderr);
    assert.equal(readState(dir).phase, 'clear-spawned');
    await waitFor(() => fs.existsSync(marker), { timeoutMs: PROBE_TIMEOUT_MS, message: 'detached clear_command did not write its marker' });
    const c = JSON.parse(fs.readFileSync(marker, 'utf8'));
    assert.equal(c.role_id, 'impl-1');
    assert.equal(c.role, 'implementer');
    assert.equal(c.json, '', 'no HANDOFF file in a project-owned pause');
    assert.equal(c.md, '');
    assert.equal(c.sid, 'OWNSID');
    assert.equal(c.pid, '4242');
    assert.match(readLog(dir, 'gsd-pause-hook.log'), /done_command: done role_id=impl-1 — entry file committed/);

    const again = run(PAUSE, dir, cfg, { session_id: 'OWNSID', stop_hook_active: true });
    assert.equal(again.stdout.trim(), '');
    assert.equal((readLog(dir, 'gsd-pause-hook.log').match(/spawned autopause.clear_command/g) || []).length, 1, 'clear is spawned once');
  });

  test('done_command is ignored on a keep-session request and without a request', (t) => {
    const { dir, cfg, tools } = makeProject(t, {});
    const ran = path.join(tools, 'ran.txt');
    const done = script(tools, 'done.js', `require('fs').writeFileSync(${JSON.stringify(ran)}, '1')`);
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({ autopause: { enabled: true, done_command: done } }));
    const ctx = writeCtx('OWNSID', 10);
    t.after(() => { try { fs.unlinkSync(ctx); } catch { /* gone */ } });
    const r = run(PAUSE, dir, cfg, { session_id: 'OWNSID', stop_hook_active: false });
    assert.equal(r.stdout.trim(), '');
    assert.ok(!fs.existsSync(ran));
    const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg, CLAUDE_CODE_SESSION_ID: 'OWNSID' };
    runHook(PAUSE, ['--keep-session'], { input: '', env, timeoutMs: HOOK_TIMEOUT_MS, cwd: dir });
    run(PAUSE, dir, cfg, { session_id: 'OWNSID', stop_hook_active: false });
    assert.ok(!fs.existsSync(ran), 'keep-session → no clear, so no done check');
  });

  function writePending(dir, extra) {
    fs.mkdirSync(stateDir(dir), { recursive: true });
    fs.writeFileSync(path.join(stateDir(dir), 'pending.json'), JSON.stringify(Object.assign({ version: 1, at: new Date().toISOString(), claude_pid: 4242, old_sid: 'OLD', role: 'implementer', role_id: 'impl-1' }, extra)));
  }

  function injected(r) {
    return r.json && r.json.hookSpecificOutput ? r.json.hookSpecificOutput.additionalContext : '';
  }

  test('resume_skill + resume_command: names the skill, injects the command output, claims nothing, acks', (t) => {
    const { dir, cfg, tools } = makeProject(t, {});
    const resumeCmd = script(tools, 'resume.js', `console.log('ENTRY: next step is X; role ' + process.env.GSD_RESUME_ROLE_ID + ' from ' + process.env.GSD_RESUME_OLD_SESSION_ID + ' in ' + process.env.GSD_RESUME_PROJECT_DIR)`);
    const claimed = path.join(tools, 'claim.txt');
    const claimCmd = script(tools, 'claim.js', `require('fs').writeFileSync(${JSON.stringify(claimed)}, process.env.GSD_RESUME_SESSION_ID)`);
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({ autopause: { enabled: true, resume_skill: 'kagefumi-resume', resume_command: resumeCmd, claim_command: claimCmd } }));
    fs.writeFileSync(path.join(cfg, 'sessions', '4242.json'), JSON.stringify({ sessionId: 'NEW', name: 'pane' }));
    // A GSD handoff on disk must stay untouched by a project-owned resume.
    fs.writeFileSync(path.join(dir, '.planning', 'HANDOFF.latest.impl-1.json'), '{}');
    writePending(dir, {});
    const r = run(RESUME, dir, cfg, { source: 'clear', session_id: 'NEW' });
    assert.equal(r.exitCode, 0, r.stderr);
    const text = injected(r);
    assert.match(text, /Run `\/kagefumi-resume` first/);
    assert.match(text, /ENTRY: next step is X; role impl-1 from OLD in /);
    assert.ok(!/STATE\.md|Handoff markdown/.test(text), 'no STATE.md excerpt, no handoff markdown');
    assert.equal(fs.readFileSync(claimed, 'utf8'), 'NEW', 'claim_command still runs');
    assert.ok(fs.existsSync(path.join(dir, '.planning', 'HANDOFF.latest.impl-1.json')), 'nothing claimed from .planning/HANDOFF*');
    const ack = JSON.parse(fs.readFileSync(path.join(stateDir(dir), 'resumed.json'), 'utf8'));
    assert.equal(ack.ok, true);
    assert.equal(ack.old_sid, 'OLD');
    assert.equal(ack.new_sid, 'NEW');
    assert.ok(!fs.existsSync(path.join(stateDir(dir), 'pending.json')), 'pending consumed');
    assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir(dir), 'state.NEW.json'), 'utf8')).phase, 'resumed');
  });

  test('resume_skill without a role works (only the pending record gates it)', (t) => {
    const { dir, cfg } = makeProject(t, { resume_skill: 'kagefumi-resume' });
    fs.writeFileSync(path.join(cfg, 'sessions', '4242.json'), JSON.stringify({ sessionId: 'NEW' }));
    writePending(dir, { role: undefined, role_id: undefined });
    const r = run(RESUME, dir, cfg, { source: 'clear', session_id: 'NEW' });
    assert.match(injected(r), /Run `\/kagefumi-resume` first/);
  });

  test('pending that does not validate → nothing injected, the reason only in the log', (t) => {
    const { dir, cfg } = makeProject(t, { resume_skill: 'kagefumi-resume' });
    fs.writeFileSync(path.join(dir, '.planning', 'HANDOFF.latest.impl-1.json'), '{}');
    // unchanged session id
    fs.writeFileSync(path.join(cfg, 'sessions', '4242.json'), JSON.stringify({ sessionId: 'OLD' }));
    writePending(dir, {});
    let r = run(RESUME, dir, cfg, { source: 'clear', session_id: 'OLD' });
    assert.equal(r.stdout.trim(), '');
    assert.match(readLog(dir, 'gsd-resume-hook.log'), /skip \(project-owned resume, nothing injected\): session id unchanged/);
    // addressed to another process
    fs.writeFileSync(path.join(cfg, 'sessions', '4242.json'), JSON.stringify({ sessionId: 'SOMEONE' }));
    writePending(dir, { claude_pid: 999999 });
    r = run(RESUME, dir, cfg, { source: 'clear', session_id: 'NEW' });
    assert.equal(r.stdout.trim(), '');
    assert.match(readLog(dir, 'gsd-resume-hook.log'), /project-owned resume, nothing injected\): pending is for pid 999999/);
    // no pending at all
    fs.unlinkSync(path.join(stateDir(dir), 'pending.json'));
    r = run(RESUME, dir, cfg, { source: 'clear', session_id: 'NEW' });
    assert.equal(r.stdout.trim(), '');
  });

  test('without resume_skill/resume_command a failed validation still lists the unclaimed handoffs (unchanged)', (t) => {
    const { dir, cfg } = makeProject(t, {});
    fs.writeFileSync(path.join(dir, '.planning', 'HANDOFF.latest.impl-1.json'), '{}');
    const r = run(RESUME, dir, cfg, { source: 'clear', session_id: 'NEW' });
    assert.match(injected(r), /unclaimed handoffs/);
  });
});
