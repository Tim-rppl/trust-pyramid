// Attacks an agent could use to sneak a violation past the gates, and whether trusted CI stops them.
// trusted-check.sh restores protected paths from the base commit before running the checks, and
// no-suppressions.sh rejects newly added "switch the check off" comments.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { copyTemplate, tempRepo, writeFiles } from './helpers.mjs';

// A tiny project whose only "lint" forbids the word FORBIDDEN in src/, configured by lint.conf.
function project() {
  const { dir, git } = tempRepo({
    'src/app.js': 'export const ok = 1;\n',
    'lint.conf': 'enabled\n',
    'lint.sh': '#!/usr/bin/env bash\n[ "$(cat lint.conf)" = disabled ] && exit 0\nif grep -n "FORBIDDEN" src/*.js | grep -v "lint-ignore"; then echo "not allowed"; exit 1; fi\n',
    'quality/protected-paths.txt': 'scripts/\nlint.sh\nlint.conf\nquality/protected-paths.txt\nquality/allowed-suppressions.txt\n',
  });
  for (const file of ['scripts/check.sh', 'scripts/trusted-check.sh', 'scripts/no-suppressions.sh', 'quality/allowed-suppressions.txt']) copyTemplate(file, dir);
  const check = join(dir, 'scripts/check.sh');
  writeFileSync(check, readFileSync(check, 'utf8').replace(/CHECKS=\([\s\S]*?\n\)/,
    'CHECKS=(\n  "src/ lint.sh lint.conf|lint|bash lint.sh"\n  ".|no new suppression comments|scripts/no-suppressions.sh"\n)'));
  git('add', '-A');
  git('commit', '-q', '-m', 'base with gates');
  git('branch', 'base');
  git('checkout', '-q', '-b', 'pr');
  return { dir, git };
}

function attack(edits) {
  const { dir, git } = project();
  writeFiles(dir, { 'src/app.js': 'export const ok = 1;\nexport const bad = "FORBIDDEN";\n', ...edits });
  git('add', '-A');
  git('commit', '-q', '-m', 'pr', '--no-verify');
  const run = command => spawnSync('bash', ['-c', command], { cwd: dir, encoding: 'utf8' });
  return {
    naive: run('scripts/check.sh --all'),
    trusted: run('git show base:scripts/trusted-check.sh > "${TMPDIR:-/tmp}/tc-$$.sh" && bash "${TMPDIR:-/tmp}/tc-$$.sh" base'),
  };
}

test('control: the violation alone is blocked either way', () => {
  const { naive, trusted } = attack({});
  assert.equal(naive.status, 1);
  assert.equal(trusted.status, 1);
});

test('turning the rule off in its config fools naive CI but not trusted CI', () => {
  const { naive, trusted } = attack({ 'lint.conf': 'disabled\n' });
  assert.equal(naive.status, 0, 'naive CI is fooled');
  assert.equal(trusted.status, 1);
  assert.match(trusted.stdout, /NOT used for this run[\s\S]*lint\.conf/);
});

test('deleting the check from scripts/check.sh fools naive CI but not trusted CI', () => {
  const check = readFileSync(join(project().dir, 'scripts/check.sh'), 'utf8').replace('  "src/ lint.sh lint.conf|lint|bash lint.sh"\n', '');
  const { naive, trusted } = attack({ 'scripts/check.sh': check });
  assert.equal(naive.status, 0, 'naive CI is fooled');
  assert.equal(trusted.status, 1);
});

test('shrinking the protected list in the PR has no effect (the list is read from base)', () => {
  const { trusted } = attack({ 'lint.conf': 'disabled\n', 'quality/protected-paths.txt': 'scripts/\n' });
  assert.equal(trusted.status, 1);
});

test('a newly added suppression comment is rejected; allowed ones need the protected allowlist', () => {
  const { trusted } = attack({ 'src/app.js': 'export const ok = 1;\nexport const bad = "FORBIDDEN"; // lint-ignore eslint-disable-line\n' });
  assert.equal(trusted.status, 1);
  assert.match(trusted.stdout, /new suppression comments[\s\S]*src\/app\.js:2/);
});

test('a clean PR passes, and a PR that changes gate files is flagged but not failed', () => {
  const { dir, git } = project();
  writeFiles(dir, { 'src/app.js': 'export const ok = 2;\n', 'lint.conf': 'enabled\n# stricter soon\n' });
  git('add', '-A');
  git('commit', '-q', '-m', 'pr');
  const result = spawnSync('bash', ['-c', 'git show base:scripts/trusted-check.sh > "${TMPDIR:-/tmp}/tc-$$.sh" && bash "${TMPDIR:-/tmp}/tc-$$.sh" base'], { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /changes protected quality files/);
});
