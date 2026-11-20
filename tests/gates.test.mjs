// check.sh, stop-gate.sh and pre-commit behave as documented in references/gates.md.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { copyTemplate, tempRepo, writeFiles } from './helpers.mjs';

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
  const { dir } = tempRepo({ 'quality/install/claude-settings.json': '{"hooks":{}}\n', 'quality/install/codex-hooks.json': '{"hooks":{}}\n', '.codex/hooks.json': '{"mine":true}\n' });
  copyTemplate('scripts/install-agent-hooks.sh', dir);
  const result = spawnSync('bash', ['scripts/install-agent-hooks.sh'], { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /installed: \.claude\/settings\.json/);
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
