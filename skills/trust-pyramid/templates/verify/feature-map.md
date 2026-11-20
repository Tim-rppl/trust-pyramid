# Feature map

What the app does, from the user's point of view. Humans and agents use the same names.
Names are **accessible names** from the UI, so they work with `node verify/app.mjs click "<name>"`.

| Feature | How to get there | Works when | Smoke step |
|---|---|---|---|
| Sign in | open `/` → "Email", "Password" → "Sign in" | dashboard heading visible | `up` |
| Example feature | main nav "Notes" | table "All notes" lists the seeded note | `notes` |

Features that need real third-party services (not covered locally) are marked ❌ in the last
column with the reason.

When you add a user-visible feature, add a row here and a step in `verify/smoke.mjs` in the same change.
