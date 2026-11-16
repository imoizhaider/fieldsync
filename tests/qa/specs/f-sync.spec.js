// F. Sync
import { test, expect, state, sql, serverRecord, serverMedia, serverObjects, waitSql, uniq, photo, slow3g, sleep, BASE_URL, PUSH, UPLOAD } from '../lib/harness.js';

const photos = (n) => Array.from({ length: n }, (_, i) => photo(i + 1));
const serverGps = (recordId) => sql('select * from public.gps_logs where record_id = $1', [recordId]);

test('F01 [P0] pending changes upload by themselves within 30 s of reconnecting', async ({ qa }) => {
  const d = await qa.device('deviceA', { user: 'a' });
  await d.open();
  await d.offline();
  const id = await d.createRecord({ title: uniq('F01 auto sync'), fields: { ph: 6.4 }, photos: photos(3) });
  await d.go('#/records');
  const clicks = [];
  await d.page.exposeFunction('__qaClick', (t) => clicks.push(t));
  await d.page.evaluate(() => document.addEventListener('click', (e) => window.__qaClick(e.target.tagName), true));
  const t0 = Date.now();
  await d.context.setOffline(false);
  await waitSql('select (select count(*)::int from public.records where id = $1) r, (select count(*)::int from public.media where record_id = $1) m, (select count(*)::int from public.gps_logs where record_id = $1) g',
    [id], (r) => r[0].r === 1 && r[0].m === 3 && r[0].g === 1, 30_000);
  const serverSeconds = (Date.now() - t0) / 1000;
  await expect(d.row(id)).toHaveAttribute('data-status', 'synced', { timeout: 30_000 });
  const badgeSeconds = (Date.now() - t0) / 1000;
  qa.note('seconds', { server: serverSeconds, badge: badgeSeconds });
  await expect(d.row(id).locator('.status')).toHaveText('Synced');
  await expect(d.page.locator('#sb-text')).toHaveText('Online / all synced');
  await d.shot('synced');
  expect(clicks, 'no button was pressed').toEqual([]);
  expect(badgeSeconds).toBeLessThan(30);
  expect(await serverObjects(id)).toHaveLength(3);
  expect(await d.outbox()).toHaveLength(0);
});

test('F02 [P0] sync runs on app open', async ({ qa }) => {
  const d = await qa.device('deviceA', { user: 'a' });
  await d.open();
  await d.offline();
  const id = await d.createRecord({ title: uniq('F02 sync on open'), fields: { ph: 6.4 }, photos: photos(1) });
  await d.page.close();                       // app closed while still offline
  await d.context.setOffline(false);          // the connection returns while it is closed
  await sleep(1500);
  expect(await serverRecord(id), 'nothing uploads while the app is closed').toBeNull();
  const page = await d.context.newPage();
  d.page = page;
  d.watch(page);
  const t0 = Date.now();
  await page.goto(BASE_URL);
  await waitSql('select id from public.media where record_id = $1', [id], (r) => r.length === 1, 30_000);
  qa.note('secondsAfterOpen', (Date.now() - t0) / 1000);
  await d.waitSynced();
  await expect(d.row(id)).toHaveAttribute('data-status', 'synced');
});

test('F03 [P0] the Sync now button fetches other people\'s changes at once', async ({ qa }) => {
  const a = await qa.device('deviceA', { user: 'a' });
  const b = await qa.device('deviceB', { user: 'b' });
  await a.open();
  await b.open();
  const title = uniq('F03 made on B');
  const id = await b.createRecord({ title, fields: { ph: 7 } });
  await b.waitSynced();
  await a.go('#/sync');
  await expect(a.page.locator('#sync-now')).toBeEnabled();
  const pullsBefore = a.rpcRequests('sync_pull').length;
  const t0 = Date.now();
  await a.page.click('#sync-now');
  await expect(async () => { expect(await a.localRecord(id)).toBeTruthy(); }).toPass({ timeout: 15_000 });
  const ms = Date.now() - t0;
  qa.note('msFromPressToRecord', ms);
  const pull = a.rpcRequests('sync_pull').slice(pullsBefore)[0];
  expect(pull.t - t0, 'the press itself started the sync (not the 20 s timer)').toBeLessThan(2500);
  await a.go('#/records');
  await expect(a.row(id).locator('.row-title')).toHaveText(title);
  // offline the button is disabled rather than silently doing nothing
  await a.offline();
  await a.go('#/sync');
  await expect(a.page.locator('#sync-now')).toBeDisabled();
  await a.shot('sync-now-disabled-offline');
});

