#!/usr/bin/env bash
# Deterministic quality checks. Runs only checks whose paths changed and prints only failures.
#   scripts/check.sh            changes in the working tree (staged + unstaged + untracked)
#   scripts/check.sh --staged   staged changes only (pre-commit)
#   scripts/check.sh --all      everything (CI)
#   scripts/check.sh --fast     only checks marked |fast (the agent's Stop hook: seconds, not minutes)
# With TRUST_GATE set (stop-hook, pre-commit, ci), each failing check is recorded by scripts/gate-log.sh.
# Every check has a time limit, so a test that never exits (an open socket, a timer) fails with a clear
# message instead of hanging every gate: 120 s for |fast checks, 900 s for the others.
# TRUST_CHECK_TIMEOUT=<seconds> overrides both; add timeout=<seconds> to one check (|fast,timeout=30).
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

# One line per check: <space-separated path prefixes>|<label>|<command>[|fast][,timeout=<seconds>]
# Mark cheap checks (typecheck, lint, fast unit tests) with |fast. The Stop hook runs only those;
# pre-commit and CI run everything.
# A prefix of "." runs the check on any change. Keep commands simple; put anything with
# $(...) or loops in a script file (it would expand when this array is defined).
# Prefer failure-focused reporters: node --test --test-reporter=spec, pytest -q -rf --tb=short.
# trust-pyramid:project-start checks (upgrades keep this section as the project wrote it)
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
# trust-pyramid:project-end checks

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

# run_limited <seconds> <command>: exit 124 when the time runs out. The whole process group is
# stopped, so children holding the output pipe open cannot keep the gate waiting.
run_limited() {
  local seconds=$1 command=$2
  if timeout --version 2>/dev/null | grep -q GNU; then        # Linux, Git for Windows
    timeout -k 5 "$seconds" bash -c "$command"
  elif command -v perl >/dev/null 2>&1; then                  # macOS
    perl -e '
      my $seconds = shift;
      my $pid = fork() // die "fork: $!";
      if ($pid == 0) { setpgrp(0, 0); exec @ARGV or exit 127 }
      $SIG{ALRM} = sub { kill "TERM", -$pid; sleep 2; kill "KILL", -$pid; exit 124 };
      alarm $seconds;
      waitpid($pid, 0);
      exit($? & 127 ? 128 + ($? & 127) : $? >> 8);
    ' "$seconds" bash -c "$command"
  else
    bash -c "$command"
  fi
}

failed=0
for entry in "${CHECKS[@]}"; do
  IFS='|' read -r prefixes label command flags <<<"$entry"
  speed=""; limit=""
  for option in ${flags//,/ }; do  # word splitting on purpose (an empty array breaks bash 3.2 with set -u)
    case "$option" in fast) speed=fast ;; timeout=*) limit=${option#timeout=} ;; esac
  done
  (( fast_only )) && [[ "$speed" != "fast" ]] && continue
  applies "$prefixes" || continue
  [[ "$speed" == fast ]] && default=120 || default=900
  limit=${limit:-${TRUST_CHECK_TIMEOUT:-$default}}
  output=$(run_limited "$limit" "$command" 2>&1); status=$?
  if (( status == 0 )); then
    echo "✓ $label"
    continue
  fi
  if (( status == 124 || status == 137 )); then
    echo "✗ $label (timed out after ${limit}s)"
    output="$output"$'\n'"Timed out after ${limit}s and was stopped. Usually a process kept running after the"
    output="$output"$'\n'"work was done: an open socket, server or timer (close them in an after/teardown hook), or a"
    output="$output"$'\n'"test waiting forever. Give the test runner its own limit (node --test --test-timeout=<ms>,"
    output="$output"$'\n'"pytest-timeout, go test -timeout). Raise this check's limit only if it is really that slow."
  else
    echo "✗ $label"
  fi
  summarize "$output"
  [[ -n "${TRUST_GATE:-}" && -f scripts/gate-log.sh ]] && bash scripts/gate-log.sh "$label" <<<"$output"
  failed=1
done

exit $failed
