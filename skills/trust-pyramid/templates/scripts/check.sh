#!/usr/bin/env bash
# Deterministic quality checks. Runs only checks whose paths changed and prints only failures.
#   scripts/check.sh            changes in the working tree (staged + unstaged + untracked)
#   scripts/check.sh --staged   staged changes only (pre-commit)
#   scripts/check.sh --all      everything (CI)
#   scripts/check.sh --fast     only checks marked |fast (the agent's Stop hook: seconds, not minutes)
# With TRUST_GATE set (stop-hook, pre-commit, ci), each failing check is recorded by scripts/gate-log.sh.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

# One line per check: <space-separated path prefixes>|<label>|<command>[|fast]
# Mark cheap checks (typecheck, lint, fast unit tests) with |fast. The Stop hook runs only those;
# pre-commit and CI run everything.
# A prefix of "." runs the check on any change. Keep commands simple; put anything with
# $(...) or loops in a script file (it would expand when this array is defined).
# Prefer failure-focused reporters: node --test --test-reporter=spec, pytest -q -rf --tb=short.
CHECKS=(
  "web/ shared/|web: typecheck + lint|npm --prefix web run --silent lint|fast"
  "web/ shared/|web: unit tests|npm --prefix web run --silent test"
  "server/ shared/|server: typecheck + lint|npm --prefix server run --silent lint|fast"
  "server/ shared/|server: unit tests|npm --prefix server run --silent test"
  ".|no new suppression comments|bash scripts/no-suppressions.sh|fast"
  # Python example:
  # "app/ tests/ lint/ pyproject.toml|python: ruff + mypy|.venv/bin/ruff check . && .venv/bin/mypy --strict app"
  # "app/ tests/ pyproject.toml|python: tests|.venv/bin/pytest -q -rf --tb=short"
)

fast_only=0
if [[ "${1:-}" == "--fast" ]]; then fast_only=1; shift; fi
case "${1:-}" in
  --all) changed="." ;;
  --staged) changed=$(git diff --cached --name-only) ;;
  *) changed=$( { git diff --name-only HEAD 2>/dev/null; git ls-files --others --exclude-standard; } ) ;;
esac

applies() {
  [[ "$changed" == "." ]] && return 0
  local prefix
  for prefix in $1; do
    [[ "$prefix" == "." ]] && return 0
    grep -q "^${prefix}" <<<"$changed" && return 0
  done
  return 1
}

# Keep the failure, drop the noise: passing tests, stack frames, banners, giant assertion dumps.
summarize() {
  local output=$1
  if grep -q 'failing tests:' <<<"$output"; then                       # node --test (spec reporter)
    output=$(sed -n '/failing tests:/,$p' <<<"$output")
  elif grep -q 'short test summary info' <<<"$output"; then             # pytest -rf
    output=$(sed -n '/= FAILURES =/,$p' <<<"$output")
  elif grep -qE '^\s*not ok ' <<<"$output"; then                        # TAP (node --test when piped)
    output=$(grep -E -A14 '^\s*not ok ' <<<"$output" | grep -vE '^\s*(duration_ms|type|\.\.\.|---)')
  elif grep -qE '^(FAIL|FAILED)\b' <<<"$output"; then                   # jest/vitest/go test
    output=$(grep -E -A15 '^(FAIL|FAILED)\b' <<<"$output")
  fi
  grep -vE '^\s+at |^\s+File ".*site-packages' <<<"$output" | cut -c1-400 | tail -60
}

failed=0
for entry in "${CHECKS[@]}"; do
  IFS='|' read -r prefixes label command speed <<<"$entry"
  (( fast_only )) && [[ "$speed" != "fast" ]] && continue
  applies "$prefixes" || continue
  if output=$(bash -c "$command" 2>&1); then
    echo "✓ $label"
  else
    echo "✗ $label"
    summarize "$output"
    [[ -n "${TRUST_GATE:-}" && -f scripts/gate-log.sh ]] && bash scripts/gate-log.sh "$label" <<<"$output"
    failed=1
  fi
done

exit $failed
