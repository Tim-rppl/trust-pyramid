#!/usr/bin/env bash
# Stop hook for Claude Code and Codex: when the agent tries to finish, run the checks.
#   pass -> {} on stdout, exit 0                       (Codex requires JSON on stdout for exit 0)
#   fail -> {"decision": "block", "reason": ...}, exit 0 (both agents keep working with the reason)
#   manual run (no hook input) -> failures on stderr, exit 2
# Runs only the fast checks (scripts/check.sh --fast); pre-commit and CI run everything.
# After STOP_GATE_MAX_ATTEMPTS failed attempts (default 2), block once more with "stop and explain
# to the user", then let the turn end with a visible systemMessage. No loops, no silent hand-over.
# A failure the agent cannot fix (a protected gate file) should be handed over at once, not retried.
# Worktrees: agents often work in a git worktree (to keep the user's uncommitted changes apart),
# while the host starts this hook from the session's checkout. Besides that checkout it checks the
# worktree containing the hook's cwd and every worktree this session's transcript mentions, each
# with its own scripts/check.sh. STOP_GATE_WORKTREES=all (or 1) checks every worktree with changes,
# none (or 0) only the session's checkout. Missing dependencies (check.sh exit 3, common in a fresh
# worktree) block with "run scripts/check.sh --setup" and do not use up a fix attempt.
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
setup_counter=$state_dir/stop-gate-setup  # "<session_id> <stops blocked for missing dependencies>"
handover=$state_dir/stop-gate-handover    # "<session_id>": told to stop and explain
mkdir -p "$state_dir"
# Proof that the host really runs this hook; scripts/hook-status.sh shows it. Manual runs do not count.
(( from_host )) && date '+%Y-%m-%d %H:%M:%S' > "$state_dir/stop-gate-last-run"

max_attempts=${STOP_GATE_MAX_ATTEMPTS:-2}
notice=""
case "${STOP_GATE_WORKTREES:-session}" in
  session) mode=session ;;
  all|1|true|yes) mode=all ;;
  none|0|false|no) mode=none ;;
  *) mode=all; notice="STOP_GATE_WORKTREES=$STOP_GATE_WORKTREES is not session, all or none, so every worktree was checked." ;;
esac

