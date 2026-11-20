#!/usr/bin/env bash
# Fails when a change ADDS a comment that switches a check off (lint-disable, ts-ignore, noqa, ...).
# Existing suppressions are left alone (ratchet); new ones need an entry in
# quality/allowed-suppressions.txt, which is a protected file (code-owner approval).
#   scripts/no-suppressions.sh            working tree vs HEAD (local gates)
#   scripts/no-suppressions.sh <base>     <base>...HEAD plus working tree (CI)
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

PATTERN='(eslint|oxlint|biome)-disable|@ts-(ignore|nocheck|expect-error)|#[[:space:]]*noqa|#[[:space:]]*type:[[:space:]]*ignore|pylint:[[:space:]]*disable|//[[:space:]]*nolint|@SuppressWarnings|istanbul ignore|c8 ignore|NOLINT'
allowed=quality/allowed-suppressions.txt

if [[ $# -gt 0 ]]; then diff=$(git diff "$1" -- . ':(exclude)lint/fixtures' ':(exclude)**/fixtures/**')
else diff=$( { git diff HEAD -- . ':(exclude)lint/fixtures'; git ls-files --others --exclude-standard -z | xargs -0 -I{} git diff --no-index /dev/null {} 2>/dev/null; } )
fi

hits=$(awk -v pattern="$PATTERN" '
  /^\+\+\+ / { file = substr($0, 7); next }
  /^@@/ { match($0, /\+[0-9]+/); line = substr($0, RSTART + 1, RLENGTH - 1) - 1; next }
  /^\+/ { line++; if ($0 ~ pattern) print file ":" line ": " substr($0, 2); next }
  /^ / { line++ }
' <<<"$diff")

if [[ -f "$allowed" && -n "$hits" ]]; then
  hits=$(grep -vFf <(grep -vE '^\s*(#|$)' "$allowed") <<<"$hits" || true)
fi

if [[ -n "$hits" ]]; then
  echo "✗ new suppression comments"
  echo "$hits" | cut -c1-200
  echo "Do not switch checks off. Fix the code the check is pointing at. If an exception is truly needed,"
  echo "add the exact line to quality/allowed-suppressions.txt with a reason; a code owner must approve it."
  exit 1
fi
echo "✓ no new suppression comments"
