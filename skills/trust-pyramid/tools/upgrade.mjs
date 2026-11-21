#!/usr/bin/env node
// Upgrades the files Trust Pyramid installed in a project without losing the project's changes.
//
// At setup, `record` stores in quality/trust-pyramid.lock.json the skill version and, for every
// installed mechanism or tailored file, the template it was installed from (the merge base).
// `upgrade` then does a three-way merge per file: the project's file, that base, and the new
// template. Changes on different lines are combined; the same lines changed on both sides are
// left as conflict markers for the agent (and the user, in the pull request) to resolve. Content
// files (lint rules, ledgers, smoke flows) are never touched.
//
//   node <skill>/tools/upgrade.mjs status  [--project DIR]
//   node <skill>/tools/upgrade.mjs record  [--project DIR] [--force] [--path P ...] [--from VERSION]
//   node <skill>/tools/upgrade.mjs upgrade [--project DIR] [--dry-run]
//   node <skill>/tools/upgrade.mjs check   [--project DIR]
//
// Exit codes: 0 ok, 1 error, 3 conflicts to resolve (upgrade) or conflict markers left (check).
// --skill DIR uses another copy of the skill (tests use it to simulate versions).
// --from VERSION (adopting an installation made before 0.4.0): record the templates of the release
// the project was installed from as the base, read from the skill's git tag v<VERSION> when the
// skill is a git checkout, else downloaded from GitHub (TRUST_PYRAMID_RAW overrides the base URL).
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCK = 'quality/trust-pyramid.lock.json';
const MARKER = /^(<{7}|>{7}) /m;

const args = process.argv.slice(2);
const command = args[0];
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const all = name => args.flatMap((arg, i) => (arg === name ? [args[i + 1]] : []));
const flag = name => args.includes(name);

