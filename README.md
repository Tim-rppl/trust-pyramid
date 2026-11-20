<div align="center">

# Trust Pyramid

**Stop reviewing AI-written code line by line. Make your coding agent prove its work.**

An agent skill for **Claude Code** and **Codex** that sets up a project-specific quality system:
architecture constraints, lint rules whose error messages tell the agent how to fix the code,
runtime verification in the real app, an evidence-based AI reviewer, and gates the agent cannot skip.

[![CI](https://github.com/Tim-rppl/trust-pyramid/actions/workflows/ci.yml/badge.svg)](https://github.com/Tim-rppl/trust-pyramid/actions/workflows/ci.yml)
![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Claude Code](https://img.shields.io/badge/Claude%20Code-skill%20%2B%20plugin-d97757)
![Codex](https://img.shields.io/badge/Codex-skill-10a37f)

**English** · [简体中文](README.zh-CN.md)

<img src="docs/media/demo-en.gif" alt="Trust Pyramid demo: the agent calls the model API from the browser, the Stop hook blocks it with fix-it lint errors, the agent fixes the root cause, the smoke flow proves it in the running app, and an independent AI reviewer's findings are settled with red-to-green test evidence" width="100%">

<sub>All terminal output and the app screenshot are real, captured from a demo project. The agent's edits are replayed by a script; the review findings come from a real, independent AI reviewer run.</sub>

</div>

---

## Why

Coding agents write code faster than anyone can review it. Writing more rules into `AGENTS.md`
does not fix this: prose is advice, and agents skip advice, on purpose or not.

Trust Pyramid moves trust from people to the system:

- **Rules live in code, not prose.** A mistake corrected once becomes a lint rule or a test, so it
  cannot happen again - for any agent or any person.
- **Error messages are prompts.** Every rule says what is wrong and how to fix it, so the agent
  repairs its own code without you.
- **Behavior is proven, not claimed.** The agent runs the real app, clicks through it, takes
  screenshots, and runs a smoke flow.
- **Checks cannot be skipped.** They run in the agent's Stop hook, in pre-commit, and in CI with
  branch protection - triggered by the system, never by the agent being checked.
- **An AI reviewer fills the gap while rules are few.** Its findings only count with evidence: a
  test that fails on the old code and passes on the new code. Confirmed findings become new rules.

The approach follows Lauren Tan's talk
[*All Code Is Slop (Except Mine)*](https://www.youtube.com/watch?v=O_zcc6Xl12g) (AI Engineer Code
Summit 2026) and adds the enforced reviewer layer. She also open-sourced her own skills as
[pstack](https://github.com/cursor/plugins/tree/main/pstack); see
[Pair it with pstack](#pair-it-with-pstack-optional) for how the two differ and work together.

## How it works

```mermaid
flowchart TB
    A["1 · Structure and APIs<br/>make the wrong thing hard to write"] --> B["2 · Static analysis<br/>types, boundary rules, project lint rules, tests"]
    B --> C["3 · Verification<br/>run the app, screenshots, smoke flow, fake model server"]
    C --> D["4 · Prose<br/>a short AGENTS.md, only what code cannot say"]
    D --> E["5 · AI reviewer<br/>finds candidates; evidence decides"]
    E --> F["6 · Human<br/>reviews evidence, not diffs"]
    E -. "confirmed findings become rules" .-> B
```

Higher layers are cheaper and deterministic, so the skill always tries them first.
The gates make sure every layer actually runs:

| When | Gate | Can the agent skip it? |
|---|---|---|
| Agent tries to finish | Stop hook (Claude Code and Codex, one script) | Hard, but an agent can edit local hook files - fast feedback, not the guarantee |
| `git commit` | pre-commit hook | Only with `--no-verify` |
| Pull request | CI: checks, smoke, AI review, review gate - using the **base branch's** gate files | **No** - with branch protection and code owners |
| Merge | Your approval, based on evidence | It is your call |

## What we measured

We tested Trust Pyramid with real Claude Code and Codex runs before recommending it
([full write-up](docs/BENCHMARK.md)). In short:

- **Project-specific rules work.** Boundary and "never do X here" rules caught their planted bugs
  every time, and findings turned into tests stopped the same bugs from coming back.
- **The first gate design could be bypassed** (rule switched off in the PR itself). CI now checks
  every PR with the base branch's gate files; all seven bypass attempts are blocked.
- **A frontier model is already good at single tasks.** Claude Opus 5.5 with no tooling handled
  races, lost updates and cross-feature invariants. Running the full pyramid on every task cost
  about 4x without catching more. That is why the default profile is **lite**.

## Profiles

| | lite (default) | full |
|---|---|---|
| Project lint rules, boundaries, tests | yes | yes, plus property tests |
| Trusted CI, CODEOWNERS, pre-commit | yes | yes |
| Stop hook | fast checks only, 2 attempts | same |
| AI reviewer | once per PR in CI | also after every task |
| Runtime verification | smoke flow in CI | on every user-visible change |

Choose **full** for smaller or cheaper coding models, many contributors, or high-risk code
(money, permissions, personal data). You can switch at any time.

## Quick start

### Claude Code

Install as a plugin:

```text
/plugin marketplace add Tim-rppl/trust-pyramid
/plugin install trust-pyramid@trust-pyramid
```

Or copy the skill manually:

```bash
git clone https://github.com/Tim-rppl/trust-pyramid.git
cp -R trust-pyramid/skills/trust-pyramid ~/.claude/skills/
```

Use one method, not both, or the skill will be listed twice.

### Codex

```bash
git clone https://github.com/Tim-rppl/trust-pyramid.git
mkdir -p ~/.agents/skills && cp -R trust-pyramid/skills/trust-pyramid ~/.agents/skills/
```

For a single repository, copy it to `.agents/skills/trust-pyramid` in that repository instead.

### Run it

Open your project, switch to plan mode if your agent has one, and ask:

```text
Use the trust-pyramid skill to set up quality gates for this project.
Product: a real-time transcription + translation web app.
Stack: TypeScript, React (Vite), Node.js, Firebase, OpenAI-compatible model APIs.
UI: English and Chinese. I can't judge code well; show me evidence in plain language.
```

In Codex you can also type `$trust-pyramid`.

The agent interviews you briefly, writes a plan, **waits for your approval**, then builds the
layers one by one. At the end it proves every check can fail, runs a demo loop on a small
feature, and reports in plain language.

## Pair it with pstack (optional)

Lauren Tan open-sourced her own skills as
[**pstack**](https://github.com/cursor/plugins/tree/main/pstack) (MIT). It is a different tool that
solves a different half of the problem, and the two can be used together. In our benchmark pstack
did not change results on single tasks with frontier models and used more tokens, so treat it as an
option for how you like to work, not a quality requirement.

| | pstack | Trust Pyramid |
|---|---|---|
| What it is | ~60 skills that shape **how the agent works**: `/poteto-mode` with 22 playbooks (bug fix, perf, refactor, feature, ...), engineering principles, and builders such as `/correct` and `/create-verification-skill` | One skill that **installs enforcement into your repo**: lint rules, verification tools, an enforced reviewer, and gates |
| When it acts | While the agent writes code, whenever you invoke it | Every time the agent finishes, you commit, or a PR opens - automatically |
| Ready to use | Immediately after install | After a one-time setup run (plan, approve, install) |
| Can it be skipped | Yes - its skills run only when you call them | No - the gates run without asking the agent |
| After you uninstall | Its effect is gone | The rules and gates stay in your repo |

**Why both:** pstack makes the agent get it right the first time, so it rewrites less. Trust
Pyramid guarantees that what it still gets wrong never reaches `main`. pstack also brings tools
that Trust Pyramid only sketches: verification for CLIs, desktop and mobile apps, state charts,
and formal verification. pstack is Lauren Tan's project; Trust Pyramid is independent and not
affiliated with her or Cursor.

### Install both

Claude Code:

```text
/plugin marketplace add cursor/plugins
/plugin install pstack@cursor-plugins
/plugin marketplace add Tim-rppl/trust-pyramid
/plugin install trust-pyramid@trust-pyramid
```

Then run `/pstack:setup-pstack` once to choose models and a reasoning budget.

Codex (and other agents) - pstack through its official mirror and the `skills` CLI:

```bash
npx skills add backnotprop/pstack
```

Then install Trust Pyramid as in [Quick start](#codex).

### Using both in the chat

In Claude Code, pstack commands carry the plugin prefix (`/pstack:<skill>`). In Codex, mention a
skill with `$<skill>` (for example `$poteto-mode`).

**1. Once per project: set up the gates.**

```text
Use the trust-pyramid skill to set up quality gates for this project. <product, stack, languages>
```

**2. Every task: work with pstack, let the gates check.**

```text
/pstack:poteto-mode Add CSV export to the notes page. Verify it in the running app.
```

pstack drives the work; when the agent tries to finish, Trust Pyramid's Stop hook runs the checks
and sends it back if anything fails.

**3. The same mistake happens twice: make it impossible.**

```text
/pstack:correct The agent keeps calling the model API directly from route handlers.
```

`/correct` turns the mistake into architecture, a type, a lint rule, or a test, and proves it
fails on the old code. The new rule then runs in every gate automatically.

**4. Your app is not a web app (CLI, desktop, mobile): build its verifier.**

```text
/pstack:create-verification-skill
```

Use the generated skill wherever Trust Pyramid's workflow asks for runtime verification.

**5. Before a pull request: let the reviewer find problems, and keep the good ones.**

```text
Run the quality reviewer on this branch. For each confirmed finding, use /pstack:correct to turn
it into a rule, then record dispositions in quality/review-dispositions.json.
```

**6. Optional, for tricky state (recording sessions, subscriptions, retries):**

```text
/pstack:statechart the recording session
/pstack:create-formal-verification-skill
```

| You want to... | Use |
|---|---|
| Do a task rigorously | `/pstack:poteto-mode` |
| Stop a repeated mistake for good | `/pstack:correct` (or Trust Pyramid's add-rule flow) |
| Prove behavior of a non-web app | `/pstack:create-verification-skill` |
| Remove comments that excuse workarounds | `/pstack:no-comments` |
| Make sure nothing bad merges | Trust Pyramid gates (automatic) |
| Get problems found for you | Trust Pyramid reviewer (runs on every PR) |

## What you get

| Area | Files added to your project |
|---|---|
| Gates | `scripts/check.sh`, `scripts/stop-gate.sh`, `.githooks/pre-commit`, `.claude/settings.json`, `.codex/hooks.json` |
| Lint | `lint/` - a project plugin with fix-it messages, fixtures, and a test that proves each rule fires |
| Verification | `verify/app.mjs` (up/click/fill/snapshot/screenshot/errors), `verify/smoke.mjs`, `verify/feature-map.md`, `verify/fake-openai.mjs` |
| AI reviewer | `quality/reviewer-prompt.md`, `.claude/agents/quality-reviewer.md`, `scripts/review-gate.mjs`, `quality/review-dispositions.json` |
| Ratchet ledger | `quality/rule-candidates.md`, `quality/review-log.md` |
| CI | `.github/workflows/quality.yml`, `.github/pull_request_template.md` |
| Prose | a short `AGENTS.md` (and `CLAUDE.md` → `@AGENTS.md`), `docs/QUALITY.md` |

Everything is adapted to your stack. Recipes are included for TypeScript/React/Node/Firebase,
Next.js + Postgres, Python/FastAPI (field-tested, with an AST rule template), Go, and mobile.

## The enforced AI reviewer

An AI reviewer is useful early, when there are few rules and you cannot spot problems yourself.
It is also easy to skip or to wave away. Trust Pyramid closes both holes:

1. **It always runs.** CI reviews every pull request (Claude Code or Codex action), cached by a
   hash of the code diff so it reruns only when code changes.
2. **Every finding needs an answer.** `quality/review-dispositions.json` marks each finding
   `confirmed`, `rejected` or `deferred`. `scripts/review-gate.mjs` is a required check:
   - **confirmed** → the named test must **fail on the base commit (at an assertion, not an import
     error) and pass on the PR head**, checked by machine;
   - **rejected** → not a real problem; needs a concrete reason, shown to you in the PR;
   - **deferred** → real but not fixed now; needs a reason and must be recorded in
     `quality/rule-candidates.md`, so it is tracked rather than forgotten.
3. **Confirmed findings feed the ratchet.** Each becomes a lint rule, a test, or an entry in
   `quality/rule-candidates.md`; the second occurrence must become a rule.

## Daily use

```text
# A mistake happened again
Turn this into a rule using trust-pyramid's add-rule process: <describe the mistake>.

# Before a pull request
Run the quality reviewer on this branch, prove or reject each finding, and give me a plain-language summary.

# Weekly
Sweep the whole repo with the reviewer and update quality/rule-candidates.md with the top 3 rule candidates.
```

## FAQ

**Is this just a code-review skill?** No. The reviewer is one layer. Most of the value comes from
rules in code and gates that run without asking the agent.

**Does it work for existing projects?** Yes. It locks in what is already clean and ratchets the
rest: noisy rules start on new code only, with a recorded backlog.

**Do I need GitHub?** The local gates work anywhere. The unskippable layer needs CI with branch
protection; the templates target GitHub Actions.

**What does it cost?** Linting and tests are free. The AI review runs once per code change in CI
and uses your Anthropic or OpenAI API key.

## Repository layout

```text
skills/trust-pyramid/
├── SKILL.md            # the workflow the agent follows
├── agents/openai.yaml  # Codex UI metadata
├── references/         # one file per layer, gates, stack recipes, lessons learned
└── templates/          # files the agent installs and adapts
.claude-plugin/         # Claude Code plugin + marketplace manifests
tests/                  # tests for the templates themselves
```

## Contributing

Issues and pull requests are welcome, especially stack recipes and lessons learned.
See [CONTRIBUTING.md](CONTRIBUTING.md). Run `npm ci && npm test` before opening a PR.

## Credits

- Lauren Tan, [*All Code Is Slop (Except Mine)*](https://ai.engineer/code/2026/talks/lauren-tan), AI Engineer Code Summit 2026.
- Lauren Tan, [pstack](https://github.com/cursor/plugins/tree/main/pstack) (MIT) - the skills behind the talk.
- OpenAI, [*Harness engineering*](https://openai.com/index/harness-engineering/).
- Maddila et al., [*Agentic Program Repair from Test Failures at Scale*](https://arxiv.org/abs/2507.18755).

## License

[MIT](LICENSE)
