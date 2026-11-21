#!/usr/bin/env bash
# Fails when a change ADDS a comment that switches a check off (lint-disable, ts-ignore, noqa, ...),
# or, in test files, a skipped or focused test (it.skip, test.only, @pytest.mark.skip, t.Skip, ...).
# Existing suppressions are left alone (ratchet); new ones need an entry in
# quality/allowed-suppressions.txt, which is a protected file (code-owner approval).
#   scripts/no-suppressions.sh            working tree vs HEAD (local gates)
#   scripts/no-suppressions.sh <base>     <base>...HEAD plus working tree (CI)
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

PATTERN='(eslint|oxlint|biome)-disable|@ts-(ignore|nocheck|expect-error)|#[[:space:]]*noqa|#[[:space:]]*type:[[:space:]]*ignore|pylint:[[:space:]]*disable|//[[:space:]]*nolint|@SuppressWarnings|istanbul ignore|c8 ignore|NOLINT'
# Skipped or focused tests, checked only in test files: it.skip / test.only / describe.todo (also with
# spaces, or assigned to a name without a call), xit / fdescribe, { skip: true }, runtime skips with
# no argument or a reason (t.skip(), ctx.skip('why'), this.skip()), pytest and unittest skips, Go
# t.Skip. Brackets ([.] [(]) instead of backslashes, because awk would unescape them once more.
SKIP_PATTERN='(^|[^A-Za-z0-9_$])(it|test|describe|suite|context|bench)[[:space:]]*[.][[:space:]]*(skip|only|todo)([^A-Za-z0-9_$]|$)|(^|[^A-Za-z0-9_$.])(xit|xtest|xdescribe|fit|fdescribe)[[:space:]]*[(]|[{,][[:space:]]*(skip|only)[[:space:]]*:[[:space:]]*(true|["`'"'"'])|[A-Za-z_$][A-Za-z0-9_$]*[[:space:]]*[.][[:space:]]*(skip|todo)[[:space:]]*[(][[:space:]]*([)]|["`'"'"'])|@pytest[.]mark[.](skip|skipif|xfail)|pytest[.](skip|xfail)[[:space:]]*[(]|@unittest[.](skip|skipIf|skipUnless|expectedFailure)|[.]skipTest[(]|(^|[^A-Za-z0-9_])[tb][.]Skip(f|Now)?[(]'
TEST_FILE='(^|/)(tests?|__tests__|spec|e2e)/|[.](test|spec)[.][cm]?[jt]sx?$|_test[.](go|py)$|(^|/)test_[^/]*[.]py$'
allowed=quality/allowed-suppressions.txt

# This script names the patterns it looks for, so it must not scan itself: the change that first adds
# it would fail on its own PATTERN line. Changes to it are protected by CODEOWNERS and trusted-check.
self=scripts/no-suppressions.sh
if [[ $# -gt 0 ]]; then diff=$(git diff "$1" -- . ':(exclude)lint/fixtures' ':(exclude)**/fixtures/**' ":(exclude)$self")
else diff=$( { git diff HEAD -- . ':(exclude)lint/fixtures' ":(exclude)$self"; git ls-files --others --exclude-standard -z | grep -zvx "$self" | xargs -0 -I{} git diff --no-index /dev/null {} 2>/dev/null; } )
fi

scan() {  # scan <line pattern> <file pattern or empty>
  awk -v pattern="$1" -v files="$2" '
    /^\+\+\+ / { file = substr($0, 7); next }
    /^@@/ { match($0, /\+[0-9]+/); line = substr($0, RSTART + 1, RLENGTH - 1) - 1; next }
    /^\+/ { line++; if ((files == "" || file ~ files) && substr($0, 2) ~ pattern) print file ":" line ": " substr($0, 2); next }
    /^ / { line++ }
  ' <<<"$diff"
}
hits=$(scan "$PATTERN" "")
skips=$(scan "$SKIP_PATTERN" "$TEST_FILE")

if [[ -f "$allowed" ]] && grep -qvE '^\s*(#|$)' "$allowed"; then
  hits=$(grep -vFf <(grep -vE '^\s*(#|$)' "$allowed") <<<"$hits" || true)
  skips=$(grep -vFf <(grep -vE '^\s*(#|$)' "$allowed") <<<"$skips" || true)
fi

status=0
if [[ -n "$hits" ]]; then
  echo "✗ new suppression comments"
  echo "$hits" | cut -c1-200
  echo "Do not switch checks off. Fix the code the check is pointing at. If an exception is truly needed,"
  echo "add the exact line to quality/allowed-suppressions.txt with a reason; a code owner must approve it."
  status=1
fi
if [[ -n "$skips" ]]; then
  echo "✗ new skipped or focused tests"
  echo "$skips" | cut -c1-200
  echo "Do not skip a failing test or run only some tests to get a gate to pass: fix the code or the test."
  echo "skip/only/todo hide coverage (only also stops the other tests in the file from running). If a skip"
  echo "is truly needed (for example a platform-only test), add the exact line to"
  echo "quality/allowed-suppressions.txt with a reason; a code owner must approve it."
  status=1
fi
(( status )) && exit 1
echo "✓ no new suppression comments or skipped tests"
