# FieldSync: QA report

Target: https://fieldsync-cep2.netlify.app/ (live build, same Supabase project as `.env`).
Dates: 15 and 16 November 2026. Browser: Playwright Chromium, two or more isolated contexts as devices.
Suite: `tests/qa/` (`npm run qa`). Plan: `tests/qa/PLAN.md`. Evidence: `artifacts/qa/<case id>/` (screenshots, `evidence.json`; on failure also trace, console log and network log in `attempt-N/`).

No app code was changed. Nothing was pushed or deployed. `npm run verify` and `npm run seed` were not run.

> **After fixes (16 November 2026):** every P0, P1 and P2 failure below is fixed and passes on the live site. New counts: PASS 111, FAIL 0, FLAKY 0, BLOCKED 1 (E06, checked across two real deploys instead). Details in section 8. Sections 1 to 7 are the original QA run and are kept as they were.

## 1. Summary

| | Count |
| --- | --- |
| Cases | 112 |
| PASS | 94 |
| FAIL | 14 |
| FLAKY | 3 |
| BLOCKED | 1 |

Failures by severity: P0 1, P1 4, P2 8, P3 1.

**Verdict.** The demo is safe to record if it stays on the main path: sign in, create records with photos and GPS offline, reconnect, automatic sync, per-field merge, same-field conflict, conflict log, data lead console and CSV. All of that passed on the live site with evidence from the screen, IndexedDB and Postgres. Two things can spoil a recording: the host's "Powered by Netlify" badge sits on top of the Delete and Sign out confirm buttons and the Sync tab at phone width (K09), and the data lead console is wider than a 1280 or 1440 px screen so Export CSV and Refresh start off screen (K02). The app is not ready for real field use until I11 (a member of one region can flag another region's photo as deleted), G08 (a synced edit is lost to a stale delete with no log entry), F12 (sync stalls for good on a request that never answers) and I12 (a forged device id hides a conflict) are fixed.

Notes on how the results were produced:

- The host badge was switched off in every case except K09 and I14, so that the app itself could be tested. K09 tests the page exactly as deployed.
- A failed case was run three times. Three failures = FAIL. Mixed = FLAKY. No assertion about the app was weakened to get a PASS. Where a test was wrong (wrong count, race in the test), the test was corrected and the reason is in `tests/qa/PROGRESS.md`.
- Assumptions taken from the PRD where it is silent: numeric fields should refuse text and impossible values; an edit that loses to a delete must be logged in either arrival order; deleted rows in the CSV must be absent or flagged.

## 2. Results

