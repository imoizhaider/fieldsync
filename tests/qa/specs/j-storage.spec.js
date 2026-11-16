// J. Storage limits
import { test, expect, state, serverMedia, uniq, photo } from '../lib/harness.js';

const quota = (pct) => new Function(`navigator.storage.estimate = async () => ({ usage: ${pct} * 1e6, quota: 100 * 1e6 });`);

test('J01 [P1] "Storage almost full" appears when the quota is low', async ({ qa }) => {
  const d = await qa.device('deviceA', { user: 'a', init: [quota(85)] });
  await d.open();
  await d.go('#/records');
  const banner = d.page.locator('.notice.bad');
  await expect(banner).toContainText('Storage almost full');
  await expect(banner).toContainText('85% used');
  await d.shot('banner-on-list');
  await banner.locator('a[href="#/storage"]').click();
  await d.page.waitForFunction(() => document.body.dataset.route === 'storage');
  await expect(d.page.locator('#storage-card')).toHaveClass(/bad/);
  await expect(d.page.locator('#storage-card h2')).toHaveText('Storage almost full');
  await expect(d.page.locator('#storage-card')).toContainText('85% used');
  await d.shot('storage-almost-full');
  // the warning on the other main screens (recorded)
  const elsewhere = {};
  for (const r of ['new', 'sync', 'tracks']) { await d.go(`#/${r}`); elsewhere[r] = await d.page.locator('#pane-detail', { hasText: 'Storage almost full' }).count(); }
  qa.note('warningOnOtherScreens', elsewhere);
  if (elsewhere.new === 0) qa.finding('The storage warning is shown only on the record list. The New record screen, where photos are added, gives no hint that space is nearly gone.');
  // just under the limit: no warning
  const ok = await qa.device('deviceB', { user: 'b', init: [quota(79)] });
  await ok.open();
  await ok.go('#/records');
  await expect(ok.page.locator('.notice.bad')).toHaveCount(0);
  await ok.go('#/storage');
  await expect(ok.page.locator('#storage-card h2')).toHaveText('Storage is fine');
});

test('J02 [P1] persistent storage is requested', async ({ qa }) => {
  const spy = () => {
    window.__persist = { calls: 0, answers: [] };
    const real = navigator.storage.persist.bind(navigator.storage);
    navigator.storage.persist = async () => { window.__persist.calls++; const r = await real(); window.__persist.answers.push(r); return r; };
  };
  const d = await qa.device('deviceA', { init: [spy] });
  d.userKey = 'a';
  await d.open('', { sync: false });
  expect((await d.page.evaluate(() => window.__persist)).calls, 'not asked before sign-in').toBe(0);
  await d.page.fill('input[name="email"]', state.users.a.email);
  await d.page.fill('input[name="password"]', state.password);
  await d.page.click('button[type="submit"]');
  await d.page.waitForFunction(() => document.body.dataset.route === 'records', null, { timeout: 30_000 });
  await d.waitSynced();
  const p = await d.page.evaluate(async () => ({ ...window.__persist, persisted: await navigator.storage.persisted() }));
  qa.note('persist', p);
  expect(p.calls).toBeGreaterThanOrEqual(1);
  expect(await d.meta('persisted')).toBe(p.answers[0]);
  await d.go('#/storage');
  const row = d.page.locator('li.row', { hasText: 'Storage protection' });
  const shown = await row.locator('.status').textContent();
  qa.note('shown', shown);
  await d.shot('storage-protection');
  expect(shown).toBe(p.persisted ? 'Granted' : 'Requested');
  if (!p.persisted) qa.finding('When the browser refuses persistent storage the app shows "Requested", the same word as while waiting. The researcher is never told that the browser said no and that data may be cleared under storage pressure.');
});

