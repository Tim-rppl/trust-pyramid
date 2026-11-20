# Changelog

## Unreleased

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
