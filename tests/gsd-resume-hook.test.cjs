// allow-test-rule: source-text-is-the-product
// Reads .md/.json product files whose deployed text IS what the runtime loads —
// testing text content tests the deployed contract.
'use strict';

/**
 * hooks/gsd-resume-hook.js — the SessionStart(clear) half of the unattended
 * pause → /clear → resume cycle (docs/reference/autopause-contract.md).
 *
 * The contract under test: claim NOTHING unless every precondition holds;
 * when they do, claim by rename, run the project extension point, route
 * through `state session-resume`, commit only the two `.latest` deletions,
 * inject the handoff + STATE.md excerpt, and never fail the session.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cleanup } = require('./helpers.cjs');
const { runHook: runHookSeam } = require('./helpers/process-seam.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const hook = require('../hooks/gsd-resume-hook.js');
const { MANAGED_HOOKS } = require('../hooks/managed-hooks-registry.cjs');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'gsd-resume-hook.js');
// One hook spawn that itself spawns gsd-tools + git a few times.
const HOOK_TIMEOUT_MS = 60000;

describe('pure pieces', () => {
  test('resolvePendingPath: default, configured, and never outside the project', () => {
    const root = path.resolve(os.tmpdir(), 'proj');
    assert.equal(hook.resolvePendingPath(root, {}), path.resolve(root, hook.DEFAULT_PENDING_FILE));
    assert.equal(hook.resolvePendingPath(root, { autopause: { pending_file: '.claude/autopause/pending.json' } }), path.resolve(root, '.claude/autopause/pending.json'));
    assert.equal(hook.resolvePendingPath(root, { autopause: { pending_file: '../../evil.json' } }), path.resolve(root, hook.DEFAULT_PENDING_FILE));
    assert.equal(hook.resolvePendingPath(root, { autopause: { pending_file: '.' } }), path.resolve(root, hook.DEFAULT_PENDING_FILE));
    // the pre-capability spelling is NOT read
    assert.equal(hook.resolvePendingPath(root, { hooks: { resume_pending_file: '.claude/autopause/pending.json' } }), path.resolve(root, hook.DEFAULT_PENDING_FILE));
  });

  test('readAutopauseConfig: defaults, enabled must be literally true, only autopause.* is read', () => {
    assert.deepEqual(hook.readAutopauseConfig('', {}), { ...hook.AUTOPAUSE_DEFAULTS, threshold_used_pct: undefined });
    assert.equal(hook.readAutopauseConfig('', { autopause: { enabled: 'true' } }).enabled, false);
    assert.equal(hook.readAutopauseConfig('', { autopause: { enabled: true } }).enabled, true);
    const c = hook.readAutopauseConfig('', { autopause: { clear_command: ' x ', threshold_used_pct: 80 }, hooks: { clear_command: 'ignored' } });
    assert.equal(c.clear_command, 'x');
    assert.equal(c.threshold_used_pct, 80);
    assert.equal(hook.readAutopauseConfig('', { hooks: { resume_claim_command: 'ignored' } }).claim_command, '');
  });

  test('decideSkipReason: every precondition', () => {
    const now = Date.parse('2026-09-16T05:10:00Z');
    const fresh = { at: '2026-09-16T05:00:00Z', old_sid: 'OLD' };
    assert.equal(hook.decideSkipReason({ source: 'clear' }, fresh, now, 'NEW'), null);
    assert.match(hook.decideSkipReason({ source: 'startup' }, fresh, now, 'NEW'), /source=startup/);
    assert.match(hook.decideSkipReason({ source: 'clear' }, null, now, 'NEW'), /no pending/);
    assert.match(hook.decideSkipReason({ source: 'clear' }, { at: '2026-09-16T04:00:00Z' }, now, 'NEW'), /stale/);
    assert.match(hook.decideSkipReason({ source: 'clear' }, { at: 'garbage' }, now, 'NEW'), /stale/);
    assert.match(hook.decideSkipReason({ source: 'clear' }, fresh, now, 'OLD'), /unchanged/);
  });

  test('injectableMarkdown: by size only — full ≤ 32 KB, else 8 KB head + keep the file; multibyte-safe cut', () => {
    const big = '€'.repeat(12000); // a 3-byte code point: 36 KB in UTF-8
    const out = hook.injectableMarkdown(big, { keepPath: '.planning/x.md' });
    assert.equal(out.keepFile, true);
    assert.ok(Buffer.byteLength(out.text, 'utf8') < 8 * 1024 + 300);
    assert.match(out.text, /<!-- TRUNCATED: \d+ bytes — the full handoff is still on disk at `\.planning\/x\.md`/);
    assert.ok(!out.text.includes('�'), 'no split multibyte char at the cut');
  });

  test('stateExcerpt: frontmatter keys + first 40 lines of ## Current Position', () => {
    const lines = ['---', 'status: executing', 'milestone: v1', 'progress:', '  percent: 10', '---', '', '## Current Position'];
    for (let i = 0; i < 60; i++) lines.push(`line ${i}`);
    lines.push('## Session', 'secret');
    const out = hook.stateExcerpt(lines.join('\n'));
    assert.match(out, /^### STATE\.md excerpt/);
    assert.match(out, /status: executing/);
    assert.match(out, / {2}percent: 10/);
    assert.doesNotMatch(out, /milestone: v1/);
    assert.match(out, /line 38/);
    assert.doesNotMatch(out, /line 39\n/);
    assert.doesNotMatch(out, /secret/);
    assert.match(out, /rest of `## Current Position`/);
    assert.equal(hook.stateExcerpt(''), '');
  });

  test('resumeAction: one line from next_action, capped, with a fallback', () => {
    assert.equal(hook.resumeAction({ next_action: '  run\n the  build ' }), 'run the build');
    assert.equal(hook.resumeAction({ next_action: 'a'.repeat(200) }).length, 120);
    assert.equal(hook.resumeAction({}), 'next action');
  });

  test('listingLine / findLatestContinueHere', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-resume-hook-'));
    t.after(() => cleanup(dir));
    const planning = path.join(dir, '.planning');
    fs.mkdirSync(path.join(planning, 'phases', '02-x'), { recursive: true });
    assert.equal(hook.listingLine(planning, 'why'), '');
    fs.writeFileSync(path.join(planning, 'HANDOFF.latest.design.json'), JSON.stringify({ role: 'reviewer', timestamp: '2026-09-16T05:00:00Z' }));
    fs.writeFileSync(path.join(planning, 'HANDOFF.A.json'), '{}');
    const line = hook.listingLine(planning, 'why');
    assert.match(line, /design\(reviewer\) 2026-09-16T05:00/);
    assert.match(line, /\(why\)/);
    assert.doesNotMatch(line, /HANDOFF\.A/);
    assert.equal(hook.findLatestContinueHere(dir, 'design', null), null);
    fs.writeFileSync(path.join(planning, 'phases', '02-x', '.continue-here.latest.design.md'), '#');
    assert.equal(hook.findLatestContinueHere(dir, 'design', null), path.join(planning, 'phases', '02-x', '.continue-here.latest.design.md'));
  });
});

describe('registration', () => {
  test('shipped: managed registry, build list, plugin hooks.json (SessionStart matcher clear)', () => {
    assert.ok(MANAGED_HOOKS.includes('gsd-resume-hook.js'));
    const build = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-hooks.js'), 'utf8');
    assert.ok(build.includes("'gsd-resume-hook.js'"));
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks', 'hooks.json'), 'utf8'));
    const group = manifest.hooks.SessionStart.find((g) => g.matcher === 'clear');
    assert.ok(group, 'a SessionStart group with matcher "clear"');
    assert.ok(group.hooks.some((h) => /gsd-resume-hook\.js/.test(h.command)));
  });

  test('trimContextOutput: empty, small, 4 KB cut', () => {
    assert.equal(hook.trimContextOutput('  \r\n '), '');
    assert.equal(hook.trimContextOutput('a\r\nb\n'), 'a\nb');
    const out = hook.trimContextOutput('€'.repeat(3000)); // 3-byte code points: 9 KB
    assert.ok(Buffer.byteLength(out, 'utf8') <= hook.CONTEXT_LIMIT_BYTES + 30);
    assert.match(out, /<!-- TRUNCATED -->$/);
    assert.ok(!out.includes('�'));
  });

  test('autopause capability owns the config keys (registry, not the core manifest)', () => {
    const cap = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'capabilities', 'autopause', 'capability.json'), 'utf8'));
    assert.equal(cap.activationKey, 'autopause.enabled');
    assert.equal(cap.config['autopause.enabled'].default, false);
    for (const k of ['autopause.threshold_used_pct', 'autopause.guard_command', 'autopause.clear_command', 'autopause.pending_file', 'autopause.claim_command', 'autopause.context_command', 'autopause.notify_command']) {
      assert.ok(cap.config[k], k);
    }
    assert.equal(cap.config['autopause.pending_file'].default, hook.DEFAULT_PENDING_FILE);
    const { isValidConfigKey } = require('../gsd-core/bin/lib/config-schema.cjs');
    assert.equal(isValidConfigKey('autopause.enabled'), true);
    assert.equal(isValidConfigKey('autopause.clear_command'), true);
    const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'gsd-core', 'bin', 'shared', 'config-schema.manifest.json'), 'utf8'));
    for (const k of ['hooks.pause_notify_command', 'hooks.resume_pending_file', 'hooks.resume_claim_command', 'hooks.resume_context_command', 'hooks.clear_command']) {
      assert.ok(!schema.validKeys.includes(k), `${k} must not survive as a second config surface`);
    }
  });

  test('pause-work.md carries the unattended rule, skills and notify steps', () => {
    const body = fs.readFileSync(path.join(__dirname, '..', 'gsd-core', 'workflows', 'pause-work.md'), 'utf8');
    assert.match(body, /Do not block on the user/);
    assert.doesNotMatch(body, /Ask user for clarifications if needed via conversational questions/);
    assert.match(body, /<step name="skills">/);
    assert.match(body, /<step name="notify">/);
    assert.match(body, /autopause\.notify_command/);
    assert.match(body, /Role source of truth/);
  });
});

describe('end to end (scratch git project)', () => {
  function makeProject(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-resume-hook-e2e-'));
    t.after(() => cleanup(dir));
    const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-resume-hook-cfg-'));
    t.after(() => cleanup(cfg));
    fs.mkdirSync(path.join(dir, '.planning', 'phases', '02-x'), { recursive: true });
    fs.mkdirSync(path.join(cfg, 'sessions'), { recursive: true });
    gitOrThrow(['init', '-q', '.'], { cwd: dir });
    gitOrThrow(['config', 'user.email', 't@t'], { cwd: dir });
    gitOrThrow(['config', 'user.name', 't'], { cwd: dir });
    fs.writeFileSync(path.join(dir, '.planning', 'STATE.md'), [
      '---', 'status: paused', 'current_phase: 2', '---', '', '# STATE', '', '## Current Position', '',
      '**Phase:** 2 of 5', '**Status:** Executing Phase 2', '', '## Session', '',
      '**Last session:** 2026-09-11T00:00:00Z', '**Stopped at:** Paused by coordinator', '**Resume file:** None', '',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, '.planning', 'HANDOFF.latest.coordinator.json'), JSON.stringify({
      version: '1.0', timestamp: '2026-09-16T05:00:00Z', session_id: 'OLD', role: 'coordinator', role_id: 'coordinator',
      phase_dir: '.planning/phases/02-x', next_action: 'run the phase 2 task 3 build',
    }));
    fs.writeFileSync(path.join(dir, '.planning', 'phases', '02-x', '.continue-here.latest.coordinator.md'), '# handoff\n\n<next_action>\nStart with: task 3\n</next_action>\n');
    fs.writeFileSync(path.join(dir, '.planning', 'HANDOFF.latest.design.json'), JSON.stringify({ role: 'design' }));
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({
      autopause: { enabled: true, claim_command: `${JSON.stringify(process.execPath)} -e "console.log('claim-hook', process.env.GSD_RESUME_ROLE_ID, process.env.GSD_RESUME_SESSION_ID)"` },
    }));
    gitOrThrow(['add', '-A'], { cwd: dir });
    gitOrThrow(['commit', '-q', '-m', 'wip: paused'], { cwd: dir });
    return { dir, cfg };
  }

  function writePending(dir, extra) {
    fs.mkdirSync(path.join(dir, '.claude', 'gsd-resume'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'gsd-resume', 'pending.json'), JSON.stringify({
      version: 1, at: new Date().toISOString(), claude_pid: 99999999, old_sid: 'OLD', role: 'coordinator', role_id: 'coordinator',
      handoff_json_path: '.planning/HANDOFF.latest.coordinator.json',
      handoff_md_path: '.planning/phases/02-x/.continue-here.latest.coordinator.md',
      ...extra,
    }));
  }

  function run(dir, cfg, input, args = []) {
    const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg };
    delete env.CLAUDE_CODE_SESSION_ID;
    const r = runHookSeam(HOOK_PATH, args, { input: JSON.stringify({ cwd: dir, ...input }), env, timeoutMs: HOOK_TIMEOUT_MS });
    let json = null;
    try { json = JSON.parse(r.stdout); } catch { json = null; }
    return { ...r, json, context: json && json.hookSpecificOutput ? json.hookSpecificOutput.additionalContext : null };
  }

  test('not addressed to this process → lists unclaimed handoffs, touches nothing', (t) => {
    const { dir, cfg } = makeProject(t);
    writePending(dir);
    const r = run(dir, cfg, { session_id: 'NEW', source: 'clear' });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.context, /unclaimed handoffs: coordinator\(coordinator\) .* \/ design\(design\)/);
    assert.match(r.context, /Not auto-claimed \(pending is for pid 99999999/);
    assert.ok(fs.existsSync(path.join(dir, '.planning', 'HANDOFF.latest.coordinator.json')));
    assert.ok(fs.existsSync(path.join(dir, '.claude', 'gsd-resume', 'pending.json')), 'pending left for its real owner');
  });

  test('source != clear → listing only, even when pending is ours', (t) => {
    const { dir, cfg } = makeProject(t);
    writePending(dir);
    fs.writeFileSync(path.join(cfg, 'sessions', '99999999.json'), JSON.stringify({ sessionId: 'NEW' }));
    const r = run(dir, cfg, { session_id: 'NEW', source: 'startup' });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.context, /Not auto-claimed \(source=startup\)/);
    assert.ok(fs.existsSync(path.join(dir, '.planning', 'HANDOFF.latest.coordinator.json')));
  });

  test('no pending and no handoffs → silent pass', (t) => {
    const { dir, cfg } = makeProject(t);
    fs.unlinkSync(path.join(dir, '.planning', 'HANDOFF.latest.coordinator.json'));
    fs.unlinkSync(path.join(dir, '.planning', 'HANDOFF.latest.design.json'));
    const r = run(dir, cfg, { session_id: 'NEW', source: 'clear' });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout.trim(), '');
  });

  test('--dry-run prints the plan and writes nothing', (t) => {
    const { dir, cfg } = makeProject(t);
    writePending(dir);
    fs.writeFileSync(path.join(cfg, 'sessions', '99999999.json'), JSON.stringify({ sessionId: 'NEW' }));
    const before = gitOrThrow(['rev-parse', 'HEAD'], { cwd: dir }).trim();
    const r = run(dir, cfg, { session_id: 'NEW', source: 'clear' }, ['--dry-run']);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /\[dry-run\] mv \.planning\/HANDOFF\.latest\.coordinator\.json → \.planning\/HANDOFF\.claimed\.coordinator\.NEW\.json/);
    assert.match(r.stdout, /\[dry-run\] gsd-tools state session-resume --session NEW --role-id coordinator/);
    assert.match(r.stdout, /\[dry-run\] git commit --only/);
    assert.match(r.stdout, /\[dry-run\] injected \d+ bytes/);
    assert.equal(gitOrThrow(['rev-parse', 'HEAD'], { cwd: dir }).trim(), before);
    assert.ok(fs.existsSync(path.join(dir, '.planning', 'HANDOFF.latest.coordinator.json')));
    assert.ok(fs.existsSync(path.join(dir, '.claude', 'gsd-resume', 'pending.json')));
    assert.ok(!fs.existsSync(path.join(dir, '.claude', 'gsd-resume', 'resumed.json')));
  });

  test('addressed to this process → claim, extension point, session-resume, consumed commit, injection', (t) => {
    const { dir, cfg } = makeProject(t);
    writePending(dir);
    fs.writeFileSync(path.join(cfg, 'sessions', '99999999.json'), JSON.stringify({ sessionId: 'NEW' }));
    const before = gitOrThrow(['rev-parse', 'HEAD'], { cwd: dir }).trim();
    const r = run(dir, cfg, { session_id: 'NEW', source: 'clear' });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.ok(r.context, `no context in: ${r.stdout}`);

    // injected text
    assert.match(r.context, /^# Automatic resume \(gsd-resume-hook\) — role: coordinator {2}previous session OLD → NEW/);
    assert.match(r.context, /Do not run `\/gsd-resume-work`/);
    assert.match(r.context, /`next_action`: run the phase 2 task 3 build/);
    assert.match(r.context, /claim_command ok — claim-hook coordinator NEW/);
    assert.match(r.context, /state session-resume: .*Stopped At.* record=\.planning\/sessions\/NEW\.json removed=\.planning\/HANDOFF\.claimed\.coordinator\.NEW\.json status paused→executing/);
    assert.match(r.context, /consumed commit [0-9a-f]{7}/);
    assert.match(r.context, /### STATE\.md excerpt[\s\S]*status: executing[\s\S]*## Current Position/);
    assert.match(r.context, /### Handoff markdown \(\.planning\/phases\/02-x\/\.continue-here\.latest\.coordinator\.md\)[\s\S]*Start with: task 3/);

    // files: both .latest consumed, nothing claimed left behind, other role untouched
    const planning = path.join(dir, '.planning');
    assert.deepEqual(fs.readdirSync(planning).filter((n) => n.startsWith('HANDOFF')), ['HANDOFF.latest.design.json']);
    assert.deepEqual(fs.readdirSync(path.join(planning, 'phases', '02-x')), []);
    const rec = JSON.parse(fs.readFileSync(path.join(planning, 'sessions', 'NEW.json'), 'utf8'));
    assert.equal(rec.role_id, 'coordinator');
    assert.match(rec.stopped_at, /^Session resumed, proceeding to run the phase 2 task 3 build/);
    const state = fs.readFileSync(path.join(planning, 'STATE.md'), 'utf8');
    assert.match(state, /^status: executing$/m, 'legacy project-wide paused repaired by session-resume');
    assert.match(state, /Stopped at:\*\* Session resumed, proceeding to run the phase 2 task 3 build/);

    // git: exactly one new commit, containing only the two deletions; STATE.md change stays in the tree
    const head = gitOrThrow(['rev-parse', 'HEAD'], { cwd: dir }).trim();
    assert.notEqual(head, before);
    assert.equal(gitOrThrow(['rev-parse', 'HEAD^'], { cwd: dir }).trim(), before);
    assert.match(gitOrThrow(['log', '-1', '--format=%s'], { cwd: dir }), /^chore: \[coordinator\] handoff consumed by NEW \(gsd-resume-hook\)/);
    const shown = gitOrThrow(['show', '--name-status', '--format=', 'HEAD'], { cwd: dir }).trim().split(/\r?\n/).sort();
    assert.deepEqual(shown, [
      'D\t.planning/HANDOFF.latest.coordinator.json',
      'D\t.planning/phases/02-x/.continue-here.latest.coordinator.md',
    ]);
    assert.match(gitOrThrow(['status', '--porcelain'], { cwd: dir }), /^ M \.planning\/STATE\.md/m);

    // the pause hook's floor for the NEW session
    const st = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'gsd-resume', 'state.NEW.json'), 'utf8'));
    assert.equal(st.phase, 'resumed');
    assert.ok(Date.parse(st.resumed_at) > 0);
    assert.equal(st.old_sid, 'OLD');

    // watcher ack
    const resumed = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'gsd-resume', 'resumed.json'), 'utf8'));
    assert.equal(resumed.ok, true);
    assert.equal(resumed.old_sid, 'OLD');
    assert.equal(resumed.new_sid, 'NEW');
    assert.equal(resumed.commit, head.slice(0, resumed.commit.length));
    assert.ok(!fs.existsSync(path.join(dir, '.claude', 'gsd-resume', 'pending.json')));
  });

  test('handoff already claimed by someone else → stops with a message, writes the ack', (t) => {
    const { dir, cfg } = makeProject(t);
    writePending(dir);
    fs.writeFileSync(path.join(cfg, 'sessions', '99999999.json'), JSON.stringify({ sessionId: 'NEW' }));
    fs.unlinkSync(path.join(dir, '.planning', 'HANDOFF.latest.coordinator.json'));
    const r = run(dir, cfg, { session_id: 'NEW', source: 'clear' });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.context, /★ \.planning\/HANDOFF\.latest\.coordinator\.json is missing/);
    const resumed = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'gsd-resume', 'resumed.json'), 'utf8'));
    assert.equal(resumed.ok, false);
    assert.equal(resumed.note, 'latest json missing');
  });

  test('only_clear → nothing claimed, ack written', (t) => {
    const { dir, cfg } = makeProject(t);
    writePending(dir, { only_clear: true });
    fs.writeFileSync(path.join(cfg, 'sessions', '99999999.json'), JSON.stringify({ sessionId: 'NEW' }));
    const r = run(dir, cfg, { session_id: 'NEW', source: 'clear' });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.context, /only-clear mode: nothing claimed/);
    assert.ok(fs.existsSync(path.join(dir, '.planning', 'HANDOFF.latest.coordinator.json')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'gsd-resume', 'resumed.json'), 'utf8')).note, 'only-clear');
  });

  function contextScript(t, body) {
    const script = path.join(os.tmpdir(), `gsd-resume-hook-ctx-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.cjs`);
    t.after(() => { try { fs.unlinkSync(script); } catch { /* gone */ } });
    fs.writeFileSync(script, body);
    return `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
  }

  function setContextCommand(dir, cmd) {
    const cfgPath = path.join(dir, '.planning', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.autopause.context_command = cmd;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    gitOrThrow(['commit', '-q', '-am', 'cfg'], { cwd: dir });
  }

  test('resume_context_command: stdout appended under "### Project context" with the GSD_RESUME_* env', (t) => {
    const { dir, cfg } = makeProject(t);
    setContextCommand(dir, contextScript(t, "console.log('successor note for ' + process.env.GSD_RESUME_ROLE_ID + ' from ' + process.env.GSD_RESUME_OLD_SESSION_ID);\n"));
    writePending(dir);
    fs.writeFileSync(path.join(cfg, 'sessions', '99999999.json'), JSON.stringify({ sessionId: 'NEW' }));
    const r = run(dir, cfg, { session_id: 'NEW', source: 'clear' });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.context, /\n---\n### Project context \(autopause\.context_command\)\n\nsuccessor note for coordinator from OLD\n$/);
    assert.match(r.context, /context_command: \d+ bytes appended/);
  });

  test('resume_context_command: output over 4 KB is cut with a TRUNCATED marker', (t) => {
    const { dir, cfg } = makeProject(t);
    setContextCommand(dir, contextScript(t, "process.stdout.write('x'.repeat(10000));\n"));
    writePending(dir);
    fs.writeFileSync(path.join(cfg, 'sessions', '99999999.json'), JSON.stringify({ sessionId: 'NEW' }));
    const r = run(dir, cfg, { session_id: 'NEW', source: 'clear' });
    assert.equal(r.exitCode, 0, r.stderr);
    const section = r.context.split('### Project context (autopause.context_command)')[1];
    assert.ok(section, 'section present');
    assert.ok(Buffer.byteLength(section, 'utf8') < 4 * 1024 + 64);
    assert.match(section, /x{100}\n<!-- TRUNCATED -->/);
  });

  test('resume_context_command: non-zero exit appends nothing (noted in the record)', (t) => {
    const { dir, cfg } = makeProject(t);
    setContextCommand(dir, contextScript(t, "console.log('should not appear'); process.exit(2);\n"));
    writePending(dir);
    fs.writeFileSync(path.join(cfg, 'sessions', '99999999.json'), JSON.stringify({ sessionId: 'NEW' }));
    const r = run(dir, cfg, { session_id: 'NEW', source: 'clear' });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.doesNotMatch(r.context, /Project context/);
    assert.doesNotMatch(r.context, /should not appear/);
    assert.match(r.context, /★ context_command failed \(rc=2\) — nothing appended/);
  });

  test('injectableMarkdown / commitDocsEnabled', (t) => {
    const small = 'x'.repeat(100);
    assert.deepEqual(hook.injectableMarkdown(small, { keepPath: 'k' }), { text: small, keepFile: false });
    const mid = 'y'.repeat(20 * 1024);
    assert.deepEqual(hook.injectableMarkdown(mid, { keepPath: 'k' }), { text: mid, keepFile: false }, 'full text between 8 and 32 KB, git or not');
    const huge = hook.injectableMarkdown('z'.repeat(40 * 1024), { keepPath: '.planning/HANDOFF.claimed.md' });
    assert.equal(huge.keepFile, true);
    assert.match(huge.text, /Read it now, then delete that file yourself/);
    assert.match(huge.text, /\.planning\/HANDOFF\.claimed\.md/);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-resume-hook-cd-'));
    t.after(() => cleanup(dir));
    fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
    assert.equal(hook.commitDocsEnabled(dir, {}), false, 'no repository → off');
    gitOrThrow(['init', '-q', '.'], { cwd: dir });
    assert.equal(hook.commitDocsEnabled(dir, {}), true);
    assert.equal(hook.commitDocsEnabled(dir, { commit_docs: false }), false);
    assert.equal(hook.commitDocsEnabled(dir, { planning: { commit_docs: false } }), false);
    fs.writeFileSync(path.join(dir, '.gitignore'), '.planning/\n');
    assert.equal(hook.commitDocsEnabled(dir, {}), false, 'ignored .planning/ → off');
  });

  test('commit_docs: false (ignored .planning/) → consume by removal only, full text injected, no consumed commit', (t) => {
    const { dir, cfg } = makeProject(t);
    fs.writeFileSync(path.join(dir, '.gitignore'), '.planning/\n');
    gitOrThrow(['rm', '-r', '-q', '--cached', '.planning'], { cwd: dir });
    gitOrThrow(['commit', '-q', '-am', 'stop tracking .planning'], { cwd: dir });
    const cfgPath = path.join(dir, '.planning', 'config.json');
    const c = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    c.commit_docs = false;
    fs.writeFileSync(cfgPath, JSON.stringify(c));
    const longMd = `# handoff\n\n${'line of context\n'.repeat(700)}<next_action>\nStart with: task 3\n</next_action>\n`; // ~11 KB, over the 8 KB cut
    fs.writeFileSync(path.join(dir, '.planning', 'phases', '02-x', '.continue-here.latest.coordinator.md'), longMd);
    const before = gitOrThrow(['rev-parse', 'HEAD'], { cwd: dir }).trim();
    writePending(dir);
    fs.writeFileSync(path.join(cfg, 'sessions', '99999999.json'), JSON.stringify({ sessionId: 'NEW' }));
    const r = run(dir, cfg, { session_id: 'NEW', source: 'clear' });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.context, /^# Automatic resume/);
    assert.match(r.context, /uncommitted handoff consumed \(commit_docs is off\); content is only in the injected text/);
    assert.doesNotMatch(r.context, /consumed commit [0-9a-f]/);
    assert.doesNotMatch(r.context, /TRUNCATED/);
    assert.ok(r.context.includes(longMd.trim()), 'full markdown injected');
    assert.equal(gitOrThrow(['rev-parse', 'HEAD'], { cwd: dir }).trim(), before, 'no commit made');
    const planning = path.join(dir, '.planning');
    assert.deepEqual(fs.readdirSync(planning).filter((n) => n.startsWith('HANDOFF')), ['HANDOFF.latest.design.json']);
    assert.deepEqual(fs.readdirSync(path.join(planning, 'phases', '02-x')), []);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'gsd-resume', 'resumed.json'), 'utf8')).commit, null);
  });

  test('untracked handoff in a committing project → removal only; over 32 KB the claimed markdown stays on disk', (t) => {
    const { dir, cfg } = makeProject(t);
    // overwrite the committed twin with a huge, uncommitted one
    const huge = `# handoff\n\n${'0123456789abcdef'.repeat(2200)}\n`; // ~35 KB
    fs.writeFileSync(path.join(dir, '.planning', 'phases', '02-x', '.continue-here.latest.coordinator.md'), huge);
    const before = gitOrThrow(['rev-parse', 'HEAD'], { cwd: dir }).trim();
    writePending(dir);
    fs.writeFileSync(path.join(cfg, 'sessions', '99999999.json'), JSON.stringify({ sessionId: 'NEW' }));
    const r = run(dir, cfg, { session_id: 'NEW', source: 'clear' });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.context, /uncommitted handoff consumed \(files were not tracked\+clean\)/);
    assert.match(r.context, /Read it now, then delete that file yourself/);
    assert.match(r.context, /★ handoff markdown kept on disk \(\.planning\/phases\/02-x\/\.continue-here\.claimed\.coordinator\.NEW\.md\)/);
    assert.equal(gitOrThrow(['rev-parse', 'HEAD'], { cwd: dir }).trim(), before, 'no commit made');
    assert.ok(fs.existsSync(path.join(dir, '.planning', 'phases', '02-x', '.continue-here.claimed.coordinator.NEW.md')), 'kept for the session to Read');
    assert.ok(!fs.existsSync(path.join(dir, '.planning', 'phases', '02-x', '.continue-here.latest.coordinator.md')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'gsd-resume', 'resumed.json'), 'utf8')).claimed, '.planning/phases/02-x/.continue-here.claimed.coordinator.NEW.md');
  });

  test('no git at all → the whole resume still works (removal only)', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-resume-hook-nogit-'));
    t.after(() => cleanup(dir));
    const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-resume-hook-cfg-'));
    t.after(() => cleanup(cfg));
    fs.mkdirSync(path.join(dir, '.planning', 'phases', '02-x'), { recursive: true });
    fs.mkdirSync(path.join(cfg, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.planning', 'STATE.md'), '---\nstatus: executing\n---\n\n## Current Position\n\n**Status:** Executing Phase 2\n');
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({ autopause: { enabled: true } }));
    fs.writeFileSync(path.join(dir, '.planning', 'HANDOFF.latest.coordinator.json'), JSON.stringify({ session_id: 'OLD', role_id: 'coordinator', phase_dir: '.planning/phases/02-x', next_action: 'go' }));
    fs.writeFileSync(path.join(dir, '.planning', 'phases', '02-x', '.continue-here.latest.coordinator.md'), '# h\n');
    writePending(dir);
    fs.writeFileSync(path.join(cfg, 'sessions', '99999999.json'), JSON.stringify({ sessionId: 'NEW' }));
    const r = run(dir, cfg, { session_id: 'NEW', source: 'clear' });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.context, /^# Automatic resume/);
    assert.match(r.context, /uncommitted handoff consumed \(commit_docs is off\)/);
    assert.match(r.context, /state session-resume: .*record=\.planning\/sessions\/NEW\.json/);
    assert.deepEqual(fs.readdirSync(path.join(dir, '.planning')).filter((n) => n.startsWith('HANDOFF')), []);
    assert.deepEqual(fs.readdirSync(path.join(dir, '.planning', 'phases', '02-x')), []);
  });

  test('autopause.enabled false → listing only, even with a pending record addressed to us', (t) => {
    const { dir, cfg } = makeProject(t);
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({ autopause: { enabled: false } }));
    writePending(dir);
    fs.writeFileSync(path.join(cfg, 'sessions', '99999999.json'), JSON.stringify({ sessionId: 'NEW' }));
    const before = gitOrThrow(['rev-parse', 'HEAD'], { cwd: dir }).trim();
    const r = run(dir, cfg, { session_id: 'NEW', source: 'clear' });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.context, /Not auto-claimed \(autopause\.enabled is false\)/);
    assert.ok(fs.existsSync(path.join(dir, '.planning', 'HANDOFF.latest.coordinator.json')));
    assert.ok(fs.existsSync(path.join(dir, '.claude', 'gsd-resume', 'pending.json')));
    assert.equal(gitOrThrow(['rev-parse', 'HEAD'], { cwd: dir }).trim(), before);
    assert.ok(!fs.existsSync(path.join(dir, '.claude', 'gsd-resume', 'gsd-resume-hook.log')), 'nothing written while disabled');
  });

  test('custom autopause.pending_file is honoured', (t) => {
    const { dir, cfg } = makeProject(t);
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({ autopause: { enabled: true, pending_file: '.claude/autopause/pending.json' } }));
    fs.mkdirSync(path.join(dir, '.claude', 'autopause'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'autopause', 'pending.json'), JSON.stringify({
      version: 1, at: new Date().toISOString(), claude_pid: 99999999, old_sid: 'OLD', role: 'coordinator', role_id: 'coordinator',
    }));
    fs.writeFileSync(path.join(cfg, 'sessions', '99999999.json'), JSON.stringify({ sessionId: 'NEW' }));
    const r = run(dir, cfg, { session_id: 'NEW', source: 'clear' });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.context, /^# Automatic resume/);
    assert.ok(fs.existsSync(path.join(dir, '.claude', 'autopause', 'resumed.json')));
    assert.ok(!fs.existsSync(path.join(dir, '.claude', 'autopause', 'pending.json')));
  });
});