test('J03 [P0] when IndexedDB refuses a write nothing is half saved', async ({ qa }) => {
  // Fails writes to one chosen object store, like a full disk would.
  const breaker = () => {
    window.__failStore = null;
    for (const m of ['add', 'put']) {
      const real = IDBObjectStore.prototype[m];
      IDBObjectStore.prototype[m] = function (...args) {
        if (window.__failStore && this.name === window.__failStore) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        return real.apply(this, args);
      };
    }
  };
  const d = await qa.device('deviceA', { user: 'a', init: [breaker] });
  await d.open();
  await d.offline();
  const results = {};
  for (const store of ['outbox', 'media', 'records']) {
    await d.go('#/new');
    await d.page.waitForSelector('#record-form');
    const title = uniq(`J03 fail ${store}`);
    await d.page.fill('[data-field="title"]', title);
    await d.page.fill('#record-form input[data-field="ph"]', '6.4');
    await d.page.fill('[data-field="notes"]', 'typed before the disk filled up');
    await d.page.setInputFiles('#library-input', photo(1));
    await expect(d.page.locator('#photo-count')).toHaveText('Photos / 1');
    await expect(d.page.locator('#gps-box')).toHaveAttribute('data-gps', 'fixed');
    const before = await d.idb(['records', 'media', 'gpsLogs', 'outbox']);
    await d.page.evaluate((s) => { window.__failStore = s; }, store);
    await d.page.click('#save-record');
    const alert = d.page.locator('#record-form [role="alert"]');
    await expect(alert, `message when ${store} fails`).toBeVisible();
    results[store] = await alert.textContent();
    await expect(alert).toContainText('Could not save on this device');
    await d.shot(`write-failed-${store}`);
    // nothing half saved
    const after = await d.idb(['records', 'media', 'gpsLogs', 'outbox']);
    for (const s of ['records', 'media', 'gpsLogs', 'outbox']) expect(after[s].length, `${s} rows after a failed save (${store} failing)`).toBe(before[s].length);
    // the form still holds everything
    expect(await d.page.locator('[data-field="title"]').inputValue()).toBe(title);
    expect(await d.page.locator('[data-field="notes"]').inputValue()).toBe('typed before the disk filled up');
    await expect(d.page.locator('#photo-count')).toHaveText('Photos / 1');
    await expect(d.page.locator('#save-record')).toBeEnabled();
    // space is freed: the same Save now works
    await d.page.evaluate(() => { window.__failStore = null; });
    await d.page.click('#save-record');
    await d.page.waitForFunction(() => !document.querySelector('#record-form'));
    const rec = (await d.idb(['records'])).records.find((r) => r.fields.title === title);
    expect(rec).toBeTruthy();
    expect(await d.localMedia(rec.id)).toHaveLength(1);
  }
  qa.note('messages', results);
  // an edit that cannot be written leaves the record as it was
  const id = (await d.idb(['records'])).records.find((r) => r.fields.title?.startsWith('J03 fail outbox')).id;
  const was = await d.localRecord(id);
  await d.go(`#/edit/${id}`);
  await d.page.waitForSelector('#record-form');
  await d.page.fill('#record-form input[data-field="ph"]', '9.1');
  await d.page.evaluate(() => { window.__failStore = 'outbox'; });
  await d.page.click('#save-record');
  await expect(d.page.locator('#record-form [role="alert"]')).toBeVisible();
  expect(await d.localRecord(id)).toEqual(was);
  await d.page.evaluate(() => { window.__failStore = null; });
  await d.page.click('a.back');
  await d.context.setOffline(false);
  await d.waitSynced();
});

test('J04 [P1] free space only removes photos that are already on the server', async ({ qa }) => {
  const d = await qa.device('deviceA', { user: 'a' });
  await d.open();
  const synced = await d.createRecord({ title: uniq('J04 synced'), fields: { ph: 6 }, photos: [photo(1), photo(2)] });
  await d.waitSynced();
  await d.offline();
  const pending = await d.createRecord({ title: uniq('J04 pending'), fields: { ph: 6 }, photos: [photo(3), photo(4)] });
  await d.go('#/storage');
  await expect(d.page.locator('li.row', { hasText: 'Pending photos' }).locator('.row-meta')).toHaveText('2 / not uploaded yet');
  await d.shot('storage-before');
  await d.page.click('#free-space');
  await expect(d.page.locator('#pane-detail [role="status"]')).toContainText('still on the server');
  expect((await d.localMedia(synced)).every((m) => m.blob === null)).toBe(true);
  const kept = await d.localMedia(pending);
  expect(kept).toHaveLength(2);
  expect(kept.every((m) => m.blob?.size > 0 && m.uploaded === 0), 'pending photos keep their data').toBe(true);
  await expect(d.page.locator('#free-space')).toBeDisabled();
  // offline, the freed photos show as empty tiles (nothing crashes)
  await d.go(`#/record/${synced}`);
  await expect(d.page.locator('#photos .photo')).toHaveCount(2);
  await d.shot('freed-photos-offline');
  await d.context.setOffline(false);
  await d.waitSynced();
  expect(await serverMedia(pending)).toHaveLength(2);
});
