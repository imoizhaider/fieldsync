// A. Auth and session
import { test, expect, state, sql, serverRecord, waitSql, uniq } from '../lib/harness.js';

async function signInUi(d, key, { password = state.password } = {}) {
  const p = d.page;
  await p.fill('input[name="email"]', state.users[key].email);
  await p.fill('input[name="password"]', password);
  await p.click('button[type="submit"]');
}

const tokenRequests = (d) => d.requests.filter((r) => r.url.includes('/auth/v1/token'));

test('A01 [P0] valid login opens the record list and caches the session', async ({ qa }) => {
  const d = await qa.device('deviceA');
  d.userKey = 'a';
  await d.open('', { sync: false });
  await expect(d.page.locator('h1.title')).toHaveText('Sign in');
  await signInUi(d, 'a');
  await d.page.waitForFunction(() => document.body.dataset.route === 'records', null, { timeout: 30_000 });
  await d.waitSynced();
  // screen
  await expect(d.page.locator('h1.title')).toHaveText('Observations');
  await expect(d.page.locator('#region-link')).toContainText(state.names.main);
  // browser storage
  const ls = await d.page.evaluate(() => ({ auth: localStorage.getItem('fieldsync-auth'), user: localStorage.getItem('fieldsync.user') }));
  expect(JSON.parse(ls.auth).user.id).toBe(state.users.a.id);
  expect(JSON.parse(ls.user).id).toBe(state.users.a.id);
  const meta = (await d.idb(['meta'])).meta;
  const regions = meta.find((m) => m.key === 'regions').value.map((r) => r.name).sort();
  expect(regions).toEqual([state.names.main, state.names.other, state.names.view].sort());
  // server
  const deviceId = meta.find((m) => m.key === 'deviceId').value;
  const dev = await waitSql('select user_id from public.devices where device_id = $1', [deviceId], (r) => r.length === 1);
  expect(dev[0].user_id).toBe(state.users.a.id);
  qa.note('regionsOnDevice', regions);
});

test('A02 [P2] empty fields show a message and send nothing', async ({ qa }) => {
  const d = await qa.device('deviceA');
  await d.open('', { sync: false });
  const p = d.page;
  const err = p.locator('#signin-error');
  for (const [email, password] of [['', ''], [state.users.a.email, ''], ['', 'x']]) {
    await p.fill('input[name="email"]', email);
    await p.fill('input[name="password"]', password);
    await p.click('button[type="submit"]');
    await expect(err).toBeVisible();
    await expect(err).toHaveText('Enter your email and password.');
  }
  // whitespace-only email counts as empty
  await p.fill('input[name="email"]', '   ');
  await p.fill('input[name="password"]', 'x');
  await p.click('button[type="submit"]');
  await expect(err).toBeVisible();
  expect(tokenRequests(d)).toHaveLength(0);
  await expect(p.locator('h1.title')).toHaveText('Sign in');
});

