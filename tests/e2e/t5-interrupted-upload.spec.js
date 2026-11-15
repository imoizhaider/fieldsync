import { test, expect, sql, uniq, snap } from './helpers.js';

test('T5 a photo upload aborted mid-flight is retried after reconnect, with no duplicate photo or record', async ({ deviceA }) => {
  const { page, context } = deviceA;
  await deviceA.open();
  await deviceA.offline();
  const title = uniq('T5 soil');
  const id = await deviceA.createRecord({ title, fields: { ph: 5.9 }, photos: 3 });
  const before = await deviceA.outbox();
  const photoOps = before.filter((e) => e.table === 'media');
  expect(photoOps).toHaveLength(3);

  // Photo 1 goes through. Photo 2 reaches the server, but the connection is
  // cut before the answer arrives (the hardest case for duplicates). After
  // that the link stays down.
  let uploads = 0;
  let down = false;
  await context.route('**/storage/v1/object/photos/**', async (route) => {
    if (route.request().method() !== 'POST' && route.request().method() !== 'PUT') return route.continue();
    uploads++;
    if (down) return route.abort('internetdisconnected');
    if (uploads === 2) {
      await route.fetch().catch(() => null);
      down = true;
      return route.abort('connectionreset');
    }
    return route.continue();
  });

  await deviceA.context.setOffline(false);

  // The push stops at photo 2 and schedules a retry.
  await deviceA.go('#/sync');
  await expect(page.locator('#sync-retry')).toContainText('Upload interrupted', { timeout: 30_000 });
  await expect(page.locator('#outbox-list')).toContainText('dropped, backoff active');
  await expect(page.locator('#outbox-list .status.plain.retry')).toContainText(/Retry \d\d:\d\d/);
  await snap(page, 'sync-retry-backoff');

  // Outbox: photos 2 and 3 are untouched (same entries as before the push).
  const during = await deviceA.outbox();
  expect(during.map((e) => e.opId)).toEqual([photoOps[1].opId, photoOps[2].opId]);
  expect(during).toEqual([photoOps[1], photoOps[2]]);
  const mid = await deviceA.idb(async (db, rid) => (await db.media.where('recordId').equals(rid).sortBy('position')).map((m) => m.uploaded), id);
  expect(mid).toEqual([1, 0, 0]);
  expect(await sql('select id from public.media where record_id = $1', [id])).toHaveLength(1);
  await deviceA.go('#/records');
  await expect(deviceA.row(id)).toHaveAttribute('data-status', 'pending');

  // The connection is really gone for a moment, then comes back.
  await deviceA.offline();
  down = false;
  const uploadsBeforeReconnect = uploads;
  await deviceA.context.setOffline(false);

  // No button press: the reconnect starts the retry.
  await expect(deviceA.row(id)).toHaveAttribute('data-status', 'synced', { timeout: 30_000 });
  await expect(page.locator('#sb-text')).toHaveText('Online / all synced');

  // Photo 1 was not sent again; only photos 2 and 3 were.
  expect(uploads - uploadsBeforeReconnect).toBe(2);

  // Server: one record, three photos, each stored once.
  expect(await sql('select id from public.records where id = $1', [id])).toHaveLength(1);
  expect(await sql("select id from public.records where fields->>'title' = $1", [title])).toHaveLength(1);
  const media = await sql('select id, storage_path from public.media where record_id = $1', [id]);
  expect(media).toHaveLength(3);
  expect(new Set(media.map((m) => m.id)).size).toBe(3);
  const objects = await sql("select name from storage.objects where bucket_id = 'photos' and name like $1", [`%/${id}/%`]);
  expect(objects.map((o) => o.name).sort()).toEqual(media.map((m) => m.storage_path).sort());

  // Device: outbox empty, all three photos marked uploaded.
  expect(await deviceA.outbox()).toHaveLength(0);
  const after = await deviceA.idb(async (db, rid) => (await db.media.where('recordId').equals(rid).toArray()).map((m) => m.uploaded), id);
  expect(after).toEqual([1, 1, 1]);
});