const skill = resolve(option('--skill') ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
const project = resolve(option('--project') ?? '.');
const version = readFileSync(join(skill, 'VERSION'), 'utf8').trim();
const manifest = JSON.parse(readFileSync(join(skill, 'install-manifest.json'), 'utf8')).files;

const lf = text => text.replace(/\r\n/g, '\n');
const read = path => lf(readFileSync(path, 'utf8'));
const template = entry => read(join(skill, 'templates', entry.template));
const inProject = path => join(project, path);
const encode = text => Buffer.from(text, 'utf8').toString('base64');
const decode = text => Buffer.from(text, 'base64').toString('utf8');
const lines = text => text.split('\n').filter(line => line.trim() !== '');

// Project sections: lines between "trust-pyramid:project-start <id>" and "trust-pyramid:project-end
// <id>" (any comment syntax) belong to the project. Before merging, the base and the new template
// take the project's copy of each section both sides have, so template examples there never
// conflict with what the project wrote.
function sections(text) {
  const found = new Map();
  const all = text.split('\n');
  all.forEach((line, i) => {
    const start = /trust-pyramid:project-start (\S+)/.exec(line);
    if (start) found.set(start[1], { start: i });
    const end = /trust-pyramid:project-end (\S+)/.exec(line);
    if (end && found.has(end[1])) found.get(end[1]).end = i;
  });
  return { all, found: new Map([...found].filter(([, range]) => range.end > range.start)) };
}
function keepProjectSections(text, project) {
  const into = sections(text);
  const from = sections(project);
  let out = into.all;
  for (const [id, range] of [...into.found].sort((a, b) => b[1].start - a[1].start)) {
    const source = from.found.get(id);
    if (!source) continue;
    out = [...out.slice(0, range.start + 1), ...from.all.slice(source.start + 1, source.end), ...out.slice(range.end)];
  }
  return out.join('\n');
}

function loadLock() {
  if (!existsSync(inProject(LOCK))) return null;
  return JSON.parse(readFileSync(inProject(LOCK), 'utf8'));
}
function saveLock(lock) {
  mkdirSync(dirname(inProject(LOCK)), { recursive: true });
  writeFileSync(inProject(LOCK), JSON.stringify(lock, null, 2) + '\n');
}
const merged = entry => entry.category === 'mechanism' || entry.category === 'tailored';
function lockEntry(entry, baseText = template(entry)) {
  const record = { template: entry.template, category: entry.category, group: entry.group };
  if (merged(entry)) record.base = encode(baseText);
  return record;
}

// Did this file come from the template? A project may have its own file at a manifest path (its own
// lint/oxlint.mjs). Count the template's meaningful lines that are still in the file: setup edits
// keep at least the comments (a CODEOWNERS with every @OWNER replaced keeps ~16%).
function fromTemplate(current, base) {
  const meaningful = text => lines(text).map(line => line.trim().replace(/\s+/g, ' ')).filter(line => line.length >= 12);
  const wanted = meaningful(base);
  if (!wanted.length) return true;
  const have = new Set(meaningful(current));
  return wanted.filter(line => have.has(line)).length / wanted.length >= 0.1;
}

// The templates of an earlier release, by template path (missing: not shipped in that release).
async function templatesAt(release) {
  const tag = `v${release}`;
  const found = new Map();
  const git = (...cmd) => spawnSync('git', ['-C', skill, ...cmd], { encoding: 'utf8' });
  const prefix = git('rev-parse', '--show-prefix');
  if (prefix.status === 0 && git('rev-parse', '-q', '--verify', `refs/tags/${tag}`).status === 0) {
    for (const entry of manifest) {
      const shown = git('show', `${tag}:./templates/${entry.template}`);
      if (shown.status === 0) found.set(entry.template, lf(shown.stdout));
    }
    if (found.size) return { found, source: `git tag ${tag}` };
  }
  const raw = process.env.TRUST_PYRAMID_RAW ?? 'https://raw.githubusercontent.com/Tim-rppl/trust-pyramid';
  for (const entry of manifest) {
    const url = `${raw}/${tag}/skills/trust-pyramid/templates/${entry.template}`;
    const response = await fetch(url);
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(`Could not download ${url}: HTTP ${response.status}`);
    found.set(entry.template, lf(await response.text()));
  }
  if (!found.size) throw new Error(`No templates found for release ${release} (tag ${tag}).`);
  return { found, source: `${raw}/${tag}` };
}
function writeFile(path, text, executableLike) {
  const full = inProject(path);
  mkdirSync(dirname(full), { recursive: true });
  const mode = existsSync(full) ? statSync(full).mode : null;
  writeFileSync(full, text);
  if (mode !== null) chmodSync(full, mode);
  else if (executableLike) chmodSync(full, 0o755);
}
const executable = path => /\.sh$/.test(path) || path.startsWith('.githooks/');

function merge(current, base, next) {
  const dir = mkdtempSync(join(tmpdir(), 'trust-pyramid-merge-'));
  try {
    const [c, b, n] = ['current', 'base', 'next'].map(name => join(dir, name));
    writeFileSync(c, current); writeFileSync(b, base); writeFileSync(n, next);
    const result = spawnSync('git', ['merge-file', '-p', '-L', 'your project', '-L', 'previous template', '-L', `trust-pyramid ${version}`, c, b, n], { encoding: 'utf8' });
    if (result.error || result.status === null || result.status >= 128) throw new Error(`git merge-file failed: ${result.error?.message ?? result.stderr}`);
    return { text: result.stdout, conflicts: result.status };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function status() {
  const lock = loadLock();
  if (!lock) {
    console.log(`No ${LOCK}: this project was set up before upgrades were recorded, or not by Trust Pyramid.`);
    console.log(`Skill version: ${version}. Run "record" once to adopt the current files as the starting point.`);
    return 1;
  }
  console.log(`Installed: ${lock.version}. Skill: ${version}. ${lock.version === version ? 'Up to date.' : 'An upgrade is available.'}`);
  return 0;
}

async function record() {
  const only = all('--path');
  const from = option('--from');
  let lock = loadLock();
  if (lock && !only.length && !flag('--force')) {
    console.error(`${LOCK} already exists. Use "upgrade" to move to a new version, or --force to re-record every file.`);
    return 1;
  }
  for (const path of only) if (!manifest.some(entry => entry.path === path)) { console.error(`Not a Trust Pyramid file: ${path}`); return 1; }
  const old = from ? await templatesAt(from) : null;
  const baseOf = entry => (old ? old.found.get(entry.template) : template(entry));
  if (!lock || (!only.length && flag('--force'))) {
    lock = { version: from ?? version, shipped: manifest.filter(entry => baseOf(entry) !== undefined).map(entry => entry.path), files: {} };
  }
  const skipped = [];
  const entries = manifest.filter(entry => {
    if (only.length) return only.includes(entry.path);
    if (!existsSync(inProject(entry.path))) return false;
    if (!merged(entry)) return true;
    const base = baseOf(entry);
    if (base === undefined) { skipped.push(`${entry.path} (release ${from} did not ship this template)`); return false; }
    if (!fromTemplate(read(inProject(entry.path)), base)) { skipped.push(`${entry.path} (it does not look like the template: the project's own file?)`); return false; }
    return true;
  });
  for (const entry of entries) lock.files[entry.path] = lockEntry(entry, baseOf(entry) ?? template(entry));
  saveLock(lock);
  console.log(`Recorded ${entries.length} file(s) at Trust Pyramid ${lock.version} in ${LOCK}${old ? `, with bases from ${old.source}` : ''}. Commit it.`);
  if (skipped.length) {
    console.log('Not recorded (left alone by upgrades). If one did come from Trust Pyramid, add it with --path:');
    for (const item of skipped) console.log(`  - ${item}`);
  }
  return 0;
}

function upgrade() {
  const lock = loadLock();
  if (!lock) {
    console.error(`No ${LOCK}. Run "record" first to adopt the current files, then upgrade with the next release.`);
    return 1;
  }
  const dry = flag('--dry-run');
  const report = { updated: [], merged: [], conflicts: [], added: [], appended: [], unchanged: [], todo: [], missing: [], retired: [] };
  const groups = new Set(Object.values(lock.files).map(file => file.group));
  // Offer only templates this release added; ones the project chose not to install stay quiet.
  const shipped = new Set(lock.shipped ?? manifest.map(entry => entry.path));
  const next = { version, shipped: manifest.map(entry => entry.path), files: { ...lock.files } };

  for (const entry of manifest) {
    const known = lock.files[entry.path];
    const exists = existsSync(inProject(entry.path));
    if (!known) {
      if (shipped.has(entry.path) || !groups.has(entry.group) || exists && entry.category !== 'append') continue;
      if (entry.category === 'mechanism' && !exists) {
        if (!dry) writeFile(entry.path, template(entry), executable(entry.path));
        next.files[entry.path] = lockEntry(entry);
        report.added.push(entry.path);
      } else if (entry.category !== 'append') {
        report.todo.push(`${entry.path} (new ${entry.category} template ${entry.template}: install and adapt it, then run: record --path ${entry.path})`);
      }
      if (entry.category !== 'append') continue;
    }
    if (entry.category === 'content') continue;
    if (entry.category === 'append') {
      const current = exists ? read(inProject(entry.path)) : '';
      const have = new Set(lines(current).map(line => line.trim()));
      const missing = lines(template(entry)).filter(line => !have.has(line.trim()));
      if (missing.length) {
        if (!dry) writeFile(entry.path, current + (current && !current.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n', false);
        report.appended.push(`${entry.path} (+${missing.length} line${missing.length > 1 ? 's' : ''})`);
      }
      next.files[entry.path] = lockEntry(entry);
      continue;
    }
    if (!exists) { report.missing.push(entry.path); continue; }

    const current = read(inProject(entry.path));
    const base = keepProjectSections(decode(known.base ?? encode(template(entry))), current);
    const fresh = keepProjectSections(template(entry), current);
    next.files[entry.path] = lockEntry(entry);
    if (fresh === base || current === fresh) { report.unchanged.push(entry.path); continue; }
    if (current === base) {
      if (!dry) writeFile(entry.path, fresh, false);
      report.updated.push(entry.path);
      continue;
    }
    const { text, conflicts } = merge(current, base, fresh);
    if (!dry) writeFile(entry.path, text, false);
    const note = entry.category === 'mechanism' ? ', a mechanism file the project had changed' : '';
    if (conflicts) report.conflicts.push(`${entry.path} (${conflicts} conflict${conflicts > 1 ? 's' : ''}${note})`);
    else report.merged.push(`${entry.path}${note ? ` (${note.slice(2)})` : ''}`);
  }
  for (const path of Object.keys(lock.files)) {
    if (!manifest.some(entry => entry.path === path)) { report.retired.push(path); delete next.files[path]; }
  }

  const titles = {
    updated: 'Replaced with the new template (the project had not changed them)',
    merged: 'Merged: the project\'s changes and the new template combined',
    conflicts: 'CONFLICTS: the project and the new template changed the same lines. Resolve the marked blocks',
    added: 'New files added',
    appended: 'Lines appended',
    todo: 'New templates to install and adapt by hand',
    missing: 'Recorded but missing in the project (moved or deleted?): not changed',
    retired: 'No longer shipped by Trust Pyramid: remove them if nothing uses them',
  };
  console.log(`Trust Pyramid ${lock.version} -> ${version}${dry ? ' (dry run, nothing written)' : ''}`);
  for (const [key, title] of Object.entries(titles)) {
    if (report[key].length) { console.log(`\n${title}:`); for (const item of report[key]) console.log(`  - ${item}`); }
  }
  if (!Object.entries(report).some(([key, list]) => key !== 'unchanged' && list.length)) console.log('\nNothing to change.');
  if (!dry) saveLock(next);
  if (report.conflicts.length) {
    console.log('\nNext: resolve every <<<<<<< ... >>>>>>> block, then run "check". Explain each resolution in the pull request.');
    return 3;
  }
  return 0;
}

function check() {
  const lock = loadLock();
  if (!lock) { console.error(`No ${LOCK}.`); return 1; }
  const left = Object.keys(lock.files).filter(path => existsSync(inProject(path)) && MARKER.test(read(inProject(path))));
  if (left.length) {
    console.log('Conflict markers left in:');
    for (const path of left) console.log(`  - ${path}`);
    return 3;
  }
  console.log('No conflict markers in Trust Pyramid files.');
  return 0;
}

const commands = { status, record, upgrade, check };
if (!commands[command]) {
  console.error('usage: upgrade.mjs status|record|upgrade|check [--project DIR] [--dry-run] [--force] [--path P]');
  process.exit(1);
}
try {
  process.exit(await commands[command]());
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
