# FieldSync: short report

CEP 2, offline-first field data collection. This report covers the architecture, the offline strategy, why IndexedDB and not localStorage, the conflict rule, and the test results.

## 1. What was built

An installable web app (PWA) for field researchers. With no network they create, edit and delete soil, water and wildlife records, attach photos and capture GPS points and tracks. Everything is saved on the device first. When a connection returns the changes upload on their own. If two researchers changed the same record while offline, the changes are merged field by field, and any value that was overwritten is kept in a conflict log. A data lead reviews the merged dataset on a laptop and can export it as CSV.

Total running cost is $0: a static host (GitHub Pages or Netlify) and one free Supabase project.

## 2. Architecture

```
            DEVICE (browser, works with no network)              CLOUD (one free Supabase project)

  +---------------------------------------------------+
  |  Screens (plain HTML, CSS, JavaScript modules)     |
  |    read and write only local data                  |
  +------------------------+--------------------------+
                           |
  +------------------------v--------------------------+        +-----------------------------------+
  |  IndexedDB (Dexie)                                 |        |  Auth      email + password        |
  |    records   media (photo blobs)   gpsLogs         |        +-----------------------------------+
  |    outbox (changes waiting)        meta            |        |  Postgres                         |
  +------------------------+--------------------------+   push  |    sync_push()  the only way to   |
                           |                          +-------->|      write: merges per field,     |
  +------------------------v--------------------------+         |      fills conflict_log           |
  |  Sync engine                                       |  pull  |    sync_pull()  changes since     |
  |    1. push outbox   2. pull changes since last     |<-------+      lastPulledAt                 |
  |    starts on reconnect and on app open             |        |    Row Level Security: only your  |
  +----------------------------------------------------+        |      regions (region_members)     |
                                                        photos  +-----------------------------------+
  +----------------------------------------------------+------->|  Storage   private bucket "photos" |
  |  Service worker: caches the app shell              |        +-----------------------------------+
  +----------------------------------------------------+
```

Three parts on the device, four services in the cloud:

- **Screens** never wait for the cloud. They read and write IndexedDB only.
- **IndexedDB** holds the data, the photos, and an **outbox** of changes that have not been uploaded yet.
- **The sync engine** is the only code that talks to Supabase.
- **Supabase Auth** signs researchers in. **Postgres** holds the merged data. **Storage** holds photo files. **Row Level Security** limits each user to their regions.

| Layer | Choice | Cost |
| --- | --- | --- |
| Frontend | Plain HTML, CSS and JavaScript ES modules. No UI framework | Free |
| Local data | IndexedDB through Dexie | Free |
| Database, sign-in, photos | Supabase Postgres, Auth, Storage (free plan) | Free |
| Hosting | GitHub Pages or Netlify, HTTPS | Free |

Dexie and supabase-js are bundled into the app and the IBM Plex Sans font is served by the app itself, so nothing is loaded from a CDN at runtime.

## 3. Offline strategy

**The app opens with no network.** A service worker caches every file of the app (HTML, CSS, JavaScript, fonts, icons) when it is first loaded, and serves them from that cache afterwards. A web app manifest makes it installable.

**Sign-in survives offline.** The session is stored on the device at the first online sign-in. After that the app opens straight to the records with no network.

**Every write is local first.** One function layer (`src/js/store.js`) performs every change. Each change and its outbox entry are saved in a single IndexedDB transaction, so there is never a saved change without a queued upload, or the reverse. The screen confirms only after that transaction has committed. If the app closes, the battery dies or the connection drops, the change is already on disk.

| Local table | Holds | Key fields |
| --- | --- | --- |
| records | Observation data | id (UUID made on device), regionId, type, fields, updatedAt, version, deleted |
| media | Photos as binary blobs | id, recordId, blob, mimeType, uploaded |
| gpsLogs | GPS points and tracks | id, recordId, points, uploaded |
| outbox | Changes waiting to upload | opId, table, rowId, changedFields, createdAt |
| meta | Sync bookkeeping | deviceId, lastPulledAt, userId |

