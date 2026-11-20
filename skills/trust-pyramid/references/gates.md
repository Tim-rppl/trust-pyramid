# Gates - making the checks unskippable

Prose can be skipped. Gates run automatically at fixed moments. Layer them: early gates are fast,
late gates are impossible to bypass. Every gate runs the same `scripts/check.sh`, so a failure
looks identical everywhere and "passes locally, fails in CI" does not happen.

| # | When | Mechanism | Purpose | Bypassable? |
|---|---|---|---|---|
| 1 | while coding | agent runs typecheck/lint | fastest feedback | yes |
| 2 | agent tries to finish its turn | Stop hook (Claude Code, Codex) | no "done" until checks pass | hard; config is local |
| 3 | `git commit` | `.githooks/pre-commit` | also covers humans and other tools | `--no-verify` |
| 4 | pull request | CI: check + smoke + AI review + review gate, **using the base branch's gate files** | runs on the server | **no**, with branch protection (+ code owners for teams); advisory where the plan has no branch protection |
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

## Windows: line endings and the executable bit

**Executable bit.** Git for Windows runs with `core.fileMode=false`, so `chmod +x` never reaches the
index and the scripts are committed as `100644`. Linux CI and macOS/Linux clones then fail with
`Permission denied` wherever a script is run directly, and git skips a `.githooks/pre-commit`
without the bit. The templates call every script through `bash <script>` so the mode matters less,
but git itself runs hooks directly. After copying the templates, on every OS:

```bash
git add scripts .githooks
git update-index --chmod=+x scripts/*.sh .githooks/*
git ls-files -s scripts .githooks   # every *.sh and hook must show 100755
```

**Line endings.**

Git for Windows defaults to `core.autocrlf=true`, which checks text files out with CRLF line
endings. bash cannot run a CRLF script, and hooks copied from a CRLF checkout carry CRLF too.
Install `templates/gitattributes` as (or append it to) `.gitattributes` **before** the first commit
of the gate files, so every clone gets LF for `scripts/`, `.githooks/`, `lint/`, `quality/`,
`verify/`, `.github/`, `.claude/` and `.codex/`. If gate files were already committed from a CRLF
working tree, run `git add --renormalize .` once and commit the result.

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

- Finds the repository from its own location, not from the current directory (the agent may have
  changed directory, or the host may start hooks elsewhere). If it cannot find it, it exits 2 with
  `stop-gate: cannot find the repository` instead of letting the turn end unchecked. Register it as
  `bash "$CLAUDE_PROJECT_DIR/scripts/stop-gate.sh"` so neither the executable bit nor the shebang
  matters (Windows).
- Runs `scripts/check.sh`. Pass: prints `{}` to stdout and exits 0 (Codex requires JSON on stdout
  when a Stop hook exits 0; Claude Code accepts it).
- Fail: writes the failures to stderr and exits 2. Both agents treat this as "keep working" and
  feed stderr back as the reason.
- Runs only checks marked `|fast` in `scripts/check.sh` (typecheck, lint, quick tests), so ending a
  turn costs seconds. Pre-commit and CI run everything.
- After `STOP_GATE_MAX_ATTEMPTS` failed attempts (default 2) it blocks once more with "stop and
  explain the failure to the user", then lets the turn end with a visible `systemMessage`. The
  failure message also tells the agent to hand over at once when the fix needs a protected file.
  In a benchmark, a 3-attempt cap plus protected-file failures made one task cost 4x the baseline.

Registration (staged by the agent, installed by the user with `scripts/install-agent-hooks.sh`,
because each agent protects its own config folder; in testing, Claude could not write
`.claude/settings.json` and Codex could not write `.codex/`):
- Claude Code: `templates/claude/settings.json` → `quality/install/claude-settings.json` → `.claude/settings.json`.
- Codex: `templates/codex/hooks.json` → `quality/install/codex-hooks.json` → `.codex/hooks.json`.
  Codex only loads project hooks from trusted projects and asks the user to review and trust new or
  changed hooks; tell the user to approve it once.

## CI

One workflow per layer, so CI never turns red for a layer that is not installed. Install only the
ones that apply:

| Template | Jobs (status checks) | Install when |
|---|---|---|
| `templates/github/workflows/quality.yml` | `check` - `scripts/check.sh --all` | always |
| `templates/github/workflows/quality-smoke.yml` | `smoke` - `node verify/app.mjs up && node verify/smoke.mjs`, uploads screenshots | `verify/` is installed (Layer 3) |
| `templates/github/workflows/quality-review.yml` | `ai-review` - the reviewer once per code diff (cached by diff hash), uploads `review.json`, posts findings as a PR comment; `review-gate` - `node scripts/review-gate.mjs` (see `layer-5-ai-reviewer.md`) | the reviewer is installed **and** the API key secret is set |

A lite setup without `verify/` or without an API key starts with `quality.yml` alone; add the
others later by copying them in, then add their status checks to branch protection. Edit the
dependency install step (`TODO(trust-pyramid)`) in each copied workflow.

### Bootstrap: the PR that introduces the gates

CI runs the base branch's gate files, and on the PR that adds them the base has none. The workflow
detects this (`git cat-file -e "$BASE_SHA:scripts/trusted-check.sh"`) and runs the PR's own copies
instead, labelled with a `Gate bootstrap` warning and a line in the job summary. Without that
check, `git show` stops the job with `fatal: path 'scripts/trusted-check.sh' exists on disk, but
not in '<base sha>'` (exit code 128), which reads like a broken setup. Tell the user:

- The gate PR is checked by its own (untrusted) gate files; that is expected once. Every PR opened
  after it merges is checked with the base branch's copies.
- To see the trusted path work before merging into the default branch, stack the branches: merge
  the gate PR into a throwaway base branch first, open a small probe PR against that branch, and
  confirm the `check` job uses the base copies (no `Gate bootstrap` warning). Then merge the gate PR
  into the default branch.

## Branch protection (the user must do this once)

Branch protection is what makes the checks mandatory. Check availability in Phase 0, not after
building: on GitHub Free, private repositories get neither branch protection nor rulesets
(`gh api repos/<owner>/<repo>/branches/main/protection` and `.../rulesets` return 403 "Upgrade to
GitHub Pro or make this repository public to enable this feature"). Public repositories and paid
plans have both.

**Team (two or more people who can approve).** Settings → Branches (or Rules → Rulesets) → protect
`main`: require a pull request, require the status checks you installed (`check`, and `smoke`,
`review-gate` if installed), require 1 approval, require review from Code Owners, and do not allow
bypassing. Or with the GitHub CLI (`gh api -X PUT repos/<owner>/<repo>/branches/main/protection ...`).

**One maintainer.** GitHub does not let an author approve their own PR, so required approvals or
code-owner review would block every merge. Require a pull request and the status checks, with no
required approvals and no code-owner review. CODEOWNERS still marks gate files in the PR view, and
trusted CI still checks every PR with the base branch's gate files.

**No branch protection available (private repository on GitHub Free).** The PR checks still run but
are advisory: nothing stops a merge while they are red. Tell the user plainly, and set up the
fallback:
- check the PR's checks before every merge (`gh pr checks <n> --watch`) and never merge on red;
- make the deploy workflow run the same checks (`scripts/check.sh --all` and the tests) before it
  deploys, so a red change never reaches users - that is the hard stop;
- revisit when the repository becomes public or the plan changes.

Explain to the user in plain language which of these applies and what it means.

## PR template

`templates/github/pull_request_template.md`: plain-language summary, smoke result, screenshots,
reviewer findings with dispositions. The human approves from this page.
