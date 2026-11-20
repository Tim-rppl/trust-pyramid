// Optional rule pack: text that lands on GitHub.
//   github/language       PR titles, PR descriptions and commit messages use the project's language
//                         (by writing system: text in other scripts is reported).
//   github/no-ai-markers  PR descriptions describe the change and its evidence only: no AI tool or
//                         vendor names, no "generated with" / co-author lines, no robot emoji.
// Code spans and fenced code blocks are skipped, so a file name (`CLAUDE.md`) or a quoted UI string
// in another language can still be mentioned inside backticks.
//
//   CI, pull request:  PR_TITLE=... PR_BODY=... node scripts/check-github-text.mjs --pr
//   CI, commits:       node scripts/check-github-text.mjs --commits <base> [<head>]
//   commit-msg hook:   node scripts/check-github-text.mjs --message <file>
// Self-contained on purpose: CI runs the base branch's copy from a temporary directory, so the
// configuration lives here too. This is a gate file: protect it like the rest of scripts/.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const CONFIG = {
  // Language rule. Unicode scripts that letters may use (https://unicode.org/reports/tr24/), e.g.
  // ['Latin'] for English, ['Latin', 'Cyrillic'] to also allow Russian. null switches the rule off.
  // The check is by writing system: it cannot tell English from another Latin-script language.
  language: { name: 'English', scripts: ['Latin'] },
  // Which texts the AI marker rule checks: 'pr-title', 'pr-body', 'commit'. [] switches it off.
  markersIn: ['pr-body'],
  // Each marker: a name for the message and a pattern, matched outside code spans and blocks.
  markers: [
    { name: 'Claude', pattern: /\bclaude\b/i },
    { name: 'Codex', pattern: /\bcodex\b/i },
    { name: 'Anthropic', pattern: /\banthropic\b/i },
    { name: 'ChatGPT', pattern: /\bchatgpt\b/i },
    { name: 'Copilot', pattern: /\bcopilot\b/i },
    { name: 'Gemini', pattern: /\bgemini\b/i },
    { name: '"generated with/by"', pattern: /\bgenerated\s+(?:with|by)\b/i },
    { name: '"AI-generated"', pattern: /\bai[\s-]generated\b/i },
    { name: 'Co-Authored-By', pattern: /\bco-authored-by\b/i },
    { name: 'robot emoji', pattern: /\u{1F916}/u },
  ],
};

/** Letters outside the allowed scripts, plus CJK and full-width punctuation. */
export function languagePattern(scripts) {
  const allowed = scripts.map(script => `\\p{Script=${script}}`).join('');
  return new RegExp(`(?:(?![${allowed}])[\\p{L}\\u3000-\\u303F\\uFF00-\\uFFEF])+`, 'u');
}

/** Blank out fenced code blocks and inline code spans, keeping line numbers. */
function stripCode(text) {
  return text
    .replace(/```[\s\S]*?```/g, block => block.replace(/[^\n]/g, ' '))
    .replace(/`[^`\n]*`/g, span => ' '.repeat(span.length));
}

/** Lines of the text with code removed; git comment lines ("# ...") blanked when `gitComments`. */
function lines(text, gitComments) {
  return stripCode(text ?? '').split(/\r?\n/).map(line => (gitComments && line.startsWith('#') ? '' : line));
}

/** Text outside the configured language, one entry per line: { line, sample }. */
export function findOtherLanguage(text, { gitComments = false, config = CONFIG } = {}) {
  if (!config.language) return [];
  const pattern = languagePattern(config.language.scripts);
  const found = [];
  lines(text, gitComments).forEach((line, index) => {
    const match = pattern.exec(line);
    if (match) found.push({ line: index + 1, sample: match[0].slice(0, 12) });
  });
  return found;
}

/** AI tool or vendor markers, one entry per marker and line: { line, marker }. */
export function findAiMarkers(text, { gitComments = false, config = CONFIG } = {}) {
  const found = [];
  lines(text, gitComments).forEach((line, index) => {
    for (const marker of config.markers) if (marker.pattern.test(line)) found.push({ line: index + 1, marker: marker.name });
  });
  return found;
}

const MARKER_HINT = 'Describe what changed, why, and the evidence. Remove AI tool or vendor names and '
  + '"generated with" / "Co-Authored-By" lines. A file name can stay inside backticks, e.g. `CLAUDE.md`.';

/** All problems for one text. `kind` is 'pr-title', 'pr-body' or 'commit'. */
export function checkText(kind, text, { where = kind, gitComments = false, config = CONFIG } = {}) {
  const problems = [];
  for (const { line, sample } of findOtherLanguage(text, { gitComments, config })) {
    problems.push(`${where} line ${line}: not ${config.language.name} ("${sample}"). Write PR titles, PR descriptions `
      + `and commit messages in ${config.language.name}. A quoted UI string or file name can stay inside backticks.`);
  }
  if (config.markersIn.includes(kind)) {
    for (const { line, marker } of findAiMarkers(text, { gitComments, config })) problems.push(`${where} line ${line}: ${marker}. ${MARKER_HINT}`);
  }
  return problems;
}

function checkCommits(base, head = 'HEAD') {
  const log = execFileSync('git', ['log', '--format=%H%x1f%B%x1e', `${base}..${head}`], { encoding: 'utf8' });
  return log.split('\x1e').flatMap(record => {
    const [sha, message] = record.trim().split('\x1f');
    if (!sha || message === undefined) return [];
    return checkText('commit', message, { where: `commit ${sha.slice(0, 7)} message` })
      .map(problem => `${problem} Reword it (git rebase -i, then force-push the branch).`);
  });
}

function main() {
  const [mode, ...args] = process.argv.slice(2);
  const problems = mode === '--pr'
    ? [...checkText('pr-title', process.env.PR_TITLE, { where: 'PR title' }), ...checkText('pr-body', process.env.PR_BODY, { where: 'PR description' })]
    : mode === '--commits' ? checkCommits(args[0], args[1])
    : mode === '--message' ? checkText('commit', readFileSync(args[0], 'utf8'), { where: 'commit message', gitComments: true })
    : null;
  if (!problems) { console.error('usage: check-github-text.mjs --pr | --commits <base> [<head>] | --message <file>'); process.exit(2); }
  if (problems.length === 0) { console.log('✓ GitHub text rules'); return; }
  console.error('✗ GitHub text rules');
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
