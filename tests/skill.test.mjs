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
  const paths = ['scripts/check.sh', 'scripts/stop-gate.sh', 'scripts/install-agent-hooks.sh', 'scripts/trusted-check.sh', 'scripts/no-suppressions.sh', 'scripts/gate-log.sh', 'githooks/pre-commit']
    .map(path => `skills/trust-pyramid/templates/${path}`);
  const modes = execFileSync('git', ['ls-files', '-s', '--', ...paths], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n');
  assert.equal(modes.length, paths.length, 'every shell template is tracked');
  for (const line of modes) assert.match(line, /^100755 /, `${line.split('\t')[1]} must be committed as 100755`);
});

test('CI never executes gate files from the PR checkout', () => {
  const workflow = ['quality.yml', 'quality-smoke.yml', 'quality-review.yml']
    .map(file => readFileSync(join(SKILL, 'templates/github/workflows', file), 'utf8')).join('\n');
  const runLines = workflow.split('\n').filter(line => !line.trim().startsWith('#'));
  const body = runLines.join('\n');
  assert.doesNotMatch(body, /^\s*(- run: )?(bash )?scripts\/(check|trusted-check)\.sh/m, 'check.sh must run through the base copy of trusted-check.sh');
  assert.doesNotMatch(body, /node scripts\/review-gate\.mjs|from '\.\/scripts\/review-gate\.mjs'/, 'review-gate must be the base copy');
  assert.match(body, /git checkout "\$BASE_SHA" -- quality\/reviewer-prompt\.md/, 'the reviewer prompt must come from base');
  assert.equal((body.match(/git show "\$BASE_SHA:scripts\/trusted-check\.sh"/g) ?? []).length, 2, 'check and smoke both use trusted-check');
  // The PR's own copy is used only for the bootstrap PR, when the base branch does not have the file.
  const fallbacks = body.match(/^\s*cp scripts\/\S+/gm) ?? [];
  assert.ok(fallbacks.length > 0);
  for (const fallback of fallbacks) {
    const file = fallback.trim().split(' ')[1];
    const before = body.slice(0, body.indexOf(fallback));
    const guard = before.lastIndexOf(`if git cat-file -e "$BASE_SHA:${file}"`);
    assert.ok(guard >= 0, `${file}: the PR's copy may only be used when the base has none`);
    const branch = before.slice(guard);
    assert.ok(/\n\s*else\n/.test(branch) && !/\n\s*fi\n/.test(branch), `${file}: the PR's copy belongs in the else branch of its guard`);
  }
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

test('tests and templates never spawn npx or python3 by name (both break on Windows)', () => {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', '*.mjs', '*.js'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n');
  for (const file of files) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    assert.doesNotMatch(text, /spawn(Sync)?\(\s*['"](npx|python3)['"]/, `${file} spawns npx/python3 directly`);
  }
});

test('CI is split per layer: the always-installed workflow needs neither verify/ nor an API key', () => {
  const dir = join(SKILL, 'templates/github/workflows');
  const jobs = file => [...readFileSync(join(dir, file), 'utf8').split('\njobs:\n')[1].matchAll(/^ {2}([\w-]+):$/gm)].map(match => match[1]);
  assert.deepEqual(jobs('quality.yml'), ['check']);
  assert.deepEqual(jobs('quality-smoke.yml'), ['smoke']);
  assert.deepEqual(jobs('quality-review.yml'), ['ai-review', 'review-gate']);
  const lite = readFileSync(join(dir, 'quality.yml'), 'utf8').split('\n').filter(line => !line.trim().startsWith('#')).join('\n');
  assert.doesNotMatch(lite, /verify\/|secrets\.|review-gate/, 'quality.yml must work for a lite setup');
  const prompt = readFileSync(join(SKILL, 'templates/quality/reviewer-prompt.md'), 'utf8');
  assert.match(prompt, /verify\/feature-map\.md` \(only when `verify\/` is installed\)/);
  assert.match(prompt, /AGENTS\.md.*sub-packages/);
});

test('the deny list is per machine, so a rule-writing worktree is not locked out of lint/', () => {
  const read = path => JSON.parse(readFileSync(join(SKILL, 'templates', path), 'utf8'));
  const shared = read('claude/settings.json');
  assert.equal(shared.permissions, undefined, 'the committed settings must not lock gate files for every checkout');
  assert.ok(shared.hooks.Stop);
  const local = read('claude/settings.local.json');
  for (const path of ['/lint/**', '/scripts/**', '/.github/**']) assert.ok(local.permissions.deny.includes(`Edit(${path})`), path);
  const addRule = readFileSync(join(SKILL, 'references/add-rule.md'), 'utf8');
  assert.match(addRule, /git worktree add/);
  assert.match(readFileSync(join(SKILL, 'references/gates.md'), 'utf8'), /## Changing gate files/);
});

test('setup cost figures are the same in SKILL.md, README and the benchmark', () => {
  const docs = [join(SKILL, 'SKILL.md'), join(ROOT, 'README.md'), join(ROOT, 'docs/BENCHMARK.md')].map(file => readFileSync(file, 'utf8'));
  for (const text of docs) {
    assert.match(text, /\$6\.5/);
    assert.match(text, /8\.5M tokens/);
    assert.match(text, /24-32 min/);
  }
});