| Case | Category | What was checked | Result | Severity | Evidence |
| --- | --- | --- | --- | --- | --- |
| A01 | Auth | valid login opens the record list and caches the session | PASS | P0 | `artifacts/qa/A01/` |
| A02 | Auth | empty fields show a message and send nothing | PASS | P2 | `artifacts/qa/A02/` |
| A03 | Auth | wrong password shows a clear message and stores nothing | PASS | P2 | `artifacts/qa/A03/` |
| A04 | Auth | unknown email and malformed email give a clear message | PASS | P2 | `artifacts/qa/A04/` |
| A05 | Auth | opens offline after one online login | PASS | P0 | `artifacts/qa/A05/` |
| A06 | Auth | session expiry while offline: pending data survives and uploads after signing in again | PASS | P1 | `artifacts/qa/A06/` |
| A07 | Auth | sign out with pending changes warns and loses nothing | PASS | P0 | `artifacts/qa/A07/` |
| A08 | Auth | two users on one device never see each other's local data | PASS | P1 | `artifacts/qa/A08/` |
| A09 | Auth | a first sign-in with no network explains itself | PASS | P2 | `artifacts/qa/A09/` |
| A10 | Auth | signed-out deep links show the sign-in screen | FLAKY | P2 | `artifacts/qa/A10/` |
| B01 | Records | create soil, water and wildlife records (screen, IndexedDB, Postgres) | PASS | P0 | `artifacts/qa/B01/` |
| B02 | Records | edit each record type | PASS | P0 | `artifacts/qa/B02/` |
| B03 | Records | delete each record type (soft delete) | PASS | P0 | `artifacts/qa/B03/` |
| B04 | Records | saving a completely empty form | PASS | P3 | `artifacts/qa/B04/` |
| B05 | Records | non-numeric pH is refused or flagged | FAIL | P2 | `artifacts/qa/B05/` |
| B06 | Records | negative and out-of-range pH is refused or flagged | FAIL | P2 | `artifacts/qa/B06/` |
| B07 | Records | very long notes: limit enforced, value syncs intact | PASS | P1 | `artifacts/qa/B07/` |
| B08 | Records | unicode, emoji and RTL text round-trip exactly | PASS | P1 | `artifacts/qa/B08/` |
| B09 | Records | HTML and script in title and notes are shown as text (XSS) | PASS | P0 | `artifacts/qa/B09/` |
| B10 | Records | a region with 200 records stays fast | PASS | P2 | `artifacts/qa/B10/` |
| B11 | Records | filter tabs show exactly the right records | PASS | P2 | `artifacts/qa/B11/` |
| B12 | Records | an emoji at the length limit does not break the record or the sync | PASS | P1 | `artifacts/qa/B12/` |
| B13 | Records | decimal comma is read as a number | PASS | P3 | `artifacts/qa/B13/` |
| B14 | Records | a view-only region cannot be changed from the UI | PASS | P1 | `artifacts/qa/B14/` |
| B15 | Records | two offline devices that pick the same label number both keep their record | PASS | P1 | `artifacts/qa/B15/` |
| B16 | Records | a long unbroken word in the notes wraps instead of being cut off | FAIL | P2 | `artifacts/qa/B16/` |
| C01 | Photos | one photo on a record | PASS | P0 | `artifacts/qa/C01/` |
| C02 | Photos | ten photos on a record | PASS | P0 | `artifacts/qa/C02/` |
| C03 | Photos | an 11 MB image is compressed to 1280 px before it is stored | PASS | P0 | `artifacts/qa/C03/` |
| C04 | Photos | a file that is not an image is refused with a clear message | PASS | P2 | `artifacts/qa/C04/` |
| C05 | Photos | camera permission denied: Permissions screen, library still works | PASS | P2 | `artifacts/qa/C05/` |
| C06 | Photos | deleting a synced photo reaches the server and the other device | PASS | P1 | `artifacts/qa/C06/` |
| C07 | Photos | photos of a record that is deleted later | PASS | P2 | `artifacts/qa/C07/` |
| C08 | Photos | a photo taken on device A is shown on device B | PASS | P1 | `artifacts/qa/C08/` |
| C09 | Photos | free space removes local copies, reopening the record fetches them again | PASS | P2 | `artifacts/qa/C09/` |
| D01 | GPS | GPS point capture | PASS | P0 | `artifacts/qa/D01/` |
| D02 | GPS | location permission denied | PASS | P2 | `artifacts/qa/D02/` |
| D03 | GPS | position unavailable and timeout | PASS | P2 | `artifacts/qa/D03/` |
| D04 | GPS | a long track of 600 points | PASS | P1 | `artifacts/qa/D04/` |
| D05 | GPS | a track recorded while the device goes offline uploads on reconnect | PASS | P0 | `artifacts/qa/D05/` |
| D06 | GPS | coordinates at the edge values | PASS | P2 | `artifacts/qa/D06/` |
| D07 | GPS | reloading in the middle of a recording does not lose the track | PASS | P1 | `artifacts/qa/D07/` |
| D08 | GPS | deleting a synced track reaches the server and the other device | PASS | P2 | `artifacts/qa/D08/` |
| E01 | Offline / PWA | the app shell opens with the network off | PASS | P0 | `artifacts/qa/E01/` |
| E02 | Offline / PWA | reload and restart offline keep the record, photos and GPS point | PASS | P0 | `artifacts/qa/E02/` |
| E03 | Offline / PWA | the manifest is valid and its icons are real | PASS | P0 | `artifacts/qa/E03/` |
| E04 | Offline / PWA | the service worker is registered, active and scoped to the app | PASS | P0 | `artifacts/qa/E04/` |
| E05 | Offline / PWA | Chrome considers the app installable | PASS | P0 | `artifacts/qa/E05/` |
| E06 | Offline / PWA | a new deploy replaces the cached app without touching local data | BLOCKED | P1 | `artifacts/qa/E06/` |
| E07 | Offline / PWA | refreshing a deep link shows the same screen, online and offline | PASS | P1 | `artifacts/qa/E07/` |
| E08 | Offline / PWA | every file the app needs is in the worker cache | PASS | P1 | `artifacts/qa/E08/` |
| E09 | Offline / PWA | first visit on a bad connection: one failed file must not leave a blank app | FAIL | P2 | `artifacts/qa/E09/` |
| F01 | Sync | pending changes upload by themselves within 30 s of reconnecting | PASS | P0 | `artifacts/qa/F01/` |
| F02 | Sync | sync runs on app open | PASS | P0 | `artifacts/qa/F02/` |
| F03 | Sync | the Sync now button fetches other people's changes at once | PASS | P0 | `artifacts/qa/F03/` |
| F04 | Sync | every sync run pushes before it pulls | PASS | P0 | `artifacts/qa/F04/` |
| F05 | Sync | a pull asks only for changes since lastPulledAt | PASS | P1 | `artifacts/qa/F05/` |
| F06 | Sync | 500 and 503 answers keep the outbox exactly as it was | PASS | P0 | `artifacts/qa/F06/` |
| F07 | Sync | a request that times out keeps the outbox and sync recovers | PASS | P0 | `artifacts/qa/F07/` |
| F08 | Sync | retries back off: about 2, 4, 8, 16 seconds | PASS | P1 | `artifacts/qa/F08/` |
| F09 | Sync | the Sync screen shows the retry countdown | PASS | P2 | `artifacts/qa/F09/` |
| F10 | Sync | sync completes on a slow 3G connection | PASS | P1 | `artifacts/qa/F10/` |
| F11 | Sync | two tabs of the same user syncing at once make no duplicates | PASS | P1 | `artifacts/qa/F11/` |
| F12 | Sync | a request that never answers does not stall sync for good | FAIL | P1 | `artifacts/qa/F12/` |
| F13 | Sync | status bar shows online or offline, pending count and last sync time | PASS | P1 | `artifacts/qa/F13/` |
| G01 | Conflicts | different fields edited on two devices are both kept | PASS | P0 | `artifacts/qa/G01/` |
| G02 | Conflicts | same field: the edit the server receives later wins, the other goes to the conflict log | PASS | P0 | `artifacts/qa/G02/` |
| G03 | Conflicts | a wrong device clock does not change the winner | PASS | P0 | `artifacts/qa/G03/` |
| G04 | Conflicts | edit vs delete: the delete wins, the edit is logged and can be restored | PASS | P0 | `artifacts/qa/G04/` |
| G05 | Conflicts | delete vs delete | PASS | P1 | `artifacts/qa/G05/` |
| G06 | Conflicts | three devices change one field: last arrival wins, two values in the log | PASS | P0 | `artifacts/qa/G06/` |
| G07 | Conflicts | the conflict log screen shows every entry of the region | PASS | P0 | `artifacts/qa/G07/` |
| G08 | Conflicts | an edit that synced first is not silently lost when a stale delete arrives later | FAIL | P1 | `artifacts/qa/G08/` |
| G09 | Conflicts | the same value entered on both devices is not a conflict | PASS | P2 | `artifacts/qa/G09/` |
| H01 | Idempotency | an interrupted photo upload is retried and leaves exactly one photo | PASS | P0 | `artifacts/qa/H01/` |
| H02 | Idempotency | a record push whose answer is lost is retried without a duplicate | PASS | P0 | `artifacts/qa/H02/` |
| H03 | Idempotency | the same outbox operation sent twice is applied once (API) | PASS | P0 | `artifacts/qa/H03/` |
| H04 | Idempotency | app closed in the middle of a sync, then reopened | PASS | P0 | `artifacts/qa/H04/` |
| H05 | Idempotency | a double click on Save makes one record | PASS | P1 | `artifacts/qa/H05/` |
| I01 | Security | a user cannot read a region they are not assigned to (direct REST) | PASS | P0 | `artifacts/qa/I01/` |
| I02 | Security | direct table writes are refused for every table | PASS | P0 | `artifacts/qa/I02/` |
| I03 | Security | sync_push into an unassigned region is rejected and writes nothing | PASS | P0 | `artifacts/qa/I03/` |
| I04 | Security | access removed while offline: the app shows "Sync rejected" and keeps the data | PASS | P1 | `artifacts/qa/I04/` |
| I05 | Security | Storage files of another region cannot be read, listed, replaced or removed | PASS | P0 | `artifacts/qa/I05/` |
| I06 | Security | the conflict log of another region is not readable | PASS | P0 | `artifacts/qa/I06/` |
| I07 | Security | no service key or other secret in the shipped files or in any request | PASS | P0 | `artifacts/qa/I07/` |
| I08 | Security | HTML that arrives from the server (names, conflict values) is rendered as text | PASS | P0 | `artifacts/qa/I08/` |
| I09 | Security | without a login nothing can be read or called | PASS | P0 | `artifacts/qa/I09/` |
| I10 | Security | a view-only member cannot write | PASS | P1 | `artifacts/qa/I10/` |
| I11 | Security | sync_push cannot delete a photo of another region | FAIL | P0 | `artifacts/qa/I11/` |
| I12 | Security | a forged device id cannot hide a conflict or take over another device | FAIL | P1 | `artifacts/qa/I12/` |
| I13 | Security | a GPS log cannot be attached to a record of another region | FAIL | P2 | `artifacts/qa/I13/` |
| I14 | Security | the app talks only to its own origin and to Supabase | PASS | P1 | `artifacts/qa/I14/` |
| I15 | Security | security headers of the host (recorded) | PASS | P3 | `artifacts/qa/I15/` |
| J01 | Storage limits | "Storage almost full" appears when the quota is low | PASS | P1 | `artifacts/qa/J01/` |
| J02 | Storage limits | persistent storage is requested | PASS | P1 | `artifacts/qa/J02/` |
| J03 | Storage limits | when IndexedDB refuses a write nothing is half saved | PASS | P0 | `artifacts/qa/J03/` |
| J04 | Storage limits | free space only removes photos that are already on the server | PASS | P1 | `artifacts/qa/J04/` |
| K01 | UI / accessibility | every design screen next to the built screen | PASS | P2 | `artifacts/qa/K01/` |
| K02 | UI / accessibility | no screen scrolls sideways at 390, 820 and 1280 | FAIL | P2 | `artifacts/qa/K02/` |
| K03 | UI / accessibility | every control is at least 44 x 44 px | PASS | P1 | `artifacts/qa/K03/` |
| K04 | UI / accessibility | every status has text and a marker that is not only colour | FLAKY | P2 | `artifacts/qa/K04/` |
| K05 | UI / accessibility | the status bar stays in view on every screen | PASS | P1 | `artifacts/qa/K05/` |
| K06 | UI / accessibility | sign in and create a record with the keyboard only | FAIL | P2 | `artifacts/qa/K06/` |
| K07 | UI / accessibility | text contrast meets WCAG AA on every screen | FAIL | P2 | `artifacts/qa/K07/` |
| K08 | UI / accessibility | Lighthouse scores | FLAKY | P3 | `artifacts/qa/K08/` |
| K09 | UI / accessibility | nothing from the host covers the app controls on the live site | FAIL | P1 | `artifacts/qa/K09/` |
| L01 | Data lead / export | the console shows the merged dataset of the region | PASS | P1 | `artifacts/qa/L01/` |
| L02 | Data lead / export | CSV export keeps commas, quotes, line breaks and unicode intact | PASS | P2 | `artifacts/qa/L02/` |
| L03 | Data lead / export | deleted records are left out of the CSV or clearly flagged | PASS | P2 | `artifacts/qa/L03/` |
| L04 | Data lead / export | the CSV opens cleanly in a spreadsheet | FAIL | P3 | `artifacts/qa/L04/` |
| L05 | Data lead / export | Mark reviewed and Restore from the console reach the server | PASS | P2 | `artifacts/qa/L05/` |