test('F04 [P0] every sync run pushes before it pulls', async ({ qa }) => {
  const d = await qa.device('deviceA', { user: 'a' });
  await d.open();
  await d.offline();
  const id = await d.createRecord({ title: uniq('F04 order'), fields: { ph: 6 }, photos: photos(1) });
  d.requests.length = 0;
  await d.online();
  await d.waitSynced();
  const seq = d.requests.filter((r) => /rpc\/sync_(push|pull)|storage\/v1\/object\/photos/.test(r.url))
    .map((r) => (r.url.includes('sync_push') ? (JSON.parse(r.body).p_ops.length ? `push(${JSON.parse(r.body).p_ops.map((o) => o.table).join(',')})` : 'push(empty)') : r.url.includes('sync_pull') ? 'pull' : 'upload'));
  qa.note('requestOrder', seq);
  const firstPull = seq.indexOf('pull');
  expect(firstPull).toBeGreaterThan(0);
  const beforePull = seq.slice(0, firstPull);
  expect(beforePull.some((s) => s.startsWith('push(records')), 'record pushed before the first pull').toBe(true);
  expect(beforePull).toContain('upload');
  expect(beforePull.filter((s) => s.includes('media')).length, 'photo row pushed before the first pull').toBe(1);
  // in every run: a pull is always directly preceded by a push
  seq.forEach((s, i) => { if (s === 'pull') expect(seq[i - 1].startsWith('push'), `request ${i}`).toBe(true); });
  // the record row goes up before its photo
  expect(seq.findIndex((s) => s.startsWith('push(records'))).toBeLessThan(seq.indexOf('upload'));
  expect(await serverRecord(id)).toBeTruthy();
});

test('F05 [P1] a pull asks only for changes since lastPulledAt', async ({ qa }) => {
  const a = await qa.device('deviceA', { user: 'a' });
  const b = await qa.device('deviceB', { user: 'b' });
  const responses = [];
  a.page.on('response', async (r) => {
    if (r.url().includes('/rpc/sync_pull') && r.status() === 200) responses.push({ since: JSON.parse(r.request().postData()).p_since, body: await r.json().catch(() => null) });
  });
  await a.open();
  await b.open();
  expect(responses[0].since, 'first pull of a new device asks for everything').toBeNull();
  const cursor = await a.meta('lastPulledAt');
  const id = await b.createRecord({ title: uniq('F05 delta'), fields: { ph: 7.3 } });
  await b.waitSynced();
  const n = responses.length;
  await a.syncNow();
  const delta = responses.slice(n).find((r) => r.body?.records.some((x) => x.id === id));
  expect(delta, 'B\'s record arrived in a pull').toBeTruthy();
  qa.note('pull', { since: delta.since, cursorBefore: cursor, records: delta.body.records.length, media: delta.body.media.length, gps: delta.body.gps_logs.length, conflicts: delta.body.conflicts.length, bytes: JSON.stringify(delta.body).length });
  expect(new Date(delta.since).getTime()).toBeGreaterThanOrEqual(new Date(cursor).getTime());
  for (const r of delta.body.records) expect(new Date(r.updated_at).getTime(), 'only rows changed after the cursor').toBeGreaterThan(new Date(delta.since).getTime());
  expect(delta.body.records.length).toBeLessThan(5);
  // the cursor moves forward with the server's clock, a few seconds behind it
  const cursor2 = await a.meta('lastPulledAt');
  expect(new Date(cursor2).getTime()).toBeGreaterThan(new Date(cursor).getTime());
  const lag = new Date(delta.body.server_time).getTime() - new Date(cursor2).getTime();
  expect(lag).toBeGreaterThanOrEqual(0);
  expect(lag).toBeLessThan(30_000);
  // an idle pull carries no rows
  const m = responses.length;
  await a.syncNow();
  const idle = responses.slice(m).pop();
  qa.note('idlePull', { records: idle.body.records.length, regions: idle.body.regions.length, profiles: idle.body.profiles.length, devices: idle.body.devices.length, bytes: JSON.stringify(idle.body).length });
  expect(idle.body.records.filter((r) => new Date(r.updated_at) <= new Date(idle.since))).toEqual([]);
  if (idle.body.devices.length > 10) qa.finding(`Every pull (also the idle one every 20 s) returns the full regions, profiles and devices lists: ${idle.body.devices.length} device rows, ${JSON.stringify(idle.body).length} bytes. The devices table only grows (one row per browser profile that ever synced), so idle traffic grows with it against the 5 GB egress limit.`);
});

