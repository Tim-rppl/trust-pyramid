#!/usr/bin/env node
// Deterministic gate over AI review findings.
// Every finding needs a disposition in quality/review-dispositions.json:
//   confirmed -> its test files must FAIL on the reviewed commit (at an assertion, not at import) and
//                PASS on the head commit (red -> green)
//   rejected  -> not a real problem; needs a reason (>= 20 chars); shown to the human
//   deferred  -> real but not fixed in this PR; needs a reason and the finding ID must be recorded
//                in quality/rule-candidates.md so it is tracked, not forgotten
// Usage:
//   node scripts/review-gate.mjs [--review .ai-review/review.json] [--dispositions quality/review-dispositions.json]
//                                [--config quality/review.config.json] [--base <ref>]
// The "red" side is the commit the reviewer looked at: review.json's reviewed_sha
// ({ "reviewed_sha": "...", "findings": [...] }). That covers bugs that already existed and bugs the
// PR itself introduced. Precedence: --base, then reviewed_sha, then $REVIEW_BASE_REF, then origin/main,
// then main. The chosen commit must exist, be an ancestor of HEAD, and differ from HEAD.
//                                [--summary review-summary.md] [--no-evidence] [--list]
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIN_REASON_LENGTH = 20;
const CANDIDATES_FILE = 'quality/rule-candidates.md';
// A "red" base run only counts if the test reached its assertions. These mean it never got there.
const WRONG_REASON = /Cannot find module|ERR_MODULE_NOT_FOUND|does not provide an export named|is not a function|is not defined|SyntaxError|ImportError|ModuleNotFoundError|cannot import name|NameError|AttributeError: module|command not found|No such file or directory/;

function defaultBase() {
  if (process.env.REVIEW_BASE_REF) return process.env.REVIEW_BASE_REF;
  const hasRemote = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'origin/main']).status === 0;
  return hasRemote ? 'origin/main' : 'main';
}

function parseArgs(argv) {
  const options = {
    review: '.ai-review/review.json', dispositions: 'quality/review-dispositions.json',
    config: 'quality/review.config.json', base: null,
    summary: null, evidence: true, list: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--no-evidence') options.evidence = false;
    else if (flag === '--list') options.list = true;
    else if (['--review', '--dispositions', '--config', '--base', '--summary'].includes(flag)) options[flag.slice(2)] = argv[++index];
    else throw new Error(`Unknown argument: ${flag}`);
  }
  return options;
}

/** The commit the findings were made against, if the review recorded it. */
export function reviewedSha(text) {
  try { return JSON.parse(text).reviewed_sha ?? null; } catch { return null; }
}

/** Accepts a JSON array, {findings: [...]}, or text that contains one (e.g. a fenced model reply). */
export function extractFindings(text) {
  const candidates = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1]);
  const start = text.search(/[[{]/);
  if (start >= 0) candidates.push(text.slice(start));
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate.trim());
      const findings = Array.isArray(value) ? value : value?.findings;
      if (Array.isArray(findings)) return findings;
    } catch { /* try the next candidate */ }
  }
  throw new Error('Review output does not contain a JSON array of findings');
}

const normalize = value => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
export const findingId = finding => createHash('sha256').update(`${normalize(finding.file)}\n${normalize(finding.summary)}`).digest('hex').slice(0, 8);

function run(command, cwd, timeoutSeconds) {
  // A nested `node --test` that inherits NODE_TEST_CONTEXT always exits 0, which would fake the evidence.
  const { NODE_TEST_CONTEXT: _ignored, ...env } = process.env;
  const result = spawnSync('bash', ['-c', command], { cwd, env, encoding: 'utf8', timeout: timeoutSeconds * 1000 });
  return { code: result.status ?? 1, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.slice(-2000) };
}

export function checkDispositions(findings, dispositions, candidatesText = '') {
  const problems = [];
  for (const finding of findings) {
    const id = findingId(finding);
    const disposition = dispositions[id];
    if (!disposition) { problems.push(`${id}: no disposition for "${finding.summary}" (${finding.file}:${finding.line ?? '?'})`); continue; }
    if (disposition.status === 'rejected') {
      if (String(disposition.reason ?? '').trim().length < MIN_REASON_LENGTH) problems.push(`${id}: rejection needs a concrete reason (at least ${MIN_REASON_LENGTH} characters)`);
    } else if (disposition.status === 'confirmed') {
      if (!Array.isArray(disposition.testFiles) || disposition.testFiles.length === 0 || typeof disposition.testCommand !== 'string' || !disposition.testCommand.trim()) {
        problems.push(`${id}: confirmed findings need testFiles (non-empty array) and testCommand`);
      }
    } else if (disposition.status === 'deferred') {
      if (String(disposition.reason ?? '').trim().length < MIN_REASON_LENGTH) problems.push(`${id}: deferral needs a concrete reason (at least ${MIN_REASON_LENGTH} characters)`);
      if (!candidatesText.includes(id)) problems.push(`${id}: deferred findings must be recorded in ${CANDIDATES_FILE} (include the ID)`);
    } else problems.push(`${id}: status must be "confirmed", "rejected" or "deferred"`);
  }
  return problems;
}

const git = (...args) => spawnSync('git', args, { encoding: 'utf8' });

