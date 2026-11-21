// check.sh, stop-gate.sh and pre-commit behave as documented in references/gates.md.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { TEMPLATES, copyTemplate, tempDir, tempRepo, writeFiles } from './helpers.mjs';

function repoWithChecks() {
  const { dir, git } = tempRepo({
    'app/value.txt': 'ok\n',
    // Simulates a test runner: lots of passing noise, then a failure summary.
    'app/test.sh': '#!/usr/bin/env bash\ngrep -qx ok app/value.txt && exit 0\nfor i in $(seq 1 100); do echo "ok $i passing"; done\necho "failing tests:"\necho "not ok - value"\nexit 1\n',
    'app/slow.sh': '#!/usr/bin/env bash\n[ -f app/slow-broken ] && { echo "slow suite failed"; exit 1; }\nexit 0\n',
  });
  copyTemplate('scripts/check.sh', dir);
  copyTemplate('scripts/stop-gate.sh', dir);
  copyTemplate('githooks/pre-commit', dir, '.githooks/pre-commit');
  const check = join(dir, 'scripts/check.sh');
  writeFileSync(check, readFileSync(check, 'utf8').replace(/CHECKS=\([\s\S]*?\n\)/, 'CHECKS=(\n  "app/|app: value is ok|bash app/test.sh|fast"\n  "app/|app: slow suite|bash app/slow.sh"\n)'));
  git('add', '-A');
  git('commit', '-q', '-m', 'gates');
  git('config', 'core.hooksPath', '.githooks');
  return { dir, git };
}

// What the host sends a Stop hook on stdin (Claude Code and Codex): only these runs count as attempts.
const hookInput = (fields = {}) => JSON.stringify({ hook_event_name: 'Stop', session_id: 's1', stop_hook_active: false, ...fields });
const run = (dir, command, input = hookInput()) => spawnSync('bash', ['-c', command], { cwd: dir, encoding: 'utf8', input });
// A host-started stop-gate.sh blocks with {"decision": "block", "reason"} on stdout and exit 0, never exit 2:
// Claude Code reads exit 2 with "No such file or directory" in stderr as a missing script (#38).
function verdict(result) {
  assert.equal(result.status, 0, `a host run always exits 0: ${result.stderr}`);
  const out = JSON.parse(result.stdout);
  return { blocked: out.decision === 'block', reason: out.reason ?? '', message: out.systemMessage };
}

test('check.sh skips untouched packages and reports only the failure summary', () => {
  const { dir } = repoWithChecks();
  assert.equal(run(dir, 'scripts/check.sh').stdout, '');
  writeFiles(dir, { 'app/value.txt': 'broken\n' });
  const result = run(dir, 'scripts/check.sh');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /✗ app: value is ok/);
  assert.match(result.stdout, /not ok - value/);
  assert.doesNotMatch(result.stdout, /ok 50 passing/, 'passing noise must be trimmed');
});

test('check.sh supports several path prefixes per check and summarizes TAP output', () => {
  const { dir } = repoWithChecks();
  const check = join(dir, 'scripts/check.sh');
  writeFileSync(check, readFileSync(check, 'utf8').replace('"app/|app: value is ok|bash app/test.sh|fast"',
    '"docs/ app/|app: value is ok|bash app/test.sh|fast"\n  "docs/|docs: tap|bash docs/tap.sh"'));
  writeFiles(dir, { 'docs/tap.sh': 'for i in $(seq 1 50); do echo "ok $i - fine"; done\necho "not ok 51 - broken thing"\necho "  ---"\necho "  error: expected 1 got 2"\nexit 1\n' });
  const result = run(dir, 'scripts/check.sh');
  assert.match(result.stdout, /✓ app: value is ok/, 'second prefix (docs/) must trigger the app check');
  assert.match(result.stdout, /not ok 51 - broken thing/);
  assert.match(result.stdout, /expected 1 got 2/);
  assert.doesNotMatch(result.stdout, /ok 20 - fine/);
});

