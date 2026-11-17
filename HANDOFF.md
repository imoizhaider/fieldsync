# HANDOFF

What a person still has to do. Nothing here blocks `npm run verify`.

## Must do

1. **Deploy the app to a free HTTPS host.** Done: https://fieldsync-cep2.netlify.app/ deploys from `main` on GitHub. The steps below are kept for a second host.
   - Create a GitHub repository and push: `git remote add origin <url>` then `git push -u origin main`.
   - GitHub Pages: add the repository variables `SUPABASE_URL` and `SUPABASE_ANON_KEY`, set Pages source to "GitHub Actions". The workflow is `.github/workflows/pages.yml`.
   - Or Netlify: connect the repository and add the same two environment variables. `netlify.toml` is ready.
   - Never put `SUPABASE_SERVICE_KEY`, `SUPABASE_DB_URL` or `SEED_PASSWORD` on the host or in the repository.
2. **Record the 3 minute demo video.** Follow `docs/DEMO_SCRIPT.md`. Use OBS Studio and Chrome DevTools offline mode, with a second browser profile as the second researcher.
3. **Wake the Supabase project** before recording and before submission (free projects pause after 7 days idle). Open the dashboard; if it says paused, press Restore.
4. **Test once on a real Android phone or tablet** after deploying: open the site in Chrome, sign in, install it from the browser menu, switch on airplane mode, create a record with a camera photo. The automated tests cover Chromium on a desktop only.

## Should do

5. **Run `npm run seed` right before the demo** for empty tables. It deletes all data in the project. Do not run it (or `npm run verify`, which calls it) once the project holds data you want to keep.
6. **Demo account password.** It is in `.env.local` as `SEED_PASSWORD`. Share it with the group privately. To change it, edit that line and run `npm run seed`.
7. **Confirm the free-plan numbers** on https://supabase.com/pricing before the demo (the PRD asks for this).
8. **Export the data once before submission** (the free plan has no backups): sign in as the data lead and press Export CSV for each region.
9. **Optional keep-alive.** `.github/workflows/keep-alive.yml` pings the database every 3 days once the repository is on GitHub with the two variables set.

## For real use (not needed for the course demo)

10. **Real accounts and regions.** Create users in Supabase Auth, add a row per user to `profiles`, and list who may edit what in `region_members` (`editor`, `viewer` or `lead`). There is no admin screen for this; use the Supabase dashboard.
11. **iPhone.** The app runs in Safari and can be added to the Home Screen, but it was not tested on a real iPhone. iOS may clear site data after long inactivity.

## A second machine

Copy `.env` and `.env.local` to the new clone (they are not in git), then:

```
npm ci
npx playwright install chromium
npm run verify
```

## After the QA fixes (16 November 2026)

- **Netlify badge (K09, MANUAL if you want it gone).** The app now keeps the badge's strip free, so it no longer covers any button (QA case K09 passes on the live site). To remove the badge itself: on the free plan it cannot be switched off (Netlify's own badge script, `/.netlify/scripts/hud`, ignores a dismissal when the account tier is "free"). Check the Netlify site settings for a badge option after upgrading; the alternatives are a paid plan or hosting on GitHub Pages (the workflow `.github/workflows/pages.yml` is ready; add the two repository variables and set Pages source to GitHub Actions).
- **Real phone check** (QA report, section 6) is still worth doing once: items 1, 9 and 11 in particular (badge, one bar of signal, a deploy while a record is pending). All three passed in Chromium.
- **Right before recording:** `npm run seed` was run at the end of the fix work, so the tables are empty and the three demo accounts exist with the password in `.env.local`. Running it again is safe and gives empty tables.
- **Netlify security headers (I15, P3, optional):** add a `[[headers]]` block for `/*` in `netlify.toml` with `X-Content-Type-Options = "nosniff"`, `Referrer-Policy = "strict-origin-when-cross-origin"` and a Content-Security-Policy that allows only `'self'` and the Supabase URL. Not done here because a wrong CSP would break the live demo, and it was not a failing case.
- **Supabase self sign-up (security finding 4, P2 in the report's findings table, not a failing case):** Supabase dashboard > Authentication > Sign In / Providers > turn off "Allow new users to sign up". A stranger's account could not read anything, but it could call both sync functions.

## After the online sign-out fix (16 November 2026)

- **Sign in once more on every device you used before this fix.** Earlier `npm run seed` and `npm run verify` runs ended every session of the three demo accounts. On the new build the app says "Online / sign-in needed to sync"; open Sync and press **Sign in again**. Pending records stay on the device and upload right after. From now on a seed run keeps the sessions.
- **Do not change a demo account's password in the Supabase dashboard** (or `SEED_PASSWORD`) shortly before recording: Supabase signs that account out on every device whenever its password is set, even to the same value.
- `npm run seed` still empties the data tables, as before.

## After round 2 (17 November 2026): offline/online sign-in and UI

- **Nothing to do on the phone for the session.** The new build keeps the session through any offline/online change; one sign-in lasts until Sign out. If a phone still shows "Online / sign-in needed to sync" from the old build, open Sync and press **Sign in again** once (the old build had already thrown its copy of the session away; pending records stay and upload right after). Then close the app and open it again so the new build runs (the first open after a deploy can still run the old one).
- **One manual check on a real iPhone** (not possible here): on the New record screen tap **Add photo**: the iOS menu (Take Photo, Photo Library, Choose File) should open at once. Then airplane mode on for a few minutes, off again: the bar should go "Offline / n pending", then "Back online", then "Online / all synced" without asking for a password.
- **"Sign-in needed" now appears only if the server really ended the session** (password changed, account removed). It goes away by itself if a later refresh is accepted; otherwise use **Sign in again** on the Sync screen.
- `npm run seed` was run at the end of this round: tables are empty, the three demo accounts exist, their sessions are kept.
