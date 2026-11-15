import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { test, expect, sql, serverRecord, seed, env, uniq, snap } from './helpers.js';
import { ROOT } from '../../scripts/env.mjs';

const REGION_A = seed.regions['Region A'];
const REGION_B = seed.regions['Region B']; // Researcher B is NOT assigned here
const REGION_C = seed.regions['Region C']; // view only for both researchers

// A raw API client holding Researcher B's real session: what an attacker with
// the public key and a valid login could do without the app.
function clientAs(userKey) {
  const state = JSON.parse(readFileSync(resolve(ROOT, `tests/.auth/${userKey}.json`), 'utf8'));
  const session = JSON.parse(state.origins[0].localStorage[0].value);
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${session.access_token}` } },
  });
}

test('G8 a write by Researcher B to a region not assigned to them is rejected and the app shows Sync rejected', async ({ deviceA, deviceB }) => {
  const { page } = deviceB;
  await deviceB.open();

  // Row Level Security: B's device was never even told that Region B exists.
  const known = await deviceB.idb(async (db) => (await db.meta.get('regions')).value.map((r) => `${r.name}:${r.role}`));
  expect(known.sort()).toEqual(['Region A:editor', 'Region C:viewer']);

  // A change for Region B gets into B's outbox anyway (stale assignment or a
  // tampered device). It goes through the app's own store and sync engine.
  const title = uniq('G8 water');
  const id = await page.evaluate(async ({ regionId, t }) => {
    const { createRecord } = await import('./js/store.js');
    return createRecord({ regionId, type: 'water', fields: { title: t, turbidity: 12 } });
  }, { regionId: REGION_B, t: title });

  // Screen: the status bar and the Sync screen both say so.
  await expect(page.locator('#sb-text')).toHaveText('Online / sync problem', { timeout: 30_000 });
  await expect(page.locator('#statusbar')).toHaveAttribute('data-tone', 'problem');
  await deviceB.go('#/sync');
  await expect(page.locator('#sync-rejected')).toContainText('Server rejected 1 change');
  await expect(page.locator('#sync-rejected')).toContainText('Nothing is lost. It is still safe on this device.');
  await expect(page.locator('#reject-reason')).toContainText('you are not assigned to this region');
  await expect(page.locator('#outbox-list [data-op-status="rejected"]')).toContainText('Failed');
  await snap(page, 'sync-rejected');

  // IndexedDB: the change is still on the device, marked rejected, not synced.
  const outbox = await deviceB.outbox();
  expect(outbox).toHaveLength(1);
  expect(outbox[0]).toMatchObject({ rowId: id, table: 'records', status: 'rejected' });
  expect((await deviceB.localRecord(id)).fields.title).toBe(title);
  expect((await deviceB.localRecord(id)).version).toBe(0);

  // Postgres: nothing was written.
  expect(await serverRecord(id)).toBeNull();

  // Retry is still refused while the assignment is missing.
  const answered = page.waitForResponse((r) => r.url().includes('/rpc/sync_push') && r.request().postData()?.includes(id));
  await page.click('#retry-sync');
  expect((await (await answered).json()).results[0]).toMatchObject({ status: 'rejected', row_id: id });
  await expect.poll(async () => (await deviceB.outbox())[0].status).toBe('rejected');
  await expect(page.locator('#sync-rejected')).toContainText('Server rejected 1 change');
  expect(await deviceB.outbox()).toHaveLength(1);
  expect(await serverRecord(id)).toBeNull();

  // ---- The same rules hold against the raw API, outside the app. ----
  await deviceA.open();
  const inRegionA = await deviceA.createRecord({ title: uniq('G8 region A'), fields: { ph: 6.2 }, photos: 1 });
  const inRegionB = await deviceA.page.evaluate(async ({ regionId, t }) => {
    const { createRecord } = await import('./js/store.js');
    return createRecord({ regionId, type: 'soil', fields: { title: t, ph: 5.5 } });
  }, { regionId: REGION_B, t: uniq('G8 region B') });
  await deviceA.idle();
  expect((await serverRecord(inRegionB)).region_id).toBe(REGION_B); // Researcher A is assigned, so it worked

  const b = clientAs('researcherB');

  // Reading: B sees Region A rows, never Region B rows.
  const visible = await b.from('records').select('id, region_id').in('id', [inRegionA, inRegionB]);
  expect(visible.error).toBeNull();
  expect(visible.data.map((r) => r.id)).toEqual([inRegionA]);
  expect((await b.from('regions').select('name')).data.map((r) => r.name).sort()).toEqual(['Region A', 'Region C']);

  // Direct table writes are refused everywhere, even in B's own region.
  const direct = await b.from('records').insert({ id: randomUUID(), region_id: REGION_A, type: 'soil', seq: 9999, fields: {} });
  expect(direct.error).not.toBeNull();
  await b.from('records').update({ deleted: true }).eq('id', inRegionA);
  await b.from('records').delete().eq('id', inRegionA);
  expect((await serverRecord(inRegionA)).deleted).toBe(false);
  const forged = await b.from('conflict_log').insert({ record_id: inRegionA, region_id: REGION_A, kind: 'same_field', field: 'ph' });
  expect(forged.error).not.toBeNull();
  const membership = await b.from('region_members').insert({ region_id: REGION_B, user_id: seed.users.researcherB.id, role: 'editor' });
  expect(membership.error).not.toBeNull();
  expect(await sql('select 1 from public.region_members where region_id = $1 and user_id = $2', [REGION_B, seed.users.researcherB.id])).toHaveLength(0);

  // The write function itself answers "rejected" for other regions.
  const push = (ops) => b.rpc('sync_push', { p_device_id: 'attacker-device', p_ops: ops });
  const newId = randomUUID();
  const r1 = await push([{ op_id: randomUUID(), table: 'records', kind: 'upsert', row_id: newId, region_id: REGION_B, type: 'soil', changed: { title: 'x' } }]);
  expect(r1.data.results[0]).toMatchObject({ status: 'rejected', reason: 'you are not assigned to this region' });
  const r2 = await push([{ op_id: randomUUID(), table: 'records', kind: 'upsert', row_id: inRegionB, base_version: 1, changed: { ph: 1 } }]);
  expect(r2.data.results[0].status).toBe('rejected');
  const r3 = await push([{ op_id: randomUUID(), table: 'records', kind: 'delete', row_id: inRegionB }]);
  expect(r3.data.results[0].status).toBe('rejected');
  const r4 = await push([{ op_id: randomUUID(), table: 'records', kind: 'upsert', row_id: randomUUID(), region_id: REGION_C, type: 'soil', changed: { title: 'x' } }]);
  expect(r4.data.results[0]).toMatchObject({ status: 'rejected', reason: 'Region C is view only' });
  expect(await serverRecord(newId)).toBeNull();
  const untouched = await serverRecord(inRegionB);
  expect(untouched).toMatchObject({ deleted: false, version: 1 });
  expect(untouched.fields.ph).toBe(5.5);

  // Storage: no upload into, and no download from, another region's folder.
  const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z', 'base64');
  const up = await b.storage.from('photos').upload(`${REGION_B}/${inRegionB}/${randomUUID()}.jpg`, jpeg, { contentType: 'image/jpeg' });
  expect(up.error).not.toBeNull();
  const upC = await b.storage.from('photos').upload(`${REGION_C}/${randomUUID()}/${randomUUID()}.jpg`, jpeg, { contentType: 'image/jpeg' });
  expect(upC.error).not.toBeNull();
  const photoA = (await sql('select storage_path from public.media where record_id = $1', [inRegionA]))[0].storage_path;
  expect((await b.storage.from('photos').download(photoA)).error).toBeNull(); // own region: allowed
  expect(await sql("select 1 from storage.objects where bucket_id = 'photos' and name like $1", [`${REGION_B}/%`])).toHaveLength(0);

  // Without a login the public key can do nothing at all.
  const anon = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  expect((await anon.from('records').select('id').limit(1)).data ?? []).toEqual([]);
  expect((await anon.rpc('sync_push', { p_device_id: 'x', p_ops: [] })).error).not.toBeNull();
  expect((await anon.rpc('sync_pull', { p_since: null })).error).not.toBeNull();
});
