import { test, expect, sql, serverRecord, GEO, uniq, snap } from './helpers.js';

test('T1 offline create with 3 photos and a GPS point survives a reload and shows Pending sync', async ({ deviceA }) => {
  const { page } = deviceA;
  await deviceA.open();
  await deviceA.offline();
  await expect(page.locator('#sb-text')).toHaveText('Offline / 0 pending');

  const title = uniq('T1 soil');
  const id = await deviceA.createRecord({ title, fields: { ph: 6.4, moisture: 22, temperature: 18.5, depth: 15 }, notes: 'Dark loam, damp near the roots.', photos: 3 });

  // Screen: saved at once, marked pending.
  await expect(deviceA.row(id)).toHaveAttribute('data-status', 'pending');
  await expect(deviceA.row(id).locator('.status')).toHaveText('Pending');
  await expect(deviceA.row(id).locator('.status')).toHaveAttribute('title', 'Pending sync');
  await expect(page.locator('#sb-text')).toHaveText('Offline / 1 pending');
  await snap(page, 'offline-pending');

  // IndexedDB: record, 3 compressed photos, GPS point, and the outbox entries.
  const inspect = () => deviceA.idb(async (db, rid) => {
    const media = await db.media.where('recordId').equals(rid).toArray();
    const sizes = [];
    for (const m of media) {
      const bmp = await createImageBitmap(m.blob);
      sizes.push({ w: bmp.width, h: bmp.height, type: m.blob.type, bytes: m.blob.size, uploaded: m.uploaded });
    }
    return {
      record: await db.records.get(rid),
      photos: sizes,
      gps: await db.gpsLogs.where('recordId').equals(rid).toArray(),
      outbox: (await db.outbox.where('recordId').equals(rid).toArray()).map((e) => ({ table: e.table, kind: e.kind, status: e.status })),
    };
  }, id);
  const check = (local) => {
    expect(local.record.fields).toMatchObject({ title, ph: 6.4, moisture: 22, temperature: 18.5, depth: 15, notes: 'Dark loam, damp near the roots.' });
    expect(local.record.version).toBe(0);
    expect(local.photos).toHaveLength(3);
    for (const p of local.photos) {
      expect(p.type).toBe('image/jpeg');
      expect(Math.max(p.w, p.h)).toBe(1280); // fixtures are 2400 x 1800
      expect(p.h).toBe(960);
      expect(p.bytes).toBeLessThan(600_000);
      expect(p.uploaded).toBe(0);
    }
    expect(local.gps).toHaveLength(1);
    expect(local.gps[0].points[0].lat).toBeCloseTo(GEO.latitude, 4);
    expect(local.gps[0].points[0].lng).toBeCloseTo(GEO.longitude, 4);
    expect(local.outbox.map((e) => e.table).sort()).toEqual(['gps_logs', 'media', 'media', 'media', 'records']);
    expect(local.outbox.every((e) => e.status === 'queued')).toBe(true);
  };
  check(await inspect());

  // Server: nothing has left the device.
  expect(await serverRecord(id)).toBeNull();

  // Reload with the network still off.
  await page.reload();
  await page.waitForSelector('html[data-ready="1"]');
  await expect(page.locator('#sb-text')).toHaveText('Offline / 1 pending');
  await expect(deviceA.row(id)).toHaveAttribute('data-status', 'pending');
  await expect(deviceA.row(id)).toContainText(title);
  await expect(deviceA.row(id)).toContainText('3 photos / GPS');
  check(await inspect());

  // The detail screen shows the photos and the point.
  await deviceA.row(id).click();
  await expect(page.locator('#record-status')).toHaveText('Pending');
  await expect(page.locator('#photos .photo.has-img')).toHaveCount(3);
  await expect(page.locator('#gps-line')).toContainText('24.8607 n, 67.0011 e');
  expect(await serverRecord(id)).toBeNull();
});

test('T2 going online uploads the record and photos with no button press', async ({ deviceA }) => {
  const { page } = deviceA;
  await deviceA.open();
  await deviceA.offline();
  const title = uniq('T2 soil');
  const id = await deviceA.createRecord({ title, fields: { ph: 7.1, moisture: 30 }, notes: 'Auto sync check', photos: 3 });
  await expect(deviceA.row(id)).toHaveAttribute('data-status', 'pending');
  expect(await serverRecord(id)).toBeNull();

  // Network back. From here on the test never clicks anything.
  const started = Date.now();
  await deviceA.context.setOffline(false);
  await expect(page.locator('#back-online')).toContainText('You are back online');
  await snap(page, 'back-online');
  // The syncing state lasts a second or two; capture it when it shows.
  if (await page.waitForSelector('#record-list [data-status="uploading"]', { timeout: 5000 }).catch(() => null)) await snap(page, 'syncing');
  await expect(deviceA.row(id)).toHaveAttribute('data-status', 'synced', { timeout: 30_000 });
  await expect(deviceA.row(id).locator('.status')).toHaveText('Synced');
  await snap(page, 'all-synced');
  expect(Date.now() - started).toBeLessThan(30_000);
  await expect(page.locator('#sb-text')).toHaveText('Online / all synced');

  // Postgres and Storage.
  const row = await serverRecord(id);
  expect(row).not.toBeNull();
  expect(row.fields).toMatchObject({ title, ph: 7.1, moisture: 30, notes: 'Auto sync check' });
  expect(row.version).toBe(1);
  expect(row.deleted).toBe(false);
  const media = await sql('select id, storage_path, size_bytes from public.media where record_id = $1', [id]);
  expect(media).toHaveLength(3);
  const objects = await sql("select name, (metadata->>'size')::int as size, metadata->>'mimetype' as mime from storage.objects where bucket_id = 'photos' and name like $1", [`%/${id}/%`]);
  expect(objects.map((o) => o.name).sort()).toEqual(media.map((m) => m.storage_path).sort());
  for (const o of objects) {
    expect(o.mime).toBe('image/jpeg');
    expect(o.size).toBeGreaterThan(1000);
  }
  const gps = await sql('select points from public.gps_logs where record_id = $1', [id]);
  expect(gps).toHaveLength(1);
  expect(gps[0].points[0].lat).toBeCloseTo(GEO.latitude, 4);

  // IndexedDB: outbox empty, everything marked uploaded.
  const local = await deviceA.idb(async (db, rid) => ({
    outbox: await db.outbox.count(),
    record: await db.records.get(rid),
    uploaded: (await db.media.where('recordId').equals(rid).toArray()).map((m) => m.uploaded),
    gpsUploaded: (await db.gpsLogs.where('recordId').equals(rid).first()).uploaded,
    lastPulledAt: (await db.meta.get('lastPulledAt'))?.value,
  }), id);
  expect(local.outbox).toBe(0);
  expect(local.record.version).toBe(1);
  expect(local.uploaded).toEqual([1, 1, 1]);
  expect(local.gpsUploaded).toBe(1);
  expect(local.lastPulledAt).toBeTruthy();
});
