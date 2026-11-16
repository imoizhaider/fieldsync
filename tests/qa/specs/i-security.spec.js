// I. Security. Mostly the public REST API, called exactly as any signed-in
// user could call it: the anon key plus that user's own token.
import { randomUUID } from 'node:crypto';
import { test, expect, state, sql, api, env, serverRecord, serverConflicts, waitSql, uniq, photo, sleep, BASE_URL, ORIGIN, SUPABASE_URL, ANON } from '../lib/harness.js';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
const TABLES = ['regions', 'region_members', 'profiles', 'records', 'media', 'gps_logs', 'conflict_log', 'applied_ops', 'devices'];
const refused = (res) => res.status >= 400;
const upsert = (regionId, changed, extra = {}) => ({ op_id: randomUUID(), table: 'records', kind: 'upsert', row_id: randomUUID(), region_id: regionId, type: 'soil', base_version: 0, changed, ...extra });

// Data in QA-<ts>-B, a region researcher B is NOT assigned to: a record, a photo,
// a GPS point and a conflict-log row. Made by researcher A through the normal API.
let victimCache = null;
async function victim() {
  if (victimCache) return victimCache;
  const a = await api('a');
  const dev1 = randomUUID();
  const dev2 = randomUUID();
  const create = upsert(state.regions.other, { title: uniq('I victim record'), ph: 6.0, notes: 'private to region B' });
  const rid = create.row_id;
  expect((await a.push(dev1, [create])).json.results[0].status).toBe('applied');
  const mid = randomUUID();
  const path = `${state.regions.other}/${rid}/${mid}.jpg`;
  const up = await a.storage('POST', `object/photos/${path}`, JPEG, { 'Content-Type': 'image/jpeg' });
  expect(up.status, up.text).toBe(200);
  const gid = randomUUID();
  const res = await a.push(dev1, [
    { op_id: randomUUID(), table: 'media', kind: 'upsert', row_id: mid, record_id: rid, storage_path: path, mime_type: 'image/jpeg', size_bytes: JPEG.length, position: 1 },
    { op_id: randomUUID(), table: 'gps_logs', kind: 'upsert', row_id: gid, region_id: state.regions.other, record_id: rid, gps_kind: 'point', points: [{ lat: 24.1, lng: 67.1, acc: 5, t: new Date().toISOString() }] },
    { op_id: randomUUID(), table: 'records', kind: 'upsert', row_id: rid, base_version: 1, changed: { ph: 6.1 } },
  ]);
  expect(res.json.results.map((r) => r.status)).toEqual(['applied', 'applied', 'applied']);
  // a second device of A changes the same field from the old version: one conflict row
  await a.push(dev2, [{ op_id: randomUUID(), table: 'records', kind: 'upsert', row_id: rid, base_version: 1, changed: { ph: 6.2 } }]);
  const conflict = (await serverConflicts(rid))[0];
  expect(conflict).toBeTruthy();
  victimCache = { rid, mid, gid, path, cid: conflict.id, dev1, dev2 };
  return victimCache;
}

test('I01 [P0] a user cannot read a region they are not assigned to (direct REST)', async ({ qa }) => {
  const v = await victim();
  const b = await api('b');
  const mine = [state.regions.main, state.regions.view];
  const seen = {};
  for (const t of ['records', 'media', 'gps_logs', 'conflict_log']) {
    const scoped = await b.rest('GET', `${t}?region_id=eq.${state.regions.other}&select=*`);
    const all = await b.rest('GET', `${t}?select=id,region_id&limit=2000`);
    seen[t] = { scopedStatus: scoped.status, scopedRows: scoped.json?.length, allRows: all.json?.length };
    expect(scoped.status).toBe(200);
    expect(scoped.json, `${t} of the other region`).toEqual([]);
    expect(all.json.every((r) => mine.includes(r.region_id)), `${t}: every visible row is in B's own regions`).toBe(true);
  }
  expect((await b.rest('GET', `records?id=eq.${v.rid}&select=*`)).json).toEqual([]);
  expect((await b.rest('GET', `media?id=eq.${v.mid}&select=*`)).json).toEqual([]);
  expect((await b.rest('GET', `gps_logs?id=eq.${v.gid}&select=*`)).json).toEqual([]);
  const regions = await b.rest('GET', 'regions?select=id,name');
  expect(regions.json.map((r) => r.id).sort()).toEqual([...mine].sort());
  const members = await b.rest('GET', 'region_members?select=region_id,user_id,role');
  expect(members.json.every((m) => mine.includes(m.region_id))).toBe(true);
  const ledger = await b.rest('GET', 'applied_ops?select=*&limit=1');
  seen.applied_ops = ledger.status;
  expect(refused(ledger) || ledger.json.length === 0).toBe(true);
  // the pull function, full and incremental
  for (const since of [null, '2000-01-01T00:00:00Z']) {
    const pull = (await b.pull(since)).json;
    expect(pull.regions.map((r) => r.id).sort()).toEqual([...mine].sort());
    for (const key of ['records', 'media', 'gps_logs', 'conflicts']) expect(pull[key].every((r) => mine.includes(r.region_id)), `sync_pull ${key}`).toBe(true);
    expect(JSON.stringify(pull)).not.toContain(v.rid);
  }
  // filters and embedding tricks
  for (const path of [`records?or=(region_id.eq.${state.regions.other},id.eq.${v.rid})`, `media?select=*,records(*)&record_id=eq.${v.rid}`, `regions?select=*,records(*)&id=eq.${state.regions.other}`]) {
    const r = await b.rest('GET', path);
    expect(r.status >= 400 || r.json.length === 0, path).toBe(true);
  }
  qa.note('seen', seen);
});

