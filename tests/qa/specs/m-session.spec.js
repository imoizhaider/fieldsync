// M. Session lifetime while ONLINE (A06 only covered expiry while offline).
// Bug report: the app signs the user out by itself during normal use.
//
// Each case uses its own throwaway QA user (qa-a+<13 digits>@example.org, in its
// own region QA-<ts>-M), so cases that end a session never touch the sessions other
// specs reuse. A token "expires" by moving `expires_at` of the stored session
// into the past: the app then has to refresh it with the real auth server, in
// seconds instead of an hour.
//
// Evidence: artifacts/qa/Mxx/ as usual, plus every /auth/v1/ request, every 401
// or 403 and the console in artifacts/fix/signout/<SIGNOUT_PHASE>/Mxx.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { test, expect, state, env, sql, serverRecord, serverMedia, serverObjects, waitSql, uniq, photo, sleep, PUSH } from '../lib/harness.js';
import { ensureAccount } from '../../../scripts/lib/accounts.mjs';
import { ROOT } from '../../../scripts/env.mjs';

const OUT = resolve(ROOT, 'artifacts/fix/signout', process.env.SIGNOUT_PHASE ?? 'run');
const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const anonClient = () => createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

// ---------------------------------------------------------------- helpers

// The M users get their own region (QA-<ts>-M), so other cases that count the
// members of the main region (L01) or the regions of a user (I01) see no change.
let mRegion = null;
async function sessionRegion() {
  mRegion ??= (await sql(
    'insert into public.regions (name) values ($1) on conflict (name) do update set name = excluded.name returning id', [`QA-${state.ts}-M`]))[0].id;
  return mRegion;
}

async function freshUser(tag, { password = state.password, role = 'editor' } = {}) {
  await sleep(3); // unique 13-digit timestamp in the email
  const email = `qa-a+${Date.now()}@example.org`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`create ${email}: ${error.message}`);
  const key = `${tag}-${Date.now()}`;
  state.users[key] = { id: data.user.id, email, name: `QA ${tag}` };
  await sql('insert into public.profiles (user_id, display_name) values ($1, $2)', [data.user.id, `QA ${tag}`]);
  await sql('insert into public.region_members (region_id, user_id, role) values ($1, $2, $3)', [await sessionRegion(), data.user.id, role]);
  return key;
}

const liveSessions = async (uid) => Number((await sql('select count(*) from auth.sessions where user_id = $1', [uid]))[0].count);

// Remembers every route and status bar text the app shows, across reloads.
function history() {
  const keep = (k, v) => {
    if (!v) return;
    const s = JSON.parse(sessionStorage.getItem(k) || '[]');
    if (s[s.length - 1] !== v) { s.push(v); sessionStorage.setItem(k, JSON.stringify(s)); }
  };
  setInterval(() => {
    try {
      keep('qa.routes', document.body?.dataset.route);
      keep('qa.bar', document.getElementById('sb-text')?.textContent?.trim());
    } catch { /* page closing */ }
  }, 100);
}
const seen = (page) => page.evaluate(() => ({ routes: JSON.parse(sessionStorage.getItem('qa.routes') || '[]'), bar: JSON.parse(sessionStorage.getItem('qa.bar') || '[]') }));

// Auth traffic, 401 and 403 answers, per device and tab.
const tracked = [];
function track(d, page = d.page, label = d.name) {
  const log = { label, auth: [], denied: [], failed: [] };
  const isAuth = (u) => u.includes('/auth/v1/');
  const short = (u) => { const x = new URL(u); return `${x.pathname}${x.searchParams.get('grant_type') ? `?grant_type=${x.searchParams.get('grant_type')}` : ''}`; };
  page.on('request', (r) => { if (isAuth(r.url())) log.auth.push({ t: new Date().toISOString(), dir: '>', method: r.method(), url: short(r.url()) }); });
  page.on('response', async (r) => {
    const u = r.url();
    if (isAuth(u)) {
      let body = null;
      if (r.status() >= 400) body = await r.text().then((s) => s.slice(0, 300)).catch(() => null);
      log.auth.push({ t: new Date().toISOString(), dir: '<', status: r.status(), url: short(u), body });
    }
    if ([401, 403].includes(r.status())) log.denied.push({ t: new Date().toISOString(), status: r.status(), url: short(u) });
  });
  page.on('requestfailed', (r) => { if (isAuth(r.url())) log.failed.push({ t: new Date().toISOString(), url: short(r.url()), error: r.failure()?.errorText }); });
  tracked.push({ d, log });
  return log;
}
const refreshes = (log) => log.auth.filter((x) => x.dir === '<' && x.url.endsWith('grant_type=refresh_token'));

