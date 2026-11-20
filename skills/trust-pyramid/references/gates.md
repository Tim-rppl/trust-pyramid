# Gates - making the checks unskippable

Prose can be skipped. Gates run automatically at fixed moments. Layer them: early gates are fast,
late gates are impossible to bypass. Every gate runs the same `scripts/check.sh`, so a failure
looks identical everywhere and "passes locally, fails in CI" does not happen.

| # | When | Mechanism | Purpose | Bypassable? |
|---|---|---|---|---|
| 1 | while coding | agent runs typecheck/lint | fastest feedback | yes |
| 2 | agent tries to finish its turn | Stop hook (Claude Code, Codex) | no "done" until checks pass | hard; config is local |
| 3 | `git commit` | `.githooks/pre-commit` | also covers humans and other tools | `--no-verify` |
| 4 | pull request | CI: check + smoke + AI review + review gate, **using the base branch's gate files** | runs on the server | **no**, with branch protection + code owners |
| 5 | merge | human approval | looks at evidence, not diffs | final say |

## The gates must not trust the code they check

A PR is written by the agent being checked, and the gate definitions live in the same repo. In a
field test, an agent's PR could pass naive CI by turning the rule off in the lint config, deleting
the check from `scripts/check.sh`, or adding the source folder to the linter's ignore list; local
hooks fall to the same tricks. Three defenses, all installed by this skill:

1. **Trusted CI** - `scripts/trusted-check.sh <base>` restores every path in
   `quality/protected-paths.txt` (read from the base commit) before running the checks, and CI runs
   the base commit's copy of that script and of `review-gate.mjs`. Loosening a rule never applies
   to the PR that loosens it; stricter rules apply after they merge.
2. **No new suppressions** - `scripts/no-suppressions.sh` fails when a change adds
   `eslint-disable`, `@ts-ignore`, `# noqa`, `# type: ignore` and similar. Exceptions go into
   `quality/allowed-suppressions.txt`, which is protected.
3. **Humans own the gate files** - `.github/CODEOWNERS` lists the protected paths; enable "Require
   review from Code Owners". Claude Code's `permissions.deny` in `.claude/settings.json` blocks the
   agent's edit tools on those paths (friction only: shell commands can still change files, which is
   why 1 and 2 exist).

Local gates (Stop hook, pre-commit) are for fast feedback and can be defeated by an agent that
edits them; only trusted CI with branch protection is unskippable. Say this plainly to the user.

## scripts/check.sh

Copy `templates/scripts/check.sh` and edit the `CHECKS` table (each entry: space-separated path
prefixes, a label, a command). Behavior:

- Runs only for packages with changes (`--staged` for pre-commit, `--all` for CI).
- Prints only failures. It recognizes `node --test` (spec and TAP), pytest (`-rf --tb=short`) and
  jest/vitest/go output; long lines are cut (assertion dumps of whole files hide the real error).
  For other runners, pick a reporter that prints a failure summary and extend `summarize()`.
- Exit code is the only contract.

## Pre-commit

`templates/githooks/pre-commit` → `.githooks/pre-commit`, then `git config core.hooksPath .githooks`.
Document the one-time `git config` in the README; add a `prepare`/`postinstall` script that sets it
when the package manager supports it.

## Stop hook (one script, both agents)

`templates/scripts/stop-gate.sh` → `scripts/stop-gate.sh` (one script for both agents). Behavior:

- Runs `scripts/check.sh`. Pass: prints `{}` to stdout and exits 0 (Codex requires JSON on stdout
  when a Stop hook exits 0; Claude Code accepts it).
- Fail: writes the failures to stderr and exits 2. Both agents treat this as "keep working" and
  feed stderr back as the reason.
- After 3 failed attempts it blocks once more with "stop and explain the failure to the user", then
  lets the turn end with a visible `systemMessage`. No infinite loops, and the hand-over is never
  silent (stderr on exit 0 is not shown to the model). Claude Code also has its own cap.

Registration:
- Claude Code: `templates/claude/settings.json` → `.claude/settings.json` (uses `$CLAUDE_PROJECT_DIR`).
- Codex: `templates/codex/hooks.json` → `.codex/hooks.json` (resolves the script from the git root).
  Codex only loads project hooks from trusted projects and asks the user to review and trust new or
  changed hooks; tell the user to approve it once.

## CI

`templates/github/workflows/quality.yml` → `.github/workflows/quality.yml`. Jobs:

1. `check` - `scripts/check.sh --all`
2. `smoke` - `node verify/app.mjs up && node verify/smoke.mjs`, uploads screenshots
3. `ai-review` - runs the reviewer once per code diff (cached by diff hash), uploads `review.json`,
   posts findings as a PR comment
4. `review-gate` - `node scripts/review-gate.mjs` (see `layer-5-ai-reviewer.md`)

## Branch protection (the user must do this once)

Settings → Branches → protect `main`: require a pull request, require status checks `check`,
`smoke`, `review-gate`, require 1 approval, and do not allow bypassing. Or with the GitHub CLI
(`gh api -X PUT repos/<owner>/<repo>/branches/main/protection ...`). Explain to the user in plain
language that this is what makes the checks truly mandatory.

## PR template

`templates/github/pull_request_template.md`: plain-language summary, smoke result, screenshots,
reviewer findings with dispositions. The human approves from this page.
