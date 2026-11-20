// review-gate.mjs: every finding needs a disposition; confirmed findings need red -> green proof.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import { checkDispositions, extractFindings, findingId } from '../skills/trust-pyramid/templates/scripts/review-gate.mjs';
import { copyTemplate, tempRepo, writeFiles } from './helpers.mjs';

// A child `node --test` inherits NODE_TEST_CONTEXT from this runner and then always exits 0.
const { NODE_TEST_CONTEXT: _ignored, ...cleanEnv } = process.env;

const finding = { file: 'src/price.mjs', line: 1, summary: 'Discount can make the price negative', failure_scenario: 'price(5, 10) returns -5' };

test('extractFindings accepts plain arrays, {findings}, and fenced model replies', () => {
  assert.deepEqual(extractFindings('[]'), []);
  assert.equal(extractFindings(JSON.stringify({ findings: [finding] })).length, 1);
  assert.equal(extractFindings(`Here you go:\n\`\`\`json\n${JSON.stringify([finding])}\n\`\`\``).length, 1);
  assert.throws(() => extractFindings('no json here'));
});

test('finding IDs are stable across whitespace and case changes', () => {
  assert.equal(findingId(finding), findingId({ ...finding, summary: '  discount can make the PRICE   negative ' }));
  assert.match(findingId(finding), /^[0-9a-f]{8}$/);
});

test('dispositions: missing, short reasons and incomplete confirmations are rejected', () => {
  const id = findingId(finding);
  assert.equal(checkDispositions([finding], {}).length, 1);
  assert.equal(checkDispositions([finding], { [id]: { status: 'rejected', reason: 'nope' } }).length, 1);
  assert.equal(checkDispositions([finding], { [id]: { status: 'rejected', reason: 'Prices are clamped by the caller in src/cart.mjs:12.' } }).length, 0);
  assert.equal(checkDispositions([finding], { [id]: { status: 'confirmed', testFiles: [] } }).length, 1);
});

test('deferred findings must be tracked in rule-candidates.md', () => {
  const id = findingId(finding);
  const deferred = { [id]: { status: 'deferred', reason: 'Needs a schema migration, scheduled for next sprint.' } };
  assert.equal(checkDispositions([finding], deferred, '| negative prices | 1 | ... |').length, 1);
  assert.equal(checkDispositions([finding], deferred, `| negative prices (${id}) | 1 | src/price.mjs:1 |`).length, 0);
});

function scenario({ fixed, testAsserts, testImport = 'price', baseArgs }) {
  const { dir, git } = tempRepo({
    'src/price.mjs': 'export const price = (base, discount) => base - discount;\n',
  });
  copyTemplate('scripts/review-gate.mjs', dir);
  git('add', '-A');
  git('commit', '-q', '-m', 'gate');
  git('branch', 'base');
  const files = {
    'test/price.test.mjs': `import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { ${testImport} } from '../src/price.mjs';\ntest('price', () => { ${testAsserts} });\n`,
    '.ai-review/review.json': JSON.stringify([finding]),
    'quality/review-dispositions.json': JSON.stringify({ findings: { [findingId(finding)]: {
      status: 'confirmed', testFiles: ['test/price.test.mjs'], testCommand: 'node --test test/price.test.mjs' } } }),
  };
  if (baseArgs?.length === 0) git('checkout', '-q', '-b', 'feature');  // main stays at the old code
  if (fixed) files['src/price.mjs'] = 'export const price = (base, discount) => Math.max(0, base - discount);\nexport const clampedPrice = price;\n';
  writeFiles(dir, files);
  git('add', '-A');
  git('commit', '-q', '-m', 'head');
  return spawnSync('node', ['scripts/review-gate.mjs', ...(baseArgs ?? ['--base', 'base'])], { cwd: dir, encoding: 'utf8', env: cleanEnv });
}

test('a red base run caused by an import error does not count as evidence', () => {
  const result = scenario({ fixed: true, testImport: 'clampedPrice', testAsserts: 'assert.equal(clampedPrice(5, 10), 0);' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /wrong reason/);
});

test('without a remote, the base defaults to main', () => {
  const result = scenario({ fixed: true, testAsserts: 'assert.equal(price(5, 10), 0);', baseArgs: [] });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('confirmed finding passes when the test is red on base and green on head', () => {
  const result = scenario({ fixed: true, testAsserts: 'assert.equal(price(5, 10), 0);' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Gate passed/);
});

test('confirmed finding fails when the test already passes on base (proves nothing)', () => {
  const result = scenario({ fixed: true, testAsserts: 'assert.equal(price(10, 5), 5);' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /PASSES on base/);
});

test('confirmed finding fails when the fix does not make the test pass', () => {
  const result = scenario({ fixed: false, testAsserts: 'assert.equal(price(5, 10), 0);' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAILS on head/);
});

test('gate fails closed when the review output is missing', () => {
  const { dir } = tempRepo();
  copyTemplate('scripts/review-gate.mjs', dir);
  const result = spawnSync('node', [join(dir, 'scripts/review-gate.mjs'), '--no-evidence'], { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /fails closed/);
});