test.afterEach(async ({ qa }, testInfo) => {
  mkdirSync(OUT, { recursive: true });
  const out = {
    case: qa.id, title: testInfo.title, result: testInfo.status, at: new Date().toISOString(),
    devices: tracked.map(({ d, log }) => ({ ...log, console: d.console.slice(-200) })),
    error: testInfo.error?.message?.slice(0, 2000) ?? null,
  };
  writeFileSync(resolve(OUT, `${qa.id}.json`), JSON.stringify(out, null, 2));
  tracked.length = 0;
});

// Make the device's access token run out, as if an hour had passed.
const expireToken = (page, seconds = -60) => page.evaluate((s) => {
  const v = JSON.parse(localStorage.getItem('fieldsync-auth'));
  v.expires_at = Math.floor(Date.now() / 1000) + s;
  localStorage.setItem('fieldsync-auth', JSON.stringify(v));
}, seconds);

const localSession = (page) => page.evaluate(() => {
  const a = JSON.parse(localStorage.getItem('fieldsync-auth') || 'null');
  const u = JSON.parse(localStorage.getItem('fieldsync.user') || 'null');
  return { authUser: a?.user?.id ?? null, expiresIn: a ? a.expires_at - Math.floor(Date.now() / 1000) : null, appUser: u?.id ?? null };
});

const isRefresh = (url) => url.pathname.endsWith('/auth/v1/token') && url.searchParams.get('grant_type') === 'refresh_token';

async function device(qa, key, name = 'deviceA', opts = {}) {
  const d = await qa.device(name, { user: key, init: [history], ...opts });
  track(d);
  return d;
}

async function signInAgain(d) {
  await d.go('#/sync');
  const button = d.page.locator('#sign-in-again');
  await expect(button, 'the Sync screen offers "Sign in again"').toBeVisible({ timeout: 10_000 });
  await button.click();
  await d.page.waitForFunction(() => document.body.dataset.route === 'signin', null, { timeout: 10_000 });
  await expect(d.page.locator('input[name="email"]'), 'email is filled in').toHaveValue(state.users[d.userKey].email);
  await d.page.fill('input[name="password"]', state.password);
  await d.page.click('button[type="submit"]');
  await d.page.waitForFunction(() => document.body.dataset.route === 'records', null, { timeout: 30_000 });
}

// ------------------------------------------------------------------ cases

test('M01 [P0] online: the token expires and is refreshed, the user stays signed in and sync keeps working', async ({ qa }) => {
  const key = await freshUser('M01');
  const d = await device(qa, key);
  const log = tracked.at(-1).log;
  await d.open();
  for (let round = 1; round <= 2; round++) {
    await expireToken(d.page);
    const id = await d.createRecord({ title: uniq(`M01 round ${round}`), fields: { ph: 6.2 } });
    await waitSql('select id from public.records where id = $1', [id], (r) => r.length === 1);
    await d.waitSynced();
  }
  const s = await localSession(d.page);
  const h = await seen(d.page);
  qa.note('refreshes', refreshes(log));
  qa.note('session', s);
  qa.note('seen', h);
  expect(refreshes(log).length, 'the app refreshed its token').toBeGreaterThanOrEqual(2);
  expect(refreshes(log).every((r) => r.status === 200), 'every refresh answered 200').toBe(true);
  expect(s.authUser).toBe(state.users[key].id);
  expect(s.expiresIn, 'a fresh access token is stored').toBeGreaterThan(600);
  expect(h.routes, 'never on the sign-in screen').not.toContain('signin');
  expect(h.bar.filter((t) => /sign-in/i.test(t)), 'status bar never asked for a sign-in').toEqual([]);
});

