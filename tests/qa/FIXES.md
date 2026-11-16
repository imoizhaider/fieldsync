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
| I11 | P0 | FIXED | FAIL: server answered "applied", photo of region B flagged deleted | PASS | PASS | b78b551 |
| F12 | P1 | FIXED | FAIL: bar stuck on "Syncing 1 of 2", 2 push requests, also after Sync now and offline/online | PASS, `recoveredWithoutReload: true` | PASS | 30e4d78 |
| G08 | P1 | FIXED | FAIL: deleted, 0 conflict rows | PASS | PASS | b78b551 |
| I12 | P1 | FIXED | FAIL: 9.9 written, 0 conflict rows, device row taken over | PASS | PASS | b78b551 |
| K09 | P1 | FIXED (app side) / MANUAL (badge) | live only | live only | PASS | cd0138f |
| I13 | P2 | FIXED | FAIL: GPS row linked to a record of another region | PASS | PASS | b78b551 |
| B05 | P2 | FIXED | FAIL: "abc" saved as pH | PASS | PASS | 6b716d1 + b78b551 |
| B06 | P2 | FIXED | FAIL: -3, 99, 1e9 saved | PASS | PASS | 6b716d1 + b78b551 |
| B16 | P2 | FIXED | FAIL: unbroken word cut off | PASS | PASS | cd0138f |
| E09 | P2 | FIXED | FAIL: blank page | PASS: message + Try again | PASS | cd0138f |
| K02 | P2 | FIXED | FAIL (with the 200-record region): console 1596 px wide | PASS | PASS | cd0138f |
| K06 | P2 | FIXED | FAIL: Escape did not close the sheet | PASS (focus moves into sheet, Escape closes) | PASS | cd0138f |
| K07 | P2 | FIXED | FAIL: photo labels 4.16:1 | PASS | PASS | cd0138f |
| L04 | P3 | FIXED (optional) | FAIL: no BOM, formula cells | PASS | PASS | 6b716d1 + cd0138f |
| E06 | P1 | PASS by real-deploy check | BLOCKED (a deploy cannot be faked in the test browser) | BLOCKED | case BLOCKED; `tests/qa/e06-redeploy.mjs` PASS across deploys 0e37935c2d80 -> 1e337452450f | dd94397 |

Regression runs after all fixes, localhost, one spec at a time: A 10/10, B 16/16, C 9/9, D 8/8, E 8/8 + E06 skipped, F 13/13, G 9/9, H 5/5, I 14/15 (I15 checks the host's HTTPS headers, so it can only pass on the live site), J 4/4, K01-K07 7/7, L 5/5. K08 and K09 are live-only.

Notes:
- I01 failed once in the regression run because K01 had just added QA user B to its helper region `QA-<ts>-E`; I01 expects B to see only B's own regions. In `npm run qa` the order is A to L, so I runs before K. The empty helper region was removed and I01 passed. No test changed.
- K06 still prints the finding "took 90 Tab presses" because the case counts Tabs to `#new-record` (the button at the foot). A "Skip to New record" link is now the first Tab stop on the list. The test was not changed.

## Done

1. QA rows cleaned, `npm run verify` passed twice in a row (12/12, 6/6).
2. Live database checked: new `sync_push`, `check_record_fields`, read-only policies.
3. Merged to `main`, normal push, Netlify served `0e37935c2d80`, later `1e337452450f`.
4. `npm run qa` on the live site, spec by spec: PASS 111, FAIL 0, FLAKY 0, BLOCKED 1 (E06, passed across two real deploys). B and K rerun on the second build: all PASS.
5. Docs updated: `docs/QA_REPORT.md` section 8, `docs/REPORT.md`, `HANDOFF.md`, `DECISIONS.md` 44 to 55.
6. Final: QA cleanup and `npm run seed`.

## Next action

None. To repeat: `npm run qa` (whole suite, then cleanup) or one spec with `--keep`.