FLAKY cases: A10 failed once when a file request to the host was dropped and the app stayed blank (same cause as E09). K04 failed once on `ERR_CONNECTION_RESET` from the test machine. K08 needed a second Lighthouse run.

## 3. Bugs

### P0

**I11. `sync_push` flags a photo of another region as deleted**
- Steps: 1) User A is editor in region 1 and region 2; user B is editor only in region 1. 2) A adds a photo to a record in region 2. 3) B calls `rpc/sync_push` with one op: `{table: "media", kind: "delete", row_id: <that photo id>}`.
- Expected: rejected. PRD line 63 (FR-12): "Researchers can edit only the regions they are assigned to (enforced by database rules)".
- Actual: the server answers `applied` and `media.deleted` becomes true for the photo in region 2. B needs only the photo id.
- Evidence: `artifacts/qa/I11/attempt-3/evidence.json`.
- Likely place: `supabase/schema.sql` line 412 to 413, the media delete branch updates by id with no region or role check.

### P1

**G08. A synced edit is lost to a stale delete and nothing is logged**
- Steps: 1) A and B both have record R. 2) Both go offline. 3) A edits pH and notes, goes online and syncs. 4) B, still on the old version, deletes R, goes online and syncs.
- Expected: PRD line 94: "The delete wins. The edit is saved in the conflict log so it can be restored"; goal G4, line 20: never silently lose data.
- Actual: R is deleted (version 3), `conflict_log` has 0 rows for it, A's list drops the record with no notice and no entry in the Conflict log. Only the order "delete first, edit second" is logged (G04 passes).
- Evidence: `artifacts/qa/G08/`.
- Likely place: `supabase/schema.sql` line 339 to 342, record delete branch does not compare `base_version` with the current version.

