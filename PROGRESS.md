# PROGRESS

Re-read this file at the start of every cycle and after any context reset.

Backend: hosted Supabase project from `.env` (option 1). It was empty when first probed.

## Milestones

All 8 milestones are built and committed (scaffold and harness, schema and RLS, PWA shell, records, photos and GPS, sync engine, merge and console, CSV and polish).

## Gate status

Two full `npm run verify` runs in the development checkout on 2026-11-15, both 12/12 PASS (T1-T6, G7-G12) and 6/6 other named tests. Code changed between them only in tests (extra screenshots) and docs.

## Failure log (one line per cause)

- FR-13: lead status bar hid pending changes, so the test saw "idle" too early. Fixed in statusbar.js.
- G9 restore: first pull skipped deleted records that still had an open conflict. Fixed in sync_pull.
- G8 / G9 / T5: test locators or waits were too broad or racy. Made precise; idle() now reads the outbox.

Fresh clone in a temporary folder (`.env` and `.env.local` copied in, `npm ci`), 2026-11-15: `npm run verify` twice in a row, both exit 0, 12/12 PASS and 6/6 other named tests (145 s, 132 s). Exit condition met.

## Final checklist

1. Fresh-clone verify, twice in a row. DONE (see above).
2. No secret in git history: `git log -p` has 0 matches for an `sb_secret_` key; `.env` and `.env.*` are in .gitignore. DONE.
3. 22 design screens mapped in DECISIONS.md; every P0/P1 mapped to a gate or named test in docs/REPORT.md. DONE.
4. Nothing is deployed; see HANDOFF.md (manual steps only).

## Next action

None. No gate is red or blocked. Re-run `npm run verify` after any code change.