test('I02 [P0] direct table writes are refused for every table', async ({ qa }) => {
  const v = await victim();
  const b = await api('b');
  const own = upsert(state.regions.main, { title: uniq('I02 own record'), ph: 6 });
  await b.push(randomUUID(), [own]);
  const before = { record: await serverRecord(own.row_id), members: await sql('select count(*)::int n from public.region_members where user_id = $1', [state.users.b.id]) };
  const attempts = {};
  const bodies = {
    regions: { name: `QA-${state.ts}-hack` },
    region_members: { region_id: state.regions.other, user_id: state.users.b.id, role: 'lead' },
    profiles: { user_id: state.users.b.id, display_name: 'hacked' },
    records: { id: randomUUID(), region_id: state.regions.main, type: 'soil', seq: 9999, fields: { title: 'direct insert' } },
    media: { id: randomUUID(), record_id: own.row_id, region_id: state.regions.main, storage_path: 'x' },
    gps_logs: { id: randomUUID(), region_id: state.regions.main, kind: 'point', points: [] },
    conflict_log: { record_id: own.row_id, region_id: state.regions.main, kind: 'same_field', field: 'ph' },
    applied_ops: { op_id: randomUUID(), user_id: state.users.b.id, result: {} },
    devices: { device_id: randomUUID(), user_id: state.users.b.id },
  };
  for (const t of TABLES) {
    const ins = await b.rest('POST', t, bodies[t], { Prefer: 'return=representation' });
    const upd = await b.rest('PATCH', `${t}?${t === 'records' ? `id=eq.${own.row_id}` : 'select=*'}`, t === 'records' ? { fields: { title: 'direct update' }, deleted: true } : { ...bodies[t] }, { Prefer: 'return=representation' });
    const del = await b.rest('DELETE', `${t}?${t === 'records' ? `id=eq.${own.row_id}` : t === 'region_members' ? `user_id=eq.${state.users.b.id}` : 'select=*'}`, undefined, { Prefer: 'return=representation' });
    attempts[t] = { insert: ins.status, update: upd.status, delete: del.status };
    expect(refused(ins), `${t} insert -> ${ins.status} ${ins.text.slice(0, 120)}`).toBe(true);
    expect(refused(upd) || upd.json?.length === 0, `${t} update -> ${upd.status}`).toBe(true);
    expect(refused(del) || del.json?.length === 0, `${t} delete -> ${del.status}`).toBe(true);
  }
  qa.note('httpStatus', attempts);
  expect(await serverRecord(own.row_id)).toEqual(before.record);
  expect(await sql('select count(*)::int n from public.region_members where user_id = $1', [state.users.b.id])).toEqual(before.members);
  expect(await sql('select count(*)::int n from public.regions where name = $1', [`QA-${state.ts}-hack`])).toEqual([{ n: 0 }]);
  expect((await serverRecord(v.rid)).deleted).toBe(false);
  // helper functions exposed over RPC must not leak either
  for (const fn of ['is_member', 'can_edit']) {
    const r = await b.rpc(fn, { p_region: state.regions.other });
    expect(r.status >= 400 || r.json === false, `${fn} -> ${r.status} ${r.text}`).toBe(true);
  }
});