**F12. A request that never answers stalls sync until the page is reloaded**
- Steps: 1) Create a record. 2) Let the `sync_push` request hang (no answer, connection not closed; common on a weak signal). 3) Wait 60 s, then let the network work again. 4) Press Sync now, and switch offline and online.
- Expected: PRD line 61 (FR-10) retry with backoff, and line 133 reliability.
- Actual: status bar stays on "Syncing 1 of 2" for good; Sync now and reconnect start nothing (2 push requests in total). Data is not lost and a reload recovers.
- Evidence: `artifacts/qa/F12/`.
- Likely place: `src/js/sync.js`, the rpc and upload calls have no timeout or abort, and a run in progress blocks every later run.

**I12. A forged device id hides a conflict and takes over the device row**
- Steps: 1) A sets pH 6.1 and syncs. 2) B reads A's device id from the `devices` list that every pull returns. 3) B pushes pH 9.9 with the old base version and `p_device_id` = A's device id.
- Expected: PRD line 59 (FR-8): the overwritten value goes to the conflict log.
- Actual: `applied`, pH is 9.9, 0 conflict rows, and the `devices` row now belongs to B.
- Evidence: `artifacts/qa/I12/attempt-3/evidence.json`.
- Likely place: `supabase/schema.sql` line 382 ("same device" is decided from the client-supplied `p_device_id` alone) and the `devices` upsert, which does not check the owner.

