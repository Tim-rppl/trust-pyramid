#!/usr/bin/env bash
# Run this YOURSELF (not the agent): Claude Code and Codex protect their own config folders, so an
# agent usually cannot install its own Stop hook or permission rules. This copies the staged files
# from quality/install/ into place, merging nothing: existing files are kept and reported.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
install_one() {
  local from=$1 to=$2
  if [[ ! -f "$from" ]]; then echo "skip: $from not found"; return; fi
  if [[ -f "$to" ]]; then echo "exists, not overwritten: $to (compare with $from and merge by hand)"; return; fi
  mkdir -p "$(dirname "$to")"
  cp "$from" "$to"
  echo "installed: $to"
}
install_one quality/install/claude-settings.json .claude/settings.json
install_one quality/install/codex-hooks.json .codex/hooks.json
echo
echo "Next: Codex asks you to review and trust new project hooks once. Then check the hook works:"
echo "  echo '{}' | bash scripts/stop-gate.sh   # expect {} when checks pass"
