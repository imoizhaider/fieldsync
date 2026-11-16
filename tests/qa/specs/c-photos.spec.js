// C. Photos
import { resolve } from 'node:path';
import { statSync } from 'node:fs';
import { test, expect, state, sql, serverRecord, serverMedia, serverObjects, waitSql, uniq, photo, FIXTURES, ORIGIN } from '../lib/harness.js';

const photos = (n) => Array.from({ length: n }, (_, i) => photo(i + 1));

async function threeWay(d, id, n) {
  const local = await d.localMedia(id);
  const media = (await serverMedia(id)).filter((m) => !m.deleted);
  const objects = await serverObjects(id);
  expect(local, 'IndexedDB media rows').toHaveLength(n);
  expect(media, 'Postgres media rows').toHaveLength(n);
  expect(objects, 'Storage objects').toHaveLength(n);
  expect(new Set(media.map((m) => m.id)).size).toBe(n);
  expect(media.map((m) => m.position)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
  expect(objects.map((o) => o.name).sort()).toEqual(media.map((m) => m.storage_path).sort());
  for (const m of local) {
    expect(m.uploaded).toBe(1);
    expect(m.blob.type).toBe('image/jpeg');
    expect(Math.max(m.blob.width, m.blob.height)).toBeLessThanOrEqual(1280);
    const srv = media.find((x) => x.id === m.id);
    expect(srv.size_bytes).toBe(m.blob.size);
    const obj = objects.find((o) => o.name === srv.storage_path);
    expect(Number(obj.metadata.size)).toBe(m.blob.size);
    expect(obj.metadata.mimetype).toBe('image/jpeg');
  }
  return { local, media, objects };
}

test('C01 [P0] one photo on a record', async ({ qa }) => {
  const d = await qa.device('deviceA', { user: 'a' });
  await d.open();
  await d.offline();
  const id = await d.createRecord({ title: uniq('C01 one photo'), fields: { ph: 6.3 }, photos: photos(1) });
  const pending = await d.localMedia(id);
  expect(pending).toHaveLength(1);
  expect(pending[0].uploaded).toBe(0);
  expect(pending[0].blob.type).toBe('image/jpeg');
  expect((await d.outbox()).filter((o) => o.table === 'media' && o.recordId === id)).toHaveLength(1);
  await d.go('#/records');
  await expect(d.row(id).locator('.row-meta')).toContainText('1 photo');
  await d.online();
  await d.waitSynced();
  const r = await threeWay(d, id, 1);
  qa.note('photo', r.local[0].blob);
  await d.go(`#/record/${id}`);
  await expect(d.page.locator('#photos .photo.has-img')).toHaveCount(1);
  await d.shot('detail-one-photo');
});

test('C02 [P0] ten photos on a record', async ({ qa }) => {
  const d = await qa.device('deviceA', { user: 'a' });
  await d.open();
  await d.offline();
  const id = await d.createRecord({ title: uniq('C02 ten photos'), fields: { ph: 6.3 }, photos: photos(10) });
  expect(await d.localMedia(id)).toHaveLength(10);
  const t0 = Date.now();
  await d.context.setOffline(false);
  await waitSql('select id from public.media where record_id = $1', [id], (r) => r.length === 10, 60_000);
  qa.note('uploadSecondsFor10', (Date.now() - t0) / 1000);
  await d.waitSynced();
  const r = await threeWay(d, id, 10);
  qa.note('sizesKb', r.local.map((m) => Math.round(m.blob.size / 1024)));
  await d.go(`#/record/${id}`);
  await expect(d.page.locator('#photos .photo.has-img')).toHaveCount(10);
  await d.shot('detail-ten-photos');
  expect(await sql("select count(*)::int n from public.records where fields->>'title' = (select fields->>'title' from public.records where id = $1)", [id])).toEqual([{ n: 1 }]);
});

test('C03 [P0] an 11 MB image is compressed to 1280 px before it is stored', async ({ qa }) => {
  const big = resolve(FIXTURES, 'big-11mb.bmp');
  const sourceBytes = statSync(big).size;
  expect(sourceBytes).toBeGreaterThan(10 * 1024 * 1024);
  const d = await qa.device('deviceA', { user: 'a' });
  await d.open();
  await d.offline();
  const t0 = Date.now();
  const id = await d.createRecord({ title: uniq('C03 big photo'), fields: { ph: 6 }, photos: [big] });
  const m = (await d.localMedia(id))[0];
  qa.note('source', { bytes: sourceBytes, width: 2400, height: 1600 });
  qa.note('stored', m.blob);
  qa.note('compressAndSaveMs', Date.now() - t0);
  expect(m.blob.type).toBe('image/jpeg');
  expect(Math.max(m.blob.width, m.blob.height)).toBe(1280);
  expect(m.blob.width).toBe(1280);
  expect(m.blob.height).toBe(853);
  expect(m.blob.size).toBeLessThan(sourceBytes / 10);
  await d.online();
  await d.waitSynced();
  await threeWay(d, id, 1);
  if (m.blob.size > 300 * 1024) qa.finding(`A noisy 11 MB source compresses to ${Math.round(m.blob.size / 1024)} KB, above the PRD's "about 150 to 300 KB" target (quality is fixed at 70 %, there is no size cap).`);
});

test('C04 [P2] a file that is not an image is refused with a clear message', async ({ qa }) => {
  const d = await qa.device('deviceA', { user: 'a' });
  await d.open();
  await d.go('#/new');
  await d.page.waitForSelector('#record-form');
  const title = uniq('C04 non image');
  await d.page.fill('[data-field="title"]', title);
  const messages = {};
  for (const name of ['not-an-image.txt', 'fake-image.jpg']) {
    await d.page.setInputFiles('#library-input', resolve(FIXTURES, name));
    const alert = d.page.locator('#record-form [role="alert"]');
    await expect(alert).toBeVisible();
    messages[name] = await alert.textContent();
    await expect(d.page.locator('#photo-count')).toHaveText('Photos / 0');
    await expect(d.page.locator('#add-photo')).toHaveText('Add');
    await expect(d.page.locator('#save-record')).toBeEnabled();
  }
  qa.note('messages', messages);
  await d.shot('non-image-message');
  // typed text survived the error, a good photo can still be added, and the record saves
  expect(await d.page.locator('[data-field="title"]').inputValue()).toBe(title);
  await d.page.setInputFiles('#library-input', [resolve(FIXTURES, 'not-an-image.txt'), photo(1)]);
  await d.page.waitForTimeout(1500);
  const mixed = await d.page.locator('#photo-count').textContent();
  qa.note('mixedSelection', mixed);
  if (mixed !== 'Photos / 1') qa.finding(`Picking a bad file together with a good photo drops the good one too (${mixed}): the loop stops at the first unreadable file.`);
  await d.page.setInputFiles('#library-input', photo(2));
  await expect(d.page.locator('#photo-count')).toHaveText(/Photos \/ [12]/);
  await expect(d.page.locator('#gps-box')).toHaveAttribute('data-gps', 'fixed');
  await d.page.click('#save-record');
  await d.page.waitForFunction(() => !document.querySelector('#record-form'));
  await d.waitSynced();
  const rec = (await d.idb(['records'])).records.find((r) => r.fields.title === title);
  expect(await serverRecord(rec.id)).toBeTruthy();
  for (const m of Object.values(messages)) {
    expect(m, 'message names the problem in plain words').toMatch(/photo|image|picture/i);
    expect(m).not.toMatch(/undefined|TypeError|InvalidStateError|DOMException/i);
  }
  if (Object.values(messages).some((m) => /decoded/.test(m))) qa.finding(`The message for a non-image file is the browser's raw error text ("${Object.values(messages)[0]}"). Understandable, but not written for a field researcher.`);
});

test('C05 [P2] camera permission denied: Permissions screen, library still works', async ({ qa }) => {
  const d = await qa.device('deviceA', { user: 'a' });
  const cdp = await d.context.newCDPSession(d.page);
  await cdp.send('Browser.setPermission', { permission: { name: 'camera' }, setting: 'denied', origin: ORIGIN });
  await d.open();
  expect(await d.page.evaluate(async () => (await navigator.permissions.query({ name: 'camera' })).state)).toBe('denied');
  await d.go('#/new');
  await d.page.waitForSelector('#record-form');
  const title = uniq('C05 camera blocked');
  await d.page.fill('[data-field="title"]', title);
  await d.page.fill('#record-form input[data-field="ph"]', '6.7');
  await d.page.click('#add-photo');
  await d.page.waitForFunction(() => document.body.dataset.route === 'permissions');
  await expect(d.page.locator('h1')).toHaveText('Permissions');
  const camRow = d.page.locator('.row', { hasText: 'Camera' }).first();
  await expect(camRow.locator('.status')).toHaveText('Blocked');
  await d.shot('permissions-blocked');
  // "Try again" keeps you here while the camera is still blocked
  await d.page.click('[data-act="camera-retry"]');
  await expect(d.page.locator('h1')).toHaveText('Permissions');
  const chooser = d.page.waitForEvent('filechooser');
  await d.page.click('[data-act="library"]');
  await (await chooser).setFiles(photo(1));
  await d.page.waitForFunction(() => document.body.dataset.route === 'new');
  await expect(d.page.locator('#photo-count')).toHaveText('Photos / 1');
  // the draft was not lost on the way
  expect(await d.page.locator('[data-field="title"]').inputValue()).toBe(title);
  expect(await d.page.locator('#record-form input[data-field="ph"]').inputValue()).toBe('6.7');
  await d.page.click('#save-record');
  await d.page.waitForFunction(() => !document.querySelector('#record-form'));
  await d.waitSynced();
  const rec = (await d.idb(['records'])).records.find((r) => r.fields.title === title);
  expect(await serverMedia(rec.id)).toHaveLength(1);
});

test('C06 [P1] deleting a synced photo reaches the server and the other device', async ({ qa }) => {
  const a = await qa.device('deviceA', { user: 'a' });
  const b = await qa.device('deviceB', { user: 'b' });
  await a.open();
  await b.open();
  const id = await a.createRecord({ title: uniq('C06 delete photo'), fields: { ph: 6 }, photos: photos(2) });
  await a.waitSynced();
  await b.syncNow();
  expect(await b.localMedia(id)).toHaveLength(2);
  const before = await a.localMedia(id);
  await a.go(`#/edit/${id}`);
  await a.page.waitForSelector('#record-form');
  await expect(a.page.locator('#photo-count')).toHaveText('Photos / 2');
  await a.page.click(`[data-remove-existing="${before[0].id}"]`);
  await expect(a.page.locator('#photo-count')).toHaveText('Photos / 1');
  await a.page.click('#save-record');
  await a.page.waitForFunction(() => !document.querySelector('#record-form'));
  await a.waitSynced();
  expect((await a.localMedia(id)).map((m) => m.id)).toEqual([before[1].id]);
  const media = await serverMedia(id);
  expect(media.find((m) => m.id === before[0].id).deleted).toBe(true);
  expect(media.find((m) => m.id === before[1].id).deleted).toBe(false);
  await a.go(`#/record/${id}`);
  await expect(a.page.locator('#photos .photo')).toHaveCount(1);
  await b.syncNow();
  expect((await b.localMedia(id)).map((m) => m.id)).toEqual([before[1].id]);
  await b.go(`#/record/${id}`);
  await expect(b.page.locator('#photos .photo')).toHaveCount(1);
  const objects = await serverObjects(id);
  qa.note('storageObjectsAfterDelete', objects.map((o) => o.name));
  if (objects.length === 2) qa.finding('The file of a deleted photo stays in Storage for good (only the media row is flagged). Nothing ever removes it, so deleted photos keep counting against the 1 GB free plan.');
  // a photo removed before it was ever uploaded leaves no trace
  await a.offline();
  await a.go(`#/edit/${id}`);
  await a.page.waitForSelector('#record-form');
  await a.page.setInputFiles('#library-input', photo(3));
  await expect(a.page.locator('#photo-count')).toHaveText('Photos / 2');
  await a.page.click('[data-remove-new="0"]');
  await expect(a.page.locator('#photo-count')).toHaveText('Photos / 1');
  await a.page.click('#save-record');
  await a.page.waitForFunction(() => !document.querySelector('#record-form'));
  expect((await a.outbox()).filter((o) => o.table === 'media')).toHaveLength(0);
  await a.online();
});

test('C07 [P2] photos of a record that is deleted later', async ({ qa }) => {
  const a = await qa.device('deviceA', { user: 'a' });
  const b = await qa.device('deviceB', { user: 'b' });
  await a.open();
  await b.open();
  const id = await a.createRecord({ title: uniq('C07 deleted with photos'), fields: { ph: 6 }, photos: photos(2) });
  await a.waitSynced();
  await b.syncNow();
  await b.go(`#/record/${id}`);
  await expect(b.page.locator('#photos .photo.has-img')).toHaveCount(2, { timeout: 30_000 });
  await a.deleteRecord(id);
  await a.waitSynced();
  await b.syncNow();
  await b.go('#/records');
  await expect(b.row(id)).toHaveCount(0);
  await expect(a.row(id)).toHaveCount(0);
  expect((await serverRecord(id)).deleted).toBe(true);
  const media = await serverMedia(id);
  const objects = await serverObjects(id);
  qa.note('server', { mediaRows: media.length, mediaFlaggedDeleted: media.filter((m) => m.deleted).length, storageObjects: objects.length });
  qa.note('deviceB', { localMediaRows: (await b.localMedia(id)).length, withBlob: (await b.localMedia(id)).filter((m) => m.blob).length });
  qa.finding(`After the record is deleted its ${media.length} photos stay as live media rows and ${objects.length} files in Storage, and device B keeps the downloaded blobs. That allows a restore, but nothing ever purges them.`);

  // offline: create with photos and delete again before the first sync
  await a.offline();
  const id2 = await a.createRecord({ title: uniq('C07 never synced'), fields: { ph: 6 }, photos: photos(2) });
  await a.deleteRecord(id2);
  expect(await a.localMedia(id2)).toHaveLength(0);
  expect((await a.outbox()).filter((o) => o.table === 'media')).toHaveLength(0);
  await a.online();
  await a.waitSynced();
  expect(await serverMedia(id2)).toHaveLength(0);
  expect(await serverObjects(id2)).toHaveLength(0);
  const s2 = await serverRecord(id2);
  qa.note('neverSyncedRecordOnServer', s2 ? { deleted: s2.deleted, version: s2.version } : null);
  expect(!s2 || s2.deleted).toBe(true);
});

test('C08 [P1] a photo taken on device A is shown on device B', async ({ qa }) => {
  const a = await qa.device('deviceA', { user: 'a' });
  const b = await qa.device('deviceB', { user: 'b' });
  await a.open();
  await b.open();
  const id = await a.createRecord({ title: uniq('C08 shared photo'), fields: { ph: 6 }, photos: photos(3) });
  await a.waitSynced();
  await b.syncNow();
  const meta = await b.localMedia(id);
  expect(meta).toHaveLength(3);
  expect(meta.every((m) => m.blob === null), 'B has rows but no blobs yet').toBe(true);
  await b.go('#/records');
  await expect(b.row(id).locator('.row-meta')).toContainText('3 photos');
  await b.go(`#/record/${id}`);
  await expect(b.page.locator('#photos .photo.has-img')).toHaveCount(3, { timeout: 30_000 });
  const got = await b.localMedia(id);
  const src = await a.localMedia(id);
  expect(got.map((m) => m.blob?.size)).toEqual(src.map((m) => m.blob.size));
  await b.shot('photos-on-device-b');
  // and they are still there with the network off
  await b.offline();
  await b.page.reload();
  await b.page.waitForSelector('html[data-ready="1"]');
  await expect(b.page.locator('#photos .photo.has-img')).toHaveCount(3);
});

test('C09 [P2] free space removes local copies, reopening the record fetches them again', async ({ qa }) => {
  const d = await qa.device('deviceA', { user: 'a' });
  await d.open();
  const id = await d.createRecord({ title: uniq('C09 free space'), fields: { ph: 6 }, photos: photos(2) });
  await d.waitSynced();
  await d.go('#/storage');
  await expect(d.page.locator('#free-space')).toBeEnabled();
  await d.page.click('#free-space');
  await expect(d.page.locator('#pane-detail [role="status"]')).toContainText(/Removed \d+ synced photos? from this device/);
  await d.shot('storage-after-free');
  expect((await d.localMedia(id)).every((m) => m.blob === null && m.uploaded === 1)).toBe(true);
  expect(await serverObjects(id)).toHaveLength(2);
  await d.go(`#/record/${id}`);
  await expect(d.page.locator('#photos .photo.has-img')).toHaveCount(2, { timeout: 30_000 });
  expect((await d.localMedia(id)).every((m) => m.blob && m.blob.size > 0)).toBe(true);
  expect(state.regions.main).toBeTruthy();
});
