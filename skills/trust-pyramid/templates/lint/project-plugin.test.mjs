// Proves each project rule fires on the violating fixture and stays silent on the compliant one.
// Uses a fixture-only config so the main lint config can keep ignoring lint/fixtures/.
import assert from 'node:assert/strict';
import test from 'node:test';
import { runOxlint } from './oxlint.mjs';

function lint(file) {
  const result = runOxlint(['-c', 'lint/fixtures/oxlintrc.json', '--format', 'json', file]);
  // A missing or half-installed oxlint must read as setup, not as a broken rule.
  assert.ok(result.stdout, `oxlint printed nothing: ${result.stderr || result.error?.message}`);
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    assert.fail(`oxlint did not print a JSON report (is it fully installed? bash scripts/check.sh --setup):\n${result.stdout.slice(0, 300)}\n${result.stderr ?? ''}`);
  }
  return report.diagnostics.map(d => `${d.code}@${d.labels[0].span.line}`).sort();
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
