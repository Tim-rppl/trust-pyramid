#!/usr/bin/env bash
# Stop hook for Claude Code and Codex: when the agent tries to finish, run the checks.
#   pass -> print {} on stdout, exit 0   (Codex requires JSON on stdout for exit 0)
#   fail -> failures on stderr, exit 2   (both agents keep working with stderr as the reason)
# Runs only the fast checks (scripts/check.sh --fast); pre-commit and CI run everything.
# After STOP_GATE_MAX_ATTEMPTS failed attempts (default 2), block once more with "stop and explain
# to the user", then let the turn end with a visible systemMessage. No loops, no silent hand-over.
# A failure the agent cannot fix (a protected gate file) should be handed over at once, not retried.
# Worktrees: agents often work in a git worktree (to keep the user's uncommitted changes apart),
# while the host starts this hook from the session's checkout. Besides that checkout it checks the
# worktree containing the hook's cwd and every worktree this session's transcript mentions, each
# with its own scripts/check.sh. STOP_GATE_WORKTREES=all checks every worktree with changes,
# none (or 0) only the session's checkout.
# Only runs started by the host (stdin carries hook_event_name) count toward the attempts, per
# session_id, and prove the hook fires. A manual run reports the same result and counts nothing.
input=""
[ -t 0 ] || input=$(cat)
field() {  # field <key>: a string value from the hook input JSON (no jq needed)
  printf '%s' "$input" | tr '\n' ' ' | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | sed 's/\\\\/\\/g'
}
# Any of these keys means the host started us (a host that omitted one must not loop forever).
from_host=0; grep -qE '"(hook_event_name|session_id|stop_hook_active)"' <<<"$input" && from_host=1
session=$(field session_id); transcript=$(field transcript_path); hook_cwd=$(field cwd)
session=${session:-no-session-id}  # a host without session_id still counts, as one session
[[ -n "$hook_cwd" ]] || hook_cwd=$PWD
# Find the repository from this script's location, not the current directory: the agent may have
# changed directory, or the host may start hooks elsewhere. If it cannot be found, say so visibly
# (systemMessage) and let the turn end: blocking (exit 2) would loop, because the agent cannot fix it.
root=$(git -C "$(dirname "${BASH_SOURCE[0]}")/.." rev-parse --show-toplevel 2>/dev/null) && cd "$root" || {
  msg="stop-gate: cannot find the repository from $0, so the quality checks did not run. Run scripts/check.sh in the repository."
  echo "$msg" >&2
  printf '{"systemMessage": "%s"}\n' "$(printf '%s' "$msg" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  exit 0; }

state_dir=.quality-state
counter=$state_dir/stop-gate-count        # "<session_id> <failed attempts>"
handover=$state_dir/stop-gate-handover    # "<session_id>": told to stop and explain
mkdir -p "$state_dir"
# Proof that the host really runs this hook; scripts/hook-status.sh shows it. Manual runs do not count.
(( from_host )) && date '+%Y-%m-%d %H:%M:%S' > "$state_dir/stop-gate-last-run"

max_attempts=${STOP_GATE_MAX_ATTEMPTS:-2}

cwd_top=$(git -C "$hook_cwd" rev-parse --show-toplevel 2>/dev/null) || cwd_top=""
mode=${STOP_GATE_WORKTREES:-session}
[[ "$mode" == 0 ]] && mode=none

ours() {  # ours <worktree>: does this session work there?
  [[ "$1" == "$cwd_top" ]] && return 0
  [[ -n "$transcript" && -f "$transcript" ]] || return 1
  local escaped=${1//\//\\\\}   # C:/a/b as it appears in JSON: C:\\a\\b
  grep -qF -e "$1" -e "$escaped" "$transcript"
}

run_checks() {
  local out status=0 worktree top script
  out=$(TRUST_GATE=stop-hook bash scripts/check.sh --fast 2>&1) || { status=1; printf '%s\n' "$out"; }
  [[ "$mode" == none ]] && return $status
  while IFS= read -r worktree; do
    [[ -d "$worktree" ]] || continue
    top=$(git -C "$worktree" rev-parse --show-toplevel 2>/dev/null) || continue
    [[ "$top" == "$root" ]] && continue
    [[ "$mode" == all ]] || ours "$top" || continue
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
  (( from_host )) && rm -f "$counter" "$handover"
  echo '{}'
  exit 0
fi

if (( ! from_host )); then
  {
    echo "Checks failed. (Manual run: no Stop hook input, so this does not count toward the agent's attempts.)"
    echo "$output"
  } >&2
  exit 2
fi

if [[ -f "$handover" && "$(cat "$handover")" == "$session" ]]; then
  # The agent has already been told to stop and explain; let the turn end, visibly.
  rm -f "$counter" "$handover"
  echo '{"systemMessage": "Quality checks are still failing after the allowed fix attempts. A human needs to look at scripts/check.sh output."}'
  exit 0
fi

read -r counted_session count < "$counter" 2>/dev/null || true
[[ "${counted_session:-}" == "$session" && "${count:-}" =~ ^[0-9]+$ ]] || count=0
count=$(( count + 1 ))
echo "$session $count" > "$counter"
if (( count > max_attempts )); then
  echo "$session" > "$handover"
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
  grep -q '^In the git worktree ' <<<"$output" && echo "A failure under \"In the git worktree ...\" comes from that worktree's uncommitted changes, which this session's transcript mentions. If that work is not yours, tell the user and finish instead of changing it."
  echo "$output"
} >&2
exit 2