test('stop-gate prints JSON on success and blocks with a JSON decision on failure, then hands over visibly', () => {
  const { dir } = repoWithChecks();
  const pass = run(dir, 'scripts/stop-gate.sh');
  assert.equal(pass.status, 0);
  assert.deepEqual(JSON.parse(pass.stdout), {});

  writeFiles(dir, { 'app/value.txt': 'broken\n' });
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const blocked = run(dir, 'scripts/stop-gate.sh');
    assert.equal(blocked.stderr, '', 'nothing on stderr for the host to misread');
    const { blocked: isBlocked, reason } = verdict(blocked);
    assert.ok(isBlocked, `attempt ${attempt} should block`);
    assert.match(reason, new RegExp(`^Checks failed \\(attempt ${attempt} of 2\\)`));
    assert.match(reason, /protected gate file/);
    assert.match(reason, /not ok - value/);
  }
  const explain = verdict(run(dir, 'scripts/stop-gate.sh'));
  assert.ok(explain.blocked, 'the 3rd stop is blocked once more, asking the agent to explain to the user');
  assert.match(explain.reason, /Tell the user in plain language/);
  const handedOver = run(dir, 'scripts/stop-gate.sh');
  assert.equal(handedOver.status, 0);
  assert.match(JSON.parse(handedOver.stdout).systemMessage, /human needs to look/);
  assert.match(verdict(run(dir, 'scripts/stop-gate.sh')).reason, /attempt 1 of 2/, 'a new turn starts counting again');
});

test('a check that never exits is stopped at its time limit, with the children that hold the output', () => {
  const { dir } = repoWithChecks();
  const check = join(dir, 'scripts/check.sh');
  writeFileSync(check, readFileSync(check, 'utf8').replace(/CHECKS=\([\s\S]*?\n\)/,
    'CHECKS=(\n  ".|hangs (background child keeps the pipe open)|bash app/hang.sh|fast,timeout=2"\n  ".|quick|true|fast"\n  ".|slow default|bash app/hang.sh"\n)'));
  writeFiles(dir, { 'app/hang.sh': '#!/usr/bin/env bash\necho "1 test failed"\nsleep 300 &\nsleep 300\n' });
  const started = Date.now();
  const fast = run(dir, 'scripts/check.sh --fast --all');
  assert.ok(Date.now() - started < 30000, 'the gate does not wait for the hung process');
  assert.equal(fast.status, 1);
  assert.match(fast.stdout, /✗ hangs \(background child keeps the pipe open\) \(timed out after 2s\)/);
  assert.match(fast.stdout, /1 test failed[\s\S]*open socket, server or timer/);
  assert.match(fast.stdout, /✓ quick/, 'a "fast,timeout=N" check still counts as fast; the others run');
  assert.doesNotMatch(fast.stdout, /slow default/);

  const env = spawnSync('bash', ['-c', 'scripts/check.sh --all'], { cwd: dir, encoding: 'utf8', env: { ...process.env, TRUST_CHECK_TIMEOUT: '2' } });
  assert.match(env.stdout, /✗ slow default \(timed out after 2s\)/, 'TRUST_CHECK_TIMEOUT sets the default limit');
});

test('pre-commit blocks a commit whose staged files fail the checks', () => {
  const { dir, git } = repoWithChecks();
  writeFiles(dir, { 'app/value.txt': 'broken\n' });
  git('add', 'app/value.txt');
  const commit = spawnSync('git', ['commit', '-m', 'bad'], { cwd: dir, encoding: 'utf8' });
  assert.notEqual(commit.status, 0);
  assert.match(commit.stdout + commit.stderr, /Commit blocked/);
});

// A project that already has its own .claude/settings.json and .codex/hooks.json (most real ones do).
function repoWithStagedHooks() {
  const { dir, git } = repoWithChecks();
  git('config', '--unset', 'core.hooksPath');
  copyTemplate('scripts/install-agent-hooks.sh', dir);
  copyTemplate('scripts/hook-status.sh', dir);
  copyTemplate('claude/settings.json', dir, 'quality/install/claude-settings.json');
  copyTemplate('claude/settings.local.json', dir, 'quality/install/claude-settings.local.json');
  copyTemplate('codex/hooks.json', dir, 'quality/install/codex-hooks.json');
  writeFiles(dir, {
    '.claude/settings.json': JSON.stringify({ model: 'mine', permissions: { allow: ['Bash(npm test)'] }, hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }, null, 2),
    '.codex/hooks.json': JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } }, null, 2),
  });
  const home = tempDir(); // never read the real ~/.claude/settings.json
  const sh = (command, extra = {}) => spawnSync('bash', ['-c', command], { cwd: dir, encoding: 'utf8', input: '', env: { ...process.env, HOME: home, ...extra } });
  return { dir, git, home, sh };
}
const json = (dir, path) => JSON.parse(readFileSync(join(dir, path), 'utf8'));
const stopCommands = config => (config.hooks?.Stop ?? []).flatMap(group => group.hooks.map(hook => hook.command));

test('hook-status reports a Stop hook that is staged but not enabled', () => {
  const { sh } = repoWithStagedHooks();
  const status = sh('bash scripts/hook-status.sh');
  assert.equal(status.status, 1);
  assert.match(status.stdout, /Claude Code Stop hook is NOT enabled/);
  assert.match(status.stdout, /Codex Stop hook is NOT enabled/);
  assert.match(status.stdout, /pre-commit is NOT enabled/);
  assert.match(status.stdout, /bash scripts\/install-agent-hooks\.sh/);
});

