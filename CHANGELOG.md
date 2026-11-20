# Changelog

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
