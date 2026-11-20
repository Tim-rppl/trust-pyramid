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
   to the PR that loosens it; stricter rules apply after they merge. `package.json` cannot be
   protected as a whole (it carries dependency changes), so trusted-check restores only its
   `"scripts"` from the base: a PR that changes `"lint": "tsc --noEmit"` to `"lint": "true"` is
   still checked with the old script.
2. **No new suppressions** - `scripts/no-suppressions.sh` fails when a change adds
   `eslint-disable`, `@ts-ignore`, `# noqa`, `# type: ignore` and similar. Exceptions go into
   `quality/allowed-suppressions.txt`, which is protected.
3. **Humans own the gate files** - `.github/CODEOWNERS` lists the protected paths; enable "Require
   review from Code Owners". Claude Code's `permissions.deny` in `.claude/settings.local.json` blocks
   the agent's edit tools on those paths (friction only: shell commands can still change files, which
   is why 1 and 2 exist). It is per machine on purpose: rule-writing sessions run in a separate git
   worktree where the file is absent (see "Changing gate files" below).

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
- Prefer calling tools directly (`node_modules/.bin/tsc -p web --noEmit`, `node lint/oxlint.mjs ...`,
  the test runner with explicit files) over `npm run <script>`: what a direct command does is defined
  in `scripts/check.sh`, which is protected. When a check does go through an npm script,
  trusted-check uses the base branch's `"scripts"` for every `package.json` the base has.

## Pre-commit

`templates/githooks/pre-commit` → `.githooks/pre-commit`, then `git config core.hooksPath .githooks`
(`scripts/install-agent-hooks.sh` asks and does it). On every commit it also runs
`scripts/hook-status.sh --quiet` and prints a reminder while the agent Stop hook is not enabled; the
reminder never blocks the commit.
Document the one-time `git config` in the README; add a `prepare`/`postinstall` script that sets it
when the package manager supports it.

## Stop hook (one script, both agents)

`templates/scripts/stop-gate.sh` → `scripts/stop-gate.sh` (one script for both agents). Behavior:

