# Contributing

Thanks for helping. This project eats its own cooking: changes are judged by evidence.

## Development

```bash
npm ci
npm test
```

Tests cover the skill structure, the gate scripts, the review gate (red → green evidence), the
fake model server, and the example lint rules.

## What to contribute

- **Stack recipes** (`skills/trust-pyramid/references/stack-recipes.md`): layout, tools with version
  notes, first rules, verification setup.
- **Lessons learned** (`references/lessons-learned.md`): a pitfall you hit, how it showed up, the fix.
- **Template improvements**: include a test in `tests/` that fails before your change and passes after.

## Rules for changes

- Keep `SKILL.md` short; put detail in `references/`.
- Every path mentioned in `SKILL.md` or `references/` must exist (a test checks this).
- Keep the skill frontmatter to portable keys (`name`, `description`, `license`, ...).
- Docs are bilingual at the top level: update `README.md` and `README.zh-CN.md` together.
  Skill files are English only.