test('M02 [P0] one account in two tabs and on a second device, past a refresh: all stay signed in', async ({ qa }) => {
  const key = await freshUser('M02');
  const laptop = await device(qa, key, 'laptop', { viewport: { width: 1280, height: 800 } });
  const tab2 = await laptop.context.newPage();
  laptop.watch(tab2);
  const tab2log = track(laptop, tab2, 'laptop-tab2');
  // The phone signs in by itself, through the screen: its own session.
  const phone = await device(qa, null, 'phone');
  phone.userKey = key;
  await phone.open('', { sync: false });
  await phone.page.fill('input[name="email"]', state.users[key].email);
  await phone.page.fill('input[name="password"]', state.password);
  await phone.page.click('button[type="submit"]');
  await phone.page.waitForFunction(() => document.body.dataset.route === 'records', null, { timeout: 30_000 });
  await laptop.open();
  await tab2.goto(laptop.page.url());
  await tab2.waitForFunction(() => document.documentElement.dataset.ready === '1');
  await phone.waitSynced();
  // The phone started on the sign-in screen on purpose; count from here.
  await phone.page.evaluate(() => { sessionStorage.removeItem('qa.routes'); sessionStorage.removeItem('qa.bar'); });
  expect(await liveSessions(state.users[key].id), 'two sessions: laptop and phone').toBeGreaterThanOrEqual(2);

  // All three run out at the same moment and sync at once.
  await Promise.all([expireToken(laptop.page), expireToken(phone.page)]);
  await Promise.all([
    laptop.page.evaluate(() => { location.hash = '#/sync'; }),
    tab2.evaluate(() => { location.hash = '#/sync'; }),
    phone.page.evaluate(() => { location.hash = '#/sync'; }),
  ]);
  await Promise.all([laptop.page, tab2, phone.page].map((p) => p.locator('#sync-now').click()));
  const a = await laptop.createRecord({ title: uniq('M02 laptop'), fields: { ph: 6.3 } });
  // Same account: the laptop's record reaches the phone too. Let it arrive first,
  // so the phone's own new record is the only new row when it saves.
  await waitSql('select id from public.records where id = $1', [a], (r) => r.length === 1);
  await phone.syncNow();
  await expect.poll(async () => Boolean(await phone.localRecord(a)), { timeout: 30_000 }).toBe(true);
  const b = await phone.createRecord({ title: uniq('M02 phone'), fields: { ph: 6.4 } });
  await waitSql('select id from public.records where id = any($1)', [[a, b]], (r) => r.length === 2);
  await laptop.waitSynced();
  await phone.waitSynced();
  // tab 2 shares the laptop's session; it must still be signed in too.
  await tab2.evaluate(() => { location.hash = '#/records'; });
  await expect(tab2.locator(`#record-list [data-record-id="${a}"]`)).toBeVisible({ timeout: 30_000 });

  const all = tracked.flatMap(({ log }) => refreshes(log));
  qa.note('refreshes', tracked.map(({ log }) => ({ label: log.label, refreshes: refreshes(log) })));
  for (const p of [laptop.page, tab2, phone.page]) {
    const s = await localSession(p);
    const h = await seen(p);
    expect(s.appUser, 'still signed in').toBe(state.users[key].id);
    expect(s.authUser, 'still has a session').toBe(state.users[key].id);
    expect(h.routes).not.toContain('signin');
    expect(h.bar.filter((t) => /sign-in/i.test(t))).toEqual([]);
  }
  expect(all.length).toBeGreaterThanOrEqual(2);
  expect(all.filter((r) => r.status !== 200), 'no refresh was refused').toEqual([]);
  expect(tab2log).toBeTruthy();
});

test('M03 [P0] the refresh endpoint answers 400 invalid_grant: no sign-out, app usable, clear message, pending data intact', async ({ qa }) => {
  const key = await freshUser('M03');
  const d = await device(qa, key);
  await d.open();
  await d.offline();
  const title = uniq('M03 pending');
  const id = await d.createRecord({ title, fields: { ph: 6.5 }, photos: [photo(1)] });
  const pending = (await d.outbox()).length;
  // Exactly what the live server answers for a refresh token it no longer knows.
  await d.context.route(isRefresh, (r) => r.fulfill({
    status: 400, contentType: 'application/json',
    body: JSON.stringify({ code: 400, error_code: 'refresh_token_not_found', error: 'invalid_grant', msg: 'Invalid Refresh Token: Refresh Token Not Found' }),
  }));
  await expireToken(d.page);
  await d.online();
  await expect(d.page.locator('#sb-text'), 'status bar says a sign-in is needed').toHaveText(/sign-in needed/i, { timeout: 40_000 });
  await d.shot('bar-sign-in-needed');
  // Still in the app, everything on the device, nothing rejected.
  const s = await localSession(d.page);
  expect(s.appUser, 'the app keeps the signed-in user').toBe(state.users[key].id);
  expect(await d.page.evaluate(() => document.body.dataset.route)).toBe('records');
  await d.go(`#/record/${id}`);
  await expect(d.page.locator('#record-title')).toHaveText(title);
  const second = await d.createRecord({ title: uniq('M03 written after'), fields: { ph: 6.6 } });
  const ob = await d.outbox();
  expect(ob.length, 'outbox kept and growing').toBeGreaterThan(pending);
  expect(ob.filter((e) => e.status === 'rejected'), 'nothing marked rejected').toEqual([]);
  expect(await serverRecord(id)).toBeNull();
  const h = await seen(d.page);
  expect(h.routes, 'the app did not send the user to the sign-in screen').not.toContain('signin');
  await d.go('#/sync');
  await d.shot('sync-screen');
  await expect(d.page.locator('.notice h2')).toHaveText('Sign-in needed');
  // The way back: a button, then everything uploads.
  await d.context.unroute(isRefresh);
  await signInAgain(d);
  await waitSql('select id from public.records where id = any($1)', [[id, second]], (r) => r.length === 2, 60_000);
  await waitSql('select id from public.media where record_id = $1', [id], (r) => r.length === 1, 60_000);
  await d.waitSynced(60_000);
});

