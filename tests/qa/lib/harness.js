// QA harness. Black box: the app is driven through its screens, IndexedDB is
// read with the raw browser API, and Postgres / Storage are read from Node.
// No module of the app is imported or called.
import { test as base, expect } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { env, readState, signIn, STATE_DIR, FIXTURES } from './admin.mjs';
import { ROOT } from '../../../scripts/env.mjs';
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');

export { expect, env, FIXTURES };
export const BASE_URL = (process.env.BASE_URL ?? 'https://fieldsync-cep2.netlify.app/').replace(/\/?$/, '/');
export const ORIGIN = new URL(BASE_URL).origin;
export const SUPABASE_URL = env.SUPABASE_URL;
export const SUPABASE_HOST = new URL(env.SUPABASE_URL).host;
export const ANON = env.SUPABASE_ANON_KEY;
export const ART = resolve(ROOT, 'artifacts/qa');
export const state = readState();
export const GEO = { latitude: 24.8607, longitude: 67.0011, accuracy: 4 };
export const photo = (n) => resolve(FIXTURES, `photo-${n}.png`);
export const uniq = (label) => `${label} ${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
export const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// ------------------------------------------------------------- Postgres
let pool = null;
export async function sql(text, params = []) {
  pool ??= new pg.Pool({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false }, max: 2 });
  return (await pool.query(text, params)).rows;
}
export const serverRecord = async (id) => (await sql('select * from public.records where id = $1', [id]))[0] ?? null;
export const serverMedia = (recordId) => sql('select * from public.media where record_id = $1 order by position', [recordId]);
export const serverObjects = (recordId) => sql("select name, metadata from storage.objects where bucket_id = 'photos' and name like $1 order by name", [`%/${recordId}/%`]);
export const serverConflicts = (recordId) => sql('select * from public.conflict_log where record_id = $1 order by at', [recordId]);

// Poll Postgres until fn(rows) is truthy.
export async function waitSql(text, params, fn, timeout = 30_000) {
  const end = Date.now() + timeout;
  let rows;
  for (;;) {
    rows = await sql(text, params);
    if (fn(rows)) return rows;
    if (Date.now() > end) throw new Error(`waitSql timed out after ${timeout} ms: ${text} -> ${JSON.stringify(rows).slice(0, 300)}`);
    await sleep(500);
  }
}

// ------------------------------------------------------------- sessions
export async function session(key) {
  const file = resolve(STATE_DIR, `${key}.session.json`);
  const saved = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  if (saved && Date.now() - saved.at < 35 * 60_000) return saved.session;
  return signIn(state, key);
}

// The public REST API as a signed-in user (anon key + user token), or with no login.
export async function api(key) {
  const s = key ? await session(key) : null;
  const headers = { apikey: ANON, Authorization: `Bearer ${s ? s.access_token : ANON}` };
  const call = async (method, url, body, extra = {}) => {
    const isRaw = body instanceof Uint8Array || typeof body === 'string';
    const res = await fetch(`${SUPABASE_URL}${url}`, {
      method, headers: { ...headers, ...(body !== undefined && !isRaw ? { 'Content-Type': 'application/json' } : {}), ...extra },
      body: body === undefined ? undefined : isRaw ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text: text.slice(0, 2000) };
  };
  return {
    user: key ? state.users[key] : null,
    rest: (method, path, body, extra) => call(method, `/rest/v1/${path}`, body, extra),
    rpc: (name, args) => call('POST', `/rest/v1/rpc/${name}`, args),
    push: (deviceId, ops) => call('POST', '/rest/v1/rpc/sync_push', { p_device_id: deviceId, p_ops: ops }),
    pull: (since = null) => call('POST', '/rest/v1/rpc/sync_pull', { p_since: since }),
    storage: (method, path, body, extra) => call(method, `/storage/v1/${path}`, body, extra),
  };
}

// --------------------------------------------------------------- device
const IDB_READ = async ({ uid, stores }) => {
  const name = `fieldsync-${uid}`;
  if (!(await indexedDB.databases()).some((d) => d.name === name)) return null;
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open(name);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  try {
    const names = stores.filter((s) => db.objectStoreNames.contains(s));
    const out = {};
    if (names.length === 0) return out;
    const tx = db.transaction(names, 'readonly');
    await Promise.all(names.map((s) => new Promise((res, rej) => {
      const r = tx.objectStore(s).getAll();
      r.onsuccess = () => { out[s] = r.result; res(); };
      r.onerror = () => rej(r.error);
    })));
    for (const m of out.media ?? []) {
      if (m.blob) {
        const info = { size: m.blob.size, type: m.blob.type };
        try { const b = await createImageBitmap(m.blob); info.width = b.width; info.height = b.height; b.close(); } catch { info.decodeFailed = true; }
        m.blob = info;
      }
    }
    return out;
  } finally { db.close(); }
};

export class Device {
  constructor(qa, name, context, page, userKey) {
    Object.assign(this, { qa, name, context, page, userKey, console: [], network: [], foreign: [], requests: [] });
    this.watch(page);
  }

  get uid() { return this.userKey ? state.users[this.userKey].id : null; }

  watch(page) {
    page.on('console', (m) => this.console.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => this.console.push(`[pageerror] ${e.message}`));
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (!['http:', 'https:'].includes(u.protocol)) return;
      this.requests.push({ t: Date.now(), method: r.method(), url: r.url(), body: r.postData()?.slice(0, 4000) ?? null });
      this.network.push(`${new Date().toISOString()} > ${r.method()} ${u.origin}${u.pathname}`);
      if (u.origin !== ORIGIN && u.host !== SUPABASE_HOST) this.foreign.push(r.url());
    });
    page.on('requestfailed', (r) => this.network.push(`${new Date().toISOString()} x ${r.method()} ${r.url().split('?')[0]} ${r.failure()?.errorText}`));
    page.on('response', (r) => { this.network.push(`${new Date().toISOString()} < ${r.status()} ${r.request().method()} ${r.url().split('?')[0]}`); });
  }

  rpcRequests(name) { return this.requests.filter((r) => r.url.includes(`/rpc/${name}`)); }

  async open(hash = '', { sync = true, sw = true } = {}) {
    // The test machine's own link to the host drops a request now and then. When a
    // module or the worker's precache fails to load, the app stays blank / without a
    // worker (see finding E09). One reload is allowed here and is written to the evidence.
    await this.page.goto(BASE_URL + hash).catch(async (err) => {
      this.qa.blip('goto failed: ' + String(err.message).split(String.fromCharCode(10))[0]);
      await this.page.goto(BASE_URL + hash);
    });
    for (let attempt = 1; ; attempt++) {
      try {
        await this.page.waitForFunction(() => document.documentElement.dataset.ready === '1', null, { timeout: 25_000 });
        if (sw) await this.page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 25_000 });
        break;
      } catch (err) {
        if (attempt >= 3) throw err;
        this.qa.blip(`${this.name}: app not ready / no service worker after 25 s (attempt ${attempt}), reloading`);
        await this.page.reload().catch(() => {});
      }
    }
    if (sync) await this.waitSynced();
  }

  // Idle, nothing waiting, and at least one pull has completed.
  async waitSynced(timeout = 45_000) {
    await expect(async () => {
      const d = await this.idb(['outbox', 'meta']);
      expect(d?.outbox?.length, 'outbox empty').toBe(0);
      expect(d.meta.find((m) => m.key === 'lastPulledAt')?.value, 'first pull done').toBeTruthy();
    }).toPass({ timeout });
    await expect(this.page.locator('#sb-text')).toHaveText(/^Online \/ (all synced|data lead)$/, { timeout });
  }

  // Press "Sync now" (or Refresh in the console) and wait for a pull that started after the press.
  async syncNow() {
    const lead = (await this.page.locator('#refresh').count()) > 0;
    if (!lead && (await this.page.locator('#sync-now').count()) === 0) await this.go('#/sync');
    const button = this.page.locator(lead ? '#refresh' : '#sync-now');
    await expect(button).toBeEnabled({ timeout: 30_000 });
    const t0 = Date.now();
    const done = this.page.waitForResponse((r) => r.url().includes('/rpc/sync_pull') && r.status() === 200
      && this.requests.some((q) => q.url === r.url() && q.t >= t0), { timeout: 45_000 });
    await button.click();
    const body = await (await done).json();
    const want = new Date(new Date(body.server_time).getTime() - 5000).toISOString();
    await expect(async () => {
      expect((await this.meta('lastPulledAt')) >= want).toBe(true);
    }).toPass({ timeout: 15_000 });
    await this.page.waitForTimeout(150);
  }

  async go(hash) {
    await this.page.evaluate((h) => {
      if (location.hash === h) window.dispatchEvent(new HashChangeEvent('hashchange')); else location.hash = h;
    }, hash);
    const route = hash.replace(/^#\/?/, '').split('/')[0];
    await this.page.waitForFunction((r) => document.body.dataset.route === r, route, { timeout: 15_000 }).catch(() => {});
    await this.page.waitForTimeout(120);
  }

  async offline() {
    await this.context.setOffline(true);
    await expect(this.page.locator('#statusbar')).toHaveAttribute('data-online', '0');
  }

  async online() {
    await this.context.setOffline(false);
    await expect(this.page.locator('#statusbar')).toHaveAttribute('data-online', '1');
  }

  idb(stores = ['records', 'media', 'gpsLogs', 'outbox', 'meta'], uid = this.uid) {
    return this.page.evaluate(IDB_READ, { uid, stores });
  }

  async localRecord(id) { return (await this.idb(['records']))?.records.find((r) => r.id === id) ?? null; }
  async outbox() { return ((await this.idb(['outbox']))?.outbox ?? []).sort((a, b) => a.seq - b.seq); }
  async meta(key) { return (await this.idb(['meta']))?.meta.find((m) => m.key === key)?.value ?? null; }
  async localMedia(recordId) { return ((await this.idb(['media']))?.media ?? []).filter((m) => m.recordId === recordId).sort((a, b) => a.position - b.position); }
  async localGps(recordId) { return ((await this.idb(['gpsLogs']))?.gpsLogs ?? []).filter((g) => g.recordId === recordId); }

  // Fill in and save the "New record" form like a researcher would.
  async createRecord({ title, type = 'soil', fields = {}, notes = '', photos = [], gps = true, region = null } = {}) {
    const p = this.page;
    if (region) await this.pickRegion(region);
    await this.go('#/new');
    await p.waitForSelector('#record-form');
    if (type !== 'soil') await p.click(`[data-type="${type}"]`);
    if (title !== undefined) await p.fill('[data-field="title"]', title);
    for (const [key, value] of Object.entries(fields)) await p.fill(`#record-form input[data-field="${key}"]`, String(value));
    if (notes) await p.fill('[data-field="notes"]', notes);
    if (photos.length > 0) {
      await p.setInputFiles('#library-input', photos);
      await expect(p.locator('#photo-count')).toHaveText(`Photos / ${photos.length}`, { timeout: 60_000 });
    }
    if (gps) await expect(p.locator('#gps-box')).toHaveAttribute('data-gps', 'fixed', { timeout: 20_000 });
    const before = new Set(((await this.idb(['records']))?.records ?? []).map((r) => r.id));
    await p.click('#save-record');
    await p.waitForFunction(() => !document.querySelector('#record-form'), null, { timeout: 15_000 });
    const after = (await this.idb(['records'])).records.filter((r) => !before.has(r.id));
    expect(after, 'exactly one new record in IndexedDB').toHaveLength(1);
    return after[0].id;
  }

  async editRecord(id, fields) {
    const p = this.page;
    await this.go(`#/edit/${id}`);
    await p.waitForSelector('#record-form');
    for (const [key, value] of Object.entries(fields)) await p.fill(`#record-form [data-field="${key}"]`, String(value));
    await p.click('#save-record');
    await p.waitForFunction(() => !document.querySelector('#record-form'), null, { timeout: 15_000 });
  }

  async deleteRecord(id) {
    await this.go(`#/record/${id}`);
    await this.page.click('#delete-record');
    await this.page.click('#confirm-delete');
    await this.page.waitForFunction(() => document.body.dataset.route === 'records');
  }

  async pickRegion(key) {
    await this.go('#/regions');
    await this.page.click(`[data-region="${state.regions[key]}"]`);
    await this.page.waitForFunction(() => document.body.dataset.route === 'records');
  }

  row(id) { return this.page.locator(`#record-list [data-record-id="${id}"]`); }

  async shot(name, opts = {}) {
    const file = resolve(this.qa.dir, `${name}.png`);
    await this.page.screenshot({ path: file, ...opts }).catch(() => {});
    return file;
  }
}

