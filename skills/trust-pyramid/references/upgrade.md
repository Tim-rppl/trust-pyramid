# Upgrade an installation

Use this when the user asks to upgrade Trust Pyramid in a project, or when
`node <skill>/tools/upgrade.mjs status` says an upgrade is available. `<skill>` is this skill's own
directory. The tool ships with the skill, so the newest skill always does the upgrade.

## How it works

Setup records `quality/trust-pyramid.lock.json`: the skill version, the templates that release
shipped, and for every installed file its template, its category, and the template text it was
installed from (base64, the merge base). `install-manifest.json` in the skill says where each
template goes and who owns it:

| Category | Examples | On upgrade |
|---|---|---|
| mechanism | `stop-gate.sh`, `trusted-check.sh`, `review-gate.mjs`, `pre-commit` | replaced; three-way merged if the project changed it |
| tailored | `check.sh`, workflows, hook settings, reviewer prompt, `AGENTS.md` | three-way merged |
| content | project lint rules, fixtures, ledgers, `smoke.mjs`, `feature-map.md` | never touched |
| append | `.gitignore`, `.gitattributes` | missing lines appended |

Three-way merge (`git merge-file`): the project's file, the base, and the new template. Changes on
different lines are combined. When both changed the same lines, the file gets conflict markers
(`<<<<<<< your project` ... `>>>>>>> trust-pyramid <version>`); nothing is chosen silently.

## Steps

1. `node <skill>/tools/upgrade.mjs status --project .` and read the `CHANGELOG.md` entries between
   the installed version and this one (this skill's repository, "Upgrade notes"). Tell the user in
   plain language what changes. No lock file: see "Adopting an older installation".
2. Work in a separate worktree on a new branch, as in `add-rule.md`: gate files are protected
   (`permissions.deny`, CODEOWNERS, trusted CI), so the upgrade reaches the default branch only
   through a pull request the user approves.
   ```bash
   git worktree add ../<repo>-tp-upgrade -b chore/trust-pyramid-<version>
   ```
3. In the worktree: `node <skill>/tools/upgrade.mjs upgrade --project .` (add `--dry-run` first to
   show the user what will change). Exit code 3 means conflicts.
4. Resolve every conflict block. Keep the project's intent and the template's fix; when they truly
   disagree, prefer the project's version and say so. Then `upgrade.mjs check` must pass.
5. Act on the rest of the report:
   - **New templates to install and adapt**: install them as in the matching setup phase, then
     `upgrade.mjs record --path <path>`.
   - **No longer shipped**: remove the file if nothing uses it (search first), else keep it.
   - **Missing**: the project moved or deleted a file; ask the user.
   - New or changed scripts: `git update-index --chmod=+x` for `*.sh` and `.githooks/*`.
6. If `quality/install/*` changed, tell the user to run `bash scripts/install-agent-hooks.sh`
   after merging (agents cannot write their own hook config), then start a new session.
7. Run every check (`bash scripts/check.sh --all`, the smoke flow) and `bash scripts/hook-status.sh`.
   Commit, including `quality/trust-pyramid.lock.json`.
8. Open a pull request. In its description, in plain language: the version change, what was
   replaced, merged and added, and **each conflict: what the project had, what the new version
   has, and what you kept and why**. CI notes that protected files changed and checks with the
   base branch's copies; the new gates take effect after merge.

## Adopting an older installation

A project set up before upgrades were recorded has no lock file. Run
`node <skill>/tools/upgrade.mjs record --project .` once: it records the current templates as the
base for every installed file. Compare the project's mechanism files with this skill's templates
and bring them up to date by hand where they differ (the base cannot tell old template text from
project edits). Commit the lock file; later releases then upgrade normally.

## For maintainers of this skill

- Bump `VERSION` and `.claude-plugin/plugin.json` together, add a dated `CHANGELOG.md` entry with
  "Upgrade notes" (anything the agent must do beyond the tool: renamed files, new secrets, new
  required checks), and tag the release `v<version>`.
- Every template must be in `install-manifest.json` (a test enforces it). Moving a template's
  install path is a breaking change: say so in the upgrade notes.