- Finds the repository from its own location, not from the current directory (the agent may have
  changed directory, or the host may start hooks elsewhere). If it cannot find it, it prints
  `stop-gate: cannot find the repository` as a visible `systemMessage` and lets the turn end: never
  silent, and never a block the agent cannot clear (exit 2 there would loop until the host's cap).
  Register it as `bash "$CLAUDE_PROJECT_DIR/scripts/stop-gate.sh"` (Claude Code) so neither the
  executable bit nor the shebang matters (Windows). Codex has no project-directory variable; its
  command finds the repository from the session directory (subfolders work) and, outside any
  repository, prints the same kind of visible `systemMessage` instead of failing with exit 127.
- Runs `scripts/check.sh`. Pass: prints `{}` to stdout and exits 0 (Codex requires JSON on stdout
  when a Stop hook exits 0; Claude Code accepts it).
- Fail: writes the failures to stderr and exits 2. Both agents treat this as "keep working" and
  feed stderr back as the reason.
- Runs only checks marked `|fast` in `scripts/check.sh` (typecheck, lint, quick tests), so ending a
  turn costs seconds. Pre-commit and CI run everything.
- Checks only **uncommitted** changes (`git diff HEAD` plus untracked files). Work the agent already
  committed but has not pushed is not checked by the Stop hook; pre-commit checked it at commit time
  and CI checks it on the PR. The hook is fast feedback, not a guarantee.
- Shared or local: committed in `.claude/settings.json`, the hook runs for everyone who uses Claude
  Code on the project; in `.claude/settings.local.json` it runs only on this machine. Ask the user in
  Phase 5. Codex reads `.codex/hooks.json` (committed) and asks each user to trust it.
- After `STOP_GATE_MAX_ATTEMPTS` failed attempts (default 2) it blocks once more with "stop and
  explain the failure to the user", then lets the turn end with a visible `systemMessage`. The
  failure message also tells the agent to hand over at once when the fix needs a protected file.
  In a benchmark, a 3-attempt cap plus protected-file failures made one task cost 4x the baseline.

Registration (staged by the agent, installed by the user with `scripts/install-agent-hooks.sh`,
because each agent protects its own config folder; in testing, Claude could not write
`.claude/settings.json` and Codex could not write `.codex/`):
- Claude Code: `templates/claude/settings.json` → `quality/install/claude-settings.json` → `.claude/settings.json`
  (the hook), and `templates/claude/settings.local.json` → `quality/install/claude-settings.local.json` →
  `.claude/settings.local.json` (the deny list).
- Codex: `templates/codex/hooks.json` → `quality/install/codex-hooks.json` → `.codex/hooks.json`.
  Codex only loads project hooks from trusted projects and asks the user to review and trust new or
  changed hooks; tell the user to approve it once.

A hook that is not registered never runs, and nothing tells the user. So:
- `scripts/install-agent-hooks.sh` (the user runs it) shows each change and asks, then merges the
  staged config into the existing file: hook entries are added unless that command (or any
  `scripts/stop-gate.sh` entry) is already there, permission lists are unioned, nothing is removed,
  and the previous file is kept as `<file>.bak`. `--yes` applies without asking.
- `scripts/hook-status.sh` reports, per clone: the Claude Code and Codex Stop hooks (for the hosts
  staged in `quality/install/`), `disableAllHooks` in user or project settings, pre-commit, and
  when the Stop hook last ran (`stop-gate.sh` writes `.quality-state/stop-gate-last-run`). Exit 1
  when something expected is missing. Setup does not pass Phase 5 until it is clean.

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

## Changing gate files (new rules) without switching the deny list off

The deny list keeps the agent away from `lint/`, `scripts/` and the other gate files during feature
work, and `references/add-rule.md` asks the agent to write rules there. Both hold with one model:

1. Feature work happens in the main checkout, where `.claude/settings.local.json` denies edits to
   gate files.
2. A rule change happens in a separate worktree:
   `git worktree add ../<repo>-rule-<name> -b rule/<name>`, then start the agent there. The deny list
   is per machine and not committed, so it is absent in the new worktree (do not list it in a
   `.worktreeinclude` file). The agent writes the rule, fixtures and test, runs `scripts/check.sh`,
   commits and opens a PR.
3. A human reviews and merges that PR (CODEOWNERS marks the gate paths; trusted CI checks it with
   the base branch's rules). The new rule applies to every PR after the merge.

Nothing is switched off in the main checkout, and the gate change gets a human review.

## Gate log: what the gates actually caught

With `TRUST_GATE` set, `scripts/check.sh` records every failing check through
`scripts/gate-log.sh`: the Stop hook sets `stop-hook`, pre-commit `pre-commit`, and the CI `check`
job `ci`; trusted-check also records new suppression comments. Each block becomes one line in
`.quality-state/gate-log.jsonl` (date, gate, check label, rule IDs found in the output, such as
`project(no-raw-ui-text)` or `TP001`), and in CI a line in the job summary. Manual runs are not
logged. The local log is per machine and gitignored; CI's record is the job summary.

`node scripts/gate-report.mjs [--rules <id,id,...>]` prints blocks per week and gate, blocks per
rule, rules that fired in more than one week, and (with `--rules`) rules that never fired. This
answers the question users ask after setup: do the gates pay for themselves?

## Optional rule pack: text that lands on GitHub

Some teams want every PR title, PR description and commit message in one language, and PR
descriptions free of AI tool or vendor markers ("Generated with ...", "Co-Authored-By: ...", the
robot emoji). Offer it in Phase 0; install only on request:

| Template | Install as |
|---|---|
| `templates/github-text/check-github-text.mjs` | `scripts/check-github-text.mjs` (edit `CONFIG` at the top) |
| `templates/github-text/commit-msg` | `.githooks/commit-msg` (`git update-index --chmod=+x`) |
| `templates/github-text/github-text.yml` | `.github/workflows/github-text.yml`; make `github-text` a required check |

- `CONFIG.language`: the language's name and the Unicode scripts its letters may use
  (`['Latin']` for English). The check works by writing system, so it catches Chinese, Japanese,
  Cyrillic and similar, not another Latin-script language. `null` switches it off.
- `CONFIG.markersIn` (default: PR descriptions only) and `CONFIG.markers` (the names and phrases
  to reject). Code spans and fenced blocks are skipped, so `CLAUDE.md` in backticks or a quoted UI
  string stays allowed.
- The workflow runs the base branch's copy (bootstrap fallback on the PR that adds it), passes PR
  text through the environment only, and re-runs when the title or description is edited.

## PR template

`templates/github/pull_request_template.md`: plain-language summary, smoke result, screenshots,
reviewer findings with dispositions. The human approves from this page.
