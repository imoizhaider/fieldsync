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

## Online sign-out (P0, reported by the owner, 16 November 2026)

**Cause:** every `npm run seed` (and so every `npm run verify`) set the demo accounts' password through the admin API, and Supabase Auth deletes every session of a user whenever an admin sets its password, even to the same value; about an hour later each device's access token ran out, the refresh answered 400 `refresh_token_not_found`, and the app had no way back but Sign out. Proof: `artifacts/fix/signout/probe.json` (step "SEED": sessions 2 -> 0, refresh 400, control user 200) and `artifacts/fix/signout/audit.json` (0 live sessions for the demo accounts after the earlier seeds; 8 live after two verify runs with the fix).

Second, smaller cause found on the way: a token refresh that failed for a network or server reason (503, the app's 30 s deadline) was shown as "sign-in needed" (M10).

Suspects:

| Id | Theory | Verdict | Evidence |
| --- | --- | --- | --- |
| S1 | refresh token rotation, two places one account | not the cause | probe "S1 both devices refresh" 200/200; M02 PASS before the fix |
| S2 | 401/403 from a data call becomes a sign-out | not the cause | `rpc()` throws a sync error, no `signOut` or `onAuthStateChange` in `src/`; M04 PASS before |
| S3 | free space or cache cleanup removes the session | not the cause | `freeSyncedPhotos` only clears photo blobs; M05 PASS before |
| S4 | two clients fight over the session | not the cause | one `createClient` in `src/js/auth.js` |
| S5 | a reload during a refresh leaves a dead token | not the cause | probe "S5": the replaced token reused after 12 s still answered 200; M06 PASS before |
| seed | admin password reset ends all sessions | **the cause** | probe "SEED"; M09 FAIL before (0 sessions left), PASS after |
| UI | a dead session has no way back | **real** | M03, M07 FAIL before (no "Sign in again"), PASS after |
| retry | refresh outage shown as sign-in | **real** | M10 FAIL before ("Online / sign-in needed" during a 503), PASS after |

Runs, localhost, one spec at a time (`artifacts/fix/signout/before-m*.log`, `after-m*.log`; auth traffic per case in `artifacts/fix/signout/before/` and `after/`):

| Case | Before | After |
| --- | --- | --- |
| M01 online refresh | PASS | PASS |
| M02 two tabs + second device | PASS (first run failed on a test bookkeeping error: the phone signs in on purpose; fixed in the test) | PASS |
| M03 refresh 400 | FAIL: no "Sign in again" on the Sync screen | PASS |
| M04 RPC 401/403, real rejection | PASS | PASS |
| M05 free space, caches | PASS | PASS |
| M06 long idle gap | PASS | PASS |
| M07 server ended the sessions | FAIL: no "Sign in again" | PASS: record and 2 photos uploaded after signing in again |
| M08 offline past expiry | PASS | PASS |
| M09 seed account step | FAIL: sessions 1 -> 0 | PASS: action "kept", sessions kept |
| M10 refresh 503 for 45 s | FAIL: bar "Online / sign-in needed" (first run passed only because the outage was shorter than auth-js's own 30 s retry; the test now outlasts it) | PASS |

Regression after the fix, localhost, one spec at a time: A 10/10, B 16/16, C 9/9, D 8/8, E 8/8, F 13/13, G 9/9, H 5/5, I 14/15 (I15 host headers, live only), J 4/4, K01-K07 7/7, L 5/5, M 10/10. Two order effects, no test changed: L01 counts the members of the main QA region, and the first M run had put its users there (M users now get their own region `QA-<ts>-M`); I01 failed after K01 had added B to its empty helper region `QA-<ts>-E` (removed, I01 passed, same as in the first fix round). `npm run verify` twice in a row: 12/12 and 6/6 both times (136 s, 133 s).

Live, build `ce2827e3bbf6` (`artifacts/fix/signout/live-*.log`): M 10/10 (M02 FLAKY: first attempt saw the laptop's record arrive on the phone during the phone's save, a race in the test; the test now waits for it first, not yet re-run live), A 10/10, B 16/16, C 9/9, D 8/8, E 8/8 (E06 BLOCKED as before), F 13/13. The run was stopped by Claude Code during G because the machine was low on memory (the owner's own Chrome held about 8 GB); G, H, I, J, K and L still need a live run on this build.

Next action (round 1): superseded by round 2 below, which re-ran everything on the live site.

## Round 2 (17 November 2026): sign-in asked after the network goes off, and UI

Owner's report: as soon as the network goes off and comes back, the bar says "Online / sign-in needed to sync" and only the password brings sync back. Evidence: `artifacts/fix/signout2/README.md`. UI: `artifacts/fix/ui/README.md`.

**Cause (M-1):** the server never ended the session. supabase-js (auth-js 2.119) deletes the stored session after a refresh fails with any answer it does not class as a network error once the access token has expired (429, the server's 400 `bad_json` for a request cut off by a dropped connection, a non-JSON 4xx). The app had no copy, so "sign-in needed" stayed until the password was typed. Also: auth-js's 60 s failure cooldown was not reset on reconnect, so sync stood still up to a minute. Not involved: rotation with a lost answer (R2), two places (R4), the service worker (R5), the CDN or HTTP cache (U-4).

| Bug | Sev | Status | Before | After (local) | After (live) |
| --- | --- | --- | --- | --- | --- |
| M-1 session lost after offline/online | P0 | FIXED | M11, M12, M13, M14, M15, M17 FAIL for the targeted reason (`signout2/before-m*.log`); V10/V11 reproduce the owner's screen | M 17/17 (`signout2/after-m-2.log`) | M 17/17; V1, V2, V5, V6, V10, V11 on live: no sign-in, session kept |
| U-4 CDN or cache | P2 | NOT A BUG | evidence `ui/u4-cache-before.json`: every file `max-age=0` or `no-cache`, live = local build | | `ui/u4-cache-after.json`: same headers, live SW = local `7843417ee3bb` 30 s after the push |
| U-1 bottom of the screen | P2 | FIXED | tab bar under New record and Record detail on a phone, photo row under the Save bar at 375x667 (`ui/before/`) | `ui/after/`; C10 PASS | C10 PASS, K 9/9 |
| U-2 Add photo on a phone | P2 | FIXED | C10 FAIL (tab bar under the form) | C10 PASS, C05 PASS | C 10/10 |
| U-3 saved track cannot be viewed | P2 | FIXED | D09 FAIL (no track screen) | D09 PASS, D08 PASS | D 9/9 |

The first after-run of M (`after-m-1.log`) found two defects in the fix itself, both corrected before the final run: the Sync screen showed the retry countdown instead of "Sign-in needed" (M03, M07), and the server's `validation_failed` answer for an unreadable token was not treated as a refusal (M14).

Regression, localhost, one spec at a time (`artifacts/fix/round2/local-*.log`): A 10/10, B 16/16, C 10/10, D 9/9, E 8/8 (+E06 skipped), F 13/13, G 9/9, H 5/5, I 14/15 (I15 live only; I01 first failed on the known K01 helper-region order effect, region removed, PASS), J 4/4, K 8/9 (K08 Lighthouse 77: the local server does not compress; 99 live), L 5/5, M 17/17. `npm run verify` twice: 12/12 and 6/6 both times.

Live, build `7843417ee3bb`, one spec at a time (`artifacts/fix/round2/live-*.log`): 131 cases, PASS 128, FAIL 0, FLAKY 2 (F03 test timing: the record came with a pull already running before the press; F08: Netlify reset one page load; both PASS on a rerun without retries), BLOCKED 1 (E06, as before).

No test was weakened, skipped or deleted. D08 now opens the saved track and presses its Delete button to reach the same confirmation sheet (the old sheet no longer exists); every assertion is unchanged.

## Done

1. QA rows cleaned, `npm run verify` passed twice in a row (12/12, 6/6).
2. Live database checked: new `sync_push`, `check_record_fields`, read-only policies.
3. Merged to `main`, normal push, Netlify served `0e37935c2d80`, later `1e337452450f`.
4. `npm run qa` on the live site, spec by spec: PASS 111, FAIL 0, FLAKY 0, BLOCKED 1 (E06, passed across two real deploys). B and K rerun on the second build: all PASS.
5. Docs updated: `docs/QA_REPORT.md` section 8, `docs/REPORT.md`, `HANDOFF.md`, `DECISIONS.md` 44 to 55.
6. Final: QA cleanup and `npm run seed`.

## Next action

None. Manual: one Add photo tap and one airplane-mode cycle on a real iPhone (HANDOFF.md). To repeat: `npm run qa` (whole suite, then cleanup) or one spec with `--keep`.