/** The red side must be a real commit in HEAD's history, and not HEAD itself. */
export function validateBase(base) {
  const resolved = git('rev-parse', '--verify', '--quiet', `${base}^{commit}`);
  if (resolved.status !== 0) return `the reviewed commit "${base}" does not exist`;
  const sha = resolved.stdout.trim();
  if (sha === git('rev-parse', 'HEAD').stdout.trim()) return `the reviewed commit is HEAD itself; commit the fixes on top of the reviewed commit`;
  if (git('merge-base', '--is-ancestor', sha, 'HEAD').status !== 0) return `the reviewed commit ${sha.slice(0, 12)} is not an ancestor of HEAD`;
  return null;
}

function proveRedToGreen(findings, dispositions, options, config) {
  const confirmed = findings.map(finding => ({ finding, id: findingId(finding), disposition: dispositions[findingId(finding)] }))
    .filter(item => item.disposition?.status === 'confirmed');
  if (!confirmed.length) return [];
  const timeout = config.timeoutSeconds ?? 600;
  const invalid = validateBase(options.base);
  if (invalid) return [invalid];
  console.log(`Red side: ${options.base} (from ${options.baseSource})`);
  const baseDir = mkdtempSync(join(tmpdir(), 'review-gate-base-'));
  const problems = [];
  const added = spawnSync('git', ['worktree', 'add', '--detach', baseDir, options.base], { encoding: 'utf8' });
  if (added.status !== 0) return [`cannot check out base ${options.base}: ${added.stderr.trim()}`];
  try {
    if (config.installCommand) {
      const install = run(config.installCommand, baseDir, timeout);
      if (install.code !== 0) return [`install failed on base:\n${install.output}`];
    }
    for (const { id, disposition } of confirmed) {
      for (const file of disposition.testFiles) {
        if (!existsSync(file)) { problems.push(`${id}: test file ${file} does not exist on head`); continue; }
        mkdirSync(dirname(join(baseDir, file)), { recursive: true });
        cpSync(file, join(baseDir, file));
      }
      const onBase = run(disposition.testCommand, baseDir, timeout);
      if (onBase.code === 0) problems.push(`${id}: the test PASSES on ${options.base} (the reviewed code), so it does not demonstrate the problem`);
      else if (WRONG_REASON.test(onBase.output)) problems.push(`${id}: the test fails on base for the wrong reason (it never reached its assertions). Test the behavior through an API that exists on base:\n${onBase.output.slice(-600)}`);
      const onHead = run(disposition.testCommand, process.cwd(), timeout);
      if (onHead.code !== 0) problems.push(`${id}: the test FAILS on head, so the fix is not proven:\n${onHead.output}`);
    }
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', baseDir]);
    rmSync(baseDir, { recursive: true, force: true });
  }
  return problems;
}

function summarize(findings, dispositions, problems) {
  const lines = ['## AI review gate', ''];
  if (!findings.length) lines.push('No findings.');
  for (const finding of findings) {
    const id = findingId(finding);
    const disposition = dispositions[id];
    const status = disposition?.status ?? 'MISSING';
    lines.push(`- \`${id}\` **${status}** - ${finding.summary} (${finding.file}:${finding.line ?? '?'})`);
    if (finding.failure_scenario) lines.push(`  - scenario: ${finding.failure_scenario}`);
    if (status === 'rejected' || status === 'deferred') lines.push(`  - reason: ${disposition.reason}`);
    if (status === 'confirmed') lines.push(`  - evidence: ${disposition.testFiles.join(', ')}`);
  }
  lines.push('', problems.length ? `### Gate failed\n${problems.map(problem => `- ${problem}`).join('\n')}` : '### Gate passed');
  return lines.join('\n');
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (!existsSync(options.review)) {
    console.error(`Review output not found at ${options.review}. The AI review job must run first (fails closed).`);
    return 1;
  }
  const reviewText = readFileSync(options.review, 'utf8');
  const findings = extractFindings(reviewText);
  if (options.base) options.baseSource = '--base';
  else if (reviewedSha(reviewText)) { options.base = reviewedSha(reviewText); options.baseSource = 'review.json reviewed_sha'; }
  else { options.base = defaultBase(); options.baseSource = process.env.REVIEW_BASE_REF ? 'REVIEW_BASE_REF' : 'default branch'; }
  if (options.list) {
    for (const finding of findings) console.log(`${findingId(finding)}  ${finding.file}:${finding.line ?? '?'}  ${finding.summary}`);
    return 0;
  }
  const dispositions = existsSync(options.dispositions) ? JSON.parse(readFileSync(options.dispositions, 'utf8')).findings ?? {} : {};
  const config = existsSync(options.config) ? JSON.parse(readFileSync(options.config, 'utf8')) : {};
  const candidatesText = existsSync(CANDIDATES_FILE) ? readFileSync(CANDIDATES_FILE, 'utf8') : '';
  const problems = checkDispositions(findings, dispositions, candidatesText);
  if (!problems.length && options.evidence) problems.push(...proveRedToGreen(findings, dispositions, options, config));
  const summary = summarize(findings, dispositions, problems);
  console.log(summary);
  if (options.summary) writeFileSync(options.summary, summary);
  return problems.length ? 1 : 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exit(main());
