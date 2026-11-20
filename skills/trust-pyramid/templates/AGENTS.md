# <Project name>

- First, once per session: run `bash scripts/hook-status.sh`. If it fails, tell the user in their own language that the quality gates are off and that they need to run `bash scripts/install-agent-hooks.sh` in a terminal and then start a new session. You cannot enable the hooks yourself; do not try.
- Layout and boundaries: see docs/QUALITY.md. Lint enforces them; follow the error messages and fix the root cause.
- Never disable a rule, skip a test, weaken an assertion, or use --no-verify. Do not write comments that excuse a workaround.
- A mistake corrected once becomes a lint rule or a test (quality/rule-candidates.md tracks the rest).
- Changed user-visible behavior: prove it in the running app (`node verify/app.mjs`), update verify/feature-map.md and verify/smoke.mjs.
- Before finishing: scripts/check.sh must pass (the Stop hook and pre-commit run it automatically).
- Before a PR: run the reviewer (quality/reviewer-prompt.md); every finding needs a disposition in quality/review-dispositions.json.
- AI calls only through the AI adapter; secrets only on the server.
