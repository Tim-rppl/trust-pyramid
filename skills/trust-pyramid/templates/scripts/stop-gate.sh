#!/usr/bin/env bash
# Stop hook for Claude Code and Codex: when the agent tries to finish, run the checks.
#   pass -> print {} on stdout, exit 0   (Codex requires JSON on stdout for exit 0)
#   fail -> failures on stderr, exit 2   (both agents keep working with stderr as the reason)
# Runs only the fast checks (scripts/check.sh --fast); pre-commit and CI run everything.
# After STOP_GATE_MAX_ATTEMPTS failed attempts (default 2), block once more with "stop and explain
# to the user", then let the turn end with a visible systemMessage. No loops, no silent hand-over.
# A failure the agent cannot fix (a protected gate file) should be handed over at once, not retried.
# Agents often work in a git worktree (to keep the user's uncommitted changes apart). The host starts
# this hook from the main checkout, so it also checks every linked worktree that has uncommitted
# changes, with that worktree's own scripts/check.sh. STOP_GATE_WORKTREES=0 turns that off.
[ -t 0 ] || cat >/dev/null  # hook input JSON on stdin is not needed
# Find the repository from this script's location, not the current directory: the agent may have
# changed directory, or the host may start hooks elsewhere. If it cannot be found, say so visibly
# (systemMessage) and let the turn end: blocking (exit 2) would loop, because the agent cannot fix it.
root=$(git -C "$(dirname "${BASH_SOURCE[0]}")/.." rev-parse --show-toplevel 2>/dev/null) && cd "$root" || {
  msg="stop-gate: cannot find the repository from $0, so the quality checks did not run. Run scripts/check.sh in the repository."
  echo "$msg" >&2
  printf '{"systemMessage": "%s"}\n' "$(printf '%s' "$msg" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  exit 0; }

state_dir=.quality-state
counter=$state_dir/stop-gate-count
handover=$state_dir/stop-gate-handover
mkdir -p "$state_dir"
# Proof that the host really runs this hook; scripts/hook-status.sh shows it.
date '+%Y-%m-%d %H:%M:%S' > "$state_dir/stop-gate-last-run"

max_attempts=${STOP_GATE_MAX_ATTEMPTS:-2}

run_checks() {
  local out status=0 worktree top script
  out=$(TRUST_GATE=stop-hook bash scripts/check.sh --fast 2>&1) || { status=1; printf '%s\n' "$out"; }
  [[ "${STOP_GATE_WORKTREES:-1}" == 0 ]] && return $status
  while IFS= read -r worktree; do
    [[ -d "$worktree" ]] || continue
    top=$(git -C "$worktree" rev-parse --show-toplevel 2>/dev/null) || continue
    [[ "$top" == "$root" ]] && continue
    [[ -n "$(git -C "$top" status --porcelain 2>/dev/null)" ]] || continue
    script="$top/scripts/check.sh"; [[ -f "$script" ]] || script="$root/scripts/check.sh"
    if ! out=$(cd "$top" && TRUST_GATE=stop-hook bash "$script" --fast 2>&1); then
      status=1
      printf 'In the git worktree %s (uncommitted changes there):\n%s\n' "$top" "$out"
    fi
  done < <(git worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p')
  return $status
}

if output=$(run_checks); then
  rm -f "$counter" "$handover"
  echo '{}'
  exit 0
fi

if [[ -f "$handover" ]]; then
  # The agent has already been told to stop and explain; let the turn end, visibly.
  rm -f "$counter" "$handover"
  echo '{"systemMessage": "Quality checks are still failing after the allowed fix attempts. A human needs to look at scripts/check.sh output."}'
  exit 0
fi

count=$(( $(cat "$counter" 2>/dev/null || echo 0) + 1 ))
echo "$count" > "$counter"
if (( count > max_attempts )); then
  touch "$handover"
  {
    echo "Checks still fail after $max_attempts attempts. Stop trying to fix them now."
    echo "Tell the user in plain language which check fails, what you tried, and what you need from them. Then finish."
    echo "$output"
  } >&2
  exit 2
fi

{
  echo "Checks failed (attempt $count of $max_attempts). Fix the root cause before finishing."
  echo "Do not disable rules, skip tests or weaken assertions. If the fix needs a protected gate file you"
  echo "cannot edit, stop now and list the exact edits for the user instead of trying again."
  grep -q '^In the git worktree ' <<<"$output" && echo "A failure under \"In the git worktree ...\" comes from that worktree's uncommitted changes. If that work is not yours (another session's), tell the user and finish instead of changing it."
  echo "$output"
} >&2
exit 2
