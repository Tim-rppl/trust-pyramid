#!/usr/bin/env bash
# Is the first gate on? Reports whether the agent Stop hook and the pre-commit hook are enabled in
# this clone, and when the Stop hook last ran. Agents cannot enable their own hooks, so this is how a
# missing hook gets noticed instead of silently doing nothing.
#   scripts/hook-status.sh           full report; exit 1 when something expected is missing
#   scripts/hook-status.sh --quiet   print only problems (used by pre-commit; never blocks there)
# Expected hosts come from quality/install/ (what setup staged); with nothing staged, at least one
# agent Stop hook is expected.
set -uo pipefail
root=$(git -C "$(dirname "${BASH_SOURCE[0]}")/.." rev-parse --show-toplevel 2>/dev/null) || {
  echo "hook-status: not inside a git repository" >&2; exit 1; }
cd "$root"
quiet=0; [[ "${1:-}" == "--quiet" ]] && quiet=1

problems=()
report() { (( quiet )) || echo "$1"; }
registered() { local f; for f in "$@"; do [[ -f "$f" ]] && grep -q 'scripts/stop-gate\.sh' "$f" && { echo "$f"; return 0; }; done; return 1; }

# In a linked git worktree (.git is a file), the host's settings live in the main checkout: the Stop
# hook registered there checks this worktree too, when the session works in it (see stop-gate.sh).
main=""
if [[ -f .git ]]; then
  main=$(git worktree list --porcelain | sed -n '1s/^worktree //p')
  report "• This is a linked git worktree of $main. The Stop hook registered there also checks this worktree"
  report "  when the agent session works in it (its cwd, or a path its transcript mentions). The per-machine deny"
  report "  list does not apply here, by design: gate changes are made in a worktree and reach the default branch"
  report "  through a reviewed pull request. Use absolute paths for files here: permission rules check a"
  report "  relative path against the session's directory, so the main checkout's deny list may refuse it."
fi
claude_settings=(.claude/settings.json .claude/settings.local.json)
codex_settings=(.codex/hooks.json)
state=.quality-state
if [[ -n "$main" ]]; then
  claude_settings+=("$main/.claude/settings.json" "$main/.claude/settings.local.json")
  codex_settings+=("$main/.codex/hooks.json")
  state="$main/.quality-state"
fi

expect_claude=0; expect_codex=0
grep -qs 'stop-gate\.sh' quality/install/claude-settings.json quality/install/claude-settings.local.json && expect_claude=1
grep -qs 'stop-gate\.sh' quality/install/codex-hooks.json && expect_codex=1

claude_file=$(registered "${claude_settings[@]}") && claude_on=1 || claude_on=0
codex_file=$(registered "${codex_settings[@]}") && codex_on=1 || codex_on=0
(( claude_on )) && report "✓ Claude Code Stop hook: registered in $claude_file"
(( codex_on )) && report "✓ Codex Stop hook: registered in $codex_file (Codex asks you to trust it once)"

if (( expect_claude || expect_codex )); then
  (( expect_claude && ! claude_on )) && problems+=("Claude Code Stop hook is NOT enabled: no scripts/stop-gate.sh in .claude/settings.json or .claude/settings.local.json")
  (( expect_codex && ! codex_on )) && problems+=("Codex Stop hook is NOT enabled: no scripts/stop-gate.sh in .codex/hooks.json")
elif (( ! claude_on && ! codex_on )); then
  problems+=("No agent Stop hook is enabled (.claude/settings.json or .codex/hooks.json)")
fi

# Settings that switch every hook off win over the project's hook config.
for f in "$HOME/.claude/settings.json" "${claude_settings[@]}"; do
  if [[ -f "$f" ]] && grep -Eq '"disableAllHooks"[[:space:]]*:[[:space:]]*true' "$f"; then
    problems+=("$f sets \"disableAllHooks\": true, so Claude Code runs no hooks at all")
  fi
done

if [[ "$(git config core.hooksPath)" == ".githooks" && -f .githooks/pre-commit ]]; then
  report "✓ pre-commit: enabled (core.hooksPath=.githooks)"
else
  problems+=("pre-commit is NOT enabled in this clone: git config core.hooksPath .githooks")
fi

if [[ -f "$state/stop-gate-last-run" ]]; then
  report "✓ Stop hook last ran: $(cat "$state/stop-gate-last-run")"
elif (( claude_on || codex_on )); then
  report "• Stop hook has not run yet in this clone: start a NEW agent session and end one turn to confirm it fires."
fi

# Rule candidates that reached Seen 2: the agent proposes them as rules (quality/ADD_RULE.md). A
# reminder, never a failure. The Seen column is found by its header; its leading number counts.
# A row with a cell starting "Blocked until" waits for something else first, and is only counted.
ledger=quality/rule-candidates.md
if (( ! quiet )) && [[ -f "$ledger" ]]; then
  waiting=$(awk -F'|' '
    function trim(s) { gsub(/^[ \t]+|[ \t]+$/, "", s); return s }
    /^[ \t]*\|/ {
      if (!col) { for (i = 1; i <= NF; i++) if (tolower(trim($i)) ~ /^seen/) col = i; if (col) kind = (col > 2 ? 2 : 1); next }
      if ($0 ~ /^[ \t]*\|[ \t:|-]+$/) next
      seen = trim($col); sub(/[^0-9].*$/, "", seen)
      if (seen + 0 < 2) next
      blocked = 0; for (i = 1; i <= NF; i++) if (tolower(trim($i)) ~ /^blocked until/) blocked = 1
      if (blocked) printf "blocked\n"; else printf "  - %s (seen %d)\n", trim($kind), seen
      next
    }
    col { exit }' "$ledger")
  blocked=$(grep -c '^blocked$' <<<"$waiting")
  waiting=$(grep -v '^blocked$' <<<"$waiting")
  if [[ -n "$waiting" ]]; then
    echo "• Rule candidates seen twice or more. After the current task, ask the user whether you may add"
    echo "  each as a rule, then do it as quality/ADD_RULE.md describes (do not wait for a maintainer):"
    echo "$waiting"
  fi
  (( blocked )) && echo "• $blocked more rule candidate(s) at Seen 2 or more are blocked until something else is done (quality/rule-candidates.md)."
fi

if (( ${#problems[@]} )); then
  echo "✗ Quality gates are not fully enabled in this clone:"
  printf '  - %s\n' "${problems[@]}"
  echo "  Fix: run  bash scripts/install-agent-hooks.sh  (it asks before changing anything), then start a new agent session."
  exit 1
fi
(( quiet )) || echo "All gates for this clone are enabled."
exit 0
