// E06 with a real deploy. The QA case E06 tries to fake a new build inside the
// test browser, which Chromium does not allow, so it reports BLOCKED. This
// script checks the same thing across a real deploy, with a browser profile
// that is kept on disk between the two phases:
//
//   node tests/qa/e06-redeploy.mjs before   # current build, 1 record saved offline (pending)
//   ...deploy any change to the app and wait until the host serves it...
//   node tests/qa/e06-redeploy.mjs after    # new build: one cache, record still pending, then uploads
//
// Needs the QA users (node tests/qa/run.mjs --keep ... creates them). Evidence
// goes to artifacts/qa/E06/manual-<phase>.json. Exit code 0 = PASS.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { chromium } from '@playwright/test';
import { env, readState, signIn, STATE_DIR } from './lib/admin.mjs';
import { ROOT } from '../../scripts/env.mjs';

const phase = process.argv[2];
if (!['before', 'after'].includes(phase)) { console.error('usage: e06-redeploy.mjs before|after'); process.exit(2); }
const BASE_URL = (process.env.BASE_URL ?? 'https://fieldsync-cep2.netlify.app/').replace(/\/?$/, '/');
const state = readState();
if (!state) { console.error('no QA users: run a QA spec with --keep first'); process.exit(2); }
const uid = state.users.a.id;
const PROFILE = resolve(STATE_DIR, 'e06-profile');
const OUT = resolve(ROOT, 'artifacts/qa/E06');
const NOTE = resolve(STATE_DIR, 'e06-record.json');
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function liveVersion() {
  const sw = await (await fetch(`${BASE_URL}sw.js?e06=${Date.now()}`, { cache: 'no-store' })).text();
  return /const VERSION = "([0-9a-f]+)"/.exec(sw)?.[1] ?? null;
}

const readLocal = async ({ uidIn, idIn }) => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open(`fieldsync-${uidIn}`); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const all = (store) => new Promise((res) => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => res(r.result); });
  const records = await all('records');
  const outbox = await all('outbox');
  db.close();
  return { record: records.find((r) => r.id === idIn) ?? null, outbox: outbox.filter((o) => o.recordId === idIn).map((o) => ({ table: o.table, kind: o.kind, status: o.status })), caches: await caches.keys() };
};

async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(500);
  }
}

const session = await signIn(state, 'a');
const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: true, serviceWorkers: 'allow', viewport: { width: 390, height: 844 },
  permissions: ['geolocation'], geolocation: { latitude: 24.86, longitude: 67.0, accuracy: 4 },
});
await ctx.addInitScript((s) => { if (!localStorage.getItem('fieldsync-auth')) localStorage.setItem('fieldsync-auth', JSON.stringify(s)); }, session);
const page = ctx.pages()[0] ?? await ctx.newPage();
const evidence = { phase, at: new Date().toISOString(), target: BASE_URL, liveVersion: await liveVersion() };
let ok = false;

try {
  if (phase === 'before') {
    await page.goto(BASE_URL);
    await page.waitForFunction(() => document.documentElement.dataset.ready === '1' && navigator.serviceWorker?.controller, null, { timeout: 60_000 });
    await page.waitForFunction(() => /all synced/.test(document.getElementById('sb-text')?.textContent ?? ''), null, { timeout: 60_000 });
    await ctx.setOffline(true);
    await page.evaluate(() => { location.hash = '#/new'; });
    await page.waitForSelector('#record-form');
    const title = `E06 pending across a deploy ${Date.now().toString(36)}`;
    await page.fill('[data-field="title"]', title);
    await page.fill('#record-form input[data-field="ph"]', '6.1');
    await page.waitForSelector('#gps-box[data-gps="fixed"]', { timeout: 20_000 });
    await page.click('#save-record');
    await page.waitForFunction(() => !document.querySelector('#record-form'));
    const id = await page.evaluate(async (u) => {
      const db = await new Promise((res) => { const r = indexedDB.open(`fieldsync-${u}`); r.onsuccess = () => res(r.result); });
      const rows = await new Promise((res) => { const r = db.transaction('records').objectStore('records').getAll(); r.onsuccess = () => res(r.result); });
      db.close();
      return rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0].id;
    }, uid);
    writeFileSync(NOTE, JSON.stringify({ id, title }));
    Object.assign(evidence, { id, title, local: await page.evaluate(readLocal, { uidIn: uid, idIn: id }) });
    ok = evidence.local.record?.fields?.title === title && evidence.local.outbox.length > 0 && evidence.local.caches.length === 1;
  } else {
    const { id, title } = JSON.parse(readFileSync(NOTE, 'utf8'));
    // Keep the change from uploading while the new build takes over.
    await ctx.route('**/rest/v1/rpc/sync_push*', (r) => r.abort('internetdisconnected'));
    await ctx.route('**/storage/v1/object/**', (r) => r.abort('internetdisconnected'));
    await ctx.setOffline(false);
    const want = `fieldsync-${evidence.liveVersion}`;
    await page.goto(BASE_URL);
    await page.waitForFunction(() => document.documentElement.dataset.ready === '1', null, { timeout: 60_000 });
    evidence.cachesOnFirstOpen = await page.evaluate(() => caches.keys());
    await waitFor(async () => { const k = await page.evaluate(() => caches.keys()); return k.length === 1 && k[0] === want; }, 60_000, `only ${want} in the cache`);
    await page.reload(); // "open the app twice"
    await page.waitForFunction(() => document.documentElement.dataset.ready === '1', null, { timeout: 60_000 });
    evidence.newCodeRunning = await page.evaluate(() => document.querySelector('#record-list [dir="auto"]') !== null || document.querySelector('[dir="auto"]') !== null);
    evidence.whilePending = await page.evaluate(readLocal, { uidIn: uid, idIn: id });
    const pendingKept = evidence.whilePending.record?.fields?.title === title && evidence.whilePending.outbox.length > 0;
    await ctx.unroute('**/rest/v1/rpc/sync_push*');
    await ctx.unroute('**/storage/v1/object/**');
    await page.evaluate(() => { location.hash = '#/sync'; });
    await waitFor(async () => (await page.evaluate(readLocal, { uidIn: uid, idIn: id })).outbox.length === 0, 90_000, 'outbox empty');
    const db = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
    await db.connect();
    evidence.server = (await db.query('select fields, version, deleted from public.records where id = $1', [id])).rows[0] ?? null;
    await db.end();
    await page.screenshot({ path: resolve(OUT, 'manual-after.png') });
    ok = pendingKept && evidence.server?.fields?.title === title && evidence.server.fields.ph === 6.1;
  }
} catch (err) {
  evidence.error = String(err?.message ?? err);
} finally {
  evidence.result = ok ? 'PASS' : 'FAIL';
  writeFileSync(resolve(OUT, `manual-${phase}.json`), JSON.stringify(evidence, null, 2));
  await ctx.close();
}
console.log(`E06 ${phase}: ${evidence.result}${evidence.error ? ` (${evidence.error})` : ''}`);
process.exitCode = ok ? 0 : 1;
