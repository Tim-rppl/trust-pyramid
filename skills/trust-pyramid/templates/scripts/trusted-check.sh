#!/usr/bin/env bash
# CI entry point: check the PR's code with the BASE branch's rules.
# A PR (written by an agent) can edit scripts/check.sh, lint configs or the review gate. If CI ran
# the PR's own copies, deleting a check or turning a rule off would pass. This script restores every
# protected path from the base commit before running the checks, so loosening a rule never takes
# effect in the PR that loosens it. New or stricter rules take effect after they merge.
#   scripts/trusted-check.sh <base-ref> [command...]     default command: scripts/check.sh --all
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
base=${1:?usage: scripts/trusted-check.sh <base-ref> [command...]}
shift
[[ $# -gt 0 ]] || set -- scripts/check.sh --all

# The list itself comes from the base commit, so a PR cannot shrink it.
protected=$(git show "$base:quality/protected-paths.txt" 2>/dev/null | grep -vE '^\s*(#|$)')
if [[ -z "$protected" ]]; then
  echo "quality/protected-paths.txt is missing on $base; refusing to run untrusted gates." >&2
  exit 1
fi

changed=()
while IFS= read -r path; do
  # Only paths that exist on base can be restored; anything else is new and checked by the reviewer.
  if git cat-file -e "$base:${path%/}" 2>/dev/null; then
    if ! git diff --quiet "$base" -- "$path"; then changed+=("$path"); fi
    git checkout -q "$base" -- "$path"
  fi
done <<<"$protected"

if (( ${#changed[@]} )); then
  echo "Note: this PR changes protected quality files; they are NOT used for this run (base versions are):"
  printf '  - %s\n' "${changed[@]}"
  echo "Changes to them need a code owner's approval and take effect after merge."
fi

status=0
"$@" || status=1
scripts/no-suppressions.sh "$base" || status=1
exit $status
