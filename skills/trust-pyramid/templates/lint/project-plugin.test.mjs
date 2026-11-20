// Proves each project rule fires on the violating fixture and stays silent on the compliant one.
// Uses a fixture-only config so the main lint config can keep ignoring lint/fixtures/.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function lint(file) {
  const result = spawnSync('npx', ['oxlint', '-c', 'lint/fixtures/oxlintrc.json', '--format', 'json', file], { cwd: root, encoding: 'utf8' });
  return JSON.parse(result.stdout).diagnostics.map(d => `${d.code}@${d.labels[0].span.line}`).sort();
}

test('violating fixture: every rule reports at the expected line', () => {
  assert.deepEqual(lint('lint/fixtures/violations.tsx'), [
    'project(no-raw-ui-text)@4',
    'project(no-raw-ui-text)@4',
    'project(no-timing-patch)@2',
    'project(no-timing-patch)@3',
  ]);
});

test('compliant fixture: no false positives', () => {
  assert.deepEqual(lint('lint/fixtures/compliant.tsx'), []);
});