test('F06 [P0] 500 and 503 answers keep the outbox exactly as it was', async ({ qa }) => {
  const d = await qa.device('deviceA', { user: 'a' });
  await d.open();
  await d.offline();
  const id = await d.createRecord({ title: uniq('F06 server errors'), fields: { ph: 6 }, photos: photos(2) });
  const before = await d.outbox();
  let fails = 0;
  await d.context.route(PUSH, (route) => { fails++; return route.fulfill({ status: fails % 2 ? 500 : 503, contentType: 'application/json', body: JSON.stringify({ message: 'QA simulated server error' }) }); });
  await d.context.setOffline(false);
  await expect(async () => { expect(fails).toBeGreaterThanOrEqual(3); }).toPass({ timeout: 40_000 });
  expect(await d.outbox(), 'outbox untouched after failed pushes').toEqual(before);
  await d.go('#/records');
  await expect(d.row(id)).toHaveAttribute('data-status', /pending|waiting/);
  await expect(d.page.locator('#sb-text')).not.toHaveText('Online / all synced');
  expect(await serverRecord(id)).toBeNull();
  await d.go('#/sync');
  await d.shot('sync-screen-during-500');
  // record goes through, then the photo upload itself answers 503
  await d.context.unroute(PUSH);
  let upFails = 0;
  await d.context.route(UPLOAD, (route) => (route.request().method() === 'GET' ? route.continue() : (upFails++, route.fulfill({ status: 503, contentType: 'application/json', body: '{"message":"QA storage down"}' }))));
  await waitSql('select id from public.records where id = $1', [id], (r) => r.length === 1, 60_000);
  await expect(async () => { expect(upFails).toBeGreaterThanOrEqual(2); }).toPass({ timeout: 60_000 });
  const mid = await d.outbox();
  expect(mid.filter((o) => o.table === 'media').map((o) => o.opId)).toEqual(before.filter((o) => o.table === 'media').map((o) => o.opId));
  expect(mid.every((o) => o.status === 'queued')).toBe(true);
  expect((await d.localMedia(id)).map((m) => m.uploaded)).toEqual([0, 0]);
  expect(await serverMedia(id)).toHaveLength(0);
  await d.context.unroute(UPLOAD);
  // recovers with no click
  await waitSql('select id from public.media where record_id = $1', [id], (r) => r.length === 2, 90_000);
  await d.waitSynced(60_000);
  expect(await sql('select count(*)::int n from public.records where id = $1', [id])).toEqual([{ n: 1 }]);
  qa.note('failedPushes', fails);
  qa.note('failedUploads', upFails);
});

test('F07 [P0] a request that times out keeps the outbox and sync recovers', async ({ qa }) => {
  const d = await qa.device('deviceA', { user: 'a' });
  await d.open();
  await d.offline();
  const id = await d.createRecord({ title: uniq('F07 timeout'), fields: { ph: 6 } });
  const before = await d.outbox();
  let timeouts = 0;
  await d.context.route(PUSH, async (route) => {
    if (timeouts >= 2) return route.continue();
    timeouts++;
    await sleep(12_000);                 // the server never answers in time
    return route.abort('timedout');
  });
  await d.context.setOffline(false);
  await sleep(6000);
  await d.go('#/sync');
  await d.shot('while-request-hangs');
  expect(await d.outbox()).toEqual(before);
  await expect(async () => { expect(timeouts).toBe(2); }).toPass({ timeout: 60_000 });
  expect(await serverRecord(id)).toBeNull();
  const rows = await waitSql('select version from public.records where id = $1', [id], (r) => r.length === 1, 90_000);
  expect(rows[0].version).toBe(1);
  await d.waitSynced(60_000);
  expect(await serverGps(id)).toHaveLength(1);
});

