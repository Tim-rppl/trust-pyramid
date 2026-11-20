import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { ROOT, SKILL, copyTemplate, tempRepo } from './helpers.mjs';

// Normalize line endings: a Windows checkout without .gitattributes would have CRLF here.
const skillMd = readFileSync(join(SKILL, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
const frontmatter = Object.fromEntries(skillMd.split('---')[1].trim().split('\n')
  .map(line => line.match(/^([\w-]+):\s*(.*)$/)).filter(Boolean).map(match => [match[1], match[2]]));

test('SKILL.md frontmatter works for Claude Code and Codex', () => {
  assert.equal(frontmatter.name, 'trust-pyramid');
  assert.match(frontmatter.name, /^[a-z0-9-]+$/);
  assert.ok(frontmatter.description.length > 100, 'description should say when to use the skill');
  assert.ok(frontmatter.description.length <= 1024, 'keep description within the common 1024-char limit');
  const portable = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
  for (const key of Object.keys(frontmatter)) assert.ok(portable.has(key), `frontmatter key "${key}" is not portable`);
});

test('every reference and template path mentioned in SKILL.md exists', () => {
  const mentioned = [...skillMd.matchAll(/`((?:references|templates)\/[^`\s]+)`/g)].map(match => match[1]);
  assert.ok(mentioned.length > 5);
  for (const path of mentioned) assert.ok(existsSync(join(SKILL, path)), `missing ${path}`);
});

test('every template path mentioned in the references exists', () => {
  for (const file of readdirSync(join(SKILL, 'references'))) {
    const text = readFileSync(join(SKILL, 'references', file), 'utf8');
    for (const match of text.matchAll(/`templates\/([^`\s]+)`/g)) {
      assert.ok(existsSync(join(SKILL, 'templates', match[1])), `${file} mentions missing templates/${match[1]}`);
    }
  }
});

test('Codex metadata and Claude plugin manifests are present and consistent', () => {
  const openai = readFileSync(join(SKILL, 'agents', 'openai.yaml'), 'utf8');
  assert.match(openai, /\$trust-pyramid/);
  const plugin = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  const marketplace = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
  assert.equal(plugin.name, 'trust-pyramid');
  assert.equal(marketplace.plugins[0].name, plugin.name);
  assert.ok(!/^(claude|anthropic)/.test(plugin.name));
});

test('shell templates are executable in the git index', () => {
  // The index mode is what a clone gets. The file system mode says nothing on Windows (core.fileMode=false).
  const paths = ['scripts/check.sh', 'scripts/stop-gate.sh', 'scripts/install-agent-hooks.sh', 'scripts/trusted-check.sh', 'scripts/no-suppressions.sh', 'githooks/pre-commit']
    .map(path => `skills/trust-pyramid/templates/${path}`);
  const modes = execFileSync('git', ['ls-files', '-s', '--', ...paths], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n');
  assert.equal(modes.length, paths.length, 'every shell template is tracked');
  for (const line of modes) assert.match(line, /^100755 /, `${line.split('\t')[1]} must be committed as 100755`);
});

test('CI never executes gate files from the PR checkout', () => {
  const workflow = readFileSync(join(SKILL, 'templates/github/workflows/quality.yml'), 'utf8');
  const runLines = workflow.split('\n').filter(line => !line.trim().startsWith('#'));
  const body = runLines.join('\n');
  assert.doesNotMatch(body, /^\s*(- run: )?(bash )?scripts\/(check|trusted-check)\.sh/m, 'check.sh must run through the base copy of trusted-check.sh');
  assert.doesNotMatch(body, /node scripts\/review-gate\.mjs|from '\.\/scripts\/review-gate\.mjs'/, 'review-gate must be the base copy');
  assert.match(body, /git checkout "\$BASE_SHA" -- quality\/reviewer-prompt\.md/, 'the reviewer prompt must come from base');
  assert.equal((body.match(/git show "\$BASE_SHA:scripts\/trusted-check\.sh"/g) ?? []).length, 2, 'check and smoke both use trusted-check');
});

test('line endings: this repo and installed projects keep gate files LF on Windows (core.autocrlf=true)', () => {
  const eol = (cwd, paths) => execFileSync('git', ['check-attr', 'eol', '--', ...paths], { cwd, encoding: 'utf8' });
  const own = ['skills/trust-pyramid/SKILL.md', 'skills/trust-pyramid/templates/scripts/check.sh', 'skills/trust-pyramid/templates/githooks/pre-commit', 'tests/skill.test.mjs'];
  for (const line of eol(ROOT, own).trim().split('\n')) assert.match(line, /: eol: lf$/, `this repository: ${line}`);

  const { dir } = tempRepo();
  copyTemplate('gitattributes', dir, '.gitattributes');
  const installed = ['scripts/check.sh', 'scripts/review-gate.mjs', '.githooks/pre-commit', 'lint/project-plugin.mjs', 'quality/protected-paths.txt', '.github/workflows/quality.yml', '.claude/settings.json', '.codex/hooks.json', 'tools/build.sh'];
  for (const line of eol(dir, installed).trim().split('\n')) assert.match(line, /: eol: lf$/, `installed project: ${line}`);
});
