# PRD: Offline-First Field Data Collection App (CEP 2)

Nov 14, 2026 · @Sufyan

## Overview

FieldSync (working title) is an installable web app that lets environmental researchers record soil, water and wildlife data with no internet, then uploads it to a cloud server on its own once a connection returns.

It runs in the browser on tablets and phones as a Progressive Web App (PWA). Records, photos and GPS logs are saved on the device first, and when several researchers edit the same regional dataset while offline, their changes are merged by a documented rule. The whole project runs on free tools, as required for CEP 2 in Prof. Dr. Asad Arfeen's course.

## Problem and goals

Researchers work in remote areas with zero or intermittent connectivity, so any app that needs a live server blocks their work or loses their data in the field.

**Goals**

- G1: Create, edit and delete records with the network fully off.
- G2: Photos and GPS logs are stored on the device and survive an app restart.
- G3: Pending changes upload automatically, within about 30 seconds of connectivity returning, with no button press.
- G4: Two researchers editing the same record offline never silently lose data. Conflicts follow one written rule and are listed in a conflict log.
- G5: Total cost is $0 (free tiers only).

**Non-goals**

- Native iOS or Android apps.
- Live co-editing while online (other users' changes only need to appear on the next refresh).
- GIS analysis, maps with offline tiles, and multi-organization accounts.

## Users and key scenarios

The primary user is a field researcher on a tablet or phone; the secondary user is a data lead who reviews the merged regional dataset on a laptop after sync.

| Persona | Where and how they work | What they need |
| --- | --- | --- |
| Field researcher | Remote sites, tablet or phone, no signal for hours or days | Fast data entry, photos, GPS, no lost work |
| Data lead | Office laptop, online | One merged dataset per region, a list of conflicts |

**Scenarios the demo must show**

1. **Record offline.** With airplane mode on, a researcher creates a soil sample with readings, notes, three photos and a GPS point. It saves instantly and shows "Pending sync".
2. **Reconnect.** The device goes back online. The pending record and photos upload on their own and the badge changes to "Synced".
3. **Same record, two devices.** Two researchers edit one sample offline. One changes the pH, the other the notes. After both sync, both changes are kept.
4. **Same field, two devices.** Both researchers change the pH. The later edit wins and the overwritten value is saved in the conflict log.
5. **Interrupted upload.** The connection drops halfway through a photo upload. The app retries later and no duplicate record appears.

## Functional requirements

Thirteen requirements; the eight marked P0 are required for the demo and the rest are built only if time remains.

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-1 | Sign in with email and password. The session is cached so the app opens offline after one online login. | P0 |
| FR-2 | Create, view, edit and delete observation records (type: soil, water or wildlife; measurement fields; notes; timestamp) inside a regional dataset. | P0 |
| FR-3 | Attach one or more photos to a record. Photos are compressed on the device before saving. | P0 |
| FR-4 | Capture a GPS point per record and record continuous GPS logs (a track) while walking. | P0 |
| FR-5 | The app is installable and opens with no network (service worker caches the app shell). | P0 |
| FR-6 | Every change is written to local storage first and marked with a sync status. | P0 |
| FR-7 | Sync runs automatically on reconnect and on app open. A "Sync now" button is the backup. | P0 |
| FR-8 | Conflicting edits are merged per field. The later edit wins on the same field, and the overwritten value goes to a conflict log. | P0 |
| FR-9 | A status bar shows online or offline, number of pending changes, and last sync time. | P1 |
| FR-10 | Uploads retry with backoff and resume after interruption. Client-generated IDs prevent duplicates. | P1 |
| FR-11 | Deletes sync as soft deletes (a deleted flag), so another device sees them. | P1 |
| FR-12 | Researchers can edit only the regions they are assigned to (enforced by database rules). | P1 |
| FR-13 | Export a regional dataset as CSV. | P2 |

## Offline strategy

The app works offline through two browser features: a service worker that caches the app itself, and IndexedDB (through the Dexie library) that holds all data on the device.

- **Service worker:** caches the HTML, JavaScript, CSS and icons so the app opens with no network. A web app manifest makes it installable on a phone or tablet.
- **IndexedDB, not localStorage:** localStorage holds only about 5 MB, stores text only (photos would need base64, about 33% larger), blocks the screen while reading and writing, and has no indexes. IndexedDB stores photos as binary blobs, offers far more space, runs asynchronously and supports indexed queries such as "all unsynced records". localStorage is used only for tiny values such as the signed-in user name.
- **Storage protection:** the app asks the browser for persistent storage so data is not cleared under storage pressure, and compresses photos on the device before saving (target: longest side 1280 px, about 70% JPEG quality).

| Local table | Holds | Key fields |
| --- | --- | --- |
| records | Observation data | id (UUID made on device), regionId, type, fields, updatedAt, version, deleted |
| media | Photos | id, recordId, blob, mimeType, uploaded |
| gpsLogs | GPS points and tracks | id, recordId, points, uploaded |
| outbox | Changes waiting to upload | opId, table, rowId, changedFields, createdAt |
| meta | Sync bookkeeping | deviceId, lastPulledAt, userId |

## Sync and conflict resolution

On reconnect the app first pushes its queued local changes to the server, then pulls changes made by others since its last sync, and merges per field using the rules below.

&#91;embedded content: sync flow · 6 steps, 1 decision\]

A rejected or interrupted push never marks anything as synced; the changes wait in the outbox for the next attempt.

| Situation | Rule |
| --- | --- |
| Different fields of one record edited on two devices | Keep both changes (per-field merge). |
| Same field edited on two devices | The edit the server received later wins. The overwritten value is saved in the conflict log. |
| One device edits a record another device deleted | The delete wins. The edit is saved in the conflict log so it can be restored. |
| New record or photo created on a device | Always uploaded. Its UUID is made on the device, so a retry cannot create a duplicate. |
| Photo upload interrupted | Left in the outbox and retried with backoff on the next connection. |

- **Versioning:** every record has a `version` number and an `updatedAt` time on the server. The server accepts a push only through one database function that compares versions and applies the merge, so merging logic lives in one place.
- **Clock risk:** device clocks can be wrong. The server stamps the time it received each change, and the later *server* time breaks ties between same-field edits.
- **Deletes:** a delete sets a `deleted` flag instead of removing the row, so other devices learn about it on their next pull.

## Architecture and tech stack

The browser does all the work offline and talks to one free Supabase project only when a connection exists.

&#91;embedded content: architecture · 3 device parts, 4 cloud services\]

Screens read and write IndexedDB without waiting for the cloud; the sync engine talks to Supabase only when a connection exists.

| Layer | Choice | Cost |
| --- | --- | --- |
| Frontend | Plain HTML and JavaScript PWA with a service worker and manifest | Free |
| Local storage | IndexedDB through Dexie.js | Free |
| Database | Supabase Postgres (free plan) | Free |
| Photo storage | Supabase Storage (free plan) | Free |
| Sign-in | Supabase Auth | Free |
| Hosting for the app | GitHub Pages or Netlify, both HTTPS (service workers need HTTPS) | Free |
| Demo recording | OBS Studio, plus Chrome DevTools offline mode | Free |

**Server tables (Supabase Postgres)**

| Table | Purpose | Key columns |
| --- | --- | --- |
| regions | A regional dataset | id, name |
| region\_members | Which researcher may edit which region | regionId, userId |
| records | Observations | id, regionId, type, fields (JSON), version, updatedAt, deleted |
| media | Photo metadata, file stored in Storage | id, recordId, storagePath |
| gps\_logs | Points and tracks | id, recordId, points (JSON) |
| conflict\_log | Overwritten values for review | id, recordId, field, lostValue, lostBy, at |

## Non-functional requirements

- **Reliability:** no data loss if the app closes, the battery dies or the connection drops during sync. Every change is written to IndexedDB before the screen confirms it.
- **Performance:** saving a record offline feels instant. A pending record with three compressed photos uploads within about 30 seconds on a normal connection.
- **Usability:** touch targets of at least 44 px, a layout that works on phone and tablet widths, and a status bar that always shows offline or online and the pending count.
- **Security:** researchers sign in with Supabase Auth. Row Level Security rules in Postgres let a user read and edit only the regions they belong to. Only the public (anon) key is placed in the frontend; the service key never leaves the server.
- **Compatibility:** current Chrome on Android, plus a desktop browser for the data lead. Safari on iOS may clear site data after long inactivity, which is noted as a known limit.
- **Cost:** stays within the Supabase free plan (see next section).

## Free-tier constraints and mitigations

The project fits inside the Supabase free plan; the one limit that can hurt the demo is that a free project pauses after one week without database activity.

| Free plan limit | Value | How the project stays inside it |
| --- | --- | --- |
| Free projects | 2 active | Use one project for the whole app. |
| Database size | 500 MB | Records and GPS logs are small text; no media is stored in Postgres. |
| File storage | 1 GB | Compress photos on the device (about 150 to 300 KB each) before upload. |
| Egress | 5 GB | Pull only changes since `lastPulledAt`, never the full dataset. |
| Inactivity | Paused after 7 days | Open the dashboard before recording and before submission. Optionally run a free scheduled ping (GitHub Actions or UptimeRobot) that makes one query every few days. |
| Backups | Not included | Keep the SQL schema in the repository and export the data once before submission. |

Figures come from Supabase's pricing page as shown in search results on 14 November 2026; confirm them on the page before the demo.

Sources: [Supabase pricing](https://supabase.com/pricing), [Supabase free tier limits 2026](https://automationatlas.io/answers/supabase-free-tier-limits-2026/)

## Testing and demo plan

The short demo video walks through the five scenarios from the users section, using Chrome DevTools offline mode on one device and a second browser profile as the second researcher.

| Test | Steps | Pass when |
| --- | --- | --- |
| T1 Offline save | Turn the network off, create a record with 3 photos and a GPS point, reload the app. | Data is still there and shows "Pending sync". |
| T2 Auto sync | Turn the network on. | Record and photos appear in Supabase, badge shows "Synced", no button pressed. |
| T3 Different fields | Edit pH on device A and notes on device B, both offline, then sync both. | Both changes are present. |
| T4 Same field | Edit pH on both devices, then sync both. | The later edit wins and the other value is in the conflict log. |
| T5 Interrupted upload | Switch the network off during a photo upload, then on again. | The photo uploads once, with no duplicate record. |
| T6 Delete sync | Delete a record on device A, sync both. | Device B no longer shows it. |

**Demo script (about 3 minutes)**

1. Show the installed app and the Supabase tables empty (15 s).
2. Go offline, add a record with photos and GPS, and reload to show it persists (60 s).
3. Go online and show it syncing and appearing in Supabase (30 s).
4. Run the two-device conflict from T3 and T4 and show the conflict log (60 s).
5. Close with the architecture diagram (15 s).

## Two-day delivery plan

The work splits into three parallel tracks so a group of three can finish the build on day 1 and spend day 2 on sync, testing and the demo video.

| Owner | Day 1: build | Day 2: integrate and deliver |
| --- | --- | --- |
| Member A: app and offline | PWA shell, manifest, service worker, Dexie tables, record forms, status bar | Wire the UI to sync, polish phone and tablet layout, fix bugs from tests |
| Member B: backend and sync | Supabase project, tables, Row Level Security, sign-in, Storage bucket | Push and pull logic, merge function, conflict log, retry with backoff |
| Member C: media, GPS, demo | Photo capture and compression, GPS point and track capture | Run tests T1 to T6, record the demo video, write the short report |

**Deliverables**

- Working app hosted on a free HTTPS host, with its source code in a repository.
- SQL schema file for the Supabase project.
- Demo video of about 3 minutes.
- Short report: this PRD's architecture, offline strategy and conflict rule, plus test results.

## Risks, assumptions and acceptance criteria

The biggest risk is the timeline: the course post calls this a two-day task, so the P1 and P2 items are the first to drop.

| Risk | Fallback |
| --- | --- |
| Supabase project pauses before the demo | Unpause it from the dashboard (about a minute) and open it the day before. |
| Sync and conflict logic takes longer than planned | Ship last-write-wins per record first, then add per-field merge. |
| Browser or device clears local data | Request persistent storage and state the limit in the report. |
| Phone testing needs HTTPS | Use the HTTPS host, or a free tunnel (ngrok or Cloudflare Tunnel) for local testing. |

**Assumptions**

- Supabase's free plan is the backend. If the group prefers PouchDB with CouchDB, the sync section changes but the requirements do not.
- The deadline is not stated in the course post. It says to finish "this week", so Monday's class is the working target until confirmed.
- A demo on Chrome (desktop DevTools plus one Android device) is acceptable.

**Acceptance criteria**

- [ ] Tests T1 to T6 pass and are shown in the demo video.
- [ ] All eight P0 requirements work.
- [ ] The project costs $0 to run.
- [ ] The report explains the conflict rule and why IndexedDB was used instead of localStorage.
