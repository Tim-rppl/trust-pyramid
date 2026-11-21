#!/usr/bin/env bash
# Run this YOURSELF (not the agent): Claude Code and Codex protect their own config folders, so an
# agent cannot enable its own Stop hook or permission rules. This merges the configs that setup
# staged in quality/install/ into the real config files, keeping everything already there, and
# enables pre-commit for this clone. It shows each change and asks first.
#   bash scripts/install-agent-hooks.sh          ask before each change
#   bash scripts/install-agent-hooks.sh --yes    apply without asking
# Then it runs scripts/hook-status.sh, which must report every gate as enabled.
set -uo pipefail
root=$(git -C "$(dirname "${BASH_SOURCE[0]}")/.." rev-parse --show-toplevel) || exit 1
cd "$root"
yes=0; [[ "${1:-}" == "--yes" || "${1:-}" == "-y" ]] && yes=1

ask() {
  (( yes )) && return 0
  if [[ ! -t 0 ]]; then echo "  Not applied: no terminal to ask. Run it in a terminal, or with --yes."; return 1; fi
  local answer; read -r -p "  $1 [y/N] " answer; [[ "$answer" =~ ^[Yy] ]]
}

# Merges staged JSON into an existing config: hook entries are added unless the same command (or any
# scripts/stop-gate.sh entry) is already there; permission lists are unioned; other keys are added
# only when missing. Never removes or changes what is there. mode: plan | write
MERGE='
const fs = require("fs");
const [from, to, mode, ...siblings] = process.argv.slice(1);
// The same host reads hooks from sibling files too (.claude/settings.json and settings.local.json):
// a Stop hook already registered in one is not added to the other.
const elsewhere = siblings.filter(file => fs.existsSync(file)).map(file => {
  try { return [file, JSON.parse(fs.readFileSync(file, "utf8"))]; } catch { return [file, {}]; }
});
const src = JSON.parse(fs.readFileSync(from, "utf8"));
let dst = {};
if (fs.existsSync(to)) {
  try { dst = JSON.parse(fs.readFileSync(to, "utf8")); }
  catch (e) { console.error(`${to} is not valid JSON (${e.message}); fix it by hand, then run this again.`); process.exit(3); }
}
const added = [], kept = [];
for (const [event, groups] of Object.entries(src.hooks ?? {})) {
  dst.hooks ??= {}; dst.hooks[event] ??= [];
  for (const group of groups) for (const hook of group.hooks ?? []) {
    const same = x => x.command === hook.command || (hook.command.includes("scripts/stop-gate.sh") && String(x.command).includes("scripts/stop-gate.sh"));
    const found = dst.hooks[event].flatMap(g => g.hooks ?? []).find(same);
    const other = !found && elsewhere.find(([, config]) => (config.hooks?.[event] ?? []).flatMap(g => g.hooks ?? []).some(same));
    if (other) kept.push(`hooks.${event}: stop-gate is already registered in ${other[0]}, so it is not added here too. To share it with everyone who clones the repository, move it to .claude/settings.json.`);
    else if (!found) { dst.hooks[event].push({ ...group, hooks: [hook] }); added.push(`hooks.${event}: ${hook.command}`); }
    else if (found.command !== hook.command) kept.push(`hooks.${event} already runs stop-gate (kept as is): ${found.command}`);
  }
}
for (const [key, value] of Object.entries(src.permissions ?? {})) {
  dst.permissions ??= {};
  if (Array.isArray(value)) {
    dst.permissions[key] ??= [];
    for (const item of value) if (!dst.permissions[key].includes(item)) { dst.permissions[key].push(item); added.push(`permissions.${key}: ${item}`); }
  } else if (!(key in dst.permissions)) { dst.permissions[key] = value; added.push(`permissions.${key}`); }
}
for (const [key, value] of Object.entries(src)) {
  if (key !== "hooks" && key !== "permissions" && !(key in dst)) { dst[key] = value; added.push(key); }
}
for (const line of kept) console.log(`  note: ${line}`);
for (const line of added) console.log(`  + ${line}`);
if (mode === "write" && added.length) {
  if (fs.existsSync(to)) fs.copyFileSync(to, `${to}.bak`);
  fs.mkdirSync(require("path").dirname(to), { recursive: true });
  fs.writeFileSync(to, JSON.stringify(dst, null, 2) + "\n");
}
process.exit(added.length ? 0 : 10);
'

install_one() {
  local from=$1 to=$2 status
  shift 2  # any further arguments: sibling config files the same host also reads
  [[ -f "$from" ]] || return 0
  echo "$to  (from $from)"
  if ! command -v node >/dev/null 2>&1; then
    if [[ -f "$to" ]]; then echo "  node is not installed, so it cannot be merged automatically. Copy the entries from $from into $to by hand."
    elif ask "Create $to?"; then mkdir -p "$(dirname "$to")"; cp "$from" "$to"; echo "  created"; fi
    return 0
  fi
  node -e "$MERGE" "$from" "$to" plan "$@"; status=$?
  if (( status == 10 )); then echo "  ✓ already enabled, nothing to change"; return 0; fi
  (( status == 0 )) || return 0
  if ask "Apply these changes to $to?"; then
    node -e "$MERGE" "$from" "$to" write "$@" >/dev/null
    [[ -f "$to.bak" ]] && echo "  applied (previous version saved as $to.bak)" || echo "  applied"
  else
    echo "  skipped"
  fi
}

install_one quality/install/claude-settings.json .claude/settings.json .claude/settings.local.json
install_one quality/install/claude-settings.local.json .claude/settings.local.json .claude/settings.json
install_one quality/install/codex-hooks.json .codex/hooks.json

if [[ -f .githooks/pre-commit && "$(git config core.hooksPath)" != ".githooks" ]]; then
  echo "pre-commit  (git config core.hooksPath .githooks, this clone only)"
  if ask "Enable the pre-commit hook?"; then git config core.hooksPath .githooks; echo "  applied"; else echo "  skipped"; fi
fi

echo
if bash scripts/hook-status.sh; then
  echo
  echo "Next: start a NEW agent session (hooks are read when a session starts) and end one turn;"
  echo "scripts/hook-status.sh then shows when the Stop hook last ran. Codex asks you to trust new"
  echo "project hooks once: approve it."
else
  exit 1
fi
