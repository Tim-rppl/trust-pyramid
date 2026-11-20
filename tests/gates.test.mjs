// check.sh, stop-gate.sh and pre-commit behave as documented in references/gates.md.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { TEMPLATES, copyTemplate, tempRepo, writeFiles } from './helpers.mjs';

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

const run = (dir, command, input = '{"stop_hook_active":false}') => spawnSync('bash', ['-c', command], { cwd: dir, encoding: 'utf8', input });

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

test('stop-gate prints JSON on success and blocks with exit 2 on failure, then hands over visibly', () => {
  const { dir } = repoWithChecks();
  const pass = run(dir, 'scripts/stop-gate.sh');
  assert.equal(pass.status, 0);
  assert.deepEqual(JSON.parse(pass.stdout), {});

  writeFiles(dir, { 'app/value.txt': 'broken\n' });
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const blocked = run(dir, 'scripts/stop-gate.sh');
    assert.equal(blocked.status, 2, `attempt ${attempt} should block`);
    assert.match(blocked.stderr, new RegExp(`attempt ${attempt} of 2`));
    assert.match(blocked.stderr, /protected gate file/);
    assert.match(blocked.stderr, /not ok - value/);
  }
  const explain = run(dir, 'scripts/stop-gate.sh');
  assert.equal(explain.status, 2, 'the 3rd stop is blocked once more, asking the agent to explain to the user');
  assert.match(explain.stderr, /Tell the user in plain language/);
  const handedOver = run(dir, 'scripts/stop-gate.sh');
  assert.equal(handedOver.status, 0);
  assert.match(JSON.parse(handedOver.stdout).systemMessage, /human needs to look/);
  const nextRound = run(dir, 'scripts/stop-gate.sh');
  assert.equal(nextRound.status, 2, 'a new turn starts counting again');
});

test('pre-commit blocks a commit whose staged files fail the checks', () => {
  const { dir, git } = repoWithChecks();
  writeFiles(dir, { 'app/value.txt': 'broken\n' });
  git('add', 'app/value.txt');
  const commit = spawnSync('git', ['commit', '-m', 'bad'], { cwd: dir, encoding: 'utf8' });
  assert.notEqual(commit.status, 0);
  assert.match(commit.stdout + commit.stderr, /Commit blocked/);
});

test('install-agent-hooks installs staged hook configs and never overwrites existing ones', () => {
  const { dir } = tempRepo({ 'quality/install/claude-settings.json': '{"hooks":{}}\n', 'quality/install/claude-settings.local.json': '{"permissions":{}}\n', 'quality/install/codex-hooks.json': '{"hooks":{}}\n', '.codex/hooks.json': '{"mine":true}\n' });
  copyTemplate('scripts/install-agent-hooks.sh', dir);
  const result = spawnSync('bash', ['scripts/install-agent-hooks.sh'], { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /installed: \.claude\/settings\.json/);
  assert.match(result.stdout, /installed: \.claude\/settings\.local\.json/);
  assert.match(result.stdout, /exists, not overwritten: \.codex\/hooks\.json/);
  assert.equal(readFileSync(join(dir, '.codex/hooks.json'), 'utf8'), '{"mine":true}\n');
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
  const first = spawnSync('bash', ['-c', 'scripts/stop-gate.sh'], { cwd: dir, encoding: 'utf8', input: '{}', env: { ...process.env, STOP_GATE_MAX_ATTEMPTS: '1' } });
  assert.match(first.stderr, /attempt 1 of 1/);
  const second = spawnSync('bash', ['-c', 'scripts/stop-gate.sh'], { cwd: dir, encoding: 'utf8', input: '{}', env: { ...process.env, STOP_GATE_MAX_ATTEMPTS: '1' } });
  assert.match(second.stderr, /Stop trying to fix them now/);
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
  assert.equal(stop.status, 2);
  assert.doesNotMatch(stop.stderr, /Permission denied/);
  assert.match(stop.stderr, /not ok - value/);
  const trusted = run(dir, 'bash scripts/trusted-check.sh HEAD');
  assert.doesNotMatch(trusted.stdout + trusted.stderr, /Permission denied/);
  assert.match(trusted.stdout, /✓ no new suppression comments/);
});

test('the Stop hook finds the repository from its own location, and fails loudly when it cannot', () => {
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

    // A copy of the script that is not inside any repository must not pass silently.
    copyTemplate('scripts/stop-gate.sh', elsewhere);
    const lost = spawnSync('bash', [join(elsewhere, 'scripts/stop-gate.sh')], { cwd: elsewhere, encoding: 'utf8', input: '{}', env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(elsewhere) } });
    assert.equal(lost.status, 2);
    assert.match(lost.stderr, /stop-gate: cannot find the repository/);
    assert.equal(lost.stdout, '');
  } finally {
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('gate interceptions are logged per gate with rule IDs, and gate-report summarizes them', () => {
  const { dir } = repoWithChecks();
  copyTemplate('scripts/gate-log.sh', dir);
  copyTemplate('scripts/gate-report.mjs', dir);
  const test = join(dir, 'app/test.sh');
  writeFileSync(test, readFileSync(test, 'utf8').replace('echo "not ok - value"', 'echo "not ok - value"\necho "app/x.tsx:4:18: UI text is not translated [Error/project(no-raw-ui-text)]"'));
  writeFiles(dir, { 'app/value.txt': 'broken\n' });
  assert.equal(run(dir, 'bash scripts/stop-gate.sh').status, 2);
  assert.equal(run(dir, 'bash scripts/check.sh').status, 1, 'a manual run is not an interception');
  const summary = join(dir, 'summary.md');
  const ci = spawnSync('bash', ['-c', 'TRUST_GATE=ci bash scripts/check.sh --all'], { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: summary } });
  assert.equal(ci.status, 1);
  assert.match(readFileSync(summary, 'utf8'), /Gate \*\*ci\*\* blocked: app: value is ok \(project\(no-raw-ui-text\)\)/);

  const log = readFileSync(join(dir, '.quality-state/gate-log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(log.map(entry => entry.gate), ['stop-hook', 'ci']);
  assert.deepEqual(log[0].rules, ['project(no-raw-ui-text)']);
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
