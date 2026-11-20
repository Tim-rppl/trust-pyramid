# Lessons learned

Each item cost real time during a reference rollout on a production TypeScript/React/Firebase app.

1. **Linter vs TypeScript version.** `typescript-eslint` declared `typescript < 6.1` while the
   project used TypeScript 7 (native compiler without the JS API). Check peer ranges before
   installing; oxlint with a JS plugin worked.
2. **Turning on a whole rule category floods the output.** Enabling a framework plugin's full
   "correctness" set reported dozens of legacy issues. Start with project rules; ratchet the rest.
3. **Rule fixtures must not be ignored by the fixture test.** If the main config ignores
   `lint/fixtures/**`, the fixture test needs its own config (`-c lint/fixtures/<cfg>`); a
   `--no-ignore` flag may not override config-level ignore patterns.
4. **Port conflicts.** Another project's Firestore emulator already held port 8080. Use a dedicated
   emulator config with non-default ports for verification.
5. **Headless browser locale.** The headless browser defaulted to English, so Chinese selectors
   failed. Pin `--lang`/`--accept-lang`. The `snapshot` command revealed the cause immediately.
6. **Per-connection init scripts die with the connection.** Record console errors from a long-lived
   watcher process attached over CDP, and register its PID so `down` stops it.
7. **Smoke runs must reset state.** A failed run left the UI language switched, so the next run
   failed everywhere. Reset language/session/data at the start; restore in `finally`.
8. **Gate output must show the failure.** `tail -40` of a test run showed 40 passing tests and hid
   the failing one. Use a failure-only reporter and truncate long lines.
9. **Existing tests can be hostile to agents.** A regex test dumped the whole source file as the
   assertion message without a line number. The equivalent lint rule pointed to `61:25` with a fix.
10. **Prove the checks are not vacuous.** Remove a translation or introduce a violation on purpose
    and confirm each layer fails. A green check that never fails is decoration.
11. **Do not restore experiments with `git checkout <file>`** when the file has uncommitted work;
    it reverts the real change too. Use a backup copy or an exact edit. (The i18n test caught this.)
12. **Screenshots catch what code checks cannot.** A new label rendered centered between two
    toolbar groups because of `justify-content: space-between`. No lint or unit test would flag it.
13. **Codex Stop hooks must print JSON on exit 0**; plain text is invalid. Exit 2 + stderr blocks.
    Claude Code accepts the same contract, so one script serves both.
14. **Agents cannot fix what they cannot run.** Without real AI credentials the AI features were
    unverifiable locally. Ship a fake OpenAI-compatible server from day one.
15. **Nested test runners can lie.** A `node --test` started from inside another `node --test`
    inherits `NODE_TEST_CONTEXT` and exits 0 even when its tests fail. Any gate that judges
    evidence by exit code must clear that variable (review-gate does).
16. **Do not build check commands with `$(...)` inside double-quoted bash arrays.** It expands when
    the array is defined, not when the check runs. Put non-trivial commands in a script file.
17. **oxlint rejects paths containing `..`**; run it from the repo root with repo-relative paths.
18. **Smoke flows collide with their own leftovers.** Rows created by earlier runs made a selector
    match three elements. Reset data before each run and scope assertions to the new item.
19. **Verification servers do not reload.** After backend edits the smoke flow hit the old code
    (404s). Restart the stack (`down`, `up`).
20. **Prove findings against the reviewed commit, not `main`.** In the demo, the reviewer's two real
    bugs were introduced by the PR itself; on `main` the code did not exist, so a test could only
    fail at import. Record `reviewed_sha` with every review.
21. **Review the gate too.** The independent reviewer flagged that an unvalidated `reviewed_sha`
    let anyone pick the "red" commit. The gate now checks it is a real ancestor of HEAD.
22. **The gates trusted the code they check.** In an attack test, 4 of 6 bypasses (rule turned off
    in config, check deleted from `check.sh`, folder added to the lint ignore list, and a
    `lint-disable` comment) passed every gate including naive CI. Trusted CI (base branch's gate
    files) plus a no-new-suppressions check blocked all of them with no false positives.
