# Changelog

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
