# FieldSync QA test plan

Target: https://fieldsync-cep2.netlify.app/ (override with `BASE_URL`). Source of truth: `docs/PRD.md`.
Written before any test code. One row per case. `Sev` is the severity a failure gets.

How every case is run
- Playwright on Chromium. Each "device" is its own browser context (own IndexedDB, own signed-in user).
- Data cases check three places: the screen, IndexedDB (read with the raw `indexedDB` API, no app modules), and Postgres + Storage (service connection, in the Node test process only).
- The app is driven through its UI or through the public REST API with the anon key and a user token. No app internals are imported or called.
- Test data lives only in regions `QA-<ts>` (main), `QA-<ts>-B` (qa-a only, the "not assigned" region for qa-b) and `QA-<ts>-V` (view only), with users `qa-a+<ts>`, `qa-b+<ts>`, `qa-lead+<ts>` `@example.org`. All are deleted at the end.
- A failure is rerun twice. 3 of 3 failed = FAIL. Mixed = FLAKY. Not automatable after 3 tries = BLOCKED with manual steps.

Assumptions where the PRD is silent (closest reading, also noted in the report)
- Measurement fields are numeric readings, so text or impossible values (pH 99) should be refused or flagged (B05, B06).
- "Edit vs delete" must leave a conflict-log entry whichever of the two reaches the server first (G08), because the PRD row names no order.
- CSV: PRD says only "export a regional dataset". Deleted rows must be either absent or clearly flagged (L03).

## A. Auth and session

| Id | Sev | Case | Pass when |
| --- | --- | --- | --- |
| A01 | P0 | Valid login | Lands on Observations, session in localStorage, first pull done, regions in IndexedDB |
| A02 | P2 | Empty fields | Each of: both empty, email only, password only shows a message, no request sent |
| A03 | P2 | Wrong password | Clear message, stays on sign-in, nothing stored, button usable again |
| A04 | P2 | Unknown email and malformed email | Clear message, no crash |
| A05 | P0 | Offline open after one online login | Network off + reload: app shell and record list open, no sign-in screen |
| A06 | P1 | Session expires while offline, then reconnect | Pending record stays in IndexedDB, bar says sign-in needed, user can reach sign-in, after sign-in the record reaches Postgres |
| A07 | P0 | Sign out with pending changes | Warning states the pending count; after signing in again the change is still local and uploads |
| A08 | P1 | Two users on one device | User B never sees user A's local rows; A's pending change survives B's session and uploads when A returns |
| A09 | P2 | First sign-in with no network | Clear "needs a connection" message |
| A10 | P2 | Signed-out deep link | `#/records`, `#/sync`, `#/console` all show sign-in when signed out |

## B. Records CRUD

| Id | Sev | Case | Pass when |
| --- | --- | --- | --- |
| B01 | P0 | Create soil, water, wildlife | Each: on screen, in IndexedDB + outbox, then in Postgres with same fields |
| B02 | P0 | Edit each type | Changed fields match in all three places, version goes up |
| B03 | P0 | Delete each type | Gone from list, `deleted` flag set locally and in Postgres (row kept) |
| B04 | P3 | Required fields missing (save a fully empty form) | Either blocked with a message or saved with a clear fallback title; no crash, syncs |
| B05 | P2 | Non-numeric pH (`abc`) | Refused or flagged; a text value must not reach a numeric reading |
| B06 | P2 | Negative and out-of-range pH (`-3`, `99`) | Refused or flagged |
| B07 | P1 | Very long notes (2000 chars typed, 5000 pasted) | Limit enforced at 2000, saved value syncs intact |
| B08 | P1 | Unicode, emoji, RTL (Urdu/Arabic), combining marks | Byte-identical in screen, IndexedDB, Postgres and on a second device |
| B09 | P0 | HTML and script in title and notes | Shown as text in list, detail, edit form; no script runs, no element injected |
| B10 | P2 | 200 records in the list | List paints < 2 s, tab switch < 1 s, sync of 200 pulled rows completes |
| B11 | P2 | Filter tabs | All / Soil / Water / Wildlife show exactly the right rows and empty text |
| B12 | P1 | Emoji at the length limit | No broken character saved; sync still completes (no stuck outbox) |
| B13 | P3 | Decimal comma `6,5` | Stored as number 6.5 |
| B14 | P1 | View-only region in the UI | No New/Edit/Delete; direct `#/new` cannot save |
| B15 | P1 | Two offline devices pick the same label number | Both records kept on server, one renumbered, both devices agree after sync |
| B16 | P2 | Long unbroken word in notes (added while testing B07) | Text wraps; nothing is cut off |

## C. Photos

