---
name: trust-pyramid
description: Set up (or extend) a project-specific quality system where coding agents prove their own work - architecture constraints, custom lint rules with fix-it error messages, runtime verification, an evidence-based AI reviewer, and gates (agent Stop hook, pre-commit, CI, branch protection) that cannot be skipped. Use when starting a new project, when adding agent guardrails to an existing repo, or when the user wants to stop reviewing AI-written code line by line. Works in Claude Code and Codex.
license: MIT
---

# Trust Pyramid

Goal: the human stops reading diffs. Agents write code that is correct by default, are stopped by
deterministic checks when it is not, prove behavior in the running app, and hand the human
evidence (screenshots, smoke results, red-to-green tests) plus a plain-language summary.

The method follows Lauren Tan's talk "All Code Is Slop (Except Mine)" (AI Engineer Code Summit 2026)
and adds an AI reviewer layer for the early phase when there are few rules and the human cannot spot problems.

## Core rules (apply to everything you build with this skill)

1. **Prefer the highest layer that can solve the problem.** In order:
   architecture/API design → static analysis → verification → prose → AI reviewer → human.
   Prose (AGENTS.md, skills) is what agents may skip; checks that run automatically are not.
2. **Code is memory.** Agents copy what is in the repo. Never leave workarounds, anti-patterns or
   dead code behind as examples.
3. **Every correction becomes a rule or a test.** Eliminate by design if possible, otherwise lint,
   otherwise test, and only then prose.
4. **Error messages are prompts.** Every custom rule says what is wrong, why, how to fix it, and the
   sanctioned escape hatch for legitimate exceptions.
5. **No escape hatches.** No disable comments, no `--no-verify`, no weakened assertions, no excuse
   comments ("too hard to change, patch for now").
6. **Ratchet.** Lock in what is already clean; rules with many existing violations start on new code
   only and are tracked until the backlog is cleared.
7. **The checker is never the checked.** Anything that must not be skipped runs outside the agent's
   control, and must not trust files the agent can edit: CI runs the base branch's gate files
   (`scripts/trusted-check.sh`), new suppression comments fail, and humans own the gate files.
8. **Fix the inner loop before automating the outer loop.**

## Workflow

Follow these phases in order. Stop after Phase 1 and wait for the user's approval.

### Phase 0 - Intake

Collect (ask only for what you cannot detect from the repo):
product in one sentence, core user-facing features, stack, package manager and runtime versions,
UI languages, deployment target, areas involving money/permissions/privacy, external APIs
(AI models, payments), the user's coding level, new vs existing project.
Detect the host agent: Claude Code (`.claude/`, `CLAUDE.md`) or Codex (`.codex/`, `AGENTS.md`).
If unsure, install gates for both.

### Phase 1 - Plan (then stop for approval)

Write a plan covering: directory layout and boundaries, tool choices with version-compatibility
notes, the first batch of rules (source, detection, draft error message), the verification
environment (including a fake model server if the app calls AI APIs), the reviewer design, the
gates, and the phases below. Read `references/stack-recipes.md` for the user's stack first.

### Phase 2 - Layer 1: structure and APIs

Read `references/layer-1-structure.md`. Create the layout and the single-entry APIs (AI client,
config/secrets, i18n, logging, shared UI primitives) so the wrong thing is hard to write.

### Phase 3 - Layer 2: static analysis

Read `references/layer-2-static.md`. Typecheck strict, boundary rules, a project lint plugin
(start from `templates/lint/`), each rule with violating + compliant fixtures and a test,
unit tests for pure logic, property tests for money/quota/permission/time logic, database
security-rule tests.

### Phase 4 - Layer 3: verification

Read `references/layer-3-verification.md`. One-command local stack with isolated ports and seeded
data, the verify CLI (`templates/verify/app.mjs`), a feature map, a smoke flow, and a fake
OpenAI-compatible server (`templates/verify/fake-openai.mjs`) when the app calls models.

### Phase 5 - Gates

Read `references/gates.md`. Install `scripts/check.sh`, the pre-commit hook, the Stop hook for
each host agent, CI, branch protection instructions, and the PR template.

Agents usually cannot write their own host config (Claude Code protects `.claude/settings*.json`,
Codex protects `.codex/`). Stage the hook configs in `quality/install/` (`claude-settings.json`,
`codex-hooks.json`), install `scripts/install-agent-hooks.sh`, and ask the user to run it. Install
the `permissions.deny` list for protected paths **last**, after every other edit: once it is in
place the agent can no longer edit gate files (by design), so earlier installation locks it out.

### Phase 6 - Layer 5: AI reviewer (enforced)

