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

expect_claude=0; expect_codex=0
grep -qs 'stop-gate\.sh' quality/install/claude-settings.json quality/install/claude-settings.local.json && expect_claude=1
grep -qs 'stop-gate\.sh' quality/install/codex-hooks.json && expect_codex=1

claude_file=$(registered .claude/settings.json .claude/settings.local.json) && claude_on=1 || claude_on=0
codex_file=$(registered .codex/hooks.json) && codex_on=1 || codex_on=0
(( claude_on )) && report "✓ Claude Code Stop hook: registered in $claude_file"
(( codex_on )) && report "✓ Codex Stop hook: registered in $codex_file (Codex asks you to trust it once)"

if (( expect_claude || expect_codex )); then
  (( expect_claude && ! claude_on )) && problems+=("Claude Code Stop hook is NOT enabled: no scripts/stop-gate.sh in .claude/settings.json or .claude/settings.local.json")
  (( expect_codex && ! codex_on )) && problems+=("Codex Stop hook is NOT enabled: no scripts/stop-gate.sh in .codex/hooks.json")
elif (( ! claude_on && ! codex_on )); then
  problems+=("No agent Stop hook is enabled (.claude/settings.json or .codex/hooks.json)")
fi

# Settings that switch every hook off win over the project's hook config.
for f in "$HOME/.claude/settings.json" .claude/settings.json .claude/settings.local.json; do
  if [[ -f "$f" ]] && grep -Eq '"disableAllHooks"[[:space:]]*:[[:space:]]*true' "$f"; then
    problems+=("$f sets \"disableAllHooks\": true, so Claude Code runs no hooks at all")
  fi
done

if [[ "$(git config core.hooksPath)" == ".githooks" && -f .githooks/pre-commit ]]; then
  report "✓ pre-commit: enabled (core.hooksPath=.githooks)"
else
  problems+=("pre-commit is NOT enabled in this clone: git config core.hooksPath .githooks")
fi

if [[ -f .quality-state/stop-gate-last-run ]]; then
  report "✓ Stop hook last ran: $(cat .quality-state/stop-gate-last-run)"
elif (( claude_on || codex_on )); then
  report "• Stop hook has not run yet in this clone: start a NEW agent session and end one turn to confirm it fires."
fi

if (( ${#problems[@]} )); then
  echo "✗ Quality gates are not fully enabled in this clone:"
  printf '  - %s\n' "${problems[@]}"
  echo "  Fix: run  bash scripts/install-agent-hooks.sh  (it asks before changing anything), then start a new agent session."
  exit 1
fi
(( quiet )) || echo "All gates for this clone are enabled."
exit 0