| Id | Sev | Case | Pass when |
| --- | --- | --- | --- |
| C01 | P0 | 1 photo on a record | Blob in IndexedDB, 1 media row, 1 Storage object, tile on screen |
| C02 | P0 | 10 photos on a record | 10 / 10 / 10, positions 1..10, no duplicates |
| C03 | P0 | 11 MB image | Stored JPEG longest side = 1280 px, far smaller than source |
| C04 | P2 | Non-image file | Clear message, no photo added, record still saves |
| C05 | P2 | Camera permission denied | Permissions screen, "Choose from library" still adds a photo |
| C06 | P1 | Delete a synced photo | Gone on device, `deleted` on server, gone on second device |
| C07 | P2 | Photo on a record that is later deleted | Record and its photos disappear on both devices; Storage/media rows not left "live" |
| C08 | P1 | Photo made on device A seen on device B | B downloads and shows it |
| C09 | P2 | Free space, then reopen record online | Local blob removed, then fetched again |

## D. GPS

| Id | Sev | Case | Pass when |
| --- | --- | --- | --- |
| D01 | P0 | Point capture | Coordinates on screen, in gpsLogs, in `gps_logs` |
| D02 | P2 | Permission denied | "Blocked" state, Permissions screen, save without GPS works |
| D03 | P2 | Position unavailable and timeout | Message shown, capture can be retried, record saves |
| D04 | P1 | Long track (600 points) | All points local and on server, distance > 0, UI responsive |
| D05 | P0 | Track while going offline | Track saved offline as Pending, uploads on reconnect |
| D06 | P2 | Edge coordinates (90,180), (-90,-180), (0,0) | Stored exactly, displayed correctly |
| D07 | P1 | Reload in the middle of a recording | Track recovered and queued, at most the documented 4 points lost |
| D08 | P2 | Delete a synced track | Flagged deleted on server, gone on second device |

## E. Offline and PWA

| Id | Sev | Case | Pass when |
| --- | --- | --- | --- |
| E01 | P0 | App shell opens with network off | Every own-origin file served with no network |
| E02 | P0 | Reload offline keeps data | Offline record + photos + GPS still there, "Pending" |
| E03 | P0 | Manifest valid | name, start_url, scope, display, 192 + 512 + maskable icons, all icons load with the stated size |
| E04 | P0 | Service worker registered and scoped | Active, scope = site root, controls the page |
| E05 | P0 | Installable | Chrome reports no installability error (except in-incognito) |
| E06 | P1 | New deploy version | New worker replaces the cache, IndexedDB data and outbox untouched |
| E07 | P1 | Deep link refresh | Reload on `#/record/<id>`, `#/sync`, `#/conflicts` online and offline: same screen, no 404 |
| E08 | P1 | Precache complete | Every file in the worker's list is in the cache |
| E09 | P2 | First visit on a bad connection (added after a real network drop left a blank app during A10) | One failed file does not leave a blank screen with no message |

## F. Sync

| Id | Sev | Case | Pass when |
| --- | --- | --- | --- |
| F01 | P0 | Auto sync on reconnect | Record + 3 photos in Supabase within 30 s, no click |
| F02 | P0 | Sync on app open | Pending change uploads after a plain reload/open |
| F03 | P0 | Sync now button | A change made on another device arrives after one press |
| F04 | P0 | Pushes before pulls | First `sync_push` request precedes first `sync_pull` in every run |
| F05 | P1 | Pull fetches only changes since lastPulledAt | `p_since` = stored lastPulledAt; response holds only rows changed after it |
| F06 | P0 | 500 / 503 responses | Outbox identical before and after, status never "Synced" |
| F07 | P0 | Request timeout | Outbox kept, sync recovers by itself |
| F08 | P1 | Backoff timing | Gaps between attempts about 2, 4, 8, 16 s |
| F09 | P2 | Retry countdown | Sync screen shows "Upload interrupted" and a `Retry mm:ss` counting down |
| F10 | P1 | Slow 3G | Record with 3 photos completes, nothing duplicated |
| F11 | P1 | Two tabs of one user | One record, one of each photo, both tabs end "all synced" |
| F12 | P1 | Request that never answers | App gives up or recovers without a manual reload |
| F13 | P1 | Status bar (FR-9) | Online/offline, pending count, last sync time all correct |

## G. Conflicts