test('install-agent-hooks merges into existing configs, keeps what is there, and is idempotent', () => {
  const { dir, sh } = repoWithStagedHooks();
  const install = sh('bash scripts/install-agent-hooks.sh --yes');
  assert.equal(install.status, 0, install.stdout + install.stderr);
  assert.match(install.stdout, /All gates for this clone are enabled/);

  const claude = json(dir, '.claude/settings.json');
  assert.equal(claude.model, 'mine');
  assert.deepEqual(claude.permissions.allow, ['Bash(npm test)']);
  assert.equal(claude.hooks.PostToolUse[0].hooks[0].command, 'echo mine');
  assert.deepEqual(stopCommands(claude), ['bash "$CLAUDE_PROJECT_DIR/scripts/stop-gate.sh"']);
  assert.ok(json(dir, '.claude/settings.local.json').permissions.deny.includes('Edit(/scripts/**)'));
  const codex = json(dir, '.codex/hooks.json');
  assert.equal(codex.hooks.SessionStart[0].hooks[0].command, 'echo hi');
  assert.equal(stopCommands(codex).length, 1);
  assert.equal(json(dir, '.claude/settings.json.bak').model, 'mine', 'the previous file is kept');
  assert.equal(sh('git config core.hooksPath').stdout.trim(), '.githooks');

  const again = sh('bash scripts/install-agent-hooks.sh --yes');
  assert.equal(again.status, 0);
  assert.match(again.stdout, /already enabled, nothing to change/);
  assert.equal(stopCommands(json(dir, '.claude/settings.json')).length, 1, 'no duplicate Stop hook');
});

test('install-agent-hooks does not register the Stop hook in both Claude settings files', () => {
  const { dir, sh } = repoWithStagedHooks();
  writeFiles(dir, { '.claude/settings.local.json': JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'bash "$CLAUDE_PROJECT_DIR/scripts/stop-gate.sh"' }] }] } }) });
  const install = sh('bash scripts/install-agent-hooks.sh --yes');
  assert.equal(install.status, 0, install.stdout + install.stderr);
  assert.match(install.stdout, /already registered in \.claude\/settings\.local\.json, so it is not added here too/);
  assert.deepEqual(stopCommands(json(dir, '.claude/settings.json')), [], 'the shared file does not get a second copy');
  assert.equal(stopCommands(json(dir, '.claude/settings.local.json')).length, 1);
  assert.match(sh('bash scripts/hook-status.sh').stdout, /Claude Code Stop hook: registered in \.claude\/settings\.local\.json/);
});

test('install-agent-hooks changes nothing without a yes, and an existing stop-gate entry is kept', () => {
  const { dir, sh } = repoWithStagedHooks();
  const before = readFileSync(join(dir, '.claude/settings.json'), 'utf8');
  const noTerminal = sh('bash scripts/install-agent-hooks.sh');
  assert.equal(noTerminal.status, 1);
  assert.match(noTerminal.stdout, /\+ hooks\.Stop: bash "\$CLAUDE_PROJECT_DIR\/scripts\/stop-gate\.sh"/, 'shows what it would add');
  assert.match(noTerminal.stdout, /Not applied: no terminal to ask/);
  assert.equal(readFileSync(join(dir, '.claude/settings.json'), 'utf8'), before);

  writeFiles(dir, { '.claude/settings.json': JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'scripts/stop-gate.sh' }] }] } }) });
  const install = sh('bash scripts/install-agent-hooks.sh --yes');
  assert.match(install.stdout, /already runs stop-gate \(kept as is\): scripts\/stop-gate\.sh/);
  assert.deepEqual(stopCommands(json(dir, '.claude/settings.json')), ['scripts/stop-gate.sh']);
});

test('hook-status flags disableAllHooks and shows when the Stop hook last ran', () => {
  const { dir, home, sh } = repoWithStagedHooks();
  sh('bash scripts/install-agent-hooks.sh --yes');
  assert.match(sh('bash scripts/hook-status.sh').stdout, /has not run yet in this clone/);
  sh('bash scripts/stop-gate.sh');
  assert.match(sh('bash scripts/hook-status.sh').stdout, /has not run yet in this clone/, 'a manual run is no proof that the host runs the hook');
  spawnSync('bash', ['scripts/stop-gate.sh'], { cwd: dir, encoding: 'utf8', input: hookInput(), env: { ...process.env, HOME: home } });
  assert.match(sh('bash scripts/hook-status.sh').stdout, /Stop hook last ran: \d{4}-\d\d-\d\d/);

  writeFiles(home, { '.claude/settings.json': '{"disableAllHooks": true}' });
  const off = sh('bash scripts/hook-status.sh');
  assert.equal(off.status, 1);
  assert.match(off.stdout, /disableAllHooks.*runs no hooks at all/);
  assert.ok(dir);
});

