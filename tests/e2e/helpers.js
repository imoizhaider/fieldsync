// Shared harness: two (or more) browser contexts act as separate devices,
// each with its own IndexedDB and its own signed-in account. Tests check
// three places: the screen, IndexedDB, and Postgres/Storage.
import { test as base, expect } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { loadEnv, ROOT } from '../../scripts/env.mjs';

export { expect };
export const env = loadEnv();
export const seed = JSON.parse(readFileSync(resolve(ROOT, 'tests/.auth/seed.json'), 'utf8'));
export const PHOTOS = [1, 2, 3].map((n) => resolve(ROOT, `tests/fixtures/generated/photo-${n}.png`));
export const GEO = { latitude: 24.8607, longitude: 67.0011, accuracy: 4 };
export const SUPABASE_HOST = new URL(env.SUPABASE_URL).host;

// ------------------------------------------------------------- Postgres
let pool = null;
export async function sql(text, params = []) {
  pool ??= new pg.Pool({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false }, max: 2 });
  return (await pool.query(text, params)).rows;
}

export async function serverRecord(id) {
  return (await sql('select * from public.records where id = $1', [id]))[0] ?? null;
}

// ---------------------------------------------------------------- device
export class Device {
  constructor(name, context, page) {
    this.name = name;
    this.context = context;
    this.page = page;
    this.console = [];
    this.network = [];
    this.foreign = []; // requests to anything that is not the app or Supabase
    this.watch(page);
  }

  watch(page) {
    page.on('console', (m) => this.console.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => this.console.push(`[pageerror] ${e.message}`));
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (!['http:', 'https:'].includes(u.protocol)) return;
      this.network.push(`> ${r.method()} ${u.origin}${u.pathname}`);
      if (u.hostname !== 'localhost' && u.host !== SUPABASE_HOST) this.foreign.push(r.url());
    });
    page.on('requestfailed', (r) => this.network.push(`x ${r.method()} ${r.url().split('?')[0]} ${r.failure()?.errorText}`));
    page.on('response', (r) => { if (r.status() >= 400) this.network.push(`< ${r.status()} ${r.url().split('?')[0]}`); });
  }

  // Open the app and wait until it is usable (and, by default, has finished its first sync).
  async open({ waitForSync = true, hash = '' } = {}) {
    await this.page.goto(`./${hash}`);
    await this.page.waitForSelector('html[data-ready="1"]');
    await this.page.waitForFunction(() => navigator.serviceWorker?.controller != null);
    if (waitForSync) await this.idle();
  }

  // Wait until the sync engine is idle with nothing left to upload. Reads the
  // outbox itself, so a change queued a moment ago is never missed.
  async idle(timeout = 30_000) {
    await this.page.waitForFunction(async () => {
      const { db } = await import('./js/db.js');
      const { state } = await import('./js/sync.js');
      return db && navigator.onLine && state.phase === 'idle' && (await db.outbox.count()) === 0 && (await db.meta.get('lastPulledAt'));
    }, null, { timeout });
    await expect(this.page.locator('#sb-text')).toHaveText(/^Online \/ (all synced|data lead)$/, { timeout });
  }

  async offline() {
    await this.context.setOffline(true);
    await expect(this.page.locator('#statusbar')).toHaveAttribute('data-online', '0');
  }

  async online() {
    await this.context.setOffline(false);
    await expect(this.page.locator('#statusbar')).toHaveAttribute('data-online', '1');
  }

  async go(hash) {
    await this.page.evaluate((h) => { location.hash = h; }, hash);
  }

  // Run the sync engine once and wait for it. Used for test set-up only; the
  // gates about automatic sync never call this.
  async sync() {
    await this.page.evaluate(async () => {
      const { syncNow } = await import('./js/sync.js');
      await syncNow({ manual: true });
      await syncNow({ manual: true });
    });
  }

  // Read IndexedDB through the app's own Dexie instance.
  idb(fn, arg) {
    return this.page.evaluate(async ({ source, arg: a }) => {
      const { db } = await import('./js/db.js');
      return new Function('db', 'arg', `return (${source})(db, arg)`)(db, a);
    }, { source: fn.toString(), arg });
  }

  localRecord(id) {
    return this.idb((db, rid) => db.records.get(rid), id);
  }

  outbox() {
    return this.idb((db) => db.outbox.orderBy('seq').toArray());
  }

  // Fill in and save the "New record" form like a researcher would.
  async createRecord({ title, type = 'soil', fields = {}, notes = '', photos = 0, gps = true } = {}) {
    const p = this.page;
    await this.go('#/new');
    await p.waitForSelector('#record-form');
    if (type !== 'soil') await p.click(`[data-type="${type}"]`);
    await p.fill('[data-field="title"]', title);
    for (const [key, value] of Object.entries(fields)) await p.fill(`#record-form input[data-field="${key}"]`, String(value));
    if (notes) await p.fill('[data-field="notes"]', notes);
    if (photos > 0) {
      await p.setInputFiles('#camera-input', PHOTOS.slice(0, photos));
      await expect(p.locator('#photo-count')).toHaveText(`Photos / ${photos}`);
    }
    if (gps) await expect(p.locator('#gps-box')).toHaveAttribute('data-gps', 'fixed');
    await p.click('#save-record');
    await p.waitForFunction(() => !document.querySelector('#record-form'));
    const id = await this.idb(async (db, t) => (await db.records.toArray()).find((r) => r.fields.title === t)?.id, title);
    expect(id, 'record saved to IndexedDB').toBeTruthy();
    return id;
  }

  async editRecord(id, fields) {
    const p = this.page;
    await this.go(`#/edit/${id}`);
    await p.waitForSelector('#record-form');
    for (const [key, value] of Object.entries(fields)) await p.fill(`#record-form [data-field="${key}"]`, String(value));
    await p.click('#save-record');
    await p.waitForFunction(() => !document.querySelector('#record-form'));
  }

  row(id) {
    return this.page.locator(`#record-list [data-record-id="${id}"]`);
  }

  async close(testInfo) {
    if (testInfo && testInfo.status !== testInfo.expectedStatus) {
      const dir = resolve(ROOT, 'artifacts/failures', testInfo.titlePath.join(' ').replace(/[^\w.-]+/g, '_').slice(0, 80));
      mkdirSync(dir, { recursive: true });
      writeFileSync(resolve(dir, `${this.name}-console.log`), this.console.join('\n'));
      writeFileSync(resolve(dir, `${this.name}-network.log`), this.network.join('\n'));
      await this.page.screenshot({ path: resolve(dir, `${this.name}.png`) }).catch(() => {});
    }
    await this.context.close();
  }
}