| Id | Sev | Case | Pass when |
| --- | --- | --- | --- |
| G01 | P0 | Different fields on two devices | Both kept everywhere, no conflict row |
| G02 | P0 | Same field | Later server arrival wins, loser in `conflict_log` |
| G03 | P0 | Wrong device clock (-1 day and +1 day) | Winner still decided by server arrival |
| G04 | P0 | Edit vs delete (delete first) | Delete wins, edit in log, Restore brings it back |
| G05 | P1 | Delete vs delete | Deleted once, no error, no conflict row |
| G06 | P0 | Three devices on one field | Last arrival wins, two log rows with the right lost values |
| G07 | P0 | Conflict log screen | Shows every `conflict_log` row for the region, on both devices and in the lead console |
| G08 | P1 | Edit synced first, stale delete arrives later | Edit is not silently lost: log entry or restore path |
| G09 | P2 | Same value on both devices | No conflict row |

## H. Idempotency and duplicates

| Id | Sev | Case | Pass when |
| --- | --- | --- | --- |
| H01 | P0 | Interrupted photo upload retried | One media row, one object per photo |
| H02 | P0 | Record push answered but answer lost | One record, version 1 |
| H03 | P0 | Same outbox op sent twice (API) | Second answer flagged duplicate, one row, version unchanged |
| H04 | P0 | App closed mid-sync, reopened | One record, each photo once, outbox drains |
| H05 | P1 | Double click on Save | One record |

## I. Security

| Id | Sev | Case | Pass when |
| --- | --- | --- | --- |
| I01 | P0 | Direct REST read of an unassigned region | records, media, gps_logs, regions, region_members return nothing for it |
| I02 | P0 | Direct table insert/update/delete | All refused for every table |
| I03 | P0 | `sync_push` into an unassigned region | Rejected, nothing written |
| I04 | P1 | Access removed while offline (through the app) | "Sync rejected" screen with reason, data kept, Retry works after access returns |
| I05 | P0 | Storage of another region | No download, list, upload or overwrite |
| I06 | P0 | conflict_log across regions | Not readable via REST or `sync_pull` |
| I07 | P0 | Secrets | No service key, DB URL or password in shipped JS or in any request |
| I08 | P0 | XSS payloads from the server (profile name, values in conflict log) | Rendered as text |
| I09 | P0 | No login | anon key alone reads nothing and cannot call the functions |
| I10 | P1 | Viewer role | Cannot write via `sync_push` or Storage |
| I11 | P0 | `sync_push` media delete with another region's photo id | Refused |
| I12 | P1 | Forged device id | Cannot suppress the conflict log or take over another device's row |
| I13 | P2 | GPS log pointing at another region's record | Refused |
| I14 | P1 | Third-party requests | App talks only to its own origin and Supabase |
| I15 | P3 | Security headers | Recorded (CSP, X-Frame-Options, nosniff) |

## J. Storage limits

| Id | Sev | Case | Pass when |
| --- | --- | --- | --- |
| J01 | P1 | Quota low (simulated 85 %) | Banner on the list and red "Storage almost full" card |
| J02 | P1 | Persistent storage | `navigator.storage.persist()` is called at sign-in, result shown |
| J03 | P0 | IndexedDB write fails | Clear error, form content kept, no half-saved record or outbox row |
| J04 | P1 | Free space | Only uploaded photos lose their blob; pending ones stay |

## K. UI and accessibility

| Id | Sev | Case | Pass when |
| --- | --- | --- | --- |
| K01 | P2 | All 22 design screens side by side | Each built screen matches its mock in layout and content (differences listed) |
| K02 | P2 | No horizontal scroll | Every screen at 390, 820, 1280 |
| K03 | P1 | Tap targets | Every control at least 44 x 44 px at all three widths |
| K04 | P2 | Status = shape + text | Every status badge has text and a non-colour marker |
| K05 | P1 | Status bar always visible | Present and in view on every screen, also when scrolled |
| K06 | P2 | Keyboard | Sign in and create a record with keyboard only, focus visible, sheet closes with Escape |
| K07 | P2 | Contrast AA | axe-core finds no contrast violations on each screen |
| K09 | P1 | Nothing covers the app's controls on the live site (added after the host badge blocked A07) | Every bottom control can be tapped at 390 px with the page exactly as deployed |
| K08 | P3 | Lighthouse | Performance, accessibility, best-practices, SEO recorded (PWA category no longer exists) |

## L. Data lead and export

| Id | Sev | Case | Pass when |
| --- | --- | --- | --- |
| L01 | P1 | Console shows merged regional data | Rows and card counts equal Postgres for the region |
| L02 | P2 | CSV with commas, quotes, newlines, unicode | Parses back to the exact values |
| L03 | P2 | Deleted records in CSV | Absent or flagged |
| L04 | P3 | CSV in a spreadsheet | UTF-8 BOM present; cells starting with `=` are neutralised |
| L05 | P2 | Mark reviewed / Restore from console | Reaches Postgres, open-conflict count drops |
