// The Python rule template reports every rule on its violating fixture and nothing on the compliant one.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import { TEMPLATES } from './helpers.mjs';

const dir = join(TEMPLATES, 'lint', 'python');
const lint = file => spawnSync('python3', ['project_rules.py', file], { cwd: dir, encoding: 'utf8' });

test('python project rules: violations fixture reports TP001-TP004 with fix-it messages', () => {
  const result = lint('fixtures/violations.py');
  assert.equal(result.status, 1);
  const codes = [...result.stdout.matchAll(/:(\d+): (TP\d{3})/g)].map(match => `${match[2]}@${match[1]}`);
  assert.deepEqual(codes, ['TP002@3', 'TP001@7', 'TP003@8', 'TP004@8']);
  assert.match(result.stdout, /Fix: /);
});

test('python project rules: compliant fixture is clean', () => {
  const result = lint('fixtures/compliant.py');
  assert.equal(result.status, 0, result.stdout);
});