test('M04 [P0] an RPC answers 401 and 403: no sign-out, outbox untouched, Sync rejected still shown for a real rejection', async ({ qa }) => {
  const key = await freshUser('M04');
  const uid = state.users[key].id;
  const d = await device(qa, key);
  await d.open();
  await d.offline();
  const id = await d.createRecord({ title: uniq('M04 pending'), fields: { ph: 6.7 } });
  const before = (await d.outbox()).map((e) => ({ seq: e.seq, opId: e.opId, status: e.status ?? null }));
  let n = 0;
  await d.context.route(PUSH, async (r) => {
    n += 1;
    if (n === 1) return r.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ code: 'PGRST301', message: 'JWT expired' }) });
    if (n === 2) return r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ code: '42501', message: 'permission denied for function sync_push' }) });
    return r.continue();
  });
  await d.online();
  await expect.poll(() => n, { timeout: 30_000, message: 'two refused pushes' }).toBeGreaterThanOrEqual(2);
  const during = (await d.outbox()).map((e) => ({ seq: e.seq, opId: e.opId, status: e.status ?? null }));
  qa.note('outbox before / after the 401 and 403', { before, during });
  expect(during, 'outbox untouched by the 401 and 403').toEqual(before);
  await waitSql('select id from public.records where id = $1', [id], (r) => r.length === 1, 60_000);
  await d.waitSynced();
  let h = await seen(d.page);
  expect(h.routes).not.toContain('signin');
  expect(h.bar.filter((t) => /sign-in/i.test(t)), 'a 401 or 403 is not a sign-in problem').toEqual([]);
  expect((await localSession(d.page)).authUser).toBe(uid);

  // A real rejection by the server: the region became view-only for this user.
  await d.offline();
  const rid = await d.createRecord({ title: uniq('M04 view only now'), fields: { ph: 6.8 } });
  await sql('update public.region_members set role = $1 where user_id = $2 and region_id = $3', ['viewer', uid, await sessionRegion()]);
  await d.online();
  await expect(d.page.locator('#sb-text')).toHaveText(/sync problem/i, { timeout: 40_000 });
  await d.go('#/sync');
  await expect(d.page.locator('#reject-reason')).toBeVisible();
  expect((await d.outbox()).find((e) => e.rowId === rid)?.status).toBe('rejected');
  h = await seen(d.page);
  expect(h.routes).not.toContain('signin');
  expect((await localSession(d.page)).appUser).toBe(uid);
});

test('M05 [P1] freeing space and clearing caches leave the user signed in', async ({ qa }) => {
  const key = await freshUser('M05');
  const d = await device(qa, key);
  await d.open();
  const id = await d.createRecord({ title: uniq('M05 photo'), fields: { ph: 6.9 }, photos: [photo(2)] });
  await waitSql('select id from public.media where record_id = $1', [id], (r) => r.length === 1, 60_000);
  await d.waitSynced();
  const before = await localSession(d.page);
  await d.go('#/storage');
  await d.page.click('#free-space');
  await expect.poll(async () => (await d.localMedia(id))[0]?.blob ?? null, { message: 'photo freed on the device' }).toBeNull();
  const afterFree = await localSession(d.page);
  await d.page.evaluate(async () => { for (const k of await caches.keys()) await caches.delete(k); });
  await d.page.reload();
  await d.page.waitForFunction(() => document.documentElement.dataset.ready === '1');
  await d.syncNow();
  const afterCaches = await localSession(d.page);
  qa.note('session', { before, afterFree, afterCaches });
  for (const s of [afterFree, afterCaches]) {
    expect(s.appUser).toBe(state.users[key].id);
    expect(s.authUser).toBe(state.users[key].id);
  }
  expect((await seen(d.page)).routes).not.toContain('signin');
});

