# Turning a correction into a rule

Use whenever a mistake is corrected (by the human, a reviewer finding, a revert, a bug report).

1. **Name the mistake** in one sentence, with one real example (file:line).
2. **Eliminate by design?** Can an API, type, wrapper, or directory boundary make the mistake
   impossible? If yes, do that and stop here (still add a test that would catch a regression).
3. **Detectable from source?** Write a lint rule:
   - message = what is wrong + how to fix + sanctioned exception path;
   - violating and compliant fixtures, and a test asserting rule ID and line;
   - run it on the whole repo; fix existing violations, or scope it and record the backlog.
4. **Only visible at runtime?** Add a unit/property test or a smoke step instead.
5. **Neither?** Add or bump an entry in `quality/rule-candidates.md` with the example. If the entry
   already exists, this is the second occurrence: find a way to make it a rule or a test now.
6. **Prove it fires**: break one compliant example on purpose, see the rule fail, restore.
7. **Clean the garden**: remove the workaround that caused the mistake so agents stop copying it.
8. Report in plain language: the mistake, the rule, where it applies, what the error message says.
