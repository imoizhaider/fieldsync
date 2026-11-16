// H. Idempotency and duplicates
import { randomUUID } from 'node:crypto';
import { test, expect, state, sql, api, serverRecord, serverMedia, serverObjects, waitSql, uniq, photo, sleep, BASE_URL, PUSH, UPLOAD } from '../lib/harness.js';

const photos = (n) => Array.from({ length: n }, (_, i) => photo(i + 1));
const titleCount = async (title) => (await sql("select count(*)::int n from public.records where fields->>'title' = $1", [title]))[0].n;
const isUpload = (route) => ['POST', 'PUT'].includes(route.request().method());

test('H01 [P0] an interrupted photo upload is retried and leaves exactly one photo', async ({ qa }) => {
  const d = await qa.device('deviceA', { user: 'a' });
  await d.open();
  await d.offline();
  const title = uniq('H01 interrupted upload');
  const id = await d.createRecord({ title, fields: { ph: 5.9 }, photos: photos(3) });
  const queued = (await d.outbox()).filter((o) => o.table === 'media');
  expect(queued).toHaveLength(3);
  // Photo 1 goes through. Photo 2 reaches the server but the answer is lost. Then the link is dead.
  let uploads = 0;
  let down = false;
  await d.context.route(UPLOAD, async (route) => {
    if (!isUpload(route)) return route.continue();
    uploads++;
    if (down) return route.abort('internetdisconnected');
    if (uploads === 2) { await route.fetch().catch(() => null); down = true; return route.abort('connectionreset'); }
    return route.continue();
  });
  await d.context.setOffline(false);
  await expect(async () => {
    expect((await d.localMedia(id)).map((m) => m.uploaded)).toEqual([1, 0, 0]);
    expect(uploads).toBeGreaterThanOrEqual(3);
  }).toPass({ timeout: 40_000 });
  const mid = (await d.outbox()).filter((o) => o.table === 'media');
  expect(mid).toEqual([queued[1], queued[2]]);
  expect(await serverMedia(id)).toHaveLength(1);
  qa.note('storageObjectsMidway', (await serverObjects(id)).length);
  await d.go('#/records');
  await expect(d.row(id)).toHaveAttribute('data-status', /pending|waiting/);
  await d.shot('midway');
  await d.offline();
  down = false;
  const sentBefore = uploads;
  await d.context.setOffline(false);
  await expect(d.row(id)).toHaveAttribute('data-status', 'synced', { timeout: 40_000 });
  expect(uploads - sentBefore, 'only the two unfinished photos were sent again').toBe(2);
  expect(await titleCount(title)).toBe(1);
  const media = await serverMedia(id);
  expect(media).toHaveLength(3);
  expect(new Set(media.map((m) => m.id)).size).toBe(3);
  expect((await serverObjects(id)).map((o) => o.name).sort()).toEqual(media.map((m) => m.storage_path).sort());
  expect(await d.outbox()).toEqual([]);
  expect((await d.localMedia(id)).map((m) => m.uploaded)).toEqual([1, 1, 1]);
});

test('H02 [P0] a record push whose answer is lost is retried without a duplicate', async ({ qa }) => {
  const d = await qa.device('deviceA', { user: 'a' });
  await d.open();
  await d.offline();
  const title = uniq('H02 lost answer');
  const id = await d.createRecord({ title, fields: { ph: 6.2 } });
  let lost = 0;
  const loseNext = async () => {
    let armed = true;
    await d.context.unroute(PUSH).catch(() => {});
    await d.context.route(PUSH, async (route) => {
      const ops = JSON.parse(route.request().postData()).p_ops;
      if (!armed || ops.length === 0) return route.continue();
      armed = false;
      lost++;
      await route.fetch().catch(() => null);   // the server applies it...
      return route.abort('connectionreset');   // ...but the device never hears back
    });
  };
  await loseNext();
  await d.context.setOffline(false);
  await d.waitSynced(60_000);
  expect(lost).toBe(1);
  expect(await titleCount(title)).toBe(1);
  let s = await serverRecord(id);
  expect(s.version).toBe(1);
  expect(await sql('select count(*)::int n from public.gps_logs where record_id = $1', [id])).toEqual([{ n: 1 }]);
  expect((await d.localRecord(id)).version).toBe(1);
  // same for an edit: applied once, version goes up by exactly one
  await d.offline();
  await d.editRecord(id, { ph: 6.9, notes: 'H02 edit' });
  await loseNext();
  await d.context.setOffline(false);
  await d.waitSynced(60_000);
  expect(lost).toBe(2);
  s = await serverRecord(id);
  expect(s.fields.ph).toBe(6.9);
  expect(s.version).toBe(2);
  expect(await sql('select count(*)::int n from public.conflict_log where record_id = $1', [id])).toEqual([{ n: 0 }]);
  // and for a delete
  await d.offline();
  await d.deleteRecord(id);
  await loseNext();
  await d.context.setOffline(false);
  await d.waitSynced(60_000);
  s = await serverRecord(id);
  expect(s.deleted).toBe(true);
  expect(s.version).toBe(3);
  await d.shot('after');
});