test('a user who never ran the installer is still reminded: AGENTS.md and the npm prepare script', () => {
  const agents = readFileSync(join(TEMPLATES, 'AGENTS.md'), 'utf8');
  assert.match(agents.split('\n').slice(0, 4).join('\n'), /run `bash scripts\/hook-status\.sh`.*install-agent-hooks\.sh/s, 'first rule in AGENTS.md');
  const gates = readFileSync(join(TEMPLATES, '..', 'references', 'gates.md'), 'utf8');
  const prepare = gates.match(/"prepare": "([^"]+)"/)[1];
  const { dir, sh } = repoWithStagedHooks();
  writeFiles(dir, { 'package.json': JSON.stringify({ name: 'x', private: true, scripts: { prepare } }) });
  const install = sh('npm install --no-audit --no-fund');
  assert.equal(install.status, 0, install.stderr);
  assert.equal(sh('git config core.hooksPath').stdout.trim(), '.githooks', 'npm install enables pre-commit');
  const outside = tempDir();
  writeFiles(outside, { 'package.json': JSON.stringify({ name: 'y', private: true, scripts: { prepare } }) });
  const noGit = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: outside, encoding: 'utf8', shell: process.platform === 'win32', env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(outside) } });
  assert.equal(noGit.status, 0, 'an install outside a git checkout still succeeds');
});

test('pre-commit reminds on every commit while the Stop hook is off, without blocking', () => {
  const { dir, git, sh } = repoWithStagedHooks();
  git('config', 'core.hooksPath', '.githooks');
  writeFiles(dir, { 'notes.txt': 'x\n' });
  const commit = sh('git add notes.txt && git commit -q -m notes');
  assert.equal(commit.status, 0, commit.stderr);
  assert.match(commit.stderr, /Claude Code Stop hook is NOT enabled/);

  sh('bash scripts/install-agent-hooks.sh --yes');
  writeFiles(dir, { 'notes.txt': 'y\n' });
  const quiet = sh('git add notes.txt && git commit -q -m notes2');
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.doesNotMatch(quiet.stderr, /NOT enabled/);
});

test('the Stop hook runs only fast checks; pre-commit and CI run everything', () => {
  const { dir } = repoWithChecks();
  writeFiles(dir, { 'app/slow-broken': 'x' });
  const stop = run(dir, 'scripts/stop-gate.sh');
  assert.equal(stop.status, 0, 'a slow-check failure does not block the end of a turn');
  const full = run(dir, 'scripts/check.sh --all');
  assert.equal(full.status, 1);
  assert.match(full.stdout, /✗ app: slow suite/);
  const fast = run(dir, 'scripts/check.sh --fast --all');
  assert.equal(fast.status, 0);
  assert.doesNotMatch(fast.stdout, /slow suite/);
});

test('STOP_GATE_MAX_ATTEMPTS changes the cap', () => {
  const { dir } = repoWithChecks();
  writeFiles(dir, { 'app/value.txt': 'broken\n' });
  const first = spawnSync('bash', ['-c', 'scripts/stop-gate.sh'], { cwd: dir, encoding: 'utf8', input: hookInput(), env: { ...process.env, STOP_GATE_MAX_ATTEMPTS: '1' } });
  assert.match(verdict(first).reason, /attempt 1 of 1/);
  const second = spawnSync('bash', ['-c', 'scripts/stop-gate.sh'], { cwd: dir, encoding: 'utf8', input: hookInput(), env: { ...process.env, STOP_GATE_MAX_ATTEMPTS: '1' } });
  assert.match(verdict(second).reason, /Stop trying to fix them now/);
});