test('F08 [P1] retries back off: about 2, 4, 8, 16 seconds', async ({ qa }) => {
  test.setTimeout(240_000);
  const d = await qa.device('deviceA', { user: 'a' });
  await d.open();
  await d.go('#/records');
  const attempts = [];
  await d.context.route(PUSH, (route) => { attempts.push(Date.now()); return route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"QA simulated"}' }); });
  const id = await d.createRecord({ title: uniq('F08 backoff'), fields: { ph: 6 } });
  await expect(async () => { expect(attempts.length).toBeGreaterThanOrEqual(6); }).toPass({ timeout: 100_000, intervals: [1000] });
  const gaps = attempts.slice(1).map((t, i) => Math.round((t - attempts[i]) / 100) / 10);
  qa.note('gapsSeconds', gaps);
  const want = [2, 4, 8, 16, 32];
  gaps.slice(0, 5).forEach((g, i) => {
    expect(g, `gap ${i + 1} of ${JSON.stringify(gaps)}`).toBeGreaterThanOrEqual(want[i] - 0.3);
    expect(g, `gap ${i + 1} of ${JSON.stringify(gaps)}`).toBeLessThanOrEqual(want[i] + 2.5);
  });
  await d.context.unroute(PUSH);
  // a reconnect resets the backoff: no waiting out the long timer
  await d.context.setOffline(true);
  await sleep(500);
  const t0 = Date.now();
  await d.context.setOffline(false);
  await waitSql('select id from public.records where id = $1', [id], (r) => r.length === 1, 15_000);
  qa.note('secondsToSyncAfterReconnect', (Date.now() - t0) / 1000);
  await d.waitSynced();
});

test('F09 [P2] the Sync screen shows the retry countdown', async ({ qa }) => {
  const d = await qa.device('deviceA', { user: 'a' });
  await d.open();
  await d.offline();
  const id = await d.createRecord({ title: uniq('F09 countdown'), fields: { ph: 6 }, photos: photos(1) });
  await d.context.route(PUSH, (route) => route.abort('connectionreset'));
  await d.context.setOffline(false);
  await d.go('#/sync');
  const card = d.page.locator('#sync-retry');
  // wait for a long enough backoff to watch it count
  await expect(async () => {
    await expect(card).toBeVisible();
    const [m, s] = (await d.page.locator('#retry-clock').textContent()).split(':').map(Number);
    expect(m * 60 + s).toBeGreaterThanOrEqual(5);
  }).toPass({ timeout: 60_000, intervals: [300] });
  await expect(card).toContainText('Upload interrupted');
  await expect(card).toContainText('Nothing is lost');
  const read = async () => { const [m, s] = (await d.page.locator('#retry-clock').textContent()).split(':').map(Number); return m * 60 + s; };
  const first = await read();
  await expect(d.page.locator('#outbox-list')).toContainText('dropped, backoff active');
  await expect(d.page.locator('#outbox-list .status.plain.retry')).toHaveText(/^Retry \d\d:\d\d$/);
  await d.shot('retry-countdown');
  await sleep(2200);
  const second = await read().catch(() => 0);
  qa.note('countdown', { first, second });
  expect(second).toBeLessThan(first);
  await expect(d.page.locator('#sb-text')).toHaveText(/Online \/ 1 pending/);
  // the list still says Pending, never Synced
  await d.go('#/records');
  await expect(d.row(id)).toHaveAttribute('data-status', /pending|waiting/);
  await d.context.unroute(PUSH);
  await d.go('#/sync');
  await d.page.click('#sync-now');           // Sync now skips the wait
  await waitSql('select id from public.media where record_id = $1', [id], (r) => r.length === 1, 30_000);
  await d.waitSynced();
});

test('F10 [P1] sync completes on a slow 3G connection', async ({ qa }) => {
  test.setTimeout(300_000);
  const d = await qa.device('deviceA', { user: 'a' });
  await d.open();
  const restore = await slow3g(d.page);
  const t0 = Date.now();
  const id = await d.createRecord({ title: uniq('F10 slow 3g'), fields: { ph: 6.6 }, photos: photos(3) });
  await d.go('#/records');
  const seen = new Set();
  const poll = setInterval(async () => {
    try { seen.add(await d.page.locator('#sb-text').textContent({ timeout: 500 })); seen.add(await d.row(id).getAttribute('data-status', { timeout: 500 })); } catch { /* repainting */ }
  }, 250);
  await waitSql('select id from public.media where record_id = $1', [id], (r) => r.length === 3, 180_000);
  await expect(d.row(id)).toHaveAttribute('data-status', 'synced', { timeout: 60_000 });
  clearInterval(poll);
  const seconds = (Date.now() - t0) / 1000;
  await restore();
  qa.note('seconds', seconds);
  qa.note('statesSeen', [...seen]);
  await d.shot('after-slow-3g');
  expect(await serverObjects(id)).toHaveLength(3);
  expect(await sql('select count(*)::int n from public.media where record_id = $1', [id])).toEqual([{ n: 3 }]);
  expect(await d.outbox()).toHaveLength(0);
  expect([...seen].some((s) => /Syncing \d of \d|uploading/.test(s ?? '')), 'progress was visible while it ran').toBe(true);
});

test('F11 [P1] two tabs of the same user syncing at once make no duplicates', async ({ qa }) => {
  const d = await qa.device('tab1', { user: 'a' });
  await d.open();
  const tab2 = await d.context.newPage();
  const errors2 = [];
  tab2.on('pageerror', (e) => errors2.push(e.message));
  tab2.on('console', (m) => { if (m.type() === 'error') errors2.push(m.text()); });
  const push2 = [];
  tab2.on('response', (r) => { if (/rpc\/sync_push|storage\/v1\/object/.test(r.url())) push2.push(`${r.status()} ${r.request().method()} ${r.url().split('/').slice(-1)[0].slice(0, 40)}`); });
  await tab2.goto(BASE_URL);
  await tab2.waitForSelector('html[data-ready="1"]');
  await d.offline();
  const title = uniq('F11 two tabs');
  const id = await d.createRecord({ title, fields: { ph: 6.1 }, photos: photos(3) });
  const id2 = await d.createRecord({ title: uniq('F11 two tabs second'), fields: { ph: 6.2 } });
  await d.editRecord(id2, { ph: 6.3 });
  await d.context.setOffline(false);          // both tabs get the "online" event together
  await waitSql('select id from public.media where record_id = $1', [id], (r) => r.length === 3, 60_000);
  await d.waitSynced(60_000);
  await expect(tab2.locator('#sb-text')).toHaveText('Online / all synced', { timeout: 60_000 });
  await sleep(3000);
  expect(await sql("select count(*)::int n from public.records where fields->>'title' = $1", [title])).toEqual([{ n: 1 }]);
  const media = await serverMedia(id);
  expect(media).toHaveLength(3);
  expect(await serverObjects(id)).toHaveLength(3);
  const s2 = await serverRecord(id2);
  expect(s2.fields.ph).toBe(6.3);
  qa.note('record2Version', s2.version);
  expect(await sql('select count(*)::int n from public.conflict_log where record_id = any($1::uuid[])', [[id, id2]]), 'a device never conflicts with itself').toEqual([{ n: 0 }]);
  const out = await d.outbox();
  expect(out, 'nothing left or rejected in the shared outbox').toEqual([]);
  await expect(tab2.locator(`#record-list [data-record-id="${id}"]`)).toHaveAttribute('data-status', 'synced', { timeout: 30_000 });
  await tab2.screenshot({ path: `${qa.dir}/tab2.png` });
  qa.note('tab2Requests', push2);
  qa.note('tab2Errors', errors2);
  qa.note('tab1Errors', d.console.filter((l) => /^\[(error|pageerror)\]/.test(l)));
  expect(errors2.filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
  expect(s2.version, 'create + one edit = version 2').toBe(2);
});

test('F12 [P1] a request that never answers does not stall sync for good', async ({ qa }) => {
  test.setTimeout(330_000);
  const d = await qa.device('deviceA', { user: 'a' });
  await d.open();
  let held = 0;
  let hold = true;
  await d.context.route(PUSH, (route) => { if (!hold) return route.continue(); held++; return new Promise(() => {}); }); // lie-fi: accepted, never answered
  const id = await d.createRecord({ title: uniq('F12 hung request'), fields: { ph: 6 } });
  await expect(async () => { expect(held).toBe(1); }).toPass({ timeout: 15_000 });
  await d.go('#/sync');
  await sleep(60_000);
  const after60 = { bar: await d.page.locator('#sb-text').textContent(), held, card: await d.page.locator('#pane-detail .notice').first().innerText() };
  await d.shot('after-60s-hung');
  hold = false;                                // the network is healthy again from here on
  // everything a user (or the phone) would do short of restarting the app
  await d.page.click('#sync-now').catch(() => {});
  await d.context.setOffline(true);
  await sleep(1500);
  await d.context.setOffline(false);
  const recovered = await waitSql('select id from public.records where id = $1', [id], (r) => r.length === 1, 90_000).then(() => true).catch(() => false);
  const after = { bar: await d.page.locator('#sb-text').textContent(), pushRequests: d.rpcRequests('sync_push').length, syncNowDisabled: await d.page.locator('#sync-now').isDisabled().catch(() => null) };
  await d.shot('after-network-healthy-90s');
  qa.note('after60sHung', after60);
  qa.note('after90sHealthy', after);
  qa.note('recoveredWithoutReload', recovered);
  // data is safe either way: a reload gets it out
  if (!recovered) {
    expect((await d.outbox()).some((o) => o.rowId === id)).toBe(true);
    await d.page.reload();
    await waitSql('select id from public.records where id = $1', [id], (r) => r.length === 1, 60_000);
    qa.note('recoveredAfterReload', true);
  }
  expect(recovered, `sync never restarted: bar "${after.bar}", ${after.pushRequests} push request(s) in total, also after Sync now and an offline/online cycle`).toBe(true);
});

test('F13 [P1] status bar shows online or offline, pending count and last sync time', async ({ qa }) => {
  const d = await qa.device('deviceA', { user: 'a' });
  await d.open();
  const bar = d.page.locator('#statusbar');
  const hhmm = (iso) => { const t = new Date(iso); return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`; };
  await expect(bar).toHaveAttribute('data-tone', 'online');
  await expect(d.page.locator('#sb-text')).toHaveText('Online / all synced');
  const last1 = await d.meta('lastSyncAt');
  // browser and Node share this machine's time zone, so the clock text can be compared
  const shown = await d.page.locator('#sb-right').textContent();
  const want = await d.page.evaluate((iso) => { const t = new Date(iso); return `Last sync ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`; }, last1);
  expect(shown).toBe(want);
  await d.offline();
  await expect(bar).toHaveAttribute('data-tone', 'offline');
  await expect(d.page.locator('#sb-text')).toHaveText('Offline / 0 pending');
  await d.createRecord({ title: uniq('F13 one'), fields: { ph: 6 }, photos: photos(3) });
  await expect(d.page.locator('#sb-text')).toHaveText('Offline / 1 pending');   // record + 3 photos + GPS = 1 pending record
  const id2 = await d.createRecord({ title: uniq('F13 two'), fields: { ph: 6 } });
  await expect(d.page.locator('#sb-text')).toHaveText('Offline / 2 pending');
  await d.editRecord(id2, { ph: 6.5 });
  await expect(d.page.locator('#sb-text')).toHaveText('Offline / 2 pending');
  await d.go('#/records');
  await expect(d.page.locator('[data-stat="pending"]')).toHaveText('02');
  await d.shot('offline-2-pending');
  // visible on every screen
  for (const route of ['tracks', 'sync', 'regions', 'storage', 'conflicts', 'new']) {
    await d.go(`#/${route}`);
    await expect(bar).toBeInViewport();
    await expect(d.page.locator('#sb-text')).toHaveText('Offline / 2 pending');
  }
  await d.go('#/records');
  const texts = new Set();
  const poll = setInterval(async () => { try { texts.add(`${await d.page.locator('#sb-text').textContent({ timeout: 300 })} | ${await d.page.locator('#sb-right').textContent({ timeout: 300 })}`); } catch { /* repaint */ } }, 100);
  await d.context.setOffline(false);
  await d.waitSynced();
  clearInterval(poll);
  qa.note('barTextsWhileSyncing', [...texts]);
  await expect(bar).toHaveAttribute('data-tone', 'online');
  const last2 = await d.meta('lastSyncAt');
  expect(new Date(last2).getTime()).toBeGreaterThan(new Date(last1).getTime());
  await expect(d.page.locator('#sb-right')).toHaveText(`Last sync ${hhmm(last2)}`);
  expect([...texts].some((t) => /^Syncing \d+ of \d+ \| \d+%$/.test(t) || t.startsWith('Back online')), 'progress or "Back online" shown while uploading').toBe(true);
  expect(state.ts).toBeTruthy();
});
