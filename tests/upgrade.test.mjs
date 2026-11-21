// tools/upgrade.mjs: a project set up from an older skill upgrades without losing its own changes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
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
  edit(dir, 'templates/scripts/check.sh', '# Python example:', '# OLD Python example:'); // inside the project section
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

  writeFileSync(join(dir, 'scripts/check.sh'), read(dir, 'scripts/check.sh')
    .replace(/CHECKS=\([\s\S]*?\n\)/, 'CHECKS=(\n  "app/|app: my project check|npm test|fast"\n)') // the project rewrites its section
    + '# my own note at the end\n'); // and changes a line outside it
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
  assert.match(check, /CHECKS=\(\n  "app\/\|app: my project check\|npm test\|fast"\n\)/, 'the project section is kept as the project wrote it');
  assert.doesNotMatch(check, /Python example/, 'template examples inside the project section do not come back or conflict');
  assert.doesNotMatch(check, /old check\.sh header/, 'the template change outside the section is applied');
  assert.match(check, /# my own note at the end\n$/, 'the project change outside the section is kept');
  assert.doesNotMatch(out, /CONFLICTS[^]*check\.sh/);

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
  writeFiles(dir, {
    'scripts/check.sh': read(SKILL, 'templates/scripts/check.sh') + '# customized\n',
    'quality/rule-candidates.md': '# mine\n',
    'lint/oxlint.mjs': '// the project\'s own runner, not the template\nconsole.log("lint all the things");\n',
  });
  const run = (...extra) => spawnSync(process.execPath, [TOOL, ...extra, '--project', dir], { encoding: 'utf8' });
  assert.equal(run('status').status, 1);
  assert.equal(run('upgrade').status, 1, 'upgrading without a lock asks to record first');
  const recorded = run('record');
  assert.equal(recorded.status, 0, recorded.stderr);
  assert.match(recorded.stdout, /Recorded 2 file\(s\)/);
  assert.match(recorded.stdout, /Not recorded[^]*lint\/oxlint\.mjs \(it does not look like the template/, 'a project\'s own file at a template path is left alone');
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

// A project installed from an older release, adopted with --from: the old templates become the base,
// so the first upgrade merges instead of leaving everything to manual work.
function adoptFixture() {
  const old = oldSkill();
  const dir = tempDir();
  const manifest = JSON.parse(read(old, 'install-manifest.json')).files;
  for (const path of ['scripts/stop-gate.sh', 'scripts/check.sh', 'AGENTS.md']) {
    writeFiles(dir, { [path]: read(old, join('templates', manifest.find(entry => entry.path === path).template)) });
  }
  writeFileSync(join(dir, 'AGENTS.md'), read(dir, 'AGENTS.md') + '- My project rule.\n');
  return { old, dir };
}
function expectMergedUpgrade(dir) {
  const result = spawnSync(process.execPath, [TOOL, 'upgrade', '--project', dir], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Trust Pyramid 0\.3\.9 ->/);
  assert.match(result.stdout, /Replaced[^]*scripts\/stop-gate\.sh/);
  assert.equal(read(dir, 'scripts/stop-gate.sh'), read(SKILL, 'templates/scripts/stop-gate.sh'));
  const agents = read(dir, 'AGENTS.md');
  assert.match(agents, /- My project rule\./, 'the project change is kept');
  assert.doesNotMatch(agents, /OLD first rule/, 'the change between releases is merged in');
}

test('record --from takes the base from the skill\'s git tag of that release', () => {
  const { old, dir } = adoptFixture();
  const repo = tempDir();
  const git = (...cmd) => spawnSync('git', cmd, { cwd: repo, encoding: 'utf8' });
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@example.test'); git('config', 'user.name', 't'); git('config', 'core.autocrlf', 'false');
  cpSync(old, join(repo, 'skills/trust-pyramid'), { recursive: true });
  git('add', '-A'); git('commit', '-q', '-m', 'old'); git('tag', 'v0.3.9');
  cpSync(SKILL, join(repo, 'skills/trust-pyramid'), { recursive: true });
  git('add', '-A'); git('commit', '-q', '-m', 'new');
  const skill = join(repo, 'skills/trust-pyramid');
  const recorded = spawnSync(process.execPath, [TOOL, 'record', '--project', dir, '--skill', skill, '--from', '0.3.9'], { encoding: 'utf8' });
  assert.equal(recorded.status, 0, recorded.stderr);
  assert.match(recorded.stdout, /at Trust Pyramid 0\.3\.9 .*with bases from git tag v0\.3\.9/);
  expectMergedUpgrade(dir);
});

test('record --from downloads the release when the skill is not a git checkout', async () => {
  const { old, dir } = adoptFixture();
  const server = createServer((request, response) => {
    const match = /^\/v0\.3\.9\/skills\/trust-pyramid\/templates\/(.+)$/.exec(request.url);
    const file = match && join(old, 'templates', decodeURIComponent(match[1]));
    if (file && existsSync(file)) response.end(readFileSync(file));
    else { response.statusCode = 404; response.end(); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  try {
    const env = { ...process.env, TRUST_PYRAMID_RAW: `http://127.0.0.1:${server.address().port}` };
    const child = await import('node:child_process');
    const recorded = await new Promise(done => child.execFile(process.execPath, [TOOL, 'record', '--project', dir, '--from', '0.3.9'], { env, encoding: 'utf8' }, (error, stdout, stderr) => done({ status: error ? error.code : 0, stdout, stderr })));
    assert.equal(recorded.status, 0, recorded.stderr);
    assert.match(recorded.stdout, /with bases from http:\/\/127\.0\.0\.1:\d+\/v0\.3\.9/);
    assert.doesNotMatch(recorded.stdout, /hook-status/, 'templates the old release did not ship are not recorded');
  } finally {
    server.close();
  }
  expectMergedUpgrade(dir);
});