**Sync starts by itself.** On app open, when the browser reports it is back online, right after a local change while online, and every 20 seconds while the app is open. "Sync now" is only a backup. Each run pushes the outbox first, then pulls only what changed on the server since `lastPulledAt`.

**A failed push changes nothing.** An outbox entry is removed only after the server has answered for it. If a push is interrupted, the entries stay exactly as they were and the engine retries with backoff (2, 4, 8 … 60 seconds). Photos are separate entries, so finished photos are not sent again.

**Retries cannot duplicate.** Record, photo and GPS ids are UUIDs made on the device, and every outbox entry also has its own id that the server remembers. Sending the same change twice has no effect the second time.

**Storage protection.** The app asks the browser for persistent storage, and compresses every photo on the device before saving it (longest side 1280 px, JPEG at about 70 %; a 2400 x 1800 test photo becomes about 40 KB). The Storage screen shows usage and can remove local copies of photos that are already on the server.

### Why IndexedDB and not localStorage

| | localStorage | IndexedDB |
| --- | --- | --- |
| Space | About 5 MB in total | A large share of free disk space (hundreds of MB and more) |
| Data types | Text only. A photo must be base64 text, about 33 % larger | Binary blobs. A photo is stored as it is |
| Speed | Synchronous: the screen freezes while it reads or writes | Asynchronous: the screen stays responsive |
| Queries | None. Find things by reading everything | Indexes, e.g. "all outbox entries for this record" |
| Safety | One write at a time, no transactions | Transactions: a record and its outbox entry are saved together or not at all |

One field visit with photos would overflow localStorage. The transaction guarantee is also what makes "saved locally" and "queued for upload" impossible to separate. localStorage is used for exactly one tiny value: who is signed in.

## 4. Conflict rule

All merging happens in one place: the Postgres function `sync_push` in `supabase/schema.sql`. Clients cannot write to any table directly.

How it knows what happened: every record has a `version` that goes up by one on each change, and for every field the server remembers which version, user and device wrote it last. Every edit a device sends carries only the fields it changed and the version the device last saw (the base version).

| Situation | Rule | Example |
| --- | --- | --- |
| Different fields edited on two devices | Keep both changes | A sets pH 6.8, B sets notes. Result: pH 6.8 and B's notes |
| Same field edited on two devices | The edit the **server receives later** wins. The value it replaced is saved in `conflict_log` | A sets pH 6.1, B sets pH 6.9, A syncs first. Result: pH 6.9. Log: 6.1, lost by A |
| Edit of a record another device deleted | The delete wins. The edit is saved in `conflict_log` and can be restored from there | A deletes, B edits notes offline. Record stays deleted. Log: B's notes |
| New record, photo or track | Always accepted. The device-made UUID means a retry cannot create a second copy | |
| Photo upload interrupted | Stays in the outbox, retried with backoff on the next connection | |

"Same field" means precisely: the field was last written by a *different device*, at a version *newer than the base version* the pushing device had, with a *different value*.

**Clock risk.** Device clocks can be wrong, so device time is never used. "Later" is the order in which the server receives the pushes, stamped with the server's own clock. In test T4 device B's clock is set a full day back and its edit still wins, because it reached the server second.

**Deletes** set a `deleted` flag instead of removing the row, so other devices learn about the delete on their next pull.

**Nothing is silently lost.** Every overwritten value is a row in `conflict_log` with the record, the field, the lost value, who lost it and when. Researchers see it in the app's Conflict log; the data lead sees open conflicts in the console.

## 5. Security

- Researchers sign in with Supabase Auth (email and password).
- Row Level Security lets a user read only rows of regions listed for them in `region_members`. There are no write policies at all.
- Writes go through `sync_push`, which checks the caller's role in the region for every change. A view-only or unassigned region answers "rejected", the change stays safe on the device, and the app shows "Sync rejected" with the reason.
- Photos live in a private Storage bucket. The first folder of each file name is the region id, and the Storage policies apply the same region check.
- Only the public key is in the built app. `npm run scan` fails the build check if the service key, a database connection string or any CDN URL appears in `dist/`.

## 6. Test results