test('I03 [P0] sync_push into an unassigned region is rejected and writes nothing', async ({ qa }) => {
  const v = await victim();
  const b = await api('b');
  const dev = randomUUID();
  const before = { rec: await serverRecord(v.rid), counts: await sql('select (select count(*)::int from public.records where region_id = $1) r, (select count(*)::int from public.gps_logs where region_id = $1) g, (select count(*)::int from public.media where region_id = $1) m, (select count(*)::int from public.conflict_log where region_id = $1 and resolved) c', [state.regions.other]) };
  const ops = {
    createInOtherRegion: upsert(state.regions.other, { title: 'I03 intruder' }),
    editVictim: { op_id: randomUUID(), table: 'records', kind: 'upsert', row_id: v.rid, base_version: 99, changed: { notes: 'defaced' } },
    editVictimClaimingOwnRegion: { op_id: randomUUID(), table: 'records', kind: 'upsert', row_id: v.rid, region_id: state.regions.main, base_version: 99, changed: { notes: 'defaced' } },
    deleteVictim: { op_id: randomUUID(), table: 'records', kind: 'delete', row_id: v.rid },
    restoreVictim: { op_id: randomUUID(), table: 'records', kind: 'restore', row_id: v.rid, changed: { notes: 'defaced' } },
    gpsInOtherRegion: { op_id: randomUUID(), table: 'gps_logs', kind: 'upsert', row_id: randomUUID(), region_id: state.regions.other, gps_kind: 'track', points: [] },
    overwriteVictimGps: { op_id: randomUUID(), table: 'gps_logs', kind: 'upsert', row_id: v.gid, region_id: state.regions.main, points: [] },
    deleteVictimGps: { op_id: randomUUID(), table: 'gps_logs', kind: 'delete', row_id: v.gid, region_id: state.regions.main },
    photoOnVictimRecord: { op_id: randomUUID(), table: 'media', kind: 'upsert', row_id: randomUUID(), record_id: v.rid, storage_path: `${state.regions.other}/${v.rid}/x.jpg` },
    resolveVictimConflict: { op_id: randomUUID(), table: 'conflict_log', kind: 'resolve', row_id: v.cid },
    unknownTable: { op_id: randomUUID(), table: 'region_members', kind: 'upsert', row_id: randomUUID(), region_id: state.regions.other },
  };
  const out = {};
  for (const [name, op] of Object.entries(ops)) {
    const res = await b.push(dev, [op]);
    const r = res.json?.results?.[0];
    out[name] = r ? `${r.status}: ${r.reason ?? ''}` : `http ${res.status} ${res.text.slice(0, 100)}`;
    expect(res.status >= 400 || r.status === 'rejected', `${name} -> ${out[name]}`).toBe(true);
  }
  qa.note('answers', out);
  expect(await serverRecord(v.rid)).toEqual(before.rec);
  expect(await sql('select (select count(*)::int from public.records where region_id = $1) r, (select count(*)::int from public.gps_logs where region_id = $1) g, (select count(*)::int from public.media where region_id = $1) m, (select count(*)::int from public.conflict_log where region_id = $1 and resolved) c', [state.regions.other])).toEqual(before.counts);
  expect((await sql('select deleted, points from public.gps_logs where id = $1', [v.gid]))[0].deleted).toBe(false);
  // all in one batch: the good op is applied, the bad ones are not
  const good = upsert(state.regions.main, { title: uniq('I03 good op in a mixed batch') });
  const mixed = await b.push(dev, [{ ...ops.deleteVictim, op_id: randomUUID() }, good, { ...ops.createInOtherRegion, op_id: randomUUID(), row_id: randomUUID() }]);
  expect(mixed.json.results.map((r) => r.status)).toEqual(['rejected', 'applied', 'rejected']);
  expect((await serverRecord(v.rid)).deleted).toBe(false);
});

test('I04 [P1] access removed while offline: the app shows "Sync rejected" and keeps the data', async ({ qa }) => {
  const d = await qa.device('deviceB', { user: 'b' });
  await d.open();
  await d.offline();
  const title = uniq('I04 made while access was removed');
  const id = await d.createRecord({ title, fields: { ph: 6.6 }, photos: [photo(1)] });
  try {
    await sql('delete from public.region_members where region_id = $1 and user_id = $2', [state.regions.main, state.users.b.id]);
    await d.context.setOffline(false);
    await expect(d.page.locator('#sb-text')).toHaveText('Online / sync problem', { timeout: 40_000 });
    await expect(d.page.locator('#statusbar')).toHaveAttribute('data-tone', 'problem');
    await d.go('#/sync');
    await expect(d.page.locator('#sync-rejected')).toBeVisible();
    await expect(d.page.locator('#sync-rejected')).toContainText('Nothing is lost');
    await expect(d.page.locator('#reject-reason')).toContainText('you are not assigned to this region');
    await d.shot('sync-rejected');
    await d.page.click('[data-act="details"]');
    await d.shot('sync-rejected-details');
    await d.page.click('#sheet-root [data-act="keep"]');
    // data is still on the device, nothing reached the server
    const out = await d.outbox();
    expect(out.length).toBeGreaterThanOrEqual(3);
    expect(out.every((o) => o.status === 'rejected')).toBe(true);
    expect((await d.localRecord(id)).fields.title).toBe(title);
    expect((await d.localMedia(id))[0].blob.size).toBeGreaterThan(0);
    expect(await serverRecord(id)).toBeNull();
    expect(await sql("select count(*)::int n from storage.objects where bucket_id = 'photos' and name like $1", [`%/${id}/%`])).toEqual([{ n: 0 }]);
    // can the researcher still see the record they made?
    await d.go('#/records');
    await d.shot('records-after-rejection');
    const visible = await d.row(id).count();
    qa.note('recordStillVisibleInList', visible);
    if (visible === 0) qa.finding('When a region is taken away, the pull removes it from the region list, so the rejected record can no longer be opened or seen in Observations. It is only named on the Sync screen (label, not title) until access returns.');
    // retry while still not allowed: stays rejected, still nothing lost
    await d.go('#/sync');
    await d.page.click('#retry-sync');
    await expect(d.page.locator('#sync-rejected')).toBeVisible({ timeout: 30_000 });
    expect((await d.outbox()).length).toBe(out.length);
  } finally {
    await sql("insert into public.region_members (region_id, user_id, role) values ($1, $2, 'editor') on conflict do nothing", [state.regions.main, state.users.b.id]);
  }
  // access is back: Retry sends everything (the app may already have retried by itself on its next automatic sync)
  await d.go('#/sync');
  const manual = await d.page.locator('#retry-sync').isVisible();
  qa.note('afterAccessReturned', manual ? 'Retry button pressed' : 'the app had already retried by itself');
  if (manual) await d.page.click('#retry-sync').catch(() => {});
  const rows = await waitSql('select fields from public.records where id = $1', [id], (r) => r.length === 1, 40_000);
  expect(rows[0].fields.title).toBe(title);
  await d.waitSynced(60_000);
  expect(await sql('select count(*)::int n from public.media where record_id = $1', [id])).toEqual([{ n: 1 }]);
  await d.go('#/records');
  await expect(d.row(id)).toHaveAttribute('data-status', 'synced');
});

