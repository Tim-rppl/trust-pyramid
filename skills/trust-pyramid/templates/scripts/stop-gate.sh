#!/usr/bin/env bash
# Stop hook for Claude Code and Codex: when the agent tries to finish, run the checks.
#   pass -> print {} on stdout, exit 0   (Codex requires JSON on stdout for exit 0)
#   fail -> failures on stderr, exit 2   (both agents keep working with stderr as the reason)
# Runs only the fast checks (scripts/check.sh --fast); pre-commit and CI run everything.
# After STOP_GATE_MAX_ATTEMPTS failed attempts (default 2), block once more with "stop and explain
# to the user", then let the turn end with a visible systemMessage. No loops, no silent hand-over.
# A failure the agent cannot fix (a protected gate file) should be handed over at once, not retried.
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

if output=$(TRUST_GATE=stop-hook bash scripts/check.sh --fast 2>&1); then
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
  echo "$output"
} >&2
exit 2
