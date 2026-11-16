# Fix log

Re-read at the start of every cycle and after any context reset.

Source of truth: `docs/QA_REPORT.md`. Rules: fix the root cause, never weaken a test, security fixes live in `supabase/schema.sql`, no secrets in `src/`, no AI attribution in commits.

How to run one spec against the local build (one spec at a time, browsers close after each run):

```
npm run build
node scripts/serve.mjs            # second shell, http://localhost:4173/fieldsync/
sh artifacts/fix/one.sh <spec> "<grep>" <tag>   # wraps: BASE_URL=... node tests/qa/run.mjs --keep <spec> -g "<grep>" --retries=0
```

`npm run verify` and `npm run seed` wipe the QA rows too. Run `node tests/qa/run.mjs --cleanup-only` before them.

## Bugs

Before = run against localhost with the old code (`artifacts/fix/before-*.log`). After = same case, new code, localhost (`artifacts/fix/after-*.log`). The schema was applied to the live Supabase project before the "after" runs, so the server half is the real one.

| Bug | Sev | Status | Before | After (local) | After (live) | Commit |
| --- | --- | --- | --- | --- | --- | --- |
| I11 | P0 | FIXED | FAIL: server answered "applied", photo of region B flagged deleted | PASS | | b78b551 |
| F12 | P1 | FIXED | FAIL in the report; hung push never released | PASS, `recoveredWithoutReload: true` | | 30e4d78 |
| G08 | P1 | FIXED | FAIL: deleted, 0 conflict rows | PASS | | b78b551 |
| I12 | P1 | FIXED | FAIL: 9.9 written, 0 conflict rows, device row taken over | PASS | | b78b551 |
| K09 | P1 | FIXED (app side) / MANUAL (badge) | live only | live only | | cd0138f |
| I13 | P2 | FIXED | FAIL: GPS row linked to a record of another region | PASS | | b78b551 |
| B05 | P2 | FIXED | FAIL: "abc" saved as pH | PASS | | 6b716d1 + b78b551 |
| B06 | P2 | FIXED | FAIL: -3, 99, 1e9 saved | PASS | | 6b716d1 + b78b551 |
| B16 | P2 | FIXED | FAIL: unbroken word cut off | PASS | | cd0138f |
| E09 | P2 | FIXED | FAIL: blank page | PASS: message + Try again | | cd0138f |
| K02 | P2 | FIXED | FAIL (with the 200-record region): console 1596 px wide | PASS | | cd0138f |
| K06 | P2 | FIXED | FAIL: Escape did not close the sheet | PASS (focus moves into sheet, Escape closes) | | cd0138f |
| K07 | P2 | FIXED | FAIL: photo labels 4.16:1 | PASS | | cd0138f |
| L04 | P3 | FIXED (optional) | FAIL: no BOM, formula cells | PASS | | 6b716d1 + cd0138f |
| E06 | P1 | to rerun on live | BLOCKED (needs a redeploy) | BLOCKED on localhost too | | |

Regression runs after all fixes, localhost, one spec at a time: A 10/10, B 16/16, C 9/9, D 8/8, E 8/8 + E06 skipped, F 13/13, G 9/9, H 5/5, I 14/15 (I15 checks the host's HTTPS headers, so it can only pass on the live site), J 4/4, K01-K07 7/7, L 5/5. K08 and K09 are live-only.

Notes:
- I01 failed once in the regression run because K01 had just added QA user B to its helper region `QA-<ts>-E`; I01 expects B to see only B's own regions. In `npm run qa` the order is A to L, so I runs before K. The empty helper region was removed and I01 passed. No test changed.
- K06 still prints the finding "took 90 Tab presses" because the case counts Tabs to `#new-record` (the button at the foot). A "Skip to New record" link is now the first Tab stop on the list. The test was not changed.

## Next actions

1. `node tests/qa/run.mjs --cleanup-only`, then `npm run verify` twice in a row.
2. Confirm on the live database that `sync_push` and the new helper are in place (query).
3. Merge into `main`, normal push, wait for Netlify to serve the new service worker version.
4. `npm run qa` against https://fieldsync-cep2.netlify.app/, rerun E06, then `npm run seed`.
5. Update `docs/QA_REPORT.md` (After fixes), `docs/REPORT.md`, `HANDOFF.md`, `DECISIONS.md`.