**K09. The host badge covers app controls on a phone-size screen**
- Steps: 1) Open the live site online at 390 x 844 and sign in. 2) Open a record and tap Delete. 3) Try to tap the red Delete button. Same for Regions > Sign out > confirm, and for the Sync tab.
- Expected: PRD line 135, usable touch targets.
- Actual: an iframe `#nl-badge-frame` (197 x 64 px, bottom right, z-index 2147483645) covers the confirm Delete button and the Sign out confirm at 4 of 4 test points, the Sync tab at 3 of 4, the Tracks tab at 1 of 4. When the app is opened offline from the cache the badge is absent.
- Evidence: `artifacts/qa/K09/` (screenshots `*-as-deployed.png`, details in `attempt-3/evidence.json`).
- Likely place: not in `src/`. Netlify injects `/.netlify/scripts/hud` on this site; turn it off in the Netlify site settings or host elsewhere.

### P2

**B05. Text is saved as a pH value.** Type `abc` in pH, save. Expected: refused or flagged (assumption). Actual: stored and synced as the text "abc". Evidence `artifacts/qa/B05/`. Likely `src/js/screens/form.js` (no numeric check on reading fields).

**B06. Impossible pH values are accepted.** -3, 99 and 1e9 are saved and synced with no warning. Evidence `artifacts/qa/B06/`. Likely `src/js/screens/form.js`.

**B16. A long word with no spaces is cut off.** Notes of 2,000 characters without a space run out of the record screen (28,314 px hidden, no wrap). Evidence `artifacts/qa/B16/`. Likely the notes paragraph style in `src/css` (`overflow-wrap` missing).

**E09. One failed file on the first visit leaves a blank app.** Steps: first visit, one JavaScript module request fails. Actual: empty page, no message, no retry; the service worker also fails to install because `cache.addAll` is all or nothing. PRD line 133. Evidence `artifacts/qa/E09/`. Likely `src/index.html` (no fallback text) and `src/sw.js`.

**I13. A GPS log can point at a record of another region.** `sync_push` accepts a `gps_logs` row in region 1 with `record_id` of a record in region 2. No data of region 2 is exposed, but the link is wrong data. Evidence `artifacts/qa/I13/`. Likely `supabase/schema.sql`, gps_logs upsert branch.

**K02. The data lead console is wider than the laptop screen.** At 1280 and 1440 px the page is 1,596 px wide; Export CSV and Refresh are off screen until the page is scrolled sideways. Seen with the QA region (long region name, about 200 records with long titles). Phone and tablet screens passed. Evidence `artifacts/qa/K02/console-1280.png`. Likely `src/js/screens/console.js` and its table styles.

**K06. Keyboard use.** Escape does not close the delete sheet and focus stays behind it. Reaching "New record" took 237 Tab presses in a region with 200 records (no skip link). Sign-in, the form and Save do work by keyboard with a visible focus mark. Evidence `artifacts/qa/K06/`. Likely `src/js/html.js` or wherever the sheet is built.