test('A03 [P2] wrong password shows a clear message and stores nothing', async ({ qa }) => {
  const d = await qa.device('deviceA');
  await d.open('', { sync: false });
  const p = d.page;
  await signInUi(d, 'a', { password: 'definitely-wrong-password' });
  const err = p.locator('#signin-error');
  await expect(err).toBeVisible();
  const text = await err.textContent();
  qa.note('message', text);
  expect(text).toMatch(/invalid|incorrect|wrong/i);
  expect(text).not.toMatch(/undefined|\[object|TypeError|fetch/i);
  await expect(p.locator('h1.title')).toHaveText('Sign in');
  await expect(p.locator('button[type="submit"]')).toBeEnabled();
  await expect(p.locator('button[type="submit"]')).toHaveText('Sign in');
  const ls = await p.evaluate(() => ({ auth: localStorage.getItem('fieldsync-auth'), user: localStorage.getItem('fieldsync.user') }));
  expect(ls.user).toBeNull();
  expect(ls.auth).toBeNull();
  // the form still works afterwards
  await signInUi(d, 'a');
  await p.waitForFunction(() => document.body.dataset.route === 'records', null, { timeout: 30_000 });
});

test('A04 [P2] unknown email and malformed email give a clear message', async ({ qa }) => {
  const d = await qa.device('deviceA');
  await d.open('', { sync: false });
  const p = d.page;
  const err = p.locator('#signin-error');
  const seen = {};
  for (const email of [`nobody+${state.ts}@example.org`, 'not-an-email', "a'--@example.org"]) {
    await p.fill('input[name="email"]', email);
    await p.fill('input[name="password"]', 'whatever-123');
    await p.click('button[type="submit"]');
    await expect(err).toBeVisible();
    await expect(p.locator('button[type="submit"]')).toBeEnabled();
    seen[email] = await err.textContent();
    expect(seen[email].trim().length).toBeGreaterThan(5);
    expect(seen[email]).not.toMatch(/undefined|\[object|TypeError/i);
  }
  qa.note('messages', seen);
  expect(d.console.filter((l) => l.startsWith('[pageerror]'))).toEqual([]);
});

test('A05 [P0] opens offline after one online login', async ({ qa }) => {
  const d = await qa.device('deviceA');
  d.userKey = 'a';
  await d.open('', { sync: false });
  await signInUi(d, 'a');
  await d.page.waitForFunction(() => document.body.dataset.route === 'records', null, { timeout: 30_000 });
  await d.page.waitForFunction(() => navigator.serviceWorker?.controller != null);
  await d.waitSynced();
  await d.context.setOffline(true);
  await d.page.reload();
  await d.page.waitForSelector('html[data-ready="1"]');
  await expect(d.page.locator('h1.title')).toHaveText('Observations');
  await expect(d.page.locator('#statusbar')).toHaveAttribute('data-online', '0');
  await expect(d.page.locator('#sb-text')).toHaveText(/^Offline \/ \d+ pending$/);
  await expect(d.page.locator('#region-link')).toContainText(state.names.main);
  // a brand new tab in the same profile, still offline
  const p2 = await d.context.newPage();
  await p2.goto(d.page.url().split('#')[0]);
  await p2.waitForSelector('html[data-ready="1"]');
  await expect(p2.locator('h1.title')).toHaveText('Observations');
  await p2.close();
});

test('A06 [P1] session expiry while offline: pending data survives and uploads after signing in again', async ({ qa }) => {
  const d = await qa.device('deviceA');
  d.userKey = 'a';
  await d.open('', { sync: false });
  await signInUi(d, 'a');
  await d.page.waitForFunction(() => document.body.dataset.route === 'records', null, { timeout: 30_000 });
  await d.page.waitForFunction(() => navigator.serviceWorker?.controller != null);
  await d.waitSynced();
  await d.offline();
  const title = uniq('A06 expired session');
  const id = await d.createRecord({ title, fields: { ph: 6.1 } });
  // The session runs out while the device is offline: expired token, refresh token no longer valid.
  await d.page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('fieldsync-auth'));
    s.expires_at = Math.floor(Date.now() / 1000) - 3600;
    s.refresh_token = 'expired-refresh-token';
    localStorage.setItem('fieldsync-auth', JSON.stringify(s));
  });
  await d.page.reload();
  await d.page.waitForSelector('html[data-ready="1"]');
  await expect(d.page.locator('h1.title')).toHaveText('Observations'); // still usable offline
  await d.context.setOffline(false);
  // reconnect: nothing may be lost, and the app must say what is wrong
  await expect(d.page.locator('#sb-text')).toHaveText(/sign-in needed/i, { timeout: 40_000 });
  await d.shot('after-reconnect');
  expect((await d.outbox()).filter((o) => o.rowId === id), 'change still in the outbox').toHaveLength(1);
  expect(await d.localRecord(id)).toBeTruthy();
  expect(await serverRecord(id)).toBeNull();
  await d.go('#/sync');
  await d.shot('sync-screen-sign-in-needed');
  await expect(d.page.locator('.notice h2')).toHaveText('Sign-in needed');
  const direct = await d.page.locator('a[href="#/signin"], button:has-text("Sign in")').count();
  if (direct === 0) qa.finding('Sync screen says "Sign in again" but offers no button or link to do it; the only way is Regions > Sign out > Sign in.');
  // the only route to the sign-in form
  await d.go('#/regions');
  await d.page.click('[data-act="signout"]');
  await d.page.click('#sheet-root [data-act="leave"]');
  await expect(d.page.locator('h1.title')).toHaveText('Sign in');
  await signInUi(d, 'a');
  await d.page.waitForFunction(() => document.body.dataset.route === 'records', null, { timeout: 30_000 });
  const rows = await waitSql('select fields, created_by from public.records where id = $1', [id], (r) => r.length === 1);
  expect(rows[0].fields.title).toBe(title);
  expect(rows[0].created_by).toBe(state.users.a.id);
  await d.waitSynced();
  await expect(d.row(id)).toHaveAttribute('data-status', 'synced');
});

test('A07 [P0] sign out with pending changes warns and loses nothing', async ({ qa }) => {
  const d = await qa.device('deviceA', { user: 'a' });
  await d.open();
  await d.offline();
  const title = uniq('A07 pending at sign-out');
  const id = await d.createRecord({ title, fields: { ph: 5.5 }, photos: [] });
  await d.go('#/regions');
  await d.page.click('[data-act="signout"]');
  const sheet = d.page.locator('#sheet-root .sheet');
  await expect(sheet).toContainText('1 change has not uploaded yet');
  await expect(sheet).toContainText('stay saved on this device');
  await d.shot('signout-warning');
  await d.page.click('#sheet-root [data-act="leave"]');
  await expect(d.page.locator('h1.title')).toHaveText('Sign in');
  // local data is still there
  const local = await d.idb(['records', 'outbox']);
  expect(local.records.find((r) => r.id === id)?.fields.title).toBe(title);
  expect(local.outbox.filter((o) => o.rowId === id).length).toBeGreaterThan(0);
  expect(await serverRecord(id)).toBeNull();
  await d.context.setOffline(false);
  await expect(d.page.locator('#statusbar')).toHaveAttribute('data-online', '1');
  await signInUi(d, 'a');
  await d.page.waitForFunction(() => document.body.dataset.route === 'records', null, { timeout: 30_000 });
  const rows = await waitSql('select fields from public.records where id = $1', [id], (r) => r.length === 1);
  expect(rows[0].fields.title).toBe(title);
  await d.waitSynced();
  await expect(d.row(id)).toHaveAttribute('data-status', 'synced');
});