test('I05 [P0] Storage files of another region cannot be read, listed, replaced or removed', async ({ qa }) => {
  const v = await victim();
  const b = await api('b');
  const anon = await api(null);
  const out = {};
  const tryAll = async (who, client) => {
    out[`${who} download`] = (await client.storage('GET', `object/photos/${v.path}`)).status;
    out[`${who} download authenticated`] = (await client.storage('GET', `object/authenticated/photos/${v.path}`)).status;
    out[`${who} download public`] = (await client.storage('GET', `object/public/photos/${v.path}`)).status;
    out[`${who} info`] = (await client.storage('GET', `object/info/photos/${v.path}`)).status;
    const sign = await client.storage('POST', `object/sign/photos/${v.path}`, { expiresIn: 600 });
    out[`${who} sign`] = sign.status;
    expect(sign.json?.signedURL, `${who} got a signed URL`).toBeUndefined();
    const list = await client.storage('POST', 'object/list/photos', { prefix: `${state.regions.other}/${v.rid}`, limit: 100 });
    out[`${who} list`] = `${list.status} rows=${Array.isArray(list.json) ? list.json.length : 'n/a'}`;
    expect(refused(list) || list.json.length === 0, `${who} list`).toBe(true);
    for (const k of ['download', 'download authenticated', 'download public', 'info']) expect(out[`${who} ${k}`], `${who} ${k}`).toBeGreaterThanOrEqual(400);
  };
  await tryAll('B', b);
  await tryAll('anon', anon);
  const overwrite = await b.storage('POST', `object/photos/${v.path}`, JPEG, { 'Content-Type': 'image/jpeg', 'x-upsert': 'true' });
  const put = await b.storage('PUT', `object/photos/${v.path}`, JPEG, { 'Content-Type': 'image/jpeg' });
  const plant = await b.storage('POST', `object/photos/${state.regions.other}/${v.rid}/${randomUUID()}.jpg`, JPEG, { 'Content-Type': 'image/jpeg' });
  const remove = await b.storage('DELETE', `object/photos/${v.path}`);
  const move = await b.storage('POST', 'object/move', { bucketId: 'photos', sourceKey: v.path, destinationKey: `${state.regions.main}/stolen.jpg` });
  const copy = await b.storage('POST', 'object/copy', { bucketId: 'photos', sourceKey: v.path, destinationKey: `${state.regions.main}/stolen.jpg` });
  Object.assign(out, { 'B overwrite': overwrite.status, 'B put': put.status, 'B plant file': plant.status, 'B delete': remove.status, 'B move': move.status, 'B copy': copy.status });
  for (const k of ['B overwrite', 'B put', 'B plant file', 'B delete', 'B move', 'B copy']) expect(out[k], k).toBeGreaterThanOrEqual(400);
  // the file is untouched
  const obj = await sql("select name, metadata->>'size' size from storage.objects where bucket_id = 'photos' and name = $1", [v.path]);
  expect(obj).toEqual([{ name: v.path, size: String(JPEG.length) }]);
  expect(await sql("select count(*)::int n from storage.objects where bucket_id = 'photos' and name like $1", [`${v.path.split("/").slice(0, 2).join("/")}/%`]), 'the victim record still has exactly its own file').toEqual([{ n: 1 }]);
  expect(await sql("select count(*)::int n from storage.objects where bucket_id = 'photos' and name = $1", [`${state.regions.main}/stolen.jpg`])).toEqual([{ n: 0 }]);
  // own region: the bucket rules still apply
  const wrongType = await b.storage('POST', `object/photos/${state.regions.main}/${randomUUID()}/${randomUUID()}.html`, '<script>alert(1)</script>', { 'Content-Type': 'text/html' });
  const tooBig = await b.storage('POST', `object/photos/${state.regions.main}/${randomUUID()}/${randomUUID()}.jpg`, new Uint8Array(5 * 1024 * 1024 + 10), { 'Content-Type': 'image/jpeg' });
  const viewOnly = await b.storage('POST', `object/photos/${state.regions.view}/${randomUUID()}/${randomUUID()}.jpg`, JPEG, { 'Content-Type': 'image/jpeg' });
  Object.assign(out, { 'B html into own region': wrongType.status, 'B 5 MB+ into own region': tooBig.status, 'B upload into view-only region': viewOnly.status });
  expect(wrongType.status).toBeGreaterThanOrEqual(400);
  expect(tooBig.status).toBeGreaterThanOrEqual(400);
  expect(viewOnly.status).toBeGreaterThanOrEqual(400);
  const bucket = await sql("select public from storage.buckets where id = 'photos'");
  expect(bucket).toEqual([{ public: false }]);
  qa.note('httpStatus', out);
});

