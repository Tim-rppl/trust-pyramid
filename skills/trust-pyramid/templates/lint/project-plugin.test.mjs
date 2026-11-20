// Proves each project rule fires on the violating fixture and stays silent on the compliant one.
// Uses a fixture-only config so the main lint config can keep ignoring lint/fixtures/.
import assert from 'node:assert/strict';
import test from 'node:test';
import { runOxlint } from './oxlint.mjs';

function lint(file) {
  const result = runOxlint(['-c', 'lint/fixtures/oxlintrc.json', '--format', 'json', file]);
  assert.ok(result.stdout, `oxlint printed nothing: ${result.stderr || result.error?.message}`);
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