test('H03 [P0] the same outbox operation sent twice is applied once (API)', async ({ qa }) => {
  const a = await api('a');
  const dev = randomUUID();
  const rid = randomUUID();
  const title = uniq('H03 same op twice');
  const create = { op_id: randomUUID(), table: 'records', kind: 'upsert', row_id: rid, region_id: state.regions.main, type: 'soil', seq: 900, base_version: 0, changed: { title, ph: 6 } };
  const r1 = await a.push(dev, [create]);
  const r2 = await a.push(dev, [create]);
  const r3 = await a.push(dev, [create, create]);   // twice inside one call
  qa.note('create', [r1.json.results[0], r2.json.results[0], r3.json.results]);
  expect(r1.json.results[0].status).toBe('applied');
  expect(r1.json.results[0].duplicate).toBeUndefined();
  expect(r2.json.results[0]).toMatchObject({ status: 'applied', duplicate: true });
  expect(r3.json.results.every((x) => x.duplicate)).toBe(true);
  expect(await titleCount(title)).toBe(1);
  expect((await serverRecord(rid)).version).toBe(1);

  const edit = { op_id: randomUUID(), table: 'records', kind: 'upsert', row_id: rid, base_version: 1, changed: { ph: 7.5 } };
  await a.push(dev, [edit]);
  const e2 = await a.push(dev, [edit]);
  expect(e2.json.results[0].duplicate).toBe(true);
  expect((await serverRecord(rid)).version).toBe(2);

  // a client that loses its op id and sends the same row again under a new one
  const again = await a.push(dev, [{ ...create, op_id: randomUUID() }]);
  expect(again.json.results[0].status).toBe('applied');
  expect(await titleCount(title)).toBe(1);
  const afterAgain = await serverRecord(rid);
  qa.note('sameRowNewOpId', { version: afterAgain.version, ph: afterAgain.fields.ph });

  // GPS point and delete, twice each
  const gid = randomUUID();
  const gps = { op_id: randomUUID(), table: 'gps_logs', kind: 'upsert', row_id: gid, region_id: state.regions.main, record_id: rid, gps_kind: 'point', points: [{ lat: 1, lng: 2, acc: 3, t: new Date().toISOString() }] };
  await a.push(dev, [gps]);
  await a.push(dev, [gps]);
  expect(await sql('select version from public.gps_logs where id = $1', [gid])).toEqual([{ version: 1 }]);
  const del = { op_id: randomUUID(), table: 'records', kind: 'delete', row_id: rid, base_version: 2 };
  await a.push(dev, [del]);
  const v = (await serverRecord(rid)).version;
  await a.push(dev, [del]);
  expect((await serverRecord(rid)).version).toBe(v);
  expect(await sql('select count(*)::int n from public.applied_ops where op_id = any($1::uuid[])', [[create.op_id, edit.op_id, gps.op_id, del.op_id]])).toEqual([{ n: 4 }]);
});

