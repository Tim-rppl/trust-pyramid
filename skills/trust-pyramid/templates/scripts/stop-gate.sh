#!/usr/bin/env bash
# Stop hook for Claude Code and Codex: when the agent tries to finish, run the checks.
#   pass -> print {} on stdout, exit 0   (Codex requires JSON on stdout for exit 0)
#   fail -> failures on stderr, exit 2   (both agents keep working with stderr as the reason)
# After 3 failed fix attempts, block once more with "stop and explain to the user", then let the
# turn end with a visible systemMessage. No infinite loops, and the hand-over is never silent.
[ -t 0 ] || cat >/dev/null  # hook input JSON on stdin is not needed
cd "$(git rev-parse --show-toplevel)" || { echo '{}'; exit 0; }

state_dir=.quality-state
counter=$state_dir/stop-gate-count
handover=$state_dir/stop-gate-handover
mkdir -p "$state_dir"

if output=$(scripts/check.sh 2>&1); then
  rm -f "$counter" "$handover"
  echo '{}'
  exit 0
fi

if [[ -f "$handover" ]]; then
  # The agent has already been told to stop and explain; let the turn end, visibly.
  rm -f "$counter" "$handover"
  echo '{"systemMessage": "Quality checks are still failing after 3 fix attempts. A human needs to look at scripts/check.sh output."}'
  exit 0
fi

count=$(( $(cat "$counter" 2>/dev/null || echo 0) + 1 ))
echo "$count" > "$counter"
if (( count > 3 )); then
  touch "$handover"
  {
    echo "Checks still fail after 3 attempts. Stop trying to fix them now."
    echo "Tell the user in plain language which check fails, what you tried, and what you need from them. Then finish."
    echo "$output"
  } >&2
  exit 2
fi

{
  echo "Checks failed (attempt $count of 3). Fix the root cause before finishing."
  echo "Do not disable rules, skip tests or weaken assertions."
  echo "$output"
} >&2
exit 2