**K07. Contrast.** The photo number labels ("01", "02") are 4.16:1 (#5b645d on #d8d5c9), AA needs 4.5:1. axe also reports the console's scrolling table as not reachable by keyboard. Everything else passed. Evidence `artifacts/qa/K07/attempt-3/axe.json`.

### P3

**L04. CSV in a spreadsheet.** No UTF-8 byte-order mark, so Excel on Windows shows Urdu and emoji as garbage. Cells that start with `=`, `+`, `-` or `@` are written as they are, so a title like `=HYPERLINK(...)` runs as a formula. Evidence `artifacts/qa/L04/`. Likely `src/js/screens/console.js` (CSV builder).

### Findings from passing cases (not counted as failures)

- D07: a reload in the middle of a track recording lost 3 of 9 points; the track is written only every 5th point. This is against PRD line 133 in spirit. An interrupted track uploads only after the Tracks screen is opened again.
- C06, C07: files of deleted photos and photos of deleted records are never removed from Storage.
- C04: one unreadable file in a multi-file pick drops the good photos too; the message is the raw browser text.
- A06: the Sync screen says "Sign in again" but has no button for it.
- I04: after access to a region is removed, the rejected record cannot be opened; it is named only on the Sync screen.
- J01, J02: the storage warning is only on the list screen; a refused persistent-storage request still reads "Requested".
- L03: the CSV comes from the laptop's local copy, so two consoles can export different rows for deleted records.
- F05: every pull returns the full regions, profiles and devices lists (22.9 KB with 125 device rows), also on the idle pull every 20 s.
- G03: `observed_at` trusts the device clock.
- B04, B08, H05: no required fields; no `dir="auto"` for Urdu text; Enter in a form field does not save.
- K01: 22 design screens compared side by side: 7 match, 15 have small differences, none is broken. Details in `tests/qa/k01-review.json`, sheets in `artifacts/qa/K01/sheets/`.
- K08 Lighthouse (mobile): performance 95, accessibility 100, best practices 100, SEO 100. FCP 1.6 s, LCP 2.0 s, TBT 190 ms, CLS 0.003.

## 4. Claims check (docs/REPORT.md)

| Claim | Result | Basis |
| --- | --- | --- |
| The app opens with no network; the worker caches every file | Confirmed | E01, E04, E08 |
| Installable | Confirmed | E03, E05 |
| Sign-in survives offline | Confirmed | A05 |
| Every change and its outbox entry are saved in one transaction | Confirmed | J03 (a refused write leaves nothing half saved) |
| "If the app closes ... the change is already on disk" | Confirmed for records and photos (E02, H04). Not confirmed for a GPS track being recorded (D07: points since the last 5-point save are lost) | E02, H04, D07 |
| Sync starts by itself on open, on reconnect, after a change, every 20 s; Sync now is a backup | Confirmed | F01, F02, F03 |
| Push first, then pull only since `lastPulledAt` | Confirmed, with the note that regions, profiles and devices come in full each time | F04, F05 |
| A failed push changes nothing; backoff 2, 4, 8 ... 60 s | Confirmed for errors and timeouts. Not confirmed for a request that never answers (sync stalls) | F06, F07, F08, F12 |
| Retries cannot duplicate | Confirmed | H01 to H05, F11 |
| Persistent storage is asked for; photos compressed to 1280 px | Confirmed (11 MB BMP became a 1280 x 853 JPEG of 144 KB) | J02, C03 |
| Storage screen can free synced photos | Confirmed | C09, J04 |
| Different fields: both kept. Same field: later server arrival wins, other value logged | Confirmed | G01, G02, G06 |
| Device time is never used for the merge | Confirmed | G03 |
| Edit of a deleted record: delete wins, edit logged and restorable | Confirmed in that order only. The reverse order (edit synced, then stale delete) logs nothing | G04, G08 |
| "Nothing is silently lost. Every overwritten value is a row in conflict_log" | Not confirmed | G08, I12 |
| Clients cannot write to any table directly | Confirmed | I02 |
| RLS: a user reads only their regions | Confirmed | I01, I06, I09 |
| `sync_push` "checks the caller's role in the region for every change" | Not confirmed | I11 (media delete), I13 (gps record link) |
| View-only or unassigned region answers "rejected", the app shows "Sync rejected", data stays on the device | Confirmed | I03, I04, I10, B14 |
| Photos are in a private bucket with the same region check | Confirmed | I05 |
| Only the public key is in the built app; nothing from a CDN | Confirmed for the app's own files. The host adds its own script (`/.netlify/scripts/hud`) | I07, I14 |
| G12: no horizontal scroll at 390, 820, 1280; 44 px targets | Confirmed for the researcher screens (K03 found no small control). Not confirmed for the console at 1280 | K02, K03 |
| Labels: the server renumbers a clashing label, the record is not affected | Confirmed | B15 |
| "12 of 12 gates passed" with `npm run verify` | Not checked: running it is forbidden in this job because it wipes the database. The behaviours behind T1 to T6 and G7 to G11 were each re-tested above | |
| A new deploy replaces the old cache without touching local data | Not checked (E06 BLOCKED) | E06 |

## 5. Security findings

| # | Severity | Finding | Case |
| --- | --- | --- | --- |
| 1 | P0 | Any signed-in user who knows a photo id can flag that photo as deleted in a region they do not belong to | I11 |
| 2 | P1 | `p_device_id` is trusted: a forged value overwrites a field with no conflict row and takes over another user's `devices` row. Device ids of all users are sent to every client on each pull | I12, F05 |
| 3 | P2 | A GPS log can be linked to a record of another region | I13 |
| 4 | P2 | Supabase self sign-up is open. A stranger can create an account with the public key; it is in no region and reads nothing, but it can call both sync functions | I09 |
| 5 | P3 | The host sends no Content-Security-Policy, X-Frame-Options, X-Content-Type-Options, Referrer-Policy or Permissions-Policy | I15 |
| 6 | P3 | The host injects its own script into the signed-in app | I14 |
| 7 | P3 | CSV export does not neutralise formula cells | L04 |

Checked and found sound: reading another region through REST (I01), direct table writes (I02), push into an unassigned region (I03), Storage read, list, replace and remove across regions (I05), another region's conflict log (I06), secrets in shipped files and requests (I07), HTML from the server and from users rendered as text (I08, B09), calls without a login (I09), view-only members (I10), two users on one device (A08).

The service key was used only in `tests/qa/lib/admin.mjs` and the SQL helper of the harness, for setup, cleanup and server-side checks. It was never placed in a browser context.

## 6. Manual checks on a real Android phone

1. Open the site in Chrome with mobile data on. Look at the bottom right corner for the Netlify badge. Open a record, tap Delete, and try to tap the red Delete button.
2. Chrome menu > Add to Home screen > Install. Open FieldSync from the home screen; it must open without the browser address bar.
3. Sign in. Turn on airplane mode. Close the app from recents and open it again from the home screen; the record list must show.
4. Still offline: New record, take 3 photos with the camera (not the gallery), wait for "GPS / fixed" outdoors, Save. The status bar must show "Offline / 1 pending".
5. Force stop the app, open it again. The record, 3 photos and GPS point must still be there, marked Pending.
6. Turn airplane mode off and do not touch anything. Within 30 s the badge must change to Synced.
7. Tracks > Start recording, walk 2 minutes, lock the screen for 30 s in the middle, unlock, Stop and save. Compare the number of points and the distance with the walk.
8. During a second track, swipe the app away, reopen it, open Tracks. Note how many points were kept.
9. In a place with one bar of signal, save a record with 5 photos. If the bar stays on "Syncing 1 of n" for more than 2 minutes, this is bug F12; note whether Sync now helps.
10. Deny the camera and location permissions in site settings, open New record. The Permissions screen must show Blocked and "Choose from library" must still work.
11. Deploy check (E06, needs a redeploy by the owner): with 1 pending record on the phone, deploy any small change, open the app twice. The pending record and its photos must still be there and upload.
12. Rotate the phone on the list and the form; nothing may be cut off.

## 7. Cleanup proof

Command: `node tests/qa/run.mjs --cleanup-only` on 16 November 2026, 07:29 UTC. Output saved in `artifacts/qa/cleanup.json`.

Deleted: 215 storage objects, 82 conflict_log, 213 media, 283 gps_logs, 297 records, 1,426 applied_ops, 502 devices, 9 region_members, 4 regions (QA-1794741514143, -B, -V, -E), 3 profiles, 3 auth users (qa-a, qa-b, qa-lead).

Count query after cleanup (rows in regions named `^QA-[0-9]{13}(-B|-V|-E)?$` or owned by users named `^qa-(a|b|lead)\+[0-9]{13}@example\.org$`):

| regions | region_members | records | media | gps_logs | conflict_log | applied_ops | devices | profiles | auth users | storage objects |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

Whole database, before QA and after cleanup:

| | regions | members | profiles | auth users | records | media | storage objects | conflict_log | gps_logs | applied_ops | devices |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Baseline, 15 Nov | 3 | 8 | 3 | 3 | 18 | 18 | 18 | 5 | 19 | 71 | 29 |
| After cleanup, 16 Nov | 3 | 8 | 3 | 3 | 19 | 18 | 18 | 5 | 21 | 78 | 33 |

The four numbers that grew are not QA rows. `node tests/qa/lib/drift.mjs` (read-only) lists every non-QA row newer than the baseline: all are in Region A and were written by the demo accounts "Researcher A" and "Data lead" between 12:25 and 15:17 UTC on 15 November, for example a soil record titled "Hahaha" created and deleted at 13:16 with its GPS point, one track at 12:26, 7 applied ops and 4 new device rows. The QA suite never signed in as a demo user, so these come from someone using the demo by hand while the QA was running. They were left untouched.

## 8. After fixes

Dates: 16 November 2026. Fix log with the failing "before" run and the passing "after" run of every case: `tests/qa/FIXES.md` (logs in `artifacts/fix/`). Server changes are in `supabase/schema.sql` and were applied to the live project with `npm run schema`; a query on the live database confirmed the new `sync_push` and the unchanged read-only policies. App changes were pushed to `main` and deployed by Netlify (service worker version `0e37935c2d80`, then `1e337452450f`).

`npm run verify` was run twice in a row after the fixes: 12 of 12 gates and 6 of 6 other named tests passed both times.

### New counts (live site, `npm run qa` spec by spec, normal retries)

| | Before | After |
| --- | --- | --- |
| Cases | 112 | 112 |
| PASS | 94 | 111 |
| FAIL | 14 | 0 |
| FLAKY | 3 | 0 |
| BLOCKED | 1 | 1 |

The full suite ran on build `0e37935c2d80`. The second deploy (`1e337452450f`, `dir="auto"` on user text, needed for the E06 check) was followed by a rerun of the records (B) and UI (K) specs on the new build: all passed. The suite was run one spec file at a time (K08 alone) to keep memory low; `run.mjs --keep` merges the results into `artifacts/qa/results.json`.

### Each bug

| Bug | Severity | Status | What changed | Proof |
| --- | --- | --- | --- | --- |
| I11 | P0 | FIXED | `sync_push` reads the region of an existing photo from the photo itself, and the delete is filtered by that region | I11 PASS (was "applied", now rejected; photo stays) |
| G08 | P1 | FIXED | a delete carries its base version; fields another device wrote after it go to `conflict_log` as `edit_vs_delete`, restorable. The delete still wins | G08 PASS; G01 to G09 PASS |
| F12 | P1 | FIXED | every backend request has a deadline (30 s, 120 s for photos); a timeout is a normal failure, the outbox stays, backoff continues | F12 PASS, recovered without reload; F01 to F13 PASS |
| I12 | P1 | FIXED | a device id belongs to its first user; a push from another user with it is rejected, the device row keeps its owner | I12 PASS |
| K09 | P1 | FIXED (app) / MANUAL (badge itself) | the layout keeps the strip under a badge fixed to the bottom edge free; the badge cannot be turned off on Netlify's free plan, see HANDOFF.md | K09 PASS on the live site with the badge present (0 controls covered) |
| I13 | P2 | FIXED | a GPS row may only link to a record of its own region | I13 PASS |
| B05 | P2 | FIXED | the form refuses text in a number field; `sync_push` refuses it too | B05 PASS |
| B06 | P2 | FIXED | pH must be 0 to 14, in the form and in `sync_push` | B06 PASS |
| B16 | P2 | FIXED | long words in notes and titles wrap | B16 PASS |
| E09 | P2 | FIXED | `index.html` shows a loading text, retries once, then shows a message with "Try again"; the worker caches files one by one with retries | E09 PASS (message and button visible) |
| K02 | P2 | FIXED | `#panes` may shrink, so the console table scrolls inside its box; Export CSV and Refresh stay on screen | K02 PASS at 1280 and 1440 with the 200-record region |
| K06 | P2 | FIXED | sheets take focus, keep Tab inside, close on Escape; "Skip to New record" is the first Tab stop on the list | K06 PASS |
| K07 | P2 | FIXED | photo number labels use the ink colour (AA); console tables are focusable regions | K07 PASS |
| L04 | P3 | FIXED (optional) | UTF-8 byte-order mark; formula-like cells written as text | L04 PASS |
| E06 | P1 | PASS by a real-deploy check (the case itself stays BLOCKED) | `tests/qa/e06-redeploy.mjs`: a kept browser profile with a record saved offline on build `0e37935c2d80`; after deploying `1e337452450f` the app opened on the new code, only the new cache was left, the pending record and GPS point were still in the outbox, and then uploaded | `artifacts/qa/E06/manual-before.json`, `manual-after.json` |

Former FLAKY cases A10, K04 and K08 passed on every attempt. A10 had failed when a file of the app was dropped (same cause as E09), which is now handled. Lighthouse (mobile): performance 99, accessibility 100, best practices 100, SEO 100.

### Still open or manual

- Netlify badge: covered app controls are fixed; the badge itself can only go with a paid plan or another host (HANDOFF.md).
- Security finding 4 (open self sign-up, P2 in the findings table, not a failing case): a Supabase dashboard setting, MANUAL (HANDOFF.md).
- Security finding 5 (host security headers, P3): not changed, steps in HANDOFF.md.
- K06 still writes the note "took about 90 Tab presses to reach New record", because the case counts Tabs to the foot button `#new-record`; the skip link is the first Tab stop. The test was not changed.
- Findings from passing cases (D07, C04, C06/C07 Storage files, A06, F05, G03, Enter key in forms) are unchanged; the reasons are in DECISIONS.md (55).

### Cleanup

QA rows were deleted with `node tests/qa/run.mjs --cleanup-only` after the live run (proof in `artifacts/qa/cleanup.json`), then `npm run seed` reset the demo data and the three demo accounts.
