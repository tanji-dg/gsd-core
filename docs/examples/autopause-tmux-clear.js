#!/usr/bin/env node
'use strict';
/*
 * Example `autopause.clear_command` for Claude Code sessions that run inside tmux (Linux / macOS).
 *
 *   "autopause": { "enabled": true, "clear_command": "node /path/to/autopause-tmux-clear.js" }
 *
 * The pause hook spawns this detached, in the project root, once the pause is done (see
 * docs/reference/autopause-contract.md). It:
 *   1. finds the tmux pane whose process tree contains GSD_CLEAR_CLAUDE_PID,
 *   2. waits (≤ 2 min) until the session is idle (<config>/sessions/<pid>.json status idle|shell),
 *   3. writes the pending record the resume hook needs (only_clear when there is no role id),
 *   4. types `/clear` into the pane, then waits (≤ 45 s) for the resume hook's ack (resumed.json).
 *
 * An EXAMPLE, not shipped behaviour: adapt it (pane naming, a `go` line after the clear, notifications).
 * It has not been run against a live tmux by the GSD maintainers. Failure never loses work:
 * the handoff stays on disk and a manual /clear → /gsd-resume-work (or the project's resume) still works.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const E = process.env;
const PID = Number(E.GSD_CLEAR_CLAUDE_PID);
const OLD_SID = E.GSD_CLEAR_SESSION_ID || '';
const ROLE_ID = E.GSD_CLEAR_ROLE_ID || '';
const STATE_DIR = path.resolve(E.GSD_CLEAR_STATE_DIR || '.claude/gsd-resume');
const CONFIG_DIR = (E.CLAUDE_CONFIG_DIR && E.CLAUDE_CONFIG_DIR.trim()) || path.join(os.homedir(), '.claude');

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' });
const log = (s) => { try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.appendFileSync(path.join(STATE_DIR, 'tmux-clear.log'), `${new Date().toISOString()} ${s}\n`); } catch (e) { /* best effort */ } };
const fail = (why) => { log(`FAIL: ${why}`); process.exit(1); };

if (!PID) fail('GSD_CLEAR_CLAUDE_PID is empty (no sessions/<pid>.json for this session)');

function parentOf(pid) {
  const r = run('ps', ['-o', 'ppid=', '-p', String(pid)]);
  return r.status === 0 ? Number(String(r.stdout).trim()) || 0 : 0;
}
function inTree(pid, root) {
  for (let p = pid, i = 0; p > 1 && i < 64; p = parentOf(p), i += 1) if (p === root) return true;
  return false;
}
function findPane() {
  const r = run('tmux', ['list-panes', '-a', '-F', '#{pane_id} #{pane_pid}']);
  if (r.status !== 0) return null;
  for (const line of String(r.stdout).split('\n')) {
    const [id, pp] = line.trim().split(' ');
    if (id && Number(pp) && inTree(PID, Number(pp))) return id;
  }
  return null;
}
function idle() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'sessions', `${PID}.json`), 'utf8'));
    return j.sessionId === OLD_SID && (j.status === 'idle' || j.status === 'shell');
  } catch (e) { return false; }
}

const pane = findPane();
if (!pane) fail(`no tmux pane contains pid ${PID}`);
for (let t = 0; !idle(); t += 500) { if (t > 120000) fail('session did not become idle within 2 min'); sleep(500); }

const pending = {
  version: 1, at: new Date().toISOString(), claude_pid: PID, old_sid: OLD_SID,
  role: E.GSD_CLEAR_ROLE || undefined, role_id: ROLE_ID || undefined,
  handoff_json_path: E.GSD_CLEAR_HANDOFF_JSON || undefined, handoff_md_path: E.GSD_CLEAR_HANDOFF_MD || undefined,
  only_clear: ROLE_ID ? false : true,
};
fs.mkdirSync(STATE_DIR, { recursive: true });
const resumed = path.join(STATE_DIR, 'resumed.json');
try { fs.unlinkSync(resumed); } catch (e) { /* none */ }
fs.writeFileSync(path.join(STATE_DIR, 'pending.json'), JSON.stringify(pending, null, 2));

run('tmux', ['send-keys', '-t', pane, '-l', '/clear']);
sleep(600);
run('tmux', ['send-keys', '-t', pane, 'Enter']);
log(`sent /clear to ${pane} (pid ${PID}, old ${OLD_SID.slice(0, 8)})`);

for (let t = 0; t <= 45000; t += 500) {
  try {
    const ack = JSON.parse(fs.readFileSync(resumed, 'utf8'));
    if (ack.old_sid === OLD_SID) { log(`resumed: ok=${ack.ok}`); process.exit(ack.ok ? 0 : 1); }
  } catch (e) { /* not yet */ }
  sleep(500);
}
fail('no resume ack within 45 s');