test('M06 [P0] the app is closed and opened again after a long idle gap: still signed in', async ({ qa }) => {
  const key = await freshUser('M06');
  const d = await device(qa, key);
  await d.open();
  // A week later: the stored access token is long dead.
  await expireToken(d.page, -7 * 24 * 3600);
  await d.page.close();
  d.page = await d.context.newPage();
  d.watch(d.page);
  const log = track(d, d.page, 'reopened');
  await d.open();
  const id = await d.createRecord({ title: uniq('M06 after the gap'), fields: { ph: 7.0 } });
  await waitSql('select id from public.records where id = $1', [id], (r) => r.length === 1);
  await d.waitSynced();
  qa.note('refreshes', refreshes(log));
  expect(refreshes(log).some((r) => r.status === 200), 'refreshed on open').toBe(true);
  expect((await seen(d.page)).routes).not.toContain('signin');
  expect((await localSession(d.page)).expiresIn).toBeGreaterThan(600);
});

test('M07 [P0] signing in again after a dead refresh token uploads every pending record and photo', async ({ qa }) => {
  const key = await freshUser('M07');
  const uid = state.users[key].id;
  const d = await device(qa, key);
  await d.open();
  await d.offline();
  const title = uniq('M07 pending');
  const id = await d.createRecord({ title, fields: { ph: 7.1 }, photos: [photo(3), photo(4)] });
  // The real thing: the server ends every session of this account, the way an
  // admin password reset does (scripts/seed.mjs before the fix).
  const { error } = await admin.auth.admin.updateUserById(uid, { password: state.password });
  expect(error).toBeNull();
  expect(await liveSessions(uid), 'server ended the sessions').toBe(0);
  await expireToken(d.page);
  await d.online();
  await expect(d.page.locator('#sb-text')).toHaveText(/sign-in needed/i, { timeout: 40_000 });
  const log = tracked[0].log;
  qa.note('refresh answers', refreshes(log));
  expect(refreshes(log).some((r) => r.status === 400), 'the server refused the refresh').toBe(true);
  expect((await d.outbox()).filter((e) => e.recordId === id || e.rowId === id).length, 'pending kept').toBeGreaterThanOrEqual(3);
  expect((await seen(d.page)).routes).not.toContain('signin');
  await signInAgain(d);
  const rows = await waitSql('select fields, created_by from public.records where id = $1', [id], (r) => r.length === 1, 60_000);
  expect(rows[0].fields.title).toBe(title);
  expect(rows[0].created_by).toBe(uid);
  await expect.poll(async () => (await serverMedia(id)).length, { timeout: 90_000 }).toBe(2);
  await expect.poll(async () => (await serverObjects(id)).length, { timeout: 30_000 }).toBe(2);
  await d.waitSynced(60_000);
  expect(await d.outbox()).toEqual([]);
});

test('M08 [P0] offline across a token expiry, then back online: no sign-out, sync resumes by itself', async ({ qa }) => {
  const key = await freshUser('M08');
  const d = await device(qa, key);
  const log = tracked.at(-1).log;
  await d.open();
  await d.offline();
  const id = await d.createRecord({ title: uniq('M08 offline'), fields: { ph: 7.2 } });
  await expireToken(d.page, -120);
  // Stay offline past the library's 30 s refresh tick, so it tries (and fails) with no network.
  await sleep(35_000);
  expect((await localSession(d.page)).authUser, 'session kept while offline').toBe(state.users[key].id);
  await d.online();
  await waitSql('select id from public.records where id = $1', [id], (r) => r.length === 1, 45_000);
  await d.waitSynced();
  const h = await seen(d.page);
  qa.note('seen', h);
  qa.note('auth', log);
  expect(h.routes).not.toContain('signin');
  expect(h.bar.filter((t) => /sign-in/i.test(t))).toEqual([]);
});

test('M09 [P0] resetting the demo accounts (npm run seed) keeps the sessions of signed-in devices', async ({ qa }) => {
  const key = await freshUser('M09');
  const uid = state.users[key].id;
  const d = await device(qa, key);
  await d.open();
  const before = await liveSessions(uid);
  // The seed's account step, run for this account with the password it already has.
  const res = await ensureAccount({ admin, anon: anonClient(), existing: { id: uid, email: state.users[key].email }, email: state.users[key].email, password: state.password });
  const after = await liveSessions(uid);
  qa.note('seed step', { action: res.action, sessionsBefore: before, sessionsAfter: after });
  expect(after, 'the seed step ended no session').toBeGreaterThanOrEqual(before);
  await expireToken(d.page);
  const id = await d.createRecord({ title: uniq('M09 after seed'), fields: { ph: 7.3 } });
  await waitSql('select id from public.records where id = $1', [id], (r) => r.length === 1);
  await d.waitSynced();
  expect((await seen(d.page)).bar.filter((t) => /sign-in/i.test(t))).toEqual([]);
  // A password that no longer works is still set by the seed.
  const other = await freshUser('M09b', { password: `Old-${Date.now()}-x` });
  const set = await ensureAccount({ admin, anon: anonClient(), existing: { id: state.users[other].id, email: state.users[other].email }, email: state.users[other].email, password: state.password });
  const { data } = await anonClient().auth.signInWithPassword({ email: state.users[other].email, password: state.password });
  expect(set.action).toBe('password set');
  expect(data?.session, 'new password works').toBeTruthy();
});

