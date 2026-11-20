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
  });
  copyTemplate('scripts/check.sh', dir);
  copyTemplate('scripts/stop-gate.sh', dir);
  copyTemplate('githooks/pre-commit', dir, '.githooks/pre-commit');
  const check = join(dir, 'scripts/check.sh');
  writeFileSync(check, readFileSync(check, 'utf8').replace(/CHECKS=\([\s\S]*?\n\)/, 'CHECKS=(\n  "app/|app: value is ok|bash app/test.sh"\n)'));
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
  writeFileSync(check, readFileSync(check, 'utf8').replace('"app/|app: value is ok|bash app/test.sh"',
    '"docs/ app/|app: value is ok|bash app/test.sh"\n  "docs/|docs: tap|bash docs/tap.sh"'));
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
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const blocked = run(dir, 'scripts/stop-gate.sh');
    assert.equal(blocked.status, 2, `attempt ${attempt} should block`);
    assert.match(blocked.stderr, new RegExp(`attempt ${attempt} of 3`));
    assert.match(blocked.stderr, /not ok - value/);
  }
  const explain = run(dir, 'scripts/stop-gate.sh');
  assert.equal(explain.status, 2, 'the 4th stop is blocked once more, asking the agent to explain to the user');
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
