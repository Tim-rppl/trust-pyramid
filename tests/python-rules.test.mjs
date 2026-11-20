// The Python rule template reports every rule on its violating fixture and nothing on the compliant one.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import { TEMPLATES } from './helpers.mjs';

const dir = join(TEMPLATES, 'lint', 'python');

// "python3" is often the Microsoft Store stub on Windows (prints nothing, exits 9009), so probe each
// candidate for a real Python 3 before using it.
const PYTHONS = [['python3'], ['python'], ['py', '-3']];
const python = PYTHONS.find(([command, ...args]) => {
  const probe = spawnSync(command, [...args, '-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' });
  return probe.status === 0 && probe.stdout.trim() === '3';
});
const skip = python ? false : `no Python 3 found (tried ${PYTHONS.map(c => c.join(' ')).join(', ')})`;
const lint = file => spawnSync(python[0], [...python.slice(1), 'project_rules.py', file], { cwd: dir, encoding: 'utf8' });

test('python project rules: violations fixture reports TP001-TP004 with fix-it messages', { skip }, () => {
  const result = lint('fixtures/violations.py');
  assert.equal(result.status, 1, result.stderr);
  const codes = [...result.stdout.matchAll(/:(\d+): (TP\d{3})/g)].map(match => `${match[2]}@${match[1]}`);
  assert.deepEqual(codes, ['TP002@3', 'TP001@7', 'TP003@8', 'TP004@8']);
  assert.match(result.stdout, /Fix: /);
});

test('python project rules: compliant fixture is clean', { skip }, () => {
  const result = lint('fixtures/compliant.py');
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
