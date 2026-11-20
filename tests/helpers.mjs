import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const SKILL = join(ROOT, 'skills', 'trust-pyramid');
export const TEMPLATES = join(SKILL, 'templates');

const created = [];
process.on('exit', () => { for (const dir of created) rmSync(dir, { recursive: true, force: true }); });

/** A throwaway git repository with an initial commit, removed when the test process exits. */
export function tempRepo(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'trust-pyramid-test-'));
  created.push(dir);
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.test');
  git('config', 'user.name', 'test');
  git('config', 'core.autocrlf', 'false'); // deterministic on Windows; installed projects get templates/gitattributes
  writeFiles(dir, files);
  git('add', '-A');
  git('commit', '-q', '-m', 'base', '--allow-empty');
  return { dir, git };
}

export function writeFiles(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
    if (path.endsWith('.sh')) chmodSync(join(dir, path), 0o755);
  }
}

export function copyTemplate(from, dir, to = from) {
  mkdirSync(dirname(join(dir, to)), { recursive: true });
  cpSync(join(TEMPLATES, from), join(dir, to), { recursive: true });
}
