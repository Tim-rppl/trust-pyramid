// tools/upgrade.mjs: a project set up from an older skill upgrades without losing its own changes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { ROOT, SKILL, tempDir, writeFiles } from './helpers.mjs';

const TOOL = join(SKILL, 'tools', 'upgrade.mjs');
const read = (dir, path) => readFileSync(join(dir, path), 'utf8');
const edit = (dir, path, from, to) => {
  const text = read(dir, path);
  assert.ok(text.includes(from), `${path} should contain ${JSON.stringify(from)}`);
  writeFileSync(join(dir, path), text.replace(from, to));
};

// The "old release": a copy of the skill whose templates differ from the current ones in known ways.
function oldSkill() {
  const dir = tempDir();
  cpSync(SKILL, dir, { recursive: true });
  writeFileSync(join(dir, 'VERSION'), '0.3.9\n');
  edit(dir, 'templates/scripts/stop-gate.sh', '#!/usr/bin/env bash\n', '#!/usr/bin/env bash\n# old stop-gate\n');
  edit(dir, 'templates/scripts/check.sh', '#!/usr/bin/env bash\n', '#!/usr/bin/env bash\n# old check.sh header\n');
  edit(dir, 'templates/AGENTS.md', '- First, once per session', '- OLD first rule. First, once per session');
  edit(dir, 'templates/quality/rule-candidates.md', '#', '# OLD\n#');
  edit(dir, 'templates/gitignore-additions.txt', '.quality-state/\n', '');
  const manifestPath = join(dir, 'install-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.files = manifest.files.filter(entry => !['scripts/hook-status.sh', '.github/pull_request_template.md'].includes(entry.path));
  manifest.files.push({ template: 'scripts/old-thing.sh', path: 'scripts/old-thing.sh', category: 'mechanism', group: 'core' });
  writeFileSync(join(dir, 'templates/scripts/old-thing.sh'), '#!/usr/bin/env bash\necho old\n');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}

const CORE = ['scripts/stop-gate.sh', 'scripts/check.sh', 'AGENTS.md', 'quality/rule-candidates.md', 'scripts/old-thing.sh', 'scripts/trusted-check.sh'];

// A project set up with the old release, then customized the way setup and daily use customize it.
function project() {
  const old = oldSkill();
  const dir = tempDir();
  const manifest = JSON.parse(read(old, 'install-manifest.json')).files;
  for (const path of CORE) {
    const entry = manifest.find(item => item.path === path);
    writeFiles(dir, { [path]: read(old, join('templates', entry.template)) });
  }
  writeFiles(dir, { '.gitignore': 'node_modules/\n' + read(old, 'templates/gitignore-additions.txt') });
  const run = (command, skill = SKILL, ...extra) => spawnSync(process.execPath, [TOOL, command, '--project', dir, '--skill', skill, ...extra], { encoding: 'utf8' });
  const recorded = run('record', old);
  assert.equal(recorded.status, 0, recorded.stderr);

  edit(dir, 'scripts/check.sh', /CHECKS=\(\n/.exec(read(dir, 'scripts/check.sh'))[0], 'CHECKS=(\n  "app/|app: my project check|npm test|fast"\n');
  edit(dir, 'AGENTS.md', '- OLD first rule.', '- MY OWN first rule.');
  writeFiles(dir, { 'quality/rule-candidates.md': '# My rule candidates\n- never call the model from the client\n' });
  writeFileSync(join(dir, 'scripts/stop-gate.sh'), read(dir, 'scripts/stop-gate.sh').replace(/\n/g, '\r\n')); // a Windows checkout
  return { dir, old, run };
}

test('upgrade keeps project changes, applies template changes, and stops at real conflicts', () => {
  const { dir, run } = project();
  const before = read(dir, 'quality/rule-candidates.md');
  const result = run('upgrade');
  assert.equal(result.status, 3, result.stdout + result.stderr);
  const out = result.stdout;
  assert.match(out, /Trust Pyramid 0\.3\.9 -> \d+\.\d+\.\d+/);

  // Untouched mechanism file (even with CRLF line endings): replaced.
  assert.match(out, /Replaced[^]*scripts\/stop-gate\.sh/);
  assert.equal(read(dir, 'scripts/stop-gate.sh'), read(SKILL, 'templates/scripts/stop-gate.sh'));

  // Tailored file, changed on other lines: both changes kept.
  assert.match(out, /Merged[^]*scripts\/check\.sh/);
  const check = read(dir, 'scripts/check.sh');
  assert.match(check, /app: my project check/, 'the project\'s CHECKS table is kept');
  assert.doesNotMatch(check, /old check\.sh header/, 'the template change is applied');

  // Same line changed on both sides: conflict markers, nothing silently chosen.
  assert.match(out, /CONFLICTS[^]*AGENTS\.md \(1 conflict\)/);
  const agents = read(dir, 'AGENTS.md');
  assert.match(agents, /<<<<<<< your project\n- MY OWN first rule\./);
  assert.match(agents, />>>>>>> trust-pyramid /);

  // Content: never touched. New mechanism file: added and executable. New tailored file: listed.
  assert.equal(read(dir, 'quality/rule-candidates.md'), before);
  assert.match(out, /New files added[^]*scripts\/hook-status\.sh/);
  assert.ok(statSync(join(dir, 'scripts/hook-status.sh')).mode & 0o100 || process.platform === 'win32');
  assert.match(out, /install and adapt[^]*\.github\/pull_request_template\.md/);
  assert.match(out, /Lines appended[^]*\.gitignore \(\+1 line\)/);
  assert.match(read(dir, '.gitignore'), /^node_modules\/\n[^]*\.quality-state\/\n$/);
  assert.match(out, /No longer shipped[^]*scripts\/old-thing\.sh/);
  assert.ok(existsSync(join(dir, 'scripts/old-thing.sh')), 'retired files are reported, not deleted');

  const lock = JSON.parse(read(dir, 'quality/trust-pyramid.lock.json'));
  assert.equal(lock.version, read(SKILL, 'VERSION').trim());
  assert.ok(!lock.files['scripts/old-thing.sh']);
  assert.ok(lock.files['scripts/hook-status.sh']);

  // Resolving the conflict clears "check"; a second upgrade changes nothing.
  assert.equal(run('check').status, 3);
  writeFileSync(join(dir, 'AGENTS.md'), agents.replace(/<<<<<<< your project\n([^\n]*\n)=======\n[^\n]*\n>>>>>>> [^\n]*\n/, '$1'));
  assert.equal(run('check').status, 0);
  const snapshot = CORE.concat('.gitignore', 'AGENTS.md').filter(path => existsSync(join(dir, path))).map(path => read(dir, path));
  const again = run('upgrade');
  assert.equal(again.status, 0, again.stdout);
  assert.match(again.stdout, /Nothing to change/);
  assert.deepEqual(CORE.concat('.gitignore', 'AGENTS.md').filter(path => existsSync(join(dir, path))).map(path => read(dir, path)), snapshot);
});

test('upgrade --dry-run reports without writing anything', () => {
  const { dir, run } = project();
  const files = ['scripts/check.sh', 'AGENTS.md', '.gitignore', 'quality/trust-pyramid.lock.json'].map(path => read(dir, path));
  const result = run('upgrade', SKILL, '--dry-run');
  assert.match(result.stdout, /dry run, nothing written/);
  assert.match(result.stdout, /CONFLICTS/);
  assert.deepEqual(['scripts/check.sh', 'AGENTS.md', '.gitignore', 'quality/trust-pyramid.lock.json'].map(path => read(dir, path)), files);
  assert.ok(!existsSync(join(dir, 'scripts/hook-status.sh')));
});

test('record adopts an existing installation once, and refuses to overwrite the lock by accident', () => {
  const dir = tempDir();
  writeFiles(dir, { 'scripts/check.sh': 'customized\n', 'quality/rule-candidates.md': '# mine\n' });
  const run = (...extra) => spawnSync(process.execPath, [TOOL, ...extra, '--project', dir], { encoding: 'utf8' });
  assert.equal(run('status').status, 1);
  assert.equal(run('upgrade').status, 1, 'upgrading without a lock asks to record first');
  const recorded = run('record');
  assert.equal(recorded.status, 0, recorded.stderr);
  assert.match(recorded.stdout, /Recorded 2 file\(s\)/);
  const lock = JSON.parse(read(dir, 'quality/trust-pyramid.lock.json'));
  assert.equal(lock.files['scripts/check.sh'].category, 'tailored');
  assert.equal(Buffer.from(lock.files['scripts/check.sh'].base, 'base64').toString(), read(SKILL, 'templates/scripts/check.sh'));
  assert.equal(lock.files['quality/rule-candidates.md'].base, undefined, 'content files need no base');
  assert.ok(!JSON.stringify(lock).includes('eslint-disable'), 'bases are encoded, so suppression scanners never see template text');
  assert.equal(run('record').status, 1);
  assert.match(run('status').stdout, /Up to date/);
  assert.equal(run('record', '--path', 'scripts/stop-gate.sh').status, 0, 'one file can be added to the record');
});

test('the install manifest covers every template exactly once, and versions agree', () => {
  const manifest = JSON.parse(read(SKILL, 'install-manifest.json')).files;
  const walk = dir => readdirSync(dir).flatMap(name => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]));
  const templates = walk(join(SKILL, 'templates')).map(path => relative(join(SKILL, 'templates'), path).split('\\').join('/')).sort();
  assert.deepEqual(manifest.map(entry => entry.template).sort(), templates);
  assert.equal(new Set(manifest.map(entry => entry.path)).size, manifest.length, 'no two templates install to the same path');
  for (const entry of manifest) assert.ok(['mechanism', 'tailored', 'content', 'append'].includes(entry.category), entry.path);

  const version = read(SKILL, 'VERSION').trim();
  assert.equal(JSON.parse(read(ROOT, '.claude-plugin/plugin.json')).version, version);
  assert.match(read(ROOT, 'CHANGELOG.md'), new RegExp(`^## ${version.replace(/\./g, '\\.')} - \\d{4}-\\d\\d-\\d\\d$`, 'm'));
});