test('I06 [P0] the conflict log of another region is not readable', async ({ qa }) => {
  const v = await victim();
  const b = await api('b');
  const anon = await api(null);
  const byId = await b.rest('GET', `conflict_log?id=eq.${v.cid}&select=*`);
  const byRegion = await b.rest('GET', `conflict_log?region_id=eq.${state.regions.other}&select=*`);
  const byRecord = await b.rest('GET', `conflict_log?record_id=eq.${v.rid}&select=*`);
  expect([byId.json, byRegion.json, byRecord.json]).toEqual([[], [], []]);
  const pull = (await b.pull(null)).json;
  expect(pull.conflicts.some((c) => c.id === v.cid || c.region_id === state.regions.other)).toBe(false);
  const anonRead = await anon.rest('GET', `conflict_log?id=eq.${v.cid}&select=*`);
  expect(refused(anonRead) || anonRead.json.length === 0).toBe(true);
  // A, who is in that region, does see it (the rule is not simply "nobody")
  const a = await api('a');
  expect((await a.rest('GET', `conflict_log?id=eq.${v.cid}&select=id`)).json).toEqual([{ id: v.cid }]);
  qa.note('status', { byId: byId.status, anon: anonRead.status });
  // through the app: B's device holds no trace of it
  const d = await qa.device('deviceB', { user: 'b' });
  await d.open();
  const dump = JSON.stringify(await d.idb(['records', 'media', 'gpsLogs', 'meta']));
  expect(dump).not.toContain(v.cid);
  expect(dump).not.toContain(v.rid);
  expect(dump).not.toContain(state.regions.other);
  await d.go('#/conflicts');
  await expect(d.page.locator(`[data-conflict="${v.cid}"]`)).toHaveCount(0);
});