test('gates still run when the scripts were committed without the executable bit (setup from Windows)', () => {
  const { dir, git } = repoWithChecks();
  const check = join(dir, 'scripts/check.sh');
  writeFileSync(check, readFileSync(check, 'utf8').replace('"app/|app: slow suite|bash app/slow.sh"',
    '"app/|app: slow suite|bash app/slow.sh"\n  ".|no new suppression comments|bash scripts/no-suppressions.sh|fast"'));
  copyTemplate('scripts/no-suppressions.sh', dir);
  copyTemplate('scripts/trusted-check.sh', dir);
  writeFiles(dir, { 'quality/protected-paths.txt': 'scripts/\n' });
  const scripts = ['scripts/check.sh', 'scripts/stop-gate.sh', 'scripts/no-suppressions.sh', 'scripts/trusted-check.sh'];
  for (const path of scripts) chmodSync(join(dir, path), 0o644);
  git('add', '-A');
  git('update-index', '--chmod=-x', ...scripts);
  git('commit', '-q', '-m', 'gates as 100644', '--no-verify');
  assert.match(git('ls-files', '-s', 'scripts/check.sh'), /^100644 /);

  assert.deepEqual(JSON.parse(run(dir, 'bash scripts/stop-gate.sh').stdout), {});
  writeFiles(dir, { 'app/value.txt': 'broken\n' });
  const stop = run(dir, 'bash scripts/stop-gate.sh');
  assert.doesNotMatch(stop.stderr, /Permission denied/);
  assert.match(verdict(stop).reason, /not ok - value/);
  const trusted = run(dir, 'bash scripts/trusted-check.sh HEAD');
  assert.doesNotMatch(trusted.stdout + trusted.stderr, /Permission denied/);
  assert.match(trusted.stdout, /✓ no new suppression comments/);
});

