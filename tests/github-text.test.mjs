// Optional rule pack templates/github-text/: language and AI-marker rules for PR text and commits.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { TEMPLATES, copyTemplate, tempRepo } from './helpers.mjs';

const RULE = join(TEMPLATES, 'github-text/check-github-text.mjs');
const { CONFIG, checkText, findAiMarkers, findOtherLanguage } = await import(pathToFileURL(RULE).href);

const markers = (body, options) => findAiMarkers(body, options).map(({ line, marker }) => `${marker}@${line}`);
const otherLanguage = (text, options) => findOtherLanguage(text, options).map(({ line, sample }) => `${sample}@${line}`);

test('no-ai-markers: attribution lines and tool names are reported with their line', () => {
  const body = [
    '## What changed',
    'Fix the audit log.',
    '',
    '\u{1F916} Generated with [Claude Code](https://example.com)',
    'Co-Authored-By: Codex <noreply@example.com>',
    'Drafted by ChatGPT and reviewed with Copilot; AI-generated summary.',
  ].join('\n');
  assert.deepEqual(markers(body), [
    'Claude@4', '"generated with/by"@4', 'robot emoji@4',
    'Codex@5', 'Co-Authored-By@5',
    'ChatGPT@6', 'Copilot@6', '"AI-generated"@6',
  ]);
});

test('no-ai-markers: normal text, file names in backticks and code blocks pass (CRLF too)', () => {
  const body = [
    'Adds `CLAUDE.md` and `.claude/agents/quality-reviewer.md`; the tooltip is unchanged.',
    'Calls the translation endpoint through the adapter.',
    '```',
    'claude --version',
    '```',
  ].join('\r\n');
  assert.deepEqual(markers(body), []);
});

test('language: other writing systems and full-width punctuation are reported per line', () => {
  assert.deepEqual(otherLanguage('feat: 接入质量门禁\n\nFix the gate，then merge.'), ['接入质量门禁@1', '，@3']);
  assert.deepEqual(otherLanguage('日本語のテキスト'), ['日本語のテキスト@1']);
  assert.deepEqual(otherLanguage('fix: правка'), ['правка@1']);
});

test('language: English, accented Latin, quoted strings in backticks and git comments pass', () => {
  assert.deepEqual(otherLanguage("fix(auth): keep the old error (`'原密码错误'`) unchanged; café naïve"), []);
  assert.deepEqual(otherLanguage('```\n录音已暂停\n```\nAll good.'), []);
  assert.deepEqual(otherLanguage('fix: typo\n# 请为您的变更输入提交说明', { gitComments: true }), []);
  assert.deepEqual(otherLanguage(''), []);
  assert.deepEqual(otherLanguage(undefined), []);
});

test('configurable: allowed scripts, switched-off rules, marker scope and marker list', () => {
  const russian = { ...CONFIG, language: { name: 'English or Russian', scripts: ['Latin', 'Cyrillic'] } };
  assert.deepEqual(otherLanguage('fix: правка', { config: russian }), []);
  assert.deepEqual(otherLanguage('接入', { config: { ...CONFIG, language: null } }), []);

  assert.deepEqual(checkText('commit', 'Co-Authored-By: Claude'), [], 'by default markers are checked in PR descriptions only');
  assert.equal(checkText('commit', 'Co-Authored-By: Claude', { config: { ...CONFIG, markersIn: ['commit'] } }).length, 2);
  assert.deepEqual(checkText('pr-body', 'Generated with Claude', { config: { ...CONFIG, markersIn: [] } }), []);
  const custom = { ...CONFIG, markers: [{ name: 'InternalBot', pattern: /\binternalbot\b/i }] };
  assert.deepEqual(markers('Written by InternalBot. Claude was not involved.', { config: custom }), ['InternalBot@1']);

  const [problem] = checkText('pr-title', '修复', { where: 'PR title' });
  assert.match(problem, /^PR title line 1: not English \("修复"\)\. Write .* in English\./);
});

test('CLI: --pr, --message and --commits report problems with exit code 1', () => {
  const run = (args, env = {}, cwd = undefined) => spawnSync(process.execPath, [RULE, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  const pr = run(['--pr'], { PR_TITLE: 'Fix the gate', PR_BODY: 'Adds `CLAUDE.md`.\n\nCo-Authored-By: Someone' });
  assert.equal(pr.status, 1);
  assert.match(pr.stderr, /PR description line 3: Co-Authored-By\./);
  assert.equal(run(['--pr'], { PR_TITLE: 'Fix the gate', PR_BODY: 'Adds `CLAUDE.md`.' }).status, 0);
  assert.equal(run(['--bogus']).status, 2);

  const { dir, git } = tempRepo();
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'Add a');
  writeFileSync(join(dir, 'b.txt'), 'b\n');
  git('add', '-A');
  git('commit', '-q', '-m', '添加 b');
  const commits = run(['--commits', 'HEAD~2', 'HEAD'], {}, dir);
  assert.equal(commits.status, 1);
  assert.match(commits.stderr, /commit [0-9a-f]{7} message line 1: not English .*Reword it/);
  assert.equal(commits.stderr.match(/message line/g).length, 1, 'only the offending commit is reported');

  const message = join(dir, 'MSG');
  writeFileSync(message, 'Add b\n# 请输入提交说明\n');
  assert.equal(run(['--message', message]).status, 0, 'git comment lines are ignored');
});

test('commit-msg hook blocks a message in another language', () => {
  const { dir, git } = tempRepo();
  copyTemplate('github-text/check-github-text.mjs', dir, 'scripts/check-github-text.mjs');
  copyTemplate('github-text/commit-msg', dir, '.githooks/commit-msg');
  git('config', 'core.hooksPath', '.githooks');
  git('add', '-A');
  const blocked = spawnSync('git', ['commit', '-q', '-m', '添加规则'], { cwd: dir, encoding: 'utf8' });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stdout + blocked.stderr, /Commit blocked/);
  const ok = spawnSync('git', ['commit', '-q', '-m', 'Add the GitHub text rules'], { cwd: dir, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
});

test('github-text workflow runs the base copy, re-runs on edits and keeps PR text out of the script', () => {
  const workflow = readFileSync(join(TEMPLATES, 'github-text/github-text.yml'), 'utf8');
  assert.match(workflow, /types: \[opened, edited, synchronize/);
  assert.match(workflow, /if git cat-file -e "\$BASE_SHA:scripts\/check-github-text\.mjs"[\s\S]*git show "\$BASE_SHA:scripts\/check-github-text\.mjs"[\s\S]*else[\s\S]*cp scripts\/check-github-text\.mjs/);
  const run = workflow.slice(workflow.indexOf('run: |'));
  assert.doesNotMatch(run, /\$\{\{\s*github\.event\.pull_request\.(title|body)/, 'PR text must reach the script through env only');
});
