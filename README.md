# FieldSync

An installable web app (PWA) for recording soil, water and wildlife data with no internet. Records, photos and GPS logs are saved on the device first and upload on their own when a connection returns. Edits made on two devices are merged field by field, and any overwritten value is kept in a conflict log.

Built for CEP 2. Everything runs on free tiers: a static host and one Supabase project.

**Live app:** https://fieldsync-cep2.netlify.app/ (deployed on Netlify from `main`)

- Requirements: [docs/PRD.md](docs/PRD.md)
- How it works and test results: [docs/REPORT.md](docs/REPORT.md)
- 3 minute demo, click by click: [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md)
- Assumptions made while building: [DECISIONS.md](DECISIONS.md)
- What a person still has to do: [HANDOFF.md](HANDOFF.md)

## What you need

- Node.js 22 or newer (built and tested on 24)
- A free Supabase project (supabase.com)

## Setup

1. Install the tools.

   ```
   npm install
   npx playwright install chromium
   ```

2. Copy `.env.example` to `.env` and fill in the four values from the Supabase dashboard.

   | Key | Where to find it | Used by |
   | --- | --- | --- |
   | `SUPABASE_URL` | Project settings, API | The app |
   | `SUPABASE_ANON_KEY` | Project settings, API keys (publishable / anon) | The app. The only key in the build |
   | `SUPABASE_SERVICE_KEY` | Project settings, API keys (secret / service role) | `npm run seed` only |
   | `SUPABASE_DB_URL` | Connect, Session pooler connection string | `npm run schema` and the tests |

   `.env` is in `.gitignore`. Never commit it.

3. Create the tables, rules and the photo bucket.

   ```
   npm run schema
   ```

4. Create the demo accounts and regions.

   ```
   npm run seed
   ```

   This makes three accounts with one shared password, which it writes to `.env.local` as `SEED_PASSWORD`:

   | Account | Email | Regions |
   | --- | --- | --- |
   | Researcher A | `researcher.a@example.org` | Region A (edit), Region B (edit), Region C (view) |
   | Researcher B | `researcher.b@example.org` | Region A (edit), Region C (view) |
   | Data lead | `data.lead@example.org` | all three |

   **`npm run seed` deletes every record, photo, GPS log and conflict in the project.** It is meant for tests and for a clean demo. Do not run it once you have real data.

## Run

```
npm run dev
```

Open http://localhost:4173/fieldsync/ and sign in with one of the accounts above. The app is served under `/fieldsync/` on purpose, so that hosting under a sub-path (GitHub Pages) is exercised all the time.

To act as a second researcher, open a second browser profile or a private window and sign in as Researcher B.

To try it offline: open Chrome DevTools, Network tab, choose Offline. The status bar at the top turns dark and says `Offline`.

## Test

```
npm run verify
```

This runs lint, the unit tests, the build, schema apply, seed, the end-to-end tests and the secret scan, then prints one line per gate and exits non-zero if anything failed:

```
T1   PASS     Offline create with 3 photos and a GPS point, then reload
...
G12  PASS     Screens at 390, 820 and 1280 px
VERIFY PASSED: 12/12 gates green
```

The end-to-end tests drive real Chromium against the real Supabase project. Two browser contexts act as device A and device B, each with its own IndexedDB and its own account. Tests check three places: the screen, IndexedDB, and Postgres plus Storage.

Single steps:

| Command | Does |
| --- | --- |
| `npm run lint` | ESLint |
| `npm run test:unit` | Unit tests for the merge logic |
| `npm run build` | Build `dist/` |
| `npm run test:e2e` | Playwright tests (needs build, schema and seed first) |
| `npm run scan` | Check `dist/` for the service key and for CDN URLs |

When a test fails, look in `artifacts/`: `failures/` has the console log, network log and a screenshot per device, `test-results/` has the Playwright trace (`npx playwright show-trace <file>`), and `screens/` has a screenshot of every screen at phone, tablet and laptop width.

## Deploy

The build output is the folder `dist/`. It is plain static files with relative paths, so it works at a domain root and under a sub-path. Service workers need HTTPS; both hosts below provide it.

**GitHub Pages**

1. Push this repository to GitHub.
2. In the repository settings, under Secrets and variables, Actions, Variables, add `SUPABASE_URL` and `SUPABASE_ANON_KEY`. They are public values, so variables are fine. Do not add the service key anywhere on GitHub.
3. In Settings, Pages, set Source to GitHub Actions.
4. Push to `main`. The workflow `.github/workflows/pages.yml` builds and publishes the site.

**Netlify** (the official deploy: https://fieldsync-cep2.netlify.app/, built from `main` on every push)

1. New site from Git, pick the repository. `netlify.toml` already sets the build command and the publish folder.
2. In Site settings, Environment variables, add `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
3. Deploy.

**By hand:** run `npm run build` with `.env` present and upload the contents of `dist/` to any static HTTPS host.

After deploying, open the site on the phone or tablet once while online, sign in, and use the browser menu to install it. From then on it opens with no network.

## Project layout

```
src/                 The app: plain HTML, CSS and JavaScript ES modules
  index.html, sw.js, manifest.webmanifest, css/app.css
  js/db.js           IndexedDB tables (Dexie)
  js/store.js        Every write: data + outbox entry in one transaction
  js/sync.js         Push then pull, automatic triggers, backoff
  js/merge.js        Pure merge logic (unit tested)
  js/screens/        One file per screen
supabase/schema.sql  Tables, Row Level Security, sync_push merge function, Storage policies
scripts/             build, serve, schema, seed, scan, verify
tests/unit/          Merge logic tests
tests/e2e/           Two-device end-to-end tests, one per gate
design/              The 22 design screens
```

## Known limits

- Safari on iOS may clear site data after weeks without use. Installing to the Home Screen and syncing regularly protects the data. The app shows this notice on iPhone.
- A free Supabase project pauses after 7 days with no database activity. Open the dashboard before a demo, or enable the scheduled ping in `.github/workflows/keep-alive.yml`.
- Other people's changes appear on the next sync (every 20 seconds while open, or on Sync now). There is no live co-editing, by design.
