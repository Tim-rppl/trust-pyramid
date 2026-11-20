#!/usr/bin/env bash
# Records one gate interception: a check that blocked the agent's turn, a commit or a PR.
#   <failure output> | TRUST_GATE=<stop-hook|pre-commit|ci> bash scripts/gate-log.sh "<check label>"
# Appends one JSON line to .quality-state/gate-log.jsonl (local, gitignored):
#   {"date":"2026-11-21T10:00:00Z","gate":"pre-commit","check":"web: lint","rules":["project(no-raw-ui-text)"]}
# and, in GitHub Actions, a line to the job summary. scripts/gate-report.mjs summarizes the log.
# Rule IDs are taken from the output: plugin(rule) as printed by oxlint/ESLint, and codes like TP001.
cd "$(git rev-parse --show-toplevel)" || exit 0
label=${1:?usage: gate-log.sh <check label> < failure output}
gate=${TRUST_GATE:-manual}
output=$(cat)

rules=$(grep -oE '[A-Za-z0-9_@-]+\([A-Za-z0-9_/-]+\)|\b[A-Z]{1,4}[0-9]{3,4}\b' <<<"$output" | sort -u)
esc() { local s=${1//\/\\}; s=${s//\"/\\\"}; printf '%s' "$s"; }
json_rules=""
while IFS= read -r rule; do
  [[ -n "$rule" ]] && json_rules+="${json_rules:+,}\"$(esc "$rule")\""
done <<<"$rules"

mkdir -p .quality-state
printf '{"date":"%s","gate":"%s","check":"%s","rules":[%s]}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(esc "$gate")" "$(esc "$label")" "$json_rules" >> .quality-state/gate-log.jsonl

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  echo "- Gate **$gate** blocked: $label${rules:+ ($(tr '\n' ' ' <<<"$rules" | sed 's/ $//'))}" >> "$GITHUB_STEP_SUMMARY"
fi
exit 0