json_string() {  # the text as a JSON string body: no control characters, ANSI colours or broken UTF-8
  local s
  s=$(printf '%s' "$1" | sed $'s/\x1b\\[[0-9;]*[A-Za-z]//g' | LC_ALL=C tr -d '\000-\010\013\014\015\016-\037\177')
  command -v iconv >/dev/null 2>&1 && s=$(printf '%s' "$s" | iconv -c -f UTF-8 -t UTF-8 2>/dev/null)
  s=${s//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\t'/\\t}; s=${s//$'\n'/\\n}
  printf '%s' "$s"
}
# Keep the agent working. Both hosts document {"decision": "block"} on stdout with exit 0 for Stop.
# Exit 2 with the reason on stderr is not used: Claude Code reads a Stop hook that exits 2 with "No such
# file or directory" in stderr as a missing script and lets the turn end, and a failing check can print that.
block() {
  local reason=$1
  [[ -n "$notice" ]] && reason="$notice"$'\n'"$reason"
  printf '{"decision": "block", "reason": "%s"}\n' "$(json_string "$reason")"
  exit 0
}
let_end() {  # let_end <message>: end the turn with a message the user sees
  printf '{"systemMessage": "%s"}\n' "$(json_string "$1")"
  exit 0
}
count_for() {  # count_for <file>: this session's count in it, 0 when missing or another session's
  local s="" c=""
  [[ -f "$1" ]] && { read -r s c < "$1"; } 2>/dev/null
  [[ "$s" == "$session" && "$c" =~ ^[0-9]+$ ]] && echo "$c" || echo 0
}

# Paths are compared in one form, so a worktree is found however the transcript spells it:
# C:\\a\\b (JSON), C:/a/b (git), /c/a/b (Git Bash), /cygdrive/c/a/b, in any letter case.
normalize() {
  sed -E 's#\\\\#/#g; s#\\#/#g; s#(^|[^A-Za-z0-9_.~-])/cygdrive/([A-Za-z])/#\1\2:/#g; s#(^|[^A-Za-z0-9_.~-])/([A-Za-z])/#\1\2:/#g' | tr '[:upper:]' '[:lower:]'
}
cwd_top=$(git -C "$hook_cwd" rev-parse --show-toplevel 2>/dev/null) || cwd_top=""
cwd_top=$(printf '%s\n' "$cwd_top" | normalize)
# Only runs started by the host are logged as Stop-hook interceptions (scripts/gate-log.sh).
gate=""; (( from_host )) && gate=stop-hook

# mentioned <transcript> <worktree>...: the worktrees (normalized, one per line) that the transcript
# mentions as a whole path: not .../wt-feature or .../wt.bak for .../wt, but .../wt/x, "…/wt" or a
# sentence ending in .../wt. A fixed-string filter on the directory names comes first, so the
# normalization runs on the few lines that can match, not on the whole, growing transcript.
mentioned() {
  local file=$1 names=() wt want
  shift
  for wt in "$@"; do names+=(-e "${wt##*/}"); done
  want=$(printf '%s\n' "$@" | normalize)
  grep -iF "${names[@]}" "$file" | normalize | WANT=$want awk '
    function ends_here(s, p,   i, c, d) {
      while ((i = index(s, p)) > 0) {
        c = substr(s, i + length(p), 1)
        if (c == "" || c !~ /[a-z0-9_.-]/) return 1
        if (c == ".") { d = substr(s, i + length(p) + 1, 1); if (d == "" || d !~ /[a-z0-9_-]/) return 1 }
        s = substr(s, i + 1)
      }
      return 0
    }
    BEGIN { n = split(ENVIRON["WANT"], want, "\n") }
    { for (k = 1; k <= n; k++) if (want[k] != "" && !(k in hit) && ends_here($0, want[k])) hit[k] = 1 }
    END { for (k in hit) print want[k] }'
}

# Exit status: 0 all pass, 1 a check failed, 3 only missing dependencies (scripts/check.sh --setup).
run_checks() {
  local out code failed=0 setup=0 worktree top norm script dirty=() others=() mine=""
  out=$(TRUST_GATE=$gate bash scripts/check.sh --fast 2>&1); code=$?
  if (( code )); then printf '%s\n' "$out"; (( code == 3 )) && setup=1 || failed=1; fi
  if [[ "$mode" != none ]]; then
    # Linked worktrees with uncommitted changes. With none (the usual case) the transcript is not read.
    while IFS= read -r worktree; do
      [[ -d "$worktree" ]] || continue
      top=$(git -C "$worktree" rev-parse --show-toplevel 2>/dev/null) || continue
      [[ "$top" == "$root" ]] && continue
      [[ -n "$(git -C "$top" status --porcelain 2>/dev/null)" ]] || continue
      dirty+=("$top")
      [[ "$(printf '%s\n' "$top" | normalize)" == "$cwd_top" ]] || others+=("$top")
    done < <(git worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p')
    if [[ "$mode" == session && ${#others[@]} -gt 0 && -n "$transcript" && -f "$transcript" ]]; then
      mine=$(mentioned "$transcript" "${others[@]}")
    fi
    for top in ${dirty[@]+"${dirty[@]}"}; do
      if [[ "$mode" == session ]]; then
        norm=$(printf '%s\n' "$top" | normalize)
        [[ "$norm" == "$cwd_top" ]] || grep -Fxq -- "$norm" <<<"$mine" || continue
      fi
      script="$top/scripts/check.sh"; [[ -f "$script" ]] || script="$root/scripts/check.sh"
      out=$(cd "$top" && TRUST_GATE=$gate bash "$script" --fast 2>&1); code=$?
      if (( code )); then
        printf 'In the git worktree %s (uncommitted changes there):\n%s\n' "$top" "$out"
        (( code == 3 )) && setup=1 || failed=1
      fi
    done
  fi
  (( failed )) && return 1
  (( setup )) && return 3
  return 0
}

output=$(run_checks); result=$?
rm -f "$state_dir/stop-gate-transcript"  # written by 0.4.4

if (( result == 0 )); then
  (( from_host )) && rm -f "$counter" "$setup_counter" "$handover"
  [[ -n "$notice" ]] && let_end "$notice"
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

if (( result == 3 )); then
  # Dependencies are missing (typically a fresh worktree). Not a problem in the change, so no fix attempt is
  # used; after max_attempts such stops in a row the turn ends with a visible message.
  count=$(( $(count_for "$setup_counter") + 1 ))
  echo "$session $count" > "$setup_counter"
  (( count > max_attempts )) && { rm -f "$setup_counter"; let_end "Quality checks did not run: dependencies are still missing. Run bash scripts/check.sh --setup where the output below says, then check again."$'\n'"$output"; }
  block "Setup needed before the checks can run. This is not a problem in your change and does not use up a fix attempt. Install the missing dependencies (bash scripts/check.sh --setup, in the directory named below), wait until it finishes, then finish again."$'\n'"$output"
fi

if [[ -f "$handover" && "$(cat "$handover")" == "$session" ]]; then
  # The agent has already been told to stop and explain; let the turn end, visibly.
  rm -f "$counter" "$setup_counter" "$handover"
  let_end "Quality checks are still failing after the allowed fix attempts. A human needs to look at scripts/check.sh output."
fi

# A real failure ends a run of setup stops: the setup limit counts setup stops in a row.
rm -f "$setup_counter"
count=$(( $(count_for "$counter") + 1 ))
echo "$session $count" > "$counter"
if (( count > max_attempts )); then
  echo "$session" > "$handover"
  block "Checks still fail after $max_attempts attempts. Stop trying to fix them now."$'\n'"Tell the user in plain language which check fails, what you tried, and what you need from them. Then finish."$'\n'"$output"
fi

reason="Checks failed (attempt $count of $max_attempts). Fix the root cause before finishing."
reason+=$'\n'"Do not disable rules, skip tests or weaken assertions. If the fix needs a protected gate file you"
reason+=$'\n'"cannot edit here, stop now: tell the user, and propose that change as its own pull request from a"
reason+=$'\n'"separate worktree (quality/ADD_RULE.md) instead of trying again."
grep -q '^In the git worktree ' <<<"$output" && reason+=$'\n'"A failure under \"In the git worktree ...\" comes from that worktree's uncommitted changes, which this session's transcript mentions. If that work is not yours, tell the user and finish instead of changing it."
block "$reason"$'\n'"$output"