Read `references/layer-5-ai-reviewer.md`. Install the reviewer prompt, the local reviewer agent,
the CI review job, and `scripts/review-gate.mjs` so every finding needs a machine-checked
disposition before merge.

### Phase 7 - Layer 4: prose

Write a short root `AGENTS.md` (Claude Code: `CLAUDE.md` containing `@AGENTS.md`) from
`templates/AGENTS.md`. Keep it under ~15 lines; rules live in code, not here.

### Phase 8 - Prove it and demo the loop

1. Run every check and the smoke flow; all must pass. Then commit to the setup branch (or ask the
   user to) and run the checks again on a fresh clone of that commit: gates that only pass on an
   uncommitted working tree are broken.
2. Prove no check is vacuous: introduce one violation per check (lint rule, boundary, test,
   smoke step), confirm it fails, then restore. Restore from a backup or with an exact edit,
   never with `git checkout` on files that hold uncommitted work.
3. Demo one small feature end to end: write a deliberately non-compliant version → gate blocks
   it → fix from the error messages → verify in the running app with screenshots → run the
   reviewer and confirm/reject findings with evidence → turn confirmed findings into rules →
   commit. Record the real outputs in `docs/QUALITY.md`.
4. Report to the user in plain language: what was installed, how each layer was proven, what is
   still missing, and the one-time setup they must do themselves (secrets, branch protection).

Commit to a new branch. Never push or deploy unless the user asks.

## Templates

| Template | Install as |
|---|---|
| `templates/scripts/check.sh` | `scripts/check.sh` (edit the `CHECKS` table) |
| `templates/scripts/stop-gate.sh` | `scripts/stop-gate.sh` |
| `templates/scripts/install-agent-hooks.sh` | `scripts/install-agent-hooks.sh` (the user runs it) |
| `templates/claude/settings.json` | `.claude/settings.json` (merge if it exists) |
| `templates/codex/hooks.json` | `.codex/hooks.json` |
| `templates/githooks/pre-commit` | `.githooks/pre-commit` + `git config core.hooksPath .githooks` |
| `templates/lint/` | `lint/` (oxlint/ESLint plugin, fixtures, fixture test) |
| `templates/lint/python/` | `lint/` for Python projects (AST rule checker + fixtures) |
| `templates/verify/` | `verify/` (CLI, config, smoke, feature map, fake model server) |
| `templates/quality/` | `quality/` (reviewer prompt, review config, dispositions, ledgers) |
| `templates/scripts/review-gate.mjs` | `scripts/review-gate.mjs` |
| `templates/scripts/trusted-check.sh`, `templates/scripts/no-suppressions.sh` | `scripts/` (CI uses the base branch's copies) |
| `templates/quality/protected-paths.txt`, `templates/quality/allowed-suppressions.txt` | `quality/` (edit the list for the project) |
| `templates/github/CODEOWNERS` | `.github/CODEOWNERS` (replace `@OWNER`) |
| `templates/claude/agents/quality-reviewer.md` | `.claude/agents/quality-reviewer.md` |
| `templates/github/` | `.github/` (workflow, PR template) |
| `templates/AGENTS.md` | `AGENTS.md` (+ `CLAUDE.md` containing `@AGENTS.md`) |
| `templates/gitignore-additions.txt` | append to `.gitignore` |

Adapt every template to the stack; remove example rules that do not apply. Templates are
JavaScript/Node because the verification tooling (Playwright) is; for non-Node stacks keep
`verify/` as a small Node package and write lint rules in the stack's own linter.

## Daily use (after setup)

- **A mistake happened twice** → follow `references/add-rule.md`.
- **Before a PR** → run the reviewer locally (`references/layer-5-ai-reviewer.md`); CI runs it anyway.
- **Weekly sweep** → run the reviewer over the whole repo to collect rule candidates.
- **New feature** → check passes, verify in the running app, update feature map + smoke, attach evidence.

## Running environment

- Tell the user the cost up front: a full setup on an existing app took ~30 minutes and the
  equivalent of $7-19 of model usage (Claude) or ~10M tokens (Codex) in testing.
- No display: never install or launch Cypress or desktop browsers. Headless Playwright is enough.
- Codex's sandbox blocks launching browsers; run the smoke flow outside the sandbox or leave it to CI.
- On small machines (8 GB RAM), run one heavy job at a time.

## Pitfalls seen in practice

Read `references/lessons-learned.md` before Phase 3. The short list: check linter support for the
installed TypeScript major version; use isolated ports; pin browser locale; reset smoke state at the
start (and reset data); restart the verify stack after backend changes; make gate output show only
failures; prove checks fire; record console errors from a long-lived process; Codex Stop hooks must
print JSON on success; run linters from the repo root.
