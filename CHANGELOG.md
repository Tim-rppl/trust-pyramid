# Changelog

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