test('I07 [P0] no service key or other secret in the shipped files or in any request', async ({ qa }) => {
  const dbUrl = new URL(env.SUPABASE_DB_URL);
  const secrets = {
    'service key': env.SUPABASE_SERVICE_KEY,
    'database password': decodeURIComponent(dbUrl.password),
    'database URL': env.SUPABASE_DB_URL,
    'seed password': env.SEED_PASSWORD,
    'QA password': state.password,
  };
  const patterns = { 'sb_secret_ key': /sb_secret_[A-Za-z0-9_-]{8,}/, 'postgres URL': /postgres(ql)?:\/\/[^\s"']+:[^\s"']+@/, 'service_role': /service_role/ };
  const d = await qa.device('deviceA');
  d.userKey = 'a';
  const captured = [];
  d.page.on('request', async (r) => { captured.push(`${r.method()} ${r.url()}\n${JSON.stringify(await r.allHeaders().catch(() => ({})))}\n${r.postData() ?? ''}`); });
  await d.open('', { sync: false });
  // 1. every file the worker lists, plus the page itself
  const sw = await (await d.context.request.get(`${BASE_URL}sw.js`)).text();
  const files = ['sw.js', ...JSON.parse(/const FILES = (\[.*?\]);/s.exec(sw)[1])];
  const hits = [];
  let bytes = 0;
  const jwtRoles = [];
  for (const f of files) {
    const res = await d.context.request.get(new URL(f, BASE_URL).href);
    const text = (await res.body()).toString('latin1');
    bytes += text.length;
    for (const [name, value] of Object.entries(secrets)) if (value && text.includes(value)) hits.push(`${f}: ${name}`);
    for (const [name, re] of Object.entries(patterns)) if (re.test(text) && !(name === 'service_role' && f.includes('vendor/supabase'))) hits.push(`${f}: ${name}`);
    for (const m of text.matchAll(/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g)) {
      try { jwtRoles.push(`${f}: ${JSON.parse(Buffer.from(m[0].split('.')[1], 'base64url').toString()).role}`); } catch { /* not a token */ }
    }
  }
  qa.note('filesScanned', { count: files.length, bytes });
  qa.note('jwtsInShippedFiles', jwtRoles);
  expect(hits).toEqual([]);
  expect(jwtRoles.filter((r) => /service/.test(r))).toEqual([]);
  // 2. a real session: sign in, create a record with a photo, sync
  await d.page.fill('input[name="email"]', state.users.a.email);
  await d.page.fill('input[name="password"]', state.password);
  await d.page.click('button[type="submit"]');
  await d.page.waitForFunction(() => document.body.dataset.route === 'records', null, { timeout: 30_000 });
  await d.waitSynced();
  await d.createRecord({ title: uniq('I07 traffic'), fields: { ph: 6 }, photos: [photo(1)] });
  await d.waitSynced();
  await sleep(500);
  const leaks = [];
  for (const c of captured) {
    for (const name of ['service key', 'database password', 'database URL', 'seed password']) if (secrets[name] && c.includes(secrets[name])) leaks.push(`${name} in ${c.split('\n')[0]}`);
    if (patterns['sb_secret_ key'].test(c)) leaks.push(`sb_secret_ in ${c.split('\n')[0]}`);
  }
  qa.note('requestsCaptured', captured.length);
  expect(leaks).toEqual([]);
  const keys = new Set(captured.filter((c) => c.includes(new URL(SUPABASE_URL).host)).map((c) => JSON.parse(c.split('\n')[1]).apikey).filter(Boolean));
  expect([...keys]).toEqual([ANON]);
  // the QA password is sent only to the sign-in endpoint, and is not kept in browser storage
  const withPassword = captured.filter((c) => c.includes(state.password)).map((c) => c.split('\n')[0]);
  expect(withPassword.every((u) => u.includes('/auth/v1/token?grant_type=password'))).toBe(true);
  const stored = await d.page.evaluate(() => JSON.stringify(localStorage) + JSON.stringify(sessionStorage));
  expect(stored).not.toContain(state.password);
  expect(JSON.stringify(await d.idb(['meta']))).not.toContain(state.password);
});

test('I08 [P0] HTML that arrives from the server (names, conflict values) is rendered as text', async ({ qa }) => {
  const payloadName = '<img src=x onerror="window.__xss=1"><b id=xss-b>QA B</b>';
  const dialogs = [];
  const a = await qa.device('deviceA', { user: 'a' });
  const b = await qa.device('deviceB', { user: 'b' });
  const lead = await qa.device('lead', { user: 'lead', viewport: { width: 1280, height: 800 } });
  for (const d of [a, b, lead]) d.page.on('dialog', async (x) => { dialogs.push(x.message()); await x.dismiss(); });
  await sql('update public.profiles set display_name = $1 where user_id = $2', [payloadName, state.users.b.id]);
  try {
    await a.open();
    await b.open();
    await lead.open();
    const lostHtml = '<svg onload="window.__xss=1"></svg><script>window.__xss=1</script>LOST';
    const keptHtml = '"><img src=x onerror=window.__xss=1>KEPT';
    const id = await a.createRecord({ title: uniq('I08 conflict with html'), fields: { ph: 6 }, notes: 'base' });
    await a.waitSynced();
    await b.syncNow();
    await a.offline(); await b.offline();
    await a.editRecord(id, { notes: lostHtml });
    await b.editRecord(id, { notes: keptHtml });
    await a.context.setOffline(false); await a.waitSynced();
    await b.context.setOffline(false); await b.waitSynced();
    // edit-vs-delete entry with HTML, restorable (the values travel through a data- attribute)
    const id2 = await a.createRecord({ title: uniq('I08 deleted with html edit'), fields: { ph: 6 } });
    await a.waitSynced(); await b.syncNow();
    await b.offline();
    await a.deleteRecord(id2); await a.waitSynced();
    await b.editRecord(id2, { notes: '\'"><img src=x onerror=window.__xss=1>EDIT' });
    await b.context.setOffline(false); await b.waitSynced();
    await a.syncNow(); await lead.syncNow();
    const check = async (d, where) => {
      const r = await d.page.evaluate(() => ({ xss: window.__xss ?? null, injected: document.querySelectorAll('#app img[src="x"], #app script, #xss-b, #app svg[onload], #sheet-root img[src="x"]').length }));
      expect(r, `${d.name} ${where}`).toEqual({ xss: null, injected: 0 });
    };
    for (const d of [a, b]) {
      for (const hash of ['#/conflicts', `#/record/${id}`, '#/records', '#/regions', '#/sync']) { await d.go(hash); await check(d, hash); }
      await d.go('#/conflicts');
      await expect(d.page.locator(`[data-record-id="${id}"] [data-lost]`)).toHaveText(lostHtml);
      await expect(d.page.locator(`[data-record-id="${id}"] [data-kept]`)).toHaveText(keptHtml);
      await d.shot(`${d.name}-conflicts`);
    }
    await a.go('#/conflicts');
    await expect(a.page.locator(`[data-record-id="${id}"] .kept .label`)).toContainText(payloadName);
    await b.go('#/regions');
    await expect(b.page.locator('#pane-detail')).toContainText(`Signed in as ${payloadName}`);
    await check(b, 'regions');
    await lead.page.click(`aside [data-region="${state.regions.main}"]`);
    for (const section of ['dataset', 'conflicts', 'researchers']) {
      await lead.page.click(`[data-section="${section}"]`);
      await check(lead, `console ${section}`);
    }
    await lead.page.click('[data-section="researchers"]');
    await lead.shot('lead-researchers');
    await lead.page.click('[data-section="dataset"]');
    await expect(lead.page.locator(`#dataset tr[data-record-id="${id}"] .who`)).toHaveText(payloadName);
    // restore through the button whose data- attribute carries the hostile value
    await b.go('#/conflicts');
    await b.page.locator(`[data-record-id="${id2}"] [data-restore]`).click();
    await b.waitSynced();
    await check(b, 'after restore');
    expect((await serverRecord(id2)).fields.notes).toBe('\'"><img src=x onerror=window.__xss=1>EDIT');
    expect(dialogs).toEqual([]);
  } finally {
    await sql('update public.profiles set display_name = $1 where user_id = $2', [state.users.b.name, state.users.b.id]);
  }
});

test('I09 [P0] without a login nothing can be read or called', async ({ qa }) => {
  await victim();
  const anon = await api(null);
  const out = {};
  for (const t of TABLES) {
    const r = await anon.rest('GET', `${t}?select=*&limit=5`);
    out[t] = `${r.status} rows=${Array.isArray(r.json) ? r.json.length : 'n/a'}`;
    expect(refused(r) || r.json.length === 0, `${t}: ${out[t]}`).toBe(true);
  }
  const pull = await anon.pull(null);
  const push = await anon.push(randomUUID(), [upsert(state.regions.main, { title: 'I09 anonymous' })]);
  out.sync_pull = pull.status;
  out.sync_push = push.status;
  expect(pull.status).toBeGreaterThanOrEqual(400);
  expect(push.status).toBeGreaterThanOrEqual(400);
  const list = await anon.storage('POST', 'object/list/photos', { prefix: '', limit: 10 });
  out.storageList = `${list.status} rows=${Array.isArray(list.json) ? list.json.length : 'n/a'}`;
  expect(refused(list) || list.json.length === 0).toBe(true);
  const upload = await anon.storage('POST', `object/photos/${state.regions.main}/${randomUUID()}/${randomUUID()}.jpg`, JPEG, { 'Content-Type': 'image/jpeg' });
  out.storageUpload = upload.status;
  expect(upload.status).toBeGreaterThanOrEqual(400);
  // a made-up token is not accepted either
  const fake = await fetch(`${SUPABASE_URL}/rest/v1/records?select=id&limit=1`, { headers: { apikey: ANON, Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.x' } });
  out.forgedToken = fake.status;
  expect(fake.status).toBeGreaterThanOrEqual(400);
  expect(await sql("select count(*)::int n from public.records where fields->>'title' = 'I09 anonymous'")).toEqual([{ n: 0 }]);
  const settings = await fetch(`${SUPABASE_URL}/auth/v1/settings`, { headers: { apikey: ANON } }).then((r) => r.json()).catch(() => null);
  out.authSettings = settings ? { disable_signup: settings.disable_signup, mailer_autoconfirm: settings.mailer_autoconfirm, email: settings.external?.email } : null;
  qa.note('answers', out);
  if (settings && settings.disable_signup === false) qa.finding('Supabase self sign-up is open (auth settings: disable_signup=false). A stranger can create an account with the public key. Such an account is in no region, so it reads nothing, but it can call the two sync functions; turn sign-up off in the dashboard since accounts are meant to be created by the data lead.');
});

test('I10 [P1] a view-only member cannot write', async ({ qa }) => {
  const lead = await api('lead');
  const a = await api('a');            // A is "viewer" in QA-<ts>-V
  const seedOp = upsert(state.regions.view, { title: uniq('I10 lead record'), ph: 6 });
  expect((await lead.push(randomUUID(), [seedOp])).json.results[0].status).toBe('applied');
  const dev = randomUUID();
  const out = {};
  const ops = {
    create: upsert(state.regions.view, { title: 'I10 viewer create' }),
    edit: { op_id: randomUUID(), table: 'records', kind: 'upsert', row_id: seedOp.row_id, base_version: 1, changed: { ph: 1 } },
    delete: { op_id: randomUUID(), table: 'records', kind: 'delete', row_id: seedOp.row_id },
    track: { op_id: randomUUID(), table: 'gps_logs', kind: 'upsert', row_id: randomUUID(), region_id: state.regions.view, gps_kind: 'track', points: [] },
    photo: { op_id: randomUUID(), table: 'media', kind: 'upsert', row_id: randomUUID(), record_id: seedOp.row_id, storage_path: 'x' },
  };
  for (const [name, op] of Object.entries(ops)) {
    const r = (await a.push(dev, [op])).json.results[0];
    out[name] = `${r.status}: ${r.reason}`;
    expect(r.status, name).toBe('rejected');
    expect(r.reason).toMatch(/view only/);
  }
  const up = await a.storage('POST', `object/photos/${state.regions.view}/${seedOp.row_id}/${randomUUID()}.jpg`, JPEG, { 'Content-Type': 'image/jpeg' });
  out.storageUpload = up.status;
  expect(up.status).toBeGreaterThanOrEqual(400);
  const s = await serverRecord(seedOp.row_id);
  expect(s.fields.ph).toBe(6);
  expect(s.deleted).toBe(false);
  // but the viewer can read it
  expect((await a.rest('GET', `records?id=eq.${seedOp.row_id}&select=id`)).json).toHaveLength(1);
  qa.note('answers', out);
});

test('I11 [P0] sync_push cannot delete a photo of another region', async ({ qa }) => {
  const v = await victim();
  const b = await api('b');
  const mine = upsert(state.regions.main, { title: uniq('I11 attacker own record') });
  expect((await b.push(randomUUID(), [mine])).json.results[0].status).toBe('applied');
  // B names their OWN record (so the region check passes) and the victim's photo id.
  const res = await b.push(randomUUID(), [{ op_id: randomUUID(), table: 'media', kind: 'delete', row_id: v.mid, record_id: mine.row_id }]);
  const answer = res.json?.results?.[0];
  const after = (await sql('select deleted, region_id, record_id from public.media where id = $1', [v.mid]))[0];
  qa.note('answer', answer);
  qa.note('victimPhotoAfter', after);
  try {
    expect(after.deleted, `a member of ${state.names.main} flagged a photo of ${state.names.other} as deleted (server answered "${answer?.status}")`).toBe(false);
  } finally {
    await sql('update public.media set deleted = false where id = $1', [v.mid]); // put the QA row back for the next cases
  }
});

test('I12 [P1] a forged device id cannot hide a conflict or take over another device', async ({ qa }) => {
  const a = await api('a');
  const b = await api('b');
  const devA = randomUUID();
  const create = upsert(state.regions.main, { title: uniq('I12 forged device'), ph: 6.0 });
  await a.push(devA, [create]);
  await a.push(devA, [{ op_id: randomUUID(), table: 'records', kind: 'upsert', row_id: create.row_id, base_version: 1, changed: { ph: 6.1 } }]);
  // Device ids of colleagues are public to region members: they come back in every pull.
  const visible = (await b.pull(null)).json.devices.some((x) => x.device_id === devA);
  qa.note('victimDeviceIdVisibleToB', visible);
  // B overwrites A's value from a stale version, but claims to BE A's device.
  const res = await b.push(devA, [{ op_id: randomUUID(), table: 'records', kind: 'upsert', row_id: create.row_id, base_version: 1, changed: { ph: 9.9 } }]);
  const s = await serverRecord(create.row_id);
  const log = await serverConflicts(create.row_id);
  const dev = (await sql('select user_id, last_status from public.devices where device_id = $1', [devA]))[0];
  qa.note('result', { answer: res.json.results[0].status, conflictsReported: res.json.results[0].conflicts, ph: s.fields.ph, conflictRows: log.length, deviceRowOwner: dev.user_id === state.users.a.id ? 'A (correct)' : dev.user_id === state.users.b.id ? 'B (taken over)' : dev.user_id });
  // control: the same push with B's own device id IS logged
  const create2 = upsert(state.regions.main, { title: uniq('I12 control'), ph: 6.0 });
  await a.push(devA, [create2]);
  await a.push(devA, [{ op_id: randomUUID(), table: 'records', kind: 'upsert', row_id: create2.row_id, base_version: 1, changed: { ph: 6.1 } }]);
  await b.push(randomUUID(), [{ op_id: randomUUID(), table: 'records', kind: 'upsert', row_id: create2.row_id, base_version: 1, changed: { ph: 9.9 } }]);
  expect(await serverConflicts(create2.row_id), 'control: honest device id logs the conflict').toHaveLength(1);
  expect(s.fields.ph === 6.1 || log.length === 1, `A's value 6.1 was overwritten with 9.9 and ${log.length} conflict rows were written`).toBe(true);
  expect(dev.user_id, 'the devices row of A\'s device still belongs to A').toBe(state.users.a.id);
});

test('I13 [P2] a GPS log cannot be attached to a record of another region', async ({ qa }) => {
  const v = await victim();
  const b = await api('b');
  const gid = randomUUID();
  const res = await b.push(randomUUID(), [{ op_id: randomUUID(), table: 'gps_logs', kind: 'upsert', row_id: gid, region_id: state.regions.main, record_id: v.rid, gps_kind: 'point', points: [{ lat: 0, lng: 0, acc: 1, t: new Date().toISOString() }] }]);
  const row = (await sql('select region_id, record_id from public.gps_logs where id = $1', [gid]))[0];
  qa.note('answer', res.json.results[0]);
  qa.note('row', row ?? null);
  // does the victim region now see a foreign GPS point on its record? (it must not)
  const a = await api('a');
  const seenByA = (await a.rest('GET', `gps_logs?record_id=eq.${v.rid}&select=id,region_id`)).json;
  qa.note('gpsRowsOnVictimRecordSeenByA', seenByA);
  expect(row?.record_id ?? null, 'a GPS row in one region points at a record of another region').not.toBe(v.rid);
});

test('I14 [P1] the app talks only to its own origin and to Supabase', async ({ qa }) => {
  const d = await qa.device('deviceA', { hud: true });   // exactly as deployed, nothing suppressed
  d.userKey = 'a';
  await d.open('', { sync: false });
  await d.page.fill('input[name="email"]', state.users.a.email);
  await d.page.fill('input[name="password"]', state.password);
  await d.page.click('button[type="submit"]');
  await d.page.waitForFunction(() => document.body.dataset.route === 'records', null, { timeout: 30_000 });
  await d.waitSynced();
  await d.createRecord({ title: uniq('I14 traffic'), fields: { ph: 6 }, photos: [photo(1)] });
  await d.waitSynced();
  for (const route of ['tracks', 'sync', 'regions', 'storage', 'install', 'conflicts', 'styleguide', 'records']) await d.go(`#/${route}`);
  await sleep(3000);
  const hosts = [...new Set(d.requests.map((r) => new URL(r.url).host))];
  const injected = d.requests.filter((r) => r.url.includes('/.netlify/')).map((r) => r.url);
  qa.note('hosts', hosts);
  qa.note('foreign', [...new Set(d.foreign)]);
  qa.note('hostInjectedScripts', [...new Set(injected)]);
  const frames = d.page.frames().map((f) => f.url()).filter((u) => u && u !== d.page.url());
  qa.note('extraFrames', frames);
  await d.shot('as-deployed');
  if (injected.length > 0) qa.finding(`The host adds its own script to the page (${[...new Set(injected)].join(', ')}). It is same-origin, but it is code the project did not write running inside the signed-in app.`);
  expect([...new Set(d.foreign)], 'requests to third parties').toEqual([]);
  expect(hosts.sort()).toEqual([new URL(ORIGIN).host, new URL(SUPABASE_URL).host].sort());
});

test('I15 [P3] security headers of the host (recorded)', async ({ qa }) => {
  const res = await fetch(BASE_URL);
  const names = ['strict-transport-security', 'content-security-policy', 'x-frame-options', 'x-content-type-options', 'referrer-policy', 'permissions-policy'];
  const headers = Object.fromEntries(names.map((n) => [n, res.headers.get(n)]));
  qa.note('headers', headers);
  const missing = names.filter((n) => !headers[n]);
  if (missing.length > 0) qa.finding(`Host response has no ${missing.join(', ')}. With no Content-Security-Policy and no frame protection the app can be framed by any site, and a future XSS would be unrestricted. One [[headers]] block in netlify.toml fixes it.`);
  expect(headers['strict-transport-security'], 'HTTPS is enforced').toBeTruthy();
  expect(new URL(res.url).protocol).toBe('https:');
  const http = await fetch(BASE_URL.replace('https:', 'http:'), { redirect: 'manual' }).catch(() => null);
  qa.note('httpRedirect', http ? `${http.status} -> ${http.headers.get('location')}` : 'no answer');
  if (http) expect([301, 302, 307, 308]).toContain(http.status);
});