test('M10 [P1] a token endpoint that fails (503) is a sync failure, not a sign-in', async ({ qa }) => {
  const key = await freshUser('M10');
  const d = await device(qa, key);
  const log = tracked.at(-1).log;
  await d.open();
  let n = 0;
  await d.context.route(isRefresh, (r) => { n += 1; return r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'upstream unavailable' }) }); });
  await expireToken(d.page);
  await d.offline();
  const id = await d.createRecord({ title: uniq('M10 pending'), fields: { ph: 7.4 } });
  await d.online();
  await expect.poll(() => n, { timeout: 30_000, message: 'refresh attempted' }).toBeGreaterThan(0);
  // auth-js itself retries a 5xx for up to 30 s; the outage lasts longer than that.
  await sleep(45_000);
  await d.shot('after-503');
  const mid = await seen(d.page);
  qa.note('seen during the outage', mid);
  expect(mid.bar.filter((t) => /sign-in/i.test(t)), 'an outage is not reported as a sign-in problem').toEqual([]);
  await d.context.unroute(isRefresh);
  // auth-js waits 60 s before it retries the same refresh token after a failure.
  await waitSql('select id from public.records where id = $1', [id], (r) => r.length === 1, 120_000);
  await d.waitSynced();
  expect(refreshes(log).some((r) => r.status === 200), 'refreshed once the server was back').toBe(true);
  expect((await seen(d.page)).routes).not.toContain('signin');
});

// ------------------------------------------- round 2: offline and back again
// Bug M-1 (round 2): after the network went off and came back the app asked for
// the password. M11 to M16 are the brief's M10 to M15 (M10 was already taken);
// M17 covers the answers that made supabase-js throw the session away.

// Wait until the device tried to refresh while offline and gave up. supabase-js
// retries a refresh for about 25 s, then keeps the failure for 60 s and answers
// every caller with it: a reconnect inside that window is the hard case.
async function failedRefreshWhileOffline(log, since = Date.now()) {
  const fails = () => log.failed.filter((f) => f.url.endsWith('grant_type=refresh_token') && Date.parse(f.t) >= since).map((f) => Date.parse(f.t));
  await expect.poll(() => fails().length, { timeout: 70_000, message: 'a refresh was tried and failed while offline' }).toBeGreaterThan(0);
  await expect.poll(() => { const f = fails(); return f.at(-1) - f[0] >= 20_000 && Date.now() - f.at(-1) >= 4_000; },
    { timeout: 60_000, message: 'the library stopped retrying (its failure is now cached)' }).toBe(true);
}
const signInShown = async (page) => (await seen(page)).bar.filter((t) => /sign-in/i.test(t));

test('M11 [P0] offline for longer than the access-token lifetime, then online: syncs by itself, no sign-in asked', async ({ qa }) => {
  const key = await freshUser('M11');
  const d = await device(qa, key);
  const log = tracked.at(-1).log;
  await d.open();
  await d.offline();
  const id = await d.createRecord({ title: uniq('M11 offline'), fields: { ph: 7.1 } });
  // The token ran out more than an hour ago (its whole lifetime) while the device was offline.
  await expireToken(d.page, -3700);
  await failedRefreshWhileOffline(log);
  expect((await localSession(d.page)).authUser, 'session kept while offline').toBe(state.users[key].id);
  const back = Date.now();
  await d.online();
  // No button, no password: the token is refreshed and the record uploads soon after the network returns.
  await waitSql('select id from public.records where id = $1', [id], (r) => r.length === 1, 30_000);
  qa.note('seconds from reconnect to upload', (Date.now() - back) / 1000);
  await d.waitSynced();
  expect(refreshes(log).some((r) => r.status === 200 && Date.parse(r.t) >= back), 'token refreshed after the reconnect').toBe(true);
  expect(await signInShown(d.page)).toEqual([]);
  expect((await seen(d.page)).routes).not.toContain('signin');
});

