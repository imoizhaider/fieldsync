# HANDOFF

What a person still has to do. Nothing here blocks `npm run verify`.

## Must do

1. **Deploy the app to a free HTTPS host.** Nothing has been published; the repository has no remote yet.
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