class QA {
  constructor(browser, testInfo) {
    this.browser = browser;
    this.testInfo = testInfo;
    this.id = /^([A-L]\d\d)/.exec(testInfo.title)?.[1] ?? 'misc';
    this.dir = resolve(ART, this.id);
    if (testInfo.retry === 0) rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
    this.devices = [];
    this.evidence = { case: this.id, title: testInfo.title, target: BASE_URL, notes: {}, findings: [] };
  }

  // A new isolated browser context = one device.
  async device(name, { user = null, viewport = { width: 390, height: 844 }, geo = GEO, permissions = ['geolocation'], clockOffsetMs = 0, init = [], hud = false, ...options } = {}) {
    const s = user ? await session(user) : null;
    const context = await this.browser.newContext({
      storageState: s ? { cookies: [], origins: [{ origin: ORIGIN, localStorage: [{ name: 'fieldsync-auth', value: JSON.stringify(s) }] }] } : undefined,
      permissions, geolocation: geo ?? undefined, viewport, serviceWorkers: 'allow', ...options,
    });
    // The live site is on Netlify's free plan, which injects a "Powered by Netlify"
    // badge over the bottom-right corner (bug K09). It is switched off here (the
    // badge script skips itself when its frame id already exists) so that every
    // other case tests the app itself. K09 runs with hud: true.
    if (!hud) {
      await context.addInitScript(() => {
        const add = () => {
          if (!document.documentElement) return false;
          if (document.getElementById('nl-badge-frame')) return true;
          const d = document.createElement('div');
          d.id = 'nl-badge-frame';
          d.hidden = true;
          d.dataset.qa = 'netlify-badge-suppressed';
          document.documentElement.appendChild(d);
          return true;
        };
        if (!add()) new MutationObserver((_, o) => { if (add()) o.disconnect(); }).observe(document, { childList: true });
      });
    }
    if (clockOffsetMs) {
      await context.addInitScript((offset) => {
        const Real = Date;
        class Skewed extends Real {
          constructor(...a) { if (a.length === 0) super(Real.now() + offset); else super(...a); }
          static now() { return Real.now() + offset; }
        }
        window.Date = Skewed;
      }, clockOffsetMs);
    }
    for (const script of init) await context.addInitScript(script);
    await context.tracing.start({ screenshots: true, snapshots: true });
    const page = await context.newPage();
    const d = new Device(this, name, context, page, user);
    this.devices.push(d);
    return d;
  }