test('M12 [P0] the network drops during a token refresh, then returns: recovers without a sign-in', async ({ qa }) => {
  const key = await freshUser('M12');
  const d = await device(qa, key);
  const log = tracked.at(-1).log;
  await d.open();
  let step = 0;
  await d.context.route(isRefresh, async (r) => {
    step += 1;
    if (step === 1) {
      // Drop 1: the request reaches the server (which rotates the token), the answer never comes back.
      await r.fetch().catch(() => null);
      await d.context.setOffline(true);
      return r.abort('internetdisconnected');
    }
    if (step === 2) {
      // Drop 2: the connection breaks while the request body is being sent. The server
      // gets half a body and answers with its real 400 bad_json; then the device is offline.
      const body = r.request().postData() ?? '';
      const res = await r.fetch({ postData: body.slice(0, Math.floor(body.length / 2)) });
      qa.note('server answer to the cut-off request', { status: res.status(), body: (await res.text()).slice(0, 200) });
      await r.fulfill({ response: res });
      await d.context.setOffline(true);
      return undefined;
    }
    return r.continue();
  });
  await expireToken(d.page);
  const id = await d.createRecord({ title: uniq('M12 pending'), fields: { ph: 7.2 } });
  await expect.poll(() => step, { timeout: 30_000, message: 'first refresh sent' }).toBeGreaterThanOrEqual(1);
  await sleep(5_000);
  await d.context.setOffline(false);
  await expect.poll(() => step, { timeout: 90_000, message: 'second refresh sent' }).toBeGreaterThanOrEqual(2);
  await sleep(5_000);
  expect((await localSession(d.page)).authUser, 'session still stored after both drops').toBe(state.users[key].id);
  await d.context.setOffline(false);
  await waitSql('select id from public.records where id = $1', [id], (r) => r.length === 1, 60_000);
  await d.waitSynced();
  qa.note('auth', log);
  expect(await signInShown(d.page), 'no sign-in asked at any point').toEqual([]);
  expect((await seen(d.page)).routes).not.toContain('signin');
});

test('M13 [P0] offline and online cycled five times: still signed in, status bar correct', async ({ qa }) => {
  test.setTimeout(600_000);
  const key = await freshUser('M13');
  const d = await device(qa, key);
  const log = tracked.at(-1).log;
  await d.open();
  const times = [];
  for (let cycle = 1; cycle <= 5; cycle++) {
    await d.offline();
    const id = await d.createRecord({ title: uniq(`M13 cycle ${cycle}`), fields: { ph: 7.3 } });
    await expect(d.page.locator('#sb-text'), `cycle ${cycle}: offline bar`).toHaveText('Offline / 1 pending');
    await expireToken(d.page);
    await failedRefreshWhileOffline(log, Date.now());
    const back = Date.now();
    await d.online();
    await waitSql('select id from public.records where id = $1', [id], (r) => r.length === 1, 30_000);
    await expect(d.page.locator('#sb-text'), `cycle ${cycle}: online bar`).toHaveText('Online / all synced', { timeout: 30_000 });
    times.push((Date.now() - back) / 1000);
    expect((await localSession(d.page)).authUser, `cycle ${cycle}: signed in`).toBe(state.users[key].id);
  }
  qa.note('seconds from reconnect to all synced, per cycle', times);
  expect(await signInShown(d.page)).toEqual([]);
  expect((await seen(d.page)).routes).not.toContain('signin');
});

test('M14 [P1] the "sign-in needed" message clears by itself after a successful refresh', async ({ qa }) => {
  test.setTimeout(400_000);
  const key = await freshUser('M14');
  const d = await device(qa, key);
  await d.open();
  let refused = 0;
  await d.context.route(isRefresh, async (r) => {
    if (refused >= 1) return r.continue();
    refused += 1;
    // The real server's answer for a refresh token it does not know (sent with a dead token).
    const res = await r.fetch({ postData: JSON.stringify({ refresh_token: 'm14deadtoken0' }) });
    return r.fulfill({ response: res });
  });
  await expireToken(d.page);
  const id = await d.createRecord({ title: uniq('M14 pending'), fields: { ph: 7.4 } });
  await expect(d.page.locator('#sb-text'), 'refused by the server: sign-in needed').toHaveText(/sign-in needed/i, { timeout: 40_000 });
  await d.shot('sign-in-needed');
  // The next refresh is accepted. Nobody presses anything.
  await expect(d.page.locator('#sb-text'), 'message gone by itself').not.toHaveText(/sign-in/i, { timeout: 180_000 });
  await waitSql('select id from public.records where id = $1', [id], (r) => r.length === 1, 60_000);
  await d.waitSynced();
  expect((await seen(d.page)).routes).not.toContain('signin');
});