test('the Stop hook finds the repository from its own location, and hands over visibly when it cannot', () => {
  const { dir } = repoWithChecks();
  const elsewhere = mkdtempSync(join(tmpdir(), 'trust-pyramid-cwd-'));
  try {
    // The registered command, run from a directory outside the repository (the agent changed directory).
    const { command } = JSON.parse(readFileSync(join(TEMPLATES, 'claude/settings.json'), 'utf8')).hooks.Stop[0].hooks[0];
    assert.equal(command, 'bash "$CLAUDE_PROJECT_DIR/scripts/stop-gate.sh"');
    const hook = () => spawnSync('bash', ['-c', command], { cwd: elsewhere, encoding: 'utf8', input: '{}', env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
    assert.deepEqual(JSON.parse(hook().stdout), {});
    writeFiles(dir, { 'app/value.txt': 'broken\n' });
    const blocked = hook();
    assert.equal(blocked.status, 2, 'checks must run even though the hook started outside the repository');
    assert.match(blocked.stderr, /not ok - value/);

    // A copy of the script that is not inside any repository must not pass silently, and must not block:
    // exit 2 would loop, because the agent cannot fix a missing repository.
    copyTemplate('scripts/stop-gate.sh', elsewhere);
    const lost = spawnSync('bash', [join(elsewhere, 'scripts/stop-gate.sh')], { cwd: elsewhere, encoding: 'utf8', input: '{}', env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(elsewhere) } });
    assert.equal(lost.status, 0);
    assert.match(lost.stderr, /stop-gate: cannot find the repository/);
    assert.match(JSON.parse(lost.stdout).systemMessage, /cannot find the repository.*checks did not run/);
  } finally {
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('the Codex Stop hook command works from a subdirectory and hands over visibly outside a repository', () => {
  const { dir } = repoWithChecks();
  const { command } = JSON.parse(readFileSync(join(TEMPLATES, 'codex/hooks.json'), 'utf8')).hooks.Stop[0].hooks[0];
  const outside = mkdtempSync(join(tmpdir(), 'trust-pyramid-cwd-'));
  try {
    const hook = cwd => spawnSync('bash', ['-c', command], { cwd, encoding: 'utf8', input: '{}', env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(outside) } });
    const sub = join(dir, 'app');
    assert.deepEqual(JSON.parse(hook(sub).stdout), {}, 'run from a subdirectory, the gate runs and passes');
    writeFiles(dir, { 'app/value.txt': 'broken\n' });
    const blocked = hook(sub);
    assert.equal(blocked.status, 2);
    assert.match(blocked.stderr, /not ok - value/);

    const lost = hook(outside);
    assert.equal(lost.status, 0, 'outside a repository it must not fail with exit 127 or block');
    assert.match(JSON.parse(lost.stdout).systemMessage, /quality checks did not run/);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('the Stop hook checks the worktrees this session works in, not other sessions\' worktrees', () => {
  const { dir, git } = repoWithChecks();
  const base = tempDir();
  const mine = join(base, 'agent work', 'mine'); // a space in the path, as in real folders
  const other = join(base, 'other');
  git('worktree', 'add', '-q', '-b', 'fix/mine', mine);
  git('worktree', 'add', '-q', '-b', 'fix/other', other);
  const real = path => spawnSync('git', ['-C', path, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim();
  const transcript = join(base, 'session.jsonl');
  writeFileSync(transcript, JSON.stringify({ type: 'tool_use', input: { file_path: `${real(mine)}/app/value.txt` } }) + '\n');
  const hook = (fields = {}, env = {}) => spawnSync('bash', [join(dir, 'scripts/stop-gate.sh')], { cwd: dir, encoding: 'utf8', input: hookInput({ cwd: dir, transcript_path: transcript, ...fields }), env: { ...process.env, ...env } });

  writeFiles(other, { 'app/value.txt': 'broken\n' });
  assert.deepEqual(JSON.parse(hook().stdout), {}, 'another session\'s broken worktree does not block this session');

  writeFiles(mine, { 'app/value.txt': 'broken\n' });
  const blocked = verdict(hook());
  assert.ok(blocked.blocked, 'the worktree in this session\'s transcript is checked');
  assert.match(blocked.reason, /In the git worktree .*agent work\/mine \(uncommitted changes there\):\n✗ app: value is ok/);
  assert.doesNotMatch(blocked.reason, /In the git worktree .*\/other /);

  writeFileSync(transcript, '');
  assert.ok(verdict(hook({ session_id: 's2', cwd: mine })).blocked, 'the worktree containing the hook cwd is checked');
  assert.ok(!verdict(hook({ session_id: 's3' })).blocked, 'neither in the transcript nor the cwd: not checked');
  const all = verdict(hook({ session_id: 's4' }, { STOP_GATE_WORKTREES: 'all' }));
  assert.match(all.reason, /agent work\/mine[^]*\/other \(uncommitted/, 'STOP_GATE_WORKTREES=all checks every worktree');
  assert.match(verdict(hook({ session_id: 's6' }, { STOP_GATE_WORKTREES: '1' })).reason, /\/other \(uncommitted/, '1 means all, as before 0.4.3');
  const unknown = verdict(hook({ session_id: 's7' }, { STOP_GATE_WORKTREES: 'mine' }));
  assert.match(unknown.reason, /^STOP_GATE_WORKTREES=mine is not session, all or none, so every worktree was checked/);
  assert.ok(!verdict(hook({ session_id: 's5', cwd: mine }, { STOP_GATE_WORKTREES: 'none' })).blocked);
});

test('manual stop-gate runs do not use up attempts; attempts are counted per session', () => {
  const { dir } = repoWithChecks();
  writeFiles(dir, { 'app/value.txt': 'broken\n' });
  const manual = run(dir, 'bash scripts/stop-gate.sh', '{}');
  assert.equal(manual.status, 2);
  assert.match(manual.stderr, /Manual run: no Stop hook input, so this does not count/);
  run(dir, 'bash scripts/stop-gate.sh', '');
  assert.match(verdict(run(dir, 'bash scripts/stop-gate.sh')).reason, /attempt 1 of 2/, 'the first real Stop is attempt 1');
  assert.match(verdict(run(dir, 'bash scripts/stop-gate.sh')).reason, /attempt 2 of 2/);
  assert.match(verdict(run(dir, 'bash scripts/stop-gate.sh', hookInput({ session_id: 's2' }))).reason, /attempt 1 of 2/, 'a new session starts again');
});

test('interceptions in a linked worktree are logged in the main checkout, with the worktree', () => {
  const { dir, git } = repoWithChecks();
  copyTemplate('scripts/gate-log.sh', dir);
  git('add', '-A');
  git('commit', '-q', '-m', 'gate log', '--no-verify');
  const worktree = join(tempDir(), 'wt');
  git('worktree', 'add', '-q', '-b', 'fix/x', worktree);
  writeFiles(worktree, { 'app/value.txt': 'broken\n' });
  assert.equal(run(worktree, 'TRUST_GATE=pre-commit bash scripts/check.sh').status, 1);
  assert.ok(!existsSync(join(worktree, '.quality-state/gate-log.jsonl')), 'nothing is left in the worktree');
  const [entry] = readFileSync(join(dir, '.quality-state/gate-log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(entry.gate, 'pre-commit');
  assert.equal(entry.check, 'app: value is ok');
  assert.match(entry.worktree, /\/wt$/);
});

test('hook-status in a linked worktree reads the main checkout\'s hook settings and says what covers it', () => {
  const { dir, git } = repoWithStagedHooks();
  const home = tempDir();
  const sh = (cwd, command) => spawnSync('bash', ['-c', command], { cwd, encoding: 'utf8', input: '', env: { ...process.env, HOME: home } });
  sh(dir, 'bash scripts/install-agent-hooks.sh --yes');
  git('add', '-A');
  git('commit', '-q', '-m', 'hooks staged', '--no-verify');
  const worktree = join(tempDir(), 'wt two');
  git('worktree', 'add', '-q', '-b', 'rule/x', worktree);
  const status = sh(worktree, 'bash scripts/hook-status.sh');
  assert.match(status.stdout, /This is a linked git worktree of /);
  assert.match(status.stdout, /✓ Claude Code Stop hook: registered in .*\.claude\/settings\.json/);
  assert.doesNotMatch(status.stdout, /Claude Code Stop hook is NOT enabled/);
});

test('gate interceptions are logged per gate with rule IDs, and gate-report summarizes them', () => {
  const { dir } = repoWithChecks();
  copyTemplate('scripts/gate-log.sh', dir);
  copyTemplate('scripts/gate-report.mjs', dir);
  const test = join(dir, 'app/test.sh');
  writeFileSync(test, readFileSync(test, 'utf8').replace('echo "not ok - value"', 'echo "not ok - value"\necho "app/x.tsx:4:18: UI text is not translated. Use t(key) and var(--color-text) [Error/project(no-raw-ui-text)]"\necho "  x eslint(no-unused-vars): expected String(value) to be used"\necho "app/y.py:3: TP001 read env vars in config.py, not via os.environ(KEY)"\necho "Dates use ISO8601 strings"'));
  writeFiles(dir, { 'app/value.txt': 'broken\n' });
  assert.ok(verdict(run(dir, 'bash scripts/stop-gate.sh')).blocked);
  assert.equal(run(dir, 'bash scripts/check.sh').status, 1, 'a manual run is not an interception');
  const summary = join(dir, 'summary.md');
  const ci = spawnSync('bash', ['-c', 'TRUST_GATE=ci bash scripts/check.sh --all'], { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: summary } });
  assert.equal(ci.status, 1);
  assert.match(readFileSync(summary, 'utf8'), /Gate \*\*ci\*\* blocked: app: value is ok \(TP001 eslint\(no-unused-vars\) project\(no-raw-ui-text\)\)/);

  const log = readFileSync(join(dir, '.quality-state/gate-log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(log.map(entry => entry.gate), ['stop-hook', 'ci']);
  assert.deepEqual(log[0].rules, ['TP001', 'eslint(no-unused-vars)', 'project(no-raw-ui-text)'], 'code quoted in messages is not a rule ID');
  assert.equal(log[0].check, 'app: value is ok');
  assert.match(log[0].date, /^\d{4}-\d{2}-\d{2}T/);

  const report = run(dir, 'node scripts/gate-report.mjs --rules "project(no-raw-ui-text),project(no-timing-patch)"');
  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stdout, /Blocks per week\n\s+\d{4}-W\d{2}\s+2\s+stop-hook 1, ci 1/);
  assert.match(report.stdout, /2\s+project\(no-raw-ui-text\)/);
  assert.match(report.stdout, /Never fired: project\(no-timing-patch\)/);
});

test('gate-report flags rules that keep coming back across weeks', async () => {
  const { summarize, isoWeek } = await import(pathToFileURL(join(TEMPLATES, 'scripts/gate-report.mjs')).href);
  assert.equal(isoWeek(new Date('2026-11-21T10:00:00Z')), '2026-W47');
  assert.equal(isoWeek(new Date('2027-01-01T10:00:00Z')), '2026-W53');
  const report = summarize([
    { date: '2026-11-16T09:00:00Z', gate: 'pre-commit', check: 'lint', rules: ['a(x)'] },
    { date: '2026-11-24T09:00:00Z', gate: 'ci', check: 'lint', rules: ['a(x)', 'b(y)'] },
    { date: '2026-11-24T10:00:00Z', gate: 'stop-hook', check: 'unit tests', rules: [] },
  ], ['a(x)', 'c(z)']);
  assert.deepEqual(report.repeated, ['a(x)']);
  assert.deepEqual(report.neverFired, ['c(z)']);
  assert.ok(report.rules.some(rule => rule.rule === '(check) unit tests'), 'failures without a rule ID are counted per check');
});

test('the first failed Stop of a session blocks, whatever the checks print (#38)', () => {
  const { dir } = repoWithChecks();
  const test = join(dir, 'app/test.sh');
  // Output the host could misread, and text that needs JSON escaping.
  writeFileSync(test, readFileSync(test, 'utf8').replace('echo "not ok - value"',
    'echo "not ok - value"\necho "cat: fixtures/x.json: No such file or directory"\nprintf \'quote " backslash \\\\ tab\\t \\033[31mred\\033[0m 中文\\n\''));
  writeFiles(dir, { 'app/value.txt': 'broken\n' });
  assert.ok(!existsSync(join(dir, '.quality-state/stop-gate-count')), 'no counter yet: the first Stop of the session');
  const first = run(dir, 'bash scripts/stop-gate.sh');
  assert.equal(first.stderr, '');
  const { blocked, reason } = verdict(first);
  assert.ok(blocked);
  assert.match(reason, /^Checks failed \(attempt 1 of 2\)/);
  assert.match(reason, /No such file or directory/);
  assert.match(reason, /quote " backslash \\ tab\t red 中文/, 'escaped as JSON, colour codes removed');
});

test('session worktrees are matched however the path is spelled, and only as a whole path (#39)', () => {
  const { dir, git } = repoWithChecks();
  const base = tempDir();
  const wt = join(base, 'wt');
  git('worktree', 'add', '-q', '-b', 'fix/wt', wt);
  const real = spawnSync('git', ['-C', wt, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim();
  writeFiles(wt, { 'app/value.txt': 'broken\n' });
  const transcript = join(base, 'session.jsonl');
  const hook = (mention, session) => {
    writeFileSync(transcript, JSON.stringify({ type: 'tool_use', input: { command: `cd ${mention} && ls` } }) + '\n');
    return verdict(spawnSync('bash', [join(dir, 'scripts/stop-gate.sh')], { cwd: dir, encoding: 'utf8', input: hookInput({ session_id: session, cwd: dir, transcript_path: transcript }) }));
  };
  assert.ok(!hook(`${real}-feature/app/x.ts`, 'a').blocked, 'a longer path that starts with the worktree path is another directory');
  assert.ok(!hook(`${real}2`, 'b').blocked);
  assert.ok(hook(`${real}/app`, 'c').blocked);
  assert.ok(hook(real.toUpperCase(), 'd').blocked, 'letter case does not matter');
  assert.ok(hook(real.replaceAll('/', '\\'), 'e').blocked, 'backslashes, as Windows tools write them');
  const drive = /^([A-Za-z]):\/(.*)$/.exec(real);
  if (drive) assert.ok(hook(`/${drive[1].toLowerCase()}/${drive[2]}`.toLowerCase(), 'f').blocked, 'the Git Bash form /c/...');
});

test('missing dependencies stop the checks with "setup needed", and do not use up fix attempts (#40)', () => {
  const { dir, git } = repoWithChecks();
  const check = join(dir, 'scripts/check.sh');
  writeFileSync(check, readFileSync(check, 'utf8').replace(/SETUP=\([\s\S]*?\n\)/, 'SETUP=(\n  "deps/installed|mkdir -p deps && touch deps/installed"\n)'));
  git('add', '-A');
  git('commit', '-q', '-m', 'setup list', '--no-verify');
  writeFiles(dir, { 'app/value.txt': 'broken\n' });

  const plain = run(dir, 'bash scripts/check.sh');
  assert.equal(plain.status, 3);
  assert.match(plain.stdout, /^setup needed in .*no check ran \(not a problem in the change\)/);
  assert.match(plain.stdout, /missing deps\/installed {2}\(installed by: mkdir -p deps && touch deps\/installed\)/);
  assert.doesNotMatch(plain.stdout, /✗ app/);

  for (let stop = 1; stop <= 2; stop += 1) {
    const { blocked, reason } = verdict(run(dir, 'bash scripts/stop-gate.sh'));
    assert.ok(blocked);
    assert.match(reason, /^Setup needed before the checks can run\. This is not a problem in your change and does not use up a fix attempt/);
  }
  assert.match(verdict(run(dir, 'bash scripts/stop-gate.sh')).message, /dependencies are still missing/, 'no endless loop when installing fails');

  const setup = run(dir, 'bash scripts/check.sh --setup');
  assert.equal(setup.status, 0, setup.stdout);
  assert.match(setup.stdout, /✓ dependencies installed/);
  assert.match(verdict(run(dir, 'bash scripts/stop-gate.sh')).reason, /^Checks failed \(attempt 1 of 2\)/, 'setup stops did not count');
});

test('check.sh names the test suites it does not run, except in the fast Stop hook run (#41)', () => {
  const { dir } = repoWithChecks();
  const check = join(dir, 'scripts/check.sh');
  writeFileSync(check, readFileSync(check, 'utf8').replace(/NOT_RUN=\([\s\S]*?\n\)/, 'NOT_RUN=(\n  "functions: emulator tests|needs the Firebase emulator; CI runs them"\n)'));
  const all = run(dir, 'bash scripts/check.sh --all');
  assert.equal(all.status, 0);
  assert.match(all.stdout, /✓ app: slow suite\n• not run here: functions: emulator tests \(needs the Firebase emulator; CI runs them\)/);
  assert.doesNotMatch(run(dir, 'bash scripts/check.sh --fast --all').stdout, /not run here/);
});
