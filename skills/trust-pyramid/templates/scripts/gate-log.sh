#!/usr/bin/env bash
# Records one gate interception: a check that blocked the agent's turn, a commit or a PR.
#   <failure output> | TRUST_GATE=<stop-hook|pre-commit|ci> bash scripts/gate-log.sh "<check label>"
# Appends one JSON line to .quality-state/gate-log.jsonl (local, gitignored):
#   {"date":"2026-11-21T10:00:00Z","gate":"pre-commit","check":"web: lint","rules":["project(no-raw-ui-text)"]}
# and, in GitHub Actions, a line to the job summary. scripts/gate-report.mjs summarizes the log.
# Rule IDs are taken only from where linters print them, so code quoted in a fix-it message (t(key),
# var(--x)) is not mistaken for a rule: "plugin(rule):" (oxlint default), "[Error/plugin(rule)]"
# (oxlint unix format), and a code after file:line[:col]: such as "app/x.py:3: TP001" or "E501".
# In a linked git worktree the entry goes to the main checkout's log, with a "worktree" field, so
# gate-report.mjs sees it and it survives `git worktree remove`.
# TRUST_GATE_LOG=0 records nothing: for probes that simulate a gate (proving a check fires), so the
# report counts only real interceptions.
[[ "${TRUST_GATE_LOG:-1}" == 0 ]] && exit 0
top=$(git rev-parse --show-toplevel) || exit 0
main=$(git worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p')
[[ -n "$main" && -d "$main" ]] || main=$top
cd "$main" || exit 0
label=${1:?usage: gate-log.sh <check label> < failure output}
gate=${TRUST_GATE:-manual}
output=$(cat)

rules=$( {
  grep -oE '[A-Za-z0-9_@-]+\([A-Za-z0-9_/-]+\):' <<<"$output" | sed 's/:$//'
  grep -oE '\[[A-Za-z]+/[A-Za-z0-9_@-]+\([A-Za-z0-9_/-]+\)\]' <<<"$output" | sed -E 's|^\[[A-Za-z]+/||; s|\]$||'
  grep -oE ':[0-9]+(:[0-9]+)?: [A-Z]{1,4}[0-9]{3,4}( |$)' <<<"$output" | sed -E 's/^.*: //; s/ $//'
} | LC_ALL=C sort -u)
esc() { local s=${1//\\/\\\\}; s=${s//\"/\\\"}; printf '%s' "$s"; }
json_rules=""
while IFS= read -r rule; do
  [[ -n "$rule" ]] && json_rules+="${json_rules:+,}\"$(esc "$rule")\""
done <<<"$rules"

mkdir -p .quality-state
where=""
[[ "$top" != "$main" ]] && where=",\"worktree\":\"$(esc "$top")\""
printf '{"date":"%s","gate":"%s","check":"%s","rules":[%s]%s}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(esc "$gate")" "$(esc "$label")" "$json_rules" "$where" >> .quality-state/gate-log.jsonl

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  echo "- Gate **$gate** blocked: $label${rules:+ ($(tr '\n' ' ' <<<"$rules" | sed 's/ $//'))}" >> "$GITHUB_STEP_SUMMARY"
fi
exit 0
