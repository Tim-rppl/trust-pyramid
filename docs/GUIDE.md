# Guide

Details behind the [README](../README.md). The agent's own instructions are in
[SKILL.md](../skills/trust-pyramid/SKILL.md).

- [Profiles](#profiles)
- [What gets added to your project](#what-gets-added-to-your-project)
- [The AI reviewer](#the-ai-reviewer)
- [Daily use](#daily-use)
- [Upgrading](#upgrading)
- [Cost and limits](#cost-and-limits)
- [Repository layout](#repository-layout)

## Profiles

| | lite (default) | full |
|---|---|---|
| Project lint rules, boundaries, tests | yes | yes, plus property tests |
| Trusted CI, CODEOWNERS, pre-commit | yes | yes |
| Stop hook | fast checks only, 2 attempts | same |
| AI reviewer | once per pull request in CI | also after every task |
| Runtime verification | smoke flow in CI | on every user-visible change |

Choose full for smaller or cheaper models, many contributors, or high-risk code (money,
permissions, personal data). You can switch at any time.

## What gets added to your project

| Area | Files |
|---|---|
| Gates | `scripts/check.sh`, `scripts/stop-gate.sh`, `scripts/install-agent-hooks.sh`, `scripts/hook-status.sh`, `.githooks/pre-commit`, `.claude/settings.json`, `.claude/settings.local.json` (deny list, per machine), `.codex/hooks.json` |
| Lint | `lint/`: a project plugin with fix-it messages, fixtures, and a test that proves each rule fires |
| Verification | `verify/app.mjs` (up, click, fill, snapshot, screenshot, errors), `verify/smoke.mjs`, `verify/feature-map.md`, `verify/fake-openai.mjs` |
| AI reviewer | `quality/reviewer-prompt.md`, `.claude/agents/quality-reviewer.md`, `scripts/review-gate.mjs`, `quality/review-dispositions.json` |
| Records | `quality/rule-candidates.md`, `quality/review-log.md` |
| CI | `.github/workflows/quality.yml`, plus `quality-smoke.yml` and `quality-review.yml` when those layers are installed, and `.github/pull_request_template.md` |
| Prose | a short `AGENTS.md` (`CLAUDE.md` points to it), `docs/QUALITY.md` |

Everything is adapted to your stack. Recipes cover TypeScript/React/Node/Firebase, Next.js with
Postgres, Python/FastAPI, Go, and mobile.

## The AI reviewer

A reviewer helps most early on, when there are few rules. It is also easy to skip or to wave away,
so Trust Pyramid enforces it:

1. **It always runs.** CI reviews every pull request. Results are cached by a hash of the code
   diff, so it reruns only when code changes.
2. **Every finding needs an answer** in `quality/review-dispositions.json`, checked by
   `scripts/review-gate.mjs`:
   - `confirmed`: the named test must fail on the base commit (at an assertion, not an import
     error) and pass on the pull request;
   - `rejected`: needs a concrete reason, shown in the pull request;
   - `deferred`: needs a reason and an entry in `quality/rule-candidates.md`.
3. **Confirmed findings become rules.** Each becomes a lint rule, a test, or a rule candidate; the
   second time the same mistake appears, it must become a rule.

## Daily use

```text
# The same mistake happened again
Turn this into a rule using trust-pyramid's add-rule process: <the mistake>.

# Before a pull request
Run the quality reviewer on this branch, prove or reject each finding, and summarize in plain language.

# Weekly
Sweep the whole repository with the reviewer and add the top 3 rule candidates to quality/rule-candidates.md.
```

## Upgrading

Update the skill (Claude Code: `/plugin marketplace update`; Codex: `git pull` and copy the skill
folder again), then ask the agent in your project:

```text
Upgrade trust-pyramid in this project.
```

The agent works on a new branch and runs a three-way merge for each installed file, the same kind
of merge git uses:

- files you never changed are replaced with the new version;
- your changes and the new version's changes are combined when they touch different lines;
- when both changed the same lines, the agent resolves it and explains each case in the pull
  request; nothing is overwritten silently;
- your own lint rules, ledgers and smoke flows are never touched.

You review and merge the pull request. Projects set up before version 0.4.0 run one extra step the
first time (the agent adopts the current files as the starting point). Details:
[references/upgrade.md](../skills/trust-pyramid/references/upgrade.md).

## Cost and limits

| Step | Model tokens | Measured or expected |
|---|---|---|
| One-time setup | yes | 24-32 min; ~$6.5 with Claude Code, ~8.5M tokens with Codex, on a mid-size Remix app ([benchmark](BENCHMARK.md), November 2026). Larger projects cost more |
| Lint, type check, tests, Stop hook, pre-commit, CI | no | free |
| The agent fixing what a gate rejected | yes | nothing when the code is right; otherwise a round or two (the Stop hook hands over after 2) |
| AI reviewer, once per pull request | yes | ~$0.7 for a small diff, plus fixes if it finds something |
| `AGENTS.md` in the prompt | a little | a dozen lines per session |

A near-full setup (reviewer after every task, 3 Stop hook attempts) cost about 4x per task in the
benchmark. The lite profile removes both. Lite itself has not been benchmarked yet, so its numbers
are estimates.

To keep usage low, start with lint rules, tests and CI. Turn on the reviewer for every pull request
or only for risky ones, and turn it off if `quality/review-log.md` shows it finding nothing real
after a few weeks.

Known limits:

- **Local gates are feedback, not a guarantee.** The Stop hook and pre-commit can be switched off
  on a machine. Only CI with branch protection cannot be skipped. On private repositories on
  GitHub Free, branch protection is not available and CI only reports.
- **The Stop hook is off until you enable it.** Agents cannot write their own hook settings. Run
  `bash scripts/install-agent-hooks.sh` once per clone. Until then, `AGENTS.md` tells the agent to
  remind you, and every commit prints a reminder.
- **The Stop hook checks uncommitted changes only.** Commits are checked by pre-commit and CI.
- **The AI reviewer is not deterministic.** It missed a planted bug in 1 of 10 runs, which is why
  its findings count only with evidence.
- **Codex's sandbox cannot launch browsers,** so with Codex the smoke flow runs in CI.
- **The benchmark is small** (one run per cell). See [BENCHMARK.md](BENCHMARK.md).

## Repository layout

```text
skills/trust-pyramid/
├── SKILL.md            # the workflow the agent follows
├── agents/openai.yaml  # Codex UI metadata
├── references/         # one file per layer, gates, stack recipes, lessons learned
└── templates/          # files the agent installs and adapts
.claude-plugin/         # Claude Code plugin and marketplace manifests
tests/                  # tests for the templates
docs/                   # this guide, the benchmark, demo media
```
