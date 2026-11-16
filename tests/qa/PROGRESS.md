# QA progress

Re-read at the start of every cycle and after any context reset.

Rules that must not be forgotten: never run `npm run verify` or `npm run seed`; never touch non-QA rows; no changes in `src/` or `supabase/`; no push, no deploy; clean up at the end and prove it.

Baseline before QA (2026-11-15): records 18, media 18, gps_logs 19, conflict_log 5, applied_ops 71, devices 29, storage objects 18, members 8, profiles 3, auth users 3, regions A/B/C.

How to run: `node tests/qa/run.mjs --keep <spec file names>` (for example `f-sync g-conflicts`); `--keep` skips the cleanup. Results merge into `artifacts/qa/results.json`; evidence is in `artifacts/qa/<case-id>/`. Final cleanup: `node tests/qa/run.mjs --cleanup-only` (writes `artifacts/qa/cleanup.json`).

**State: DONE (16 November 2026).** Every case has a result, QA data is deleted (proof in `artifacts/qa/cleanup.json`), report is `docs/QA_REPORT.md`.

## Final results: 112 cases, PASS 94, FAIL 14, FLAKY 3, BLOCKED 1

| Cat | Result |
| --- | --- |
| A | A01-A09 PASS, A10 FLAKY |
| B | FAIL B05, B06, B16 (P2); rest PASS |
| C | all PASS |
| D | all PASS |
| E | FAIL E09 (P2), BLOCKED E06 (needs a redeploy; manual steps in the report), rest PASS |
| F | FAIL F12 (P1), rest PASS |
| G | FAIL G08 (P1), rest PASS |
| H | all PASS |
| I | FAIL I11 (P0), I12 (P1), I13 (P2), rest PASS |
| J | all PASS |
| K | FAIL K02, K06, K07 (P2), K09 (P1); K04, K08 FLAKY; rest PASS |
| L | FAIL L04 (P3), rest PASS |

## Test corrections made during the run (the app assertion was never weakened)

- B14, I05: counted rows left by earlier runs; now scoped to the rows of the case.
- G07: the device conflict log covers all regions of the user; the expected count is now taken per user.
- E06: an async predicate was always true; now really waits, and reports BLOCKED when the worker cannot be swapped.
- D08, G07 (console tab), I04, K01 captures: races in the test.
- H05, K06: Enter key and tab budget moved to findings; the case subject is unchanged.
- K04: text-only "plain" labels are a finding, not a failure.

## Notes for a next run

- Run one spec file at a time (`node tests/qa/run.mjs --keep <spec>`), K08 alone (`k-ui -g "K08 "`). A big batch was once stopped by the system for low memory.
- `npm run qa` runs everything and cleans up at the end.
- The host badge is switched off in every case except K09.

## Next action

None. To repeat: `npm run qa`.