test('A08 [P1] two users on one device never see each other\'s local data', async ({ qa }) => {
  const d = await qa.device('shared', { user: 'a' });
  await d.open();
  await d.offline();
  const titleA = uniq('A08 by user A');
  const idA = await d.createRecord({ title: titleA, fields: { ph: 6.6 } });
  await d.go('#/regions');
  await d.page.click('[data-act="signout"]');
  await d.page.click('#sheet-root [data-act="leave"]');
  await d.context.setOffline(false);
  await expect(d.page.locator('#statusbar')).toHaveAttribute('data-online', '1');

  // user B on the same device
  d.userKey = 'b';
  await signInUi(d, 'b');
  await d.page.waitForFunction(() => document.body.dataset.route === 'records', null, { timeout: 30_000 });
  await d.waitSynced();
  await expect(d.page.locator('#pane-detail')).not.toContainText(titleA);
  const bLocal = await d.idb(['records', 'outbox']);
  expect(bLocal.records.some((r) => r.id === idA)).toBe(false);
  expect(bLocal.outbox).toHaveLength(0);
  expect(await serverRecord(idA), 'A\'s pending record was not uploaded under B\'s login').toBeNull();
  const regionsB = (await d.idb(['meta'])).meta.find((m) => m.key === 'regions').value.map((r) => r.name);
  expect(regionsB).not.toContain(state.names.other);
  const titleB = uniq('A08 by user B');
  const idB = await d.createRecord({ title: titleB, fields: { ph: 7.7 } });
  await waitSql('select created_by from public.records where id = $1', [idB], (r) => r[0]?.created_by === state.users.b.id);
  await d.waitSynced();
  await d.shot('user-b-list');
  // A's database still holds A's pending change
  const aStill = await d.idb(['records', 'outbox'], state.users.a.id);
  expect(aStill.outbox.some((o) => o.rowId === idA)).toBe(true);
  await d.go('#/regions');
  await expect(d.page.locator('#pane-detail')).toContainText(`Signed in as ${state.users.b.name}`);
  await d.page.click('[data-act="signout"]');
  await d.page.click('#sheet-root [data-act="leave"]');

  // user A comes back: the pending record uploads as A
  d.userKey = 'a';
  await signInUi(d, 'a');
  await d.page.waitForFunction(() => document.body.dataset.route === 'records', null, { timeout: 30_000 });
  const rows = await waitSql('select created_by, fields from public.records where id = $1', [idA], (r) => r.length === 1);
  expect(rows[0].created_by).toBe(state.users.a.id);
  await d.waitSynced();
  await expect(d.row(idA)).toHaveAttribute('data-status', 'synced');
  await expect(d.row(idB)).toHaveCount(1); // B's synced record arrives through the server, as it should
  const dbs = await d.page.evaluate(async () => (await indexedDB.databases()).map((x) => x.name).sort());
  qa.note('databases', dbs);
  expect(dbs).toEqual([`fieldsync-${state.users.a.id}`, `fieldsync-${state.users.b.id}`].sort());
});

test('A09 [P2] a first sign-in with no network explains itself', async ({ qa }) => {
  const d = await qa.device('deviceA');
  await d.open('', { sync: false });
  await d.context.setOffline(true);
  await expect(d.page.locator('#sb-text')).toHaveText('Offline / sign-in needed');
  await signInUi(d, 'a');
  const err = d.page.locator('#signin-error');
  await expect(err).toBeVisible();
  await expect(err).toHaveText(/needs a connection/i);
  await expect(d.page.locator('button[type="submit"]')).toBeEnabled();
});

test('A10 [P2] signed-out deep links show the sign-in screen', async ({ qa }) => {
  const d = await qa.device('deviceA');
  for (const hash of ['#/records', '#/sync', '#/console', '#/conflicts', '#/new', '#/storage', '#/regions', '#/tracks']) {
    await d.open(hash, { sync: false, sw: false });
    await expect(d.page.locator('h1.title'), hash).toHaveText('Sign in');
    await expect(d.page.locator('#nav'), hash).toBeHidden();
  }
  expect(await sql('select 1 as ok')).toEqual([{ ok: 1 }]);
});