  note(key, value) { this.evidence.notes[key] = value; }
  blip(text) { (this.evidence.networkBlips ??= []).push(`${new Date().toISOString()} ${text}`); }
  finding(text) { this.evidence.findings.push(text); }

  // Could not be automated: marks the case BLOCKED with the manual steps.
  blocked(reason, manualSteps) {
    this.evidence.blocked = { reason, manualSteps };
    this.testInfo.annotations.push({ type: 'blocked', description: `${reason} | Manual: ${manualSteps}` });
    base.skip(true, reason);
  }

  async teardown() {
    const failed = this.testInfo.status !== this.testInfo.expectedStatus && this.testInfo.status !== 'skipped';
    const attempt = resolve(this.dir, `attempt-${this.testInfo.retry + 1}`);
    if (failed) mkdirSync(attempt, { recursive: true });
    for (const d of this.devices) {
      if (!d.page.isClosed()) await d.page.screenshot({ path: resolve(this.dir, `${d.name}-final.png`) }).catch(() => {});
      if (failed) {
        writeFileSync(resolve(attempt, `${d.name}-console.log`), d.console.join('\n'));
        writeFileSync(resolve(attempt, `${d.name}-network.log`), d.network.join('\n'));
        if (!d.page.isClosed()) await d.page.screenshot({ path: resolve(attempt, `${d.name}.png`) }).catch(() => {});
        await d.context.tracing.stop({ path: resolve(attempt, `${d.name}-trace.zip`) }).catch(() => {});
      } else {
        await d.context.tracing.stop().catch(() => {});
      }
      await d.context.close().catch(() => {});
    }
    this.evidence.result = this.testInfo.status;
    this.evidence.retry = this.testInfo.retry;
    if (failed) this.evidence.error = (this.testInfo.error?.message ?? '').replace(ANSI, '').slice(0, 3000);
    writeFileSync(resolve(failed ? attempt : this.dir, 'evidence.json'), JSON.stringify(this.evidence, null, 2));
  }
}

export const test = base.extend({
  qa: async ({ browser }, use, testInfo) => {
    const qa = new QA(browser, testInfo);
    await use(qa);
    await qa.teardown();
  },
});

// ------------------------------------------------------------- network
// Chrome DevTools throttling, roughly "Slow 3G".
export async function slow3g(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 400, downloadThroughput: (400 * 1024) / 8, uploadThroughput: (400 * 1024) / 8 });
  return () => cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
}

export const PUSH = '**/rest/v1/rpc/sync_push*';
export const PULL = '**/rest/v1/rpc/sync_pull*';
export const UPLOAD = '**/storage/v1/object/photos/**';
