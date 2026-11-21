// Runs oxlint through node itself, so the same command works on Windows, macOS and Linux.
// Spawning "npx" (npx.cmd on Windows) or a .cmd shim without a shell fails on Windows.
//   import { runOxlint } from './oxlint.mjs';  runOxlint(['-c', '.oxlintrc.json', 'src'])
//   node lint/oxlint.mjs -c .oxlintrc.json src      (CLI form for scripts/check.sh)
// oxlint is resolved like an import from this file: lint/node_modules, then the repo root's.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root: run linters from here (oxlint rejects paths containing ".."). */
export const ROOT = fileURLToPath(new URL('..', import.meta.url));

function oxlintBin() {
  try {
    const manifest = createRequire(import.meta.url).resolve('oxlint/package.json');
    return join(dirname(manifest), 'bin', 'oxlint');
  } catch {
    return null;
  }
}

export function runOxlint(args, { cwd = ROOT } = {}) {
  const bin = oxlintBin();
  if (!bin) return { status: 2, stdout: '', stderr: 'oxlint is not installed here. In a fresh worktree run: bash scripts/check.sh --setup. Otherwise add it as a dev dependency (npm i -D oxlint).' };
  return spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8' });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = runOxlint(process.argv.slice(2));
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? result.error?.message ?? '');
  process.exit(result.status ?? 1);
}
