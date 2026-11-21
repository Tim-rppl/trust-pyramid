# Changelog

## 0.4.3 - 2026-11-21

Fixes from a field test of 0.4.2 (#32-#36).

- **Stop hook checks only this session's worktrees:** the session's checkout, the worktree containing
  the hook's `cwd`, and worktrees the session's transcript mentions. Other sessions' worktrees no
  longer block or slow down this session. `STOP_GATE_WORKTREES=all|none` (#36).
- **Manual runs do not use up attempts:** only runs started by the host (hook input with
  `hook_event_name`) count, per `session_id`, and only they update the "Stop hook last ran" proof in
  `hook-status.sh` (#35).
- **Worktree interceptions are logged:** `gate-log.sh` writes to the main checkout's log, with a
  `worktree` field, so `gate-report.mjs` counts them (#32). It also escapes backslashes correctly.
- **More skipped tests are caught:** `it.skip (` with a space, `const later = it.skip`, runtime
  skips such as `t.skip()`, `ctx.skip('why')`, `this.skip()` (#34).
- **TypeScript tests are type-checked:** setup docs and the TypeScript recipe add a
  `tsconfig.test.json` when the project's config leaves tests out, with a baseline for existing
  errors; the reviewer prompt looks for tests that cannot fail, such as fakes that no longer match
  their interface (#33).

### Upgrade notes

- `scripts/stop-gate.sh`, `scripts/gate-log.sh`, `scripts/no-suppressions.sh`,
  `scripts/hook-status.sh` and `quality/reviewer-prompt.md` change; the upgrade merges them.
- To test the Stop hook by hand, run `echo '{}' | bash scripts/stop-gate.sh`; it no longer affects
  the agent's attempts. `hook-status.sh` shows "last ran" only after a real Stop in a new session.
- TypeScript projects: check whether the typecheck covers the test files (`references/stack-recipes.md`).

## 0.4.2 - 2026-11-21

Fixes from a field test of 0.4.1 on a real project (#26, #27, #28; report in #29).

- **Skipped and focused tests are caught:** `no-suppressions.sh` fails when a test file gains
  `it.skip`, `test.only`, `describe.skip`, `xit`, `{ skip: true }`, `@pytest.mark.skip`,
  `pytest.skip()`, `@unittest.skip` or Go `t.Skip()`, with the same protected allowlist (#27).
- **Checks have a time limit:** `check.sh` stops a check that runs too long (120 s for fast checks,
  900 s for the others; `TRUST_CHECK_TIMEOUT` or `fast,timeout=<seconds>`), with its child
  processes, and says it timed out. CI templates set `timeout-minutes` (#28).
- **Worktrees are checked:** the Stop hook also checks every linked git worktree with uncommitted
  changes, and `hook-status.sh` in a worktree reads the main checkout's hook settings (#26).
- **Docs:** test runner time limits per stack; run long suites in the background.

### Upgrade notes

- `scripts/check.sh`, `scripts/stop-gate.sh`, `scripts/no-suppressions.sh`, `scripts/hook-status.sh`
  and the CI workflows change; the upgrade merges them. The new skip check applies to lines added
  after the upgrade, not to skips already in the code.
- A check that legitimately takes longer than 120 s (fast) or 900 s needs `timeout=<seconds>` in its
  `CHECKS` entry.

## 0.4.1 - 2026-11-21

Fixes from a field test of the 0.4.0 upgrade on a real project (#23).

- **Adopting a 0.3.0 installation merges for real:** `upgrade.mjs record --from <version>` records
  the templates of the release the project was installed from (from the skill's git tag, or
  downloaded from GitHub), so the first upgrade is a three-way merge instead of manual work.
  `record` no longer claims a project's own file that sits at a template path (such as its own
  `lint/oxlint.mjs`); it lists it instead.
- **Rule IDs in the gate log:** `gate-log.sh` reads rule IDs only where linters print them
  (`plugin(rule):`, `[Error/plugin(rule)]`, a code after `file:line:`), so code quoted in a fix-it
  message (`t(key)`, `var(--x)`) no longer counts as a rule in `gate-report.mjs`.
- **One Stop hook registration:** `install-agent-hooks.sh` does not add the Stop hook to
  `.claude/settings.json` when `.claude/settings.local.json` already has it (or the other way round),
  and says where it is.
- **Docs:** `references/upgrade.md` says what conflicts to expect and not to run
  `trusted-check.sh` locally (it restores the base branch's gate files into the working tree).

### Upgrade notes

- From 0.3.0 or earlier: `record --from 0.3.0`, then upgrade (`references/upgrade.md`, "Adopting an
  older installation"). This replaces the 0.4.0 advice to record with the current templates.
- A project that edited its templates can expect one conflict per file that both sides changed,
  not only in `scripts/check.sh`. In 0.4.0, `stop-gate.sh` stops blocking when it cannot find the
  repository (it hands over with a visible message), which may show up as one of them.
- From 0.4.0: nothing to do beyond the upgrade; `scripts/gate-log.sh` and
  `scripts/install-agent-hooks.sh` are replaced or merged.

## 0.4.0 - 2026-11-21

**Upgrade mode.** `tools/upgrade.mjs` upgrades the files the skill installed in a project with a
three-way merge per file, keeping the project's changes. Setup now records
`quality/trust-pyramid.lock.json`; `install-manifest.json` says where each template goes and
whether it is mechanism (replaced), tailored (merged), content (never touched) or append.
Instructions: `references/upgrade.md`.

### Upgrade notes

- Projects set up with 0.3.0 or earlier have no lock file. Ask the agent to upgrade; it runs
  `upgrade.mjs record` once to adopt the current files and brings mechanism scripts up to date by
  hand. New in this release and worth installing: `scripts/hook-status.sh`, the updated
  `scripts/install-agent-hooks.sh`, `stop-gate.sh` and `.githooks/pre-commit`, the first rule in
  `AGENTS.md`, and the npm `prepare` script.
- Expect one conflict in `scripts/check.sh`: 0.4.0 marks the `CHECKS` table as a project section
  (`trust-pyramid:project-start checks`). Keep the project's table between the new markers; later
  upgrades then never conflict there.

Fixes from installing the skill on a real project on Windows 11 (issues #1-#15).

- **First install works on Windows:** LF line endings via `.gitattributes` (this repo and a template
  for installed projects); scripts called through `bash` and committed as `100755`; oxlint run
  through `node` (`lint/oxlint.mjs`); Python tests fall back to `python` / `py -3`; CI also runs on
  `windows-latest`.
- **Gates:** `no-suppressions.sh` no longer flags itself; the Stop hook finds the repository from
  its own location; when it cannot, it says so in a visible `systemMessage` instead of blocking in a
  loop (the Codex hook command also works from subfolders and no longer fails with exit 127 outside a
  repository); the PR that introduces the gates gets a labelled
  "Gate bootstrap" result instead of exit code 128; trusted-check uses the base branch's npm
  `scripts`; gate interceptions are logged (`scripts/gate-log.sh`, `scripts/gate-report.mjs`).
- **The Stop hook is enabled, not just staged:** `install-agent-hooks.sh` asks, then merges into
  existing `.claude/settings.json`, `.claude/settings.local.json` and `.codex/hooks.json` (it used
  to skip any file that existed, so the hook stayed off) and enables pre-commit.
  `scripts/hook-status.sh` reports what is on and when the Stop hook last ran; setup does not pass
  Phase 5 until it is clean; pre-commit reminds on every commit while the hook is off. For a user
  who never ran the installer: `AGENTS.md` tells the agent to run `hook-status.sh` at the start of
  each session and explain how to enable the gates, and JS projects get a `prepare` script so
  `npm install` enables pre-commit.
- **Setup:** branch protection availability and team size are checked in Phase 0 (GitHub Free
  private repos, solo maintainers); CI is split per layer (`quality.yml`, `quality-smoke.yml`,
  `quality-review.yml`); the deny list is per machine and rules are written in a separate worktree;
  Phase 8 adds a blind review, a recurrence probe PR, violation counts and demo cleanup.
- **Docs:** one sourced set of cost figures; the Stop hook's scope; reviewer sweep cost estimates.
- **Optional rule pack:** `templates/github-text/` checks the language of PR text and commit
  messages and keeps AI tool markers out of PR descriptions.

## 0.3.0 - 2026-11-21

Results of a field benchmark with real Claude Code and Codex runs (see docs/BENCHMARK.md).

- **Profiles:** lite (default) and full. Lite keeps project rules, tests, trusted CI and a fast
  Stop hook, and runs the AI reviewer once per PR in CI.
- **Trusted CI:** CI checks each PR with the base branch's gate files (`scripts/trusted-check.sh`);
  new suppression comments fail (`scripts/no-suppressions.sh`); CODEOWNERS and Claude Code deny
  rules protect gate files. Closes bypasses found in an attack test.
- **Stop hook:** runs only checks marked `|fast`, caps attempts at 2 (`STOP_GATE_MAX_ATTEMPTS`),
  and tells the agent to hand over at once when a fix needs a protected file.
- **Setup:** hook configs are staged and installed by the user (`scripts/install-agent-hooks.sh`);
  the protected-path deny list goes in last; gates are re-verified on the committed tree; no
  Cypress or desktop browsers; tell the user the setup cost.
- **AI client guidance:** one total deadline across retries for user-facing calls.
- **README:** what we measured, profiles, and pstack pairing marked optional.

## 0.1.1 - 2026-11-20

- Review gate proves confirmed findings against the reviewed commit (`reviewed_sha` in
  `review.json`, written by CI), so bugs introduced by the PR itself can be proven too.
- Review gate rejects a reviewed commit that is missing, not an ancestor of HEAD, or HEAD itself,
  and prints which commit it used.
- README: demo GIF recorded from a real demo project; pstack pairing guide.

## 0.1.0 - 2026-11-20

First release.

- `trust-pyramid` skill for Claude Code (skill + plugin marketplace) and Codex.
- Six-layer workflow: structure, static analysis, verification, prose, enforced AI reviewer, human.
- Gates: `check.sh`, a Stop hook shared by Claude Code and Codex, pre-commit, GitHub Actions workflow.
- Review gate that machine-checks red → green evidence for confirmed findings.
- Verify CLI (Playwright over CDP), smoke flow, feature map, OpenAI-compatible fake model server.
- Stack recipes and lessons learned from a production rollout and a Python/FastAPI field test.
- Review dispositions: confirmed (red → green, failing at an assertion), rejected, deferred (tracked).
- Python AST rule template with fixtures.
