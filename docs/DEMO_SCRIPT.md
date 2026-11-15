# Demo script (about 3 minutes)

Click-by-click walkthrough of the five PRD scenarios. Times are targets.

## Before recording

1. Open the Supabase dashboard so the project is awake (a free project pauses after 7 days idle).
2. Run `npm run seed` for empty tables. This deletes all existing data. The password for the three accounts is `SEED_PASSWORD` in `.env.local`.
3. Open three windows:
   - **Window A:** Chrome, the app, signed in as `researcher.a@example.org`. Open DevTools, Network tab (for the Offline switch). Use device toolbar at phone size if recording on a laptop.
   - **Window B:** a second Chrome profile, the app, signed in as `researcher.b@example.org`, DevTools Network tab open.
   - **Window S:** Supabase dashboard, Table Editor, `records` table.
4. Have three photos ready on the machine.
5. In OBS, add all three windows to one scene.

## 1. Installed app and empty tables (15 s)

1. Window A: point at the install icon in the address bar (or the installed app window). Say: "It is a web app, installed like a native one."
2. Window S: show `records` with 0 rows.
3. Window A: the list says **No records yet**; the status bar says **Online / all synced**.

## 2. Record offline (60 s)

1. Window A, DevTools Network: set throttling to **Offline**. The status bar turns dark: **Offline / 0 pending**.
2. Tap **Create first record**.
3. Leave the type on **Soil**. Type title `Soil sample, north transect`.
4. Type pH `6.4`, Moisture `22`, Temperature `18.5`, Depth `15`.
5. Notes: `Dark loam, damp near the roots.`
6. Tap **Add** and choose the three photos. The label becomes **Photos / 3**.
7. The GPS box shows **GPS / fixed** with coordinates. (Allow location if asked.)
8. Tap **Save to device**. The list shows the record with the orange **Pending** badge. The status bar says **Offline / 1 pending**.
9. Press F5 to reload, still offline. The app opens and the record is still there, still **Pending**.
10. Window S: refresh. Still 0 rows. Say: "Nothing has left the device."

## 3. Reconnect (30 s)

1. Window A, DevTools Network: set throttling back to **No throttling**. Do not touch anything else.
2. The status bar goes green: **Back online**, then **Syncing 1 of 5** with a progress line. A banner says "You are back online."
3. The badge changes to **Synced**; a green bar says **All changes uploaded**.
4. Window S: refresh `records`: 1 row. Open Storage, bucket `photos`: 3 files.

## 4. Two devices, one record (60 s)

**Different fields (T3)**

1. Window B: tap the **Sync** tab, then **Sync now**. Go back to **Records**: the record is there.
2. Set **both** windows to **Offline**.
3. Window A: open the record, **Edit**, change pH to `6.8`, **Save changes**.
4. Window B: open the record, **Edit**, change Notes to `Roots exposed on the east bank`, **Save changes**.
5. Window A back online; wait for **Synced**. Then Window B back online; wait for **Synced**.
6. Window A: **Sync** tab, **Sync now**. Open the record: pH `6.8` and the new notes are both there. Same in Window B.

**Same field (T4)**

1. Both windows **Offline** again.
2. Window A: edit pH to `6.1`. Window B: edit pH to `6.9`.
3. Window A online, wait for **Synced**. Then Window B online, wait for **Synced**.
4. Window A: **Sync** tab, **Sync now**. Open the record: pH is `6.9` (B reached the server later), and a notice says **Conflict on pH … 6.1 is saved in the log**.
5. Tap **Review**: the conflict log shows **Kept 6.9** and **Overwritten 6.1** (struck through).
6. Window S: open `conflict_log`: one row, `lost_value` 6.1.

**Interrupted upload (T5), if time allows**

1. Window A offline. Create a record with 3 photos. Go online, and after about a second switch to **Offline** again, then back online.
2. Open the **Sync** tab during the gap: one photo shows **Retry** with a countdown.
3. After it finishes, Window S: `records` has the record once, `media` has exactly 3 rows for it.

## 5. Close (15 s)

1. Optional: third window signed in as `data.lead@example.org` at laptop size: the **Regional dataset** with the conflict and **Export CSV**.
2. Show the architecture diagram from `docs/REPORT.md` and say the three parts: service worker for the app shell, IndexedDB with an outbox for data, one Supabase function that merges per field.