test('H04 [P0] app closed in the middle of a sync, then reopened', async ({ qa }) => {
  const d = await qa.device('deviceA', { user: 'a' });
  await d.open();
  await d.offline();
  const title = uniq('H04 killed mid sync');
  const id = await d.createRecord({ title, fields: { ph: 6.3 }, photos: photos(3) });
  let uploads = 0;
  await d.context.route(UPLOAD, async (route) => {
    if (!isUpload(route)) return route.continue();
    uploads++;
    await sleep(2500);                         // slow link, so the app dies part-way
    return route.continue().catch(() => {});
  });
  await d.context.setOffline(false);
  await waitSql('select id from public.media where record_id = $1', [id], (r) => r.length >= 1, 40_000);
  await sleep(800);                            // photo 2 is now on its way
  await d.page.close({ runBeforeUnload: false });
  const midway = { mediaRows: (await serverMedia(id)).length, objects: (await serverObjects(id)).length, uploadsStarted: uploads };
  qa.note('whenKilled', midway);
  expect(midway.mediaRows).toBeLessThan(3);
  await d.context.unroute(UPLOAD);
  const page = await d.context.newPage();
  d.page = page;
  d.watch(page);
  await page.goto(BASE_URL);
  await page.waitForSelector('html[data-ready="1"]');
  await d.waitSynced(60_000);
  await expect(d.row(id)).toHaveAttribute('data-status', 'synced');
  expect(await titleCount(title)).toBe(1);
  const media = await serverMedia(id);
  expect(media).toHaveLength(3);
  expect(new Set(media.map((m) => m.id)).size).toBe(3);
  expect(await serverObjects(id)).toHaveLength(3);
  expect((await d.localMedia(id)).map((m) => m.uploaded)).toEqual([1, 1, 1]);
  expect((await serverRecord(id)).version).toBe(1);
  await d.shot('after-reopen');
});

test('H05 [P1] a double click on Save makes one record', async ({ qa }) => {
  const d = await qa.device('deviceA', { user: 'a' });
  await d.open();
  await d.go('#/new');
  await d.page.waitForSelector('#record-form');
  const title = uniq('H05 double click');
  await d.page.fill('[data-field="title"]', title);
  await d.page.fill('#record-form input[data-field="ph"]', '6.4');
  await d.page.setInputFiles('#library-input', photos(2));
  await expect(d.page.locator('#photo-count')).toHaveText('Photos / 2');
  await expect(d.page.locator('#gps-box')).toHaveAttribute('data-gps', 'fixed');
  await d.page.evaluate(() => { const b = document.querySelector('#save-record'); b.click(); b.click(); b.click(); document.querySelector('#record-form').requestSubmit(); });
  await d.page.waitForFunction(() => !document.querySelector('#record-form'));
  await d.page.waitForTimeout(800);
  const local = (await d.idb(['records'])).records.filter((r) => r.fields.title === title);
  expect(local).toHaveLength(1);
  await d.waitSynced();
  expect(await titleCount(title)).toBe(1);
  expect(await serverMedia(local[0].id)).toHaveLength(2);
  // same for the delete confirmation and for Enter in the title field
  await d.go('#/new');
  await d.page.waitForSelector('#record-form');
  const title2 = uniq('H05 enter key');
  await d.page.fill('[data-field="title"]', title2);
  await expect(d.page.locator('#gps-box')).toHaveAttribute('data-gps', 'fixed');
  await d.page.press('[data-field="title"]', 'Enter');
  await d.page.press('[data-field="title"]', 'Enter');
  const enterSaves = await d.page.waitForFunction(() => !document.querySelector('#record-form'), null, { timeout: 4000 }).then(() => true).catch(() => false);
  qa.note('enterKeyInTitleSaves', enterSaves);
  if (!enterSaves) {
    qa.finding('Pressing Enter in a text field of the record form does nothing; the record is saved only with the Save button.');
    await d.page.dblclick('#save-record').catch(() => {});
    await d.page.waitForFunction(() => !document.querySelector('#record-form'));
  }
  expect((await d.idb(['records'])).records.filter((r) => r.fields.title === title2)).toHaveLength(1);
  await d.waitSynced();
  expect(await titleCount(title2)).toBe(1);
});
