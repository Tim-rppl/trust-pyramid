#!/usr/bin/env bash
# CI entry point: check the PR's code with the BASE branch's rules.
# A PR (written by an agent) can edit scripts/check.sh, lint configs or the review gate. If CI ran
# the PR's own copies, deleting a check or turning a rule off would pass. This script restores every
# protected path from the base commit before running the checks, so loosening a rule never takes
# effect in the PR that loosens it. New or stricter rules take effect after they merge.
#   scripts/trusted-check.sh <base-ref> [command...]     default command: bash scripts/check.sh --all
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
base=${1:?usage: scripts/trusted-check.sh <base-ref> [command...]}
shift
[[ $# -gt 0 ]] || set -- bash scripts/check.sh --all

# Bootstrap: the change that introduces the gates has no base copy to trust yet. Run its own gate
# files, say so loudly, and let the result count. From the next change on, the base copy applies.
if ! git cat-file -e "$base:scripts/trusted-check.sh" 2>/dev/null; then
  note="Gate bootstrap: $base has no scripts/trusted-check.sh, so this change introduces the gates. Its own gate files are used for this run (there is nothing on the base to trust yet); trusted checks apply to every change after it merges."
  echo "$note"
  [[ -n "${GITHUB_ACTIONS:-}" ]] && echo "::warning title=Gate bootstrap::$note"
  [[ -n "${GITHUB_STEP_SUMMARY:-}" ]] && echo "**$note**" >> "$GITHUB_STEP_SUMMARY"
  status=0
  "$@" || status=1
  bash scripts/no-suppressions.sh "$base" || status=1
  exit $status
fi

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
bash scripts/no-suppressions.sh "$base" || status=1
exit $status
