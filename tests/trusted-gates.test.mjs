// Attacks an agent could use to sneak a violation past the gates, and whether trusted CI stops them.
// trusted-check.sh restores protected paths from the base commit before running the checks, and
// no-suppressions.sh rejects newly added "switch the check off" comments.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { copyTemplate, tempDir, tempRepo, workflowStep, writeFiles } from './helpers.mjs';

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
    'CHECKS=(\n  "src/ lint.sh lint.conf|lint|bash lint.sh"\n  ".|no new suppression comments|bash scripts/no-suppressions.sh"\n)'));
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

// Where SKILL.md installs each template (Python rules go to lint/ in Python projects; here the JS
// rules take that place).
const INSTALL = [
  ['scripts', 'scripts'], ['githooks', '.githooks'], ['lint', 'lint'], ['quality', 'quality'],
  ['github', '.github'], ['claude', '.claude'], ['codex', '.codex'], ['verify', 'verify'], ['AGENTS.md', 'AGENTS.md'],
];

test('the change that adds the full set of gate files passes no-suppressions.sh (it does not flag itself)', () => {
  const { dir, git } = tempRepo({ 'src/app.js': 'export const ok = 1;\n' });
  git('checkout', '-q', '-b', 'setup');
  for (const [from, to] of INSTALL) copyTemplate(from, dir, to);
  const run = command => spawnSync('bash', ['-c', command], { cwd: dir, encoding: 'utf8' });
  const local = run('bash scripts/no-suppressions.sh');
  assert.equal(local.status, 0, `untracked gate files: ${local.stdout}`);
  git('add', '-A');
  git('commit', '-q', '-m', 'add gates', '--no-verify');
  const ci = run('bash scripts/no-suppressions.sh main');
  assert.equal(ci.status, 0, `committed gate files vs base: ${ci.stdout}`);
  writeFiles(dir, { 'src/app.js': 'export const ok = 1; // eslint-disable-line\n' });
  assert.equal(run('bash scripts/no-suppressions.sh main').status, 1, 'other files are still checked');
});

// The PR that introduces the gates: the base branch has none of them.
function bootstrapProject(app = 'export const ok = 1;\n') {
  const { dir, git } = tempRepo({ 'src/app.js': 'export const ok = 1;\n' });
  git('branch', 'base');
  git('checkout', '-q', '-b', 'setup');
  writeFiles(dir, {
    'src/app.js': app,
    'lint.sh': '#!/usr/bin/env bash\nif grep -n "FORBIDDEN" src/*.js; then echo "not allowed"; exit 1; fi\n',
    'quality/protected-paths.txt': 'scripts/\nlint.sh\nquality/protected-paths.txt\n',
  });
  for (const file of ['scripts/check.sh', 'scripts/trusted-check.sh', 'scripts/no-suppressions.sh']) copyTemplate(file, dir);
  const check = join(dir, 'scripts/check.sh');
  writeFileSync(check, readFileSync(check, 'utf8').replace(/CHECKS=\([\s\S]*?\n\)/,
    'CHECKS=(\n  "src/ lint.sh|lint|bash lint.sh"\n  ".|no new suppression comments|bash scripts/no-suppressions.sh"\n)'));
  git('add', '-A');
  git('commit', '-q', '-m', 'add gates', '--no-verify');
  return { dir, git };
}

function runCheckStep(dir, base) {
  const temp = tempDir();
  const summary = join(temp, 'summary.md');
  writeFileSync(summary, '');
  const env = { ...process.env, BASE_SHA: base, RUNNER_TEMP: temp, GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary };
  const result = spawnSync('bash', ['-c', workflowStep('quality.yml', "Checks with the base branch's rules")], { cwd: dir, encoding: 'utf8', env });
  return { ...result, summary: readFileSync(summary, 'utf8') };
}

test('bootstrap: the PR that introduces the gates gets a labelled result, not "exit code 128"', () => {
  const { dir, git } = bootstrapProject();
  const base = git('rev-parse', 'base').trim();
  const clean = runCheckStep(dir, base);
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.doesNotMatch(clean.stderr, /fatal:/);
  assert.match(clean.stdout, /Gate bootstrap: .* introduces the gates/);
  assert.match(clean.stdout, /::warning title=Gate bootstrap::/);
  assert.match(clean.summary, /Gate bootstrap/);

  const bad = bootstrapProject('export const bad = "FORBIDDEN";\n');
  const blocked = runCheckStep(bad.dir, bad.git('rev-parse', 'base').trim());
  assert.equal(blocked.status, 1, 'the gate PR is still checked by its own gate files');
  assert.match(blocked.stdout, /✗ lint/);
});

test('after the gates merge, the same workflow step uses the base copy (no bootstrap)', () => {
  const { dir, git } = project();
  writeFiles(dir, { 'src/app.js': 'export const bad = "FORBIDDEN";\n', 'lint.conf': 'disabled\n' });
  git('add', '-A');
  git('commit', '-q', '-m', 'pr', '--no-verify');
  const result = runCheckStep(dir, git('rev-parse', 'base').trim());
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /Gate bootstrap/);
  assert.match(result.stdout, /NOT used for this run[\s\S]*lint\.conf/);
});

test('loosening an npm script that check.sh calls fools naive CI but not trusted CI; dependency changes still apply', () => {
  const { dir, git } = project();
  writeFiles(dir, { 'app/package.json': JSON.stringify({ name: 'app', private: true, scripts: { lint: 'cd .. && bash lint.sh' } }, null, 2) + '\n' });
  const check = join(dir, 'scripts/check.sh');
  writeFileSync(check, readFileSync(check, 'utf8').replace('"src/ lint.sh lint.conf|lint|bash lint.sh"', '"src/ lint.sh lint.conf app/|lint|cd app && npm run --silent lint"'));
  git('add', '-A');
  git('commit', '-q', '-m', 'lint through an npm script');
  git('branch', '-f', 'base');

  writeFiles(dir, {
    'src/app.js': 'export const ok = 1;\nexport const bad = "FORBIDDEN";\n',
    'app/package.json': JSON.stringify({ name: 'app', private: true, scripts: { lint: 'node -e 0' }, dependencies: { leftpad: '1.0.0' } }, null, 2) + '\n',
  });
  git('add', '-A');
  git('commit', '-q', '-m', 'pr', '--no-verify');
  const run = command => spawnSync('bash', ['-c', command], { cwd: dir, encoding: 'utf8' });
  assert.equal(run('bash scripts/check.sh --all').status, 0, 'naive CI is fooled');
  const trusted = run('git show base:scripts/trusted-check.sh > "${TMPDIR:-/tmp}/tc-$$.sh" && bash "${TMPDIR:-/tmp}/tc-$$.sh" base');
  assert.equal(trusted.status, 1, trusted.stdout + trusted.stderr);
  assert.match(trusted.stdout, /NOT used for this run[\s\S]*app\/package\.json \("scripts" only\)/);
  const pkg = JSON.parse(readFileSync(join(dir, 'app/package.json'), 'utf8'));
  assert.deepEqual(pkg.scripts, { lint: 'cd .. && bash lint.sh' });
  assert.deepEqual(pkg.dependencies, { leftpad: '1.0.0' }, 'dependency changes are not reverted');
});