export async function newDevice(browser, name, { user = null, viewport = { width: 390, height: 844 }, ...options } = {}) {
  const context = await browser.newContext({
    storageState: user ? resolve(ROOT, `tests/.auth/${user}.json`) : undefined,
    permissions: ['geolocation', 'camera'],
    geolocation: GEO,
    viewport,
    serviceWorkers: 'allow',
    ...options,
  });
  const page = await context.newPage();
  return new Device(name, context, page);
}

// deviceA = Researcher A, deviceB = Researcher B, leadDevice = Data lead (laptop).
export const test = base.extend({
  deviceA: async ({ browser }, use, testInfo) => {
    const d = await newDevice(browser, 'deviceA', { user: 'researcherA' });
    await use(d);
    await d.close(testInfo);
  },
  deviceB: async ({ browser }, use, testInfo) => {
    const d = await newDevice(browser, 'deviceB', { user: 'researcherB' });
    await use(d);
    await d.close(testInfo);
  },
  leadDevice: async ({ browser }, use, testInfo) => {
    const d = await newDevice(browser, 'lead', { user: 'lead', viewport: { width: 1280, height: 800 } });
    await use(d);
    await d.close(testInfo);
  },
});

// Screenshot of a state that only exists for a moment (syncing, back online...).
export async function snap(page, name) {
  const dir = resolve(ROOT, 'artifacts/screens/states');
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: resolve(dir, `${name}.png`) });
}

export const uniq = (label) => `${label} ${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