test('M15 [P0] pending records made while offline upload on their own after reconnecting', async ({ qa }) => {
  const key = await freshUser('M15');
  const d = await device(qa, key);
  const log = tracked.at(-1).log;
  await d.open();
  await d.offline();
  const ids = [
    await d.createRecord({ title: uniq('M15 one'), fields: { ph: 7.5 }, photos: [photo(1)] }),
    await d.createRecord({ title: uniq('M15 two'), fields: { ph: 7.6 } }),
    await d.createRecord({ title: uniq('M15 three'), type: 'wildlife', fields: { species: 'Heron', count: 2 } }),
  ];
  const queued = (await d.outbox()).length;
  await expireToken(d.page);
  await failedRefreshWhileOffline(log);
  expect((await d.outbox()).length, 'outbox untouched while offline').toBe(queued);
  await d.online();
  // No Sync now, no sign-in.
  await waitSql('select id from public.records where id = any($1)', [ids], (r) => r.length === 3, 30_000);
  await waitSql('select id from public.media where record_id = $1', [ids[0]], (r) => r.length === 1, 60_000);
  await d.waitSynced();
  expect(d.rpcRequests('sync_push').length).toBeGreaterThan(0);
  expect(await signInShown(d.page)).toEqual([]);
});

test('M16 [P1] the service worker does not cache or intercept auth requests', async ({ qa }) => {
  const key = await freshUser('M16');
  const d = await device(qa, key);
  const log = tracked.at(-1).log;
  const viaWorker = [];
  d.context.on('request', (r) => { if (r.url().includes('/auth/v1/') && r.serviceWorker()) viaWorker.push(r.url()); });
  const fromWorker = [];
  d.page.on('response', (r) => { if (r.url().includes('/auth/v1/') && r.fromServiceWorker()) fromWorker.push(r.url()); });
  await d.open();
  expect(await d.page.evaluate(() => Boolean(navigator.serviceWorker.controller)), 'the worker controls the page').toBe(true);
  await d.offline();
  await expireToken(d.page);
  await failedRefreshWhileOffline(log);
  await d.online();
  // Generous: this case is about the worker, not about how soon the refresh comes.
  await expect.poll(() => refreshes(log).some((r) => r.status === 200), { timeout: 150_000, message: 'refreshed online' }).toBe(true);
  const cached = await d.page.evaluate(async () => {
    const out = [];
    for (const name of await caches.keys()) {
      for (const req of await (await caches.open(name)).keys()) out.push(req.url);
    }
    return { origin: location.origin, urls: out };
  });
  qa.note('cache entries', cached.urls.length);
  expect(cached.urls.filter((u) => !u.startsWith(cached.origin) || u.includes('/auth/v1/')), 'only the app files are cached').toEqual([]);
  expect(viaWorker, 'no auth request was made by the worker').toEqual([]);
  expect(fromWorker, 'no auth answer came from the worker').toEqual([]);
  expect(log.auth.filter((a) => a.dir === '>').length, 'auth requests were seen').toBeGreaterThan(0);
});

test('M17 [P0] a refresh answered with an error that is not a rejection (rate limit, cut-off request, proxy page) keeps the session', async ({ qa }) => {
  test.setTimeout(500_000);
  const answers = [
    { status: 429, contentType: 'application/json', body: JSON.stringify({ code: 429, error_code: 'over_request_rate_limit', msg: 'Request rate limit reached' }) },
    { status: 400, contentType: 'application/json', body: JSON.stringify({ code: 400, error_code: 'bad_json', msg: 'Could not parse request body as JSON: unexpected end of JSON input' }) },
    { status: 403, contentType: 'text/html', body: '<html><body>Access denied by the network</body></html>' },
  ];
  for (const answer of answers) {
    const key = await freshUser(`M17-${answer.status}`);
    const d = await device(qa, key, `device${answer.status}`);
    await d.open();
    let n = 0;
    await d.context.route(isRefresh, (r) => { if (n >= 1) return r.continue(); n += 1; return r.fulfill(answer); });
    await expireToken(d.page);
    const id = await d.createRecord({ title: uniq(`M17 ${answer.status}`), fields: { ph: 7.7 } });
    await expect.poll(() => n, { timeout: 30_000, message: `${answer.status} answered` }).toBe(1);
    await sleep(2_000);
    expect((await localSession(d.page)).authUser, `${answer.status}: session still stored`).toBe(state.users[key].id);
    await waitSql('select id from public.records where id = $1', [id], (r) => r.length === 1, 150_000);
    await d.waitSynced();
    expect(await signInShown(d.page), `${answer.status}: no sign-in asked`).toEqual([]);
    await d.context.close();
  }
});