`npm run verify` runs lint, 17 unit tests of the merge logic, the build, schema apply, seed, 18 end-to-end tests and the secret scan. The end-to-end tests run real Chromium against the real Supabase project. Two browser contexts act as device A and device B, each with its own IndexedDB and its own account, and each test checks three places: the screen, IndexedDB, and Postgres plus Storage. Offline is simulated with the browser's offline switch; the interrupted upload is simulated by cutting the Storage request mid-flight.

Result of `npm run verify` on 15 November 2026, on a fresh clone in a temporary folder against the hosted Supabase project, run twice in a row: **12 of 12 gates passed both times**, plus 6 of 6 other named tests (145 s and 132 s).

| Gate | Check | Pass when | Result |
| --- | --- | --- | --- |
| T1 | Offline create with 3 photos and a GPS point, then reload | Data still there, shows Pending sync | PASS |
| T2 | Go online with no button press | Record and photos in Supabase within 30 s, badge Synced | PASS |
| T3 | A edits pH, B edits notes offline, both sync | Both changes on the server and both devices | PASS |
| T4 | Both devices edit pH, then sync | Later server-received edit wins, other value in conflict_log | PASS |
| T5 | Photo upload aborted mid-flight, then reconnect | Photo exists once, no duplicate record | PASS |
| T6 | A deletes a record, both sync | B no longer shows it | PASS |
| G7 | Open with the network off after one online sign-in | App shell loads, records listed | PASS |
| G8 | Researcher B writes to a region not assigned | Server rejects, app shows Sync rejected | PASS |
| G9 | Edit a record another device deleted | Delete wins, edit in conflict_log | PASS |
| G10 | Scan build for service key and CDN URLs | Nothing found | PASS |
| G11 | Manifest and service worker check | Installable | PASS |
| G12 | Screens at 390, 820, 1280 px | No horizontal scroll, 44 px targets, compared by eye with design/ | PASS |

### Requirement coverage

Every P0 and P1 requirement maps to a gate or a named test.

| Requirement | Priority | Covered by |
| --- | --- | --- |
| FR-1 Sign in, session cached, opens offline after one login | P0 | G7; test "FR-1 sign-in shows a clear error…" |
| FR-2 Create, view, edit, delete records in a regional dataset | P0 | T1, T3, T6; test "FR-2 records of every type…" |
| FR-3 Photos, compressed on the device | P0 | T1 (1280 px, JPEG), T2 (in Storage); test "FR-3 synced photos can be freed…" |
| FR-4 GPS point per record and continuous GPS track | P0 | T1, T2 (point); test "FR-4 a GPS track is recorded…" |
| FR-5 Installable, opens with no network | P0 | G7, G11 |
| FR-6 Every change written locally first, with a sync status | P0 | T1 |
| FR-7 Automatic sync on reconnect and app open; Sync now as backup | P0 | T2, T5 (reconnect), G7 (app open) |
| FR-8 Per-field merge, later edit wins, conflict log | P0 | T3, T4, G9; unit tests in `tests/unit/merge.test.js` |
| FR-9 Status bar: online/offline, pending count, last sync | P1 | T1, T2; test "FR-9 FR-12 a view-only region…" |
| FR-10 Retry with backoff, resume, no duplicates | P1 | T5; unit test "backoffDelay…" |
| FR-11 Deletes sync as soft deletes | P1 | T6, G9 |
| FR-12 Edit only assigned regions, enforced by the database | P1 | G8; test "FR-9 FR-12 a view-only region…" |
| FR-13 Export a region as CSV | P2 | test "FR-13 the data lead sees the merged dataset…" |

## 7. Known limits

- Safari on iOS can clear site data after long inactivity. The app asks for persistent storage and tells iPhone users to add it to the Home Screen, but the safe habit is to sync before a long gap.
- A free Supabase project pauses after 7 days idle. Unpausing takes about a minute from the dashboard; a scheduled ping is included.
- Changes by other people appear on the next sync, not live. This is a stated non-goal.
- The device proposes label numbers (SOIL-014). If two offline devices pick the same number, the server renumbers the second one at first sync. The record itself is never affected.
