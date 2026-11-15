// Named tests for the requirements that are not one of the twelve gates.
import { readFileSync } from 'node:fs';
import { test, expect, sql, serverRecord, seed, env, newDevice, uniq, SUPABASE_HOST } from './helpers.js';

test('FR-1 sign-in shows a clear error for a wrong password and for a first sign-in with no signal', async ({ browser }, testInfo) => {
  const device = await newDevice(browser, 'signin');
  const { page } = device;
  try {
    await page.goto('./');
    await page.fill('input[name="email"]', seed.users.researcherA.email);
    await page.fill('input[name="password"]', 'definitely-not-the-password');
    await page.click('button[type="submit"]');
    await expect(page.locator('#signin-error')).toContainText(/invalid/i);
    await expect(page.locator('input[name="email"]')).toBeVisible();

    await page.waitForFunction(() => navigator.serviceWorker?.controller != null);
    await device.context.setOffline(true);
    await expect(page.locator('#sb-text')).toHaveText('Offline / sign-in needed');
    await page.fill('input[name="password"]', env.SEED_PASSWORD);
    await page.click('button[type="submit"]');
    await expect(page.locator('#signin-error')).toContainText('A first sign-in needs a connection');
  } finally {
    await device.close(testInfo);
  }
});

test('FR-2 records of every type can be created, edited and filtered, and labels are numbered per type', async ({ deviceA }) => {
  const { page } = deviceA;
  await deviceA.open();
  const water = await deviceA.createRecord({ title: uniq('FR-2 water'), type: 'water', fields: { turbidity: 12, oxygen: 8.4 } });
  const wild = await deviceA.createRecord({ title: uniq('FR-2 heron'), type: 'wildlife', fields: { species: 'Grey heron', count: 2 }, gps: true });
  await deviceA.idle();
  expect((await serverRecord(water)).fields).toMatchObject({ turbidity: 12, oxygen: 8.4 });
  expect((await serverRecord(wild)).fields).toMatchObject({ species: 'Grey heron', count: 2 });
  await expect(deviceA.row(water).locator('.label').first()).toHaveText(/^WTR-\d{3}$/);
  await expect(deviceA.row(wild).locator('.label').first()).toHaveText(/^WLD-\d{3}$/);

  await page.click('[data-filter="water"]');
  await expect(deviceA.row(water)).toBeVisible();
  await expect(deviceA.row(wild)).toHaveCount(0);
  await page.click('[data-filter="all"]');

  await deviceA.editRecord(wild, { count: 3 });
  await deviceA.idle();
  const row = await serverRecord(wild);
  expect(row.fields.count).toBe(3);
  expect(row.version).toBe(2);
  await expect(page.locator('.reading[data-field="count"]')).toHaveText('3');
});

test('FR-4 a GPS track is recorded while walking, saved on the device, and synced', async ({ deviceA }) => {
  const { page, context } = deviceA;
  await deviceA.open();
  await deviceA.offline();
  await deviceA.go('#/tracks');
  const name = uniq('Ridge walk');
  await page.fill('#track-name', name);
  await page.click('#start-track');
  await expect(page.locator('#recorder')).toHaveAttribute('data-status', 'recording');
  let n = 1;
  for (const [lat, lng] of [[24.8611, 67.0016], [24.8618, 67.0021], [24.8616, 67.0032], [24.8627, 67.0041]]) {
    await context.setGeolocation({ latitude: lat, longitude: lng, accuracy: 4 });
    await expect(page.locator('#track-points')).toHaveText(String(++n));
  }
  expect(Number(await page.locator('#track-km').textContent())).toBeGreaterThan(0.1);
  await page.click('#stop-track');

  const item = page.locator('#track-list [data-track]').filter({ hasText: name });
  await expect(item).toHaveAttribute('data-status', 'pending');
  const local = await deviceA.idb(async (db, nm) => (await db.gpsLogs.toArray()).find((g) => g.name === nm), name);
  expect(local.points).toHaveLength(5);
  expect(local.kind).toBe('track');

  // Survives a restart with the network off, then uploads by itself.
  await page.reload();
  await page.waitForSelector('html[data-ready="1"]');
  await deviceA.go('#/tracks');
  await expect(item).toHaveAttribute('data-status', 'pending');
  await deviceA.context.setOffline(false);
  await expect(item).toHaveAttribute('data-status', 'synced', { timeout: 30_000 });
  const rows = await sql('select kind, name, points, distance_m from public.gps_logs where id = $1', [local.id]);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ kind: 'track', name });
  expect(rows[0].points).toHaveLength(5);
  expect(rows[0].distance_m).toBeGreaterThan(100);
});

test('FR-9 FR-12 a view-only region blocks new records on the device, and the status bar always shows state', async ({ deviceA }) => {
  const { page } = deviceA;
  await deviceA.open();
  await expect(page.locator('#statusbar')).toBeVisible();
  await expect(page.locator('#sb-right')).toHaveText(/^Last sync \d\d:\d\d$/);

  await page.click('#region-link');
  await expect(page.getByRole('button', { name: /Region C/ })).toContainText('View only');
  await expect(page.getByRole('button', { name: /Region A/ })).toContainText('Can edit');
  await page.getByRole('button', { name: /Region C/ }).click();
  await expect(page.locator('#region-link')).toContainText('Region C');
  await expect(page.locator('#new-record')).toHaveCount(0);
  await expect(page.locator('#pane-detail')).toContainText('Region C is view only');
  await deviceA.go('#/new');
  await expect(page.locator('#save-record')).toBeDisabled();

  await deviceA.go('#/regions');
  await page.getByRole('button', { name: /Region A/ }).click();
  await expect(page.locator('#new-record')).toBeVisible();
});

test('FR-13 the data lead sees the merged dataset and open conflicts, and exports the region as CSV', async ({ deviceA, deviceB, leadDevice }) => {
  await deviceA.open();
  const title = uniq('Lead soil');
  const id = await deviceA.createRecord({ title, fields: { ph: 6.4 }, notes: 'has, a comma', photos: 1 });
  await deviceA.idle();
  await deviceB.open();
  await deviceB.offline();
  await deviceB.editRecord(id, { ph: 6.8 });
  await deviceA.editRecord(id, { ph: 6.0 });
  await deviceA.idle();
  await deviceB.online();
  await deviceB.idle();

  const { page } = leadDevice;
  await leadDevice.open();
  await expect(page).toHaveURL(/#\/console$/);
  await expect(page.locator('#sb-text')).toHaveText('Online / data lead');
  const row = page.locator(`#dataset [data-record-id="${id}"]`);
  await expect(row).toContainText(title);
  await expect(row).toContainText('pH 6.8');
  await expect(row).toContainText('Researcher B');
  await expect(row).toHaveAttribute('data-status', 'conflict');
  const conflictId = (await sql('select id from public.conflict_log where record_id = $1', [id]))[0].id;
  const panel = page.locator(`#open-conflicts-panel [data-conflict="${conflictId}"]`);
  await expect(panel.locator('[data-kept]')).toHaveText('6.8');
  await expect(panel.locator('[data-lost]')).toHaveText('6');

  // CSV export.
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#export-csv')]);
  expect(download.suggestedFilename()).toMatch(/^fieldsync-region-a-\d{4}-\d\d-\d\d\.csv$/);
  const csv = readFileSync(await download.path(), 'utf8');
  const lines = csv.trim().split('\r\n');
  expect(lines[0]).toBe('label,id,type,title,ph,moisture,temperature,depth,turbidity,oxygen,species,count,notes,lat,lng,accuracy_m,photos,observed_at,updated_at,last_edit_by,version,deleted');
  const line = lines.find((l) => l.includes(id));
  expect(line).toContain(`,soil,${title},6.8,`);
  expect(line).toContain('"has, a comma"');
  expect(line).toContain(',24.8607,67.0011,4,1,');
  expect(line).toContain(',Researcher B,3,no');

  // Marking the conflict reviewed goes through the same write function.
  await panel.getByRole('button', { name: 'Mark reviewed' }).click();
  await expect(page.locator(`#open-conflicts-panel [data-conflict="${conflictId}"]`)).toHaveCount(0);
  await leadDevice.idle();
  expect((await sql('select resolved, resolved_by from public.conflict_log where id = $1', [conflictId]))[0])
    .toEqual({ resolved: true, resolved_by: seed.users.lead.id });
  await expect(row).toHaveAttribute('data-status', 'merged');
});

test('FR-3 synced photos can be freed from the device and come back from the server on demand', async ({ deviceA }) => {
  const { page } = deviceA;
  await deviceA.open();
  const id = await deviceA.createRecord({ title: uniq('Storage soil'), fields: { ph: 6.3 }, photos: 2 });
  await deviceA.idle();
  await deviceA.go('#/storage');
  await expect(page.locator('#synced-photos')).toContainText(/^[1-9]\d* \/ can be cleared$/);
  await page.click('#free-space');
  await expect(page.locator('#synced-photos')).toHaveText('0 / can be cleared');
  const blobs = () => deviceA.idb(async (db, rid) => (await db.media.where('recordId').equals(rid).toArray()).map((m) => Boolean(m.blob)), id);
  expect(await blobs()).toEqual([false, false]);
  expect(await sql('select 1 from public.media where record_id = $1', [id])).toHaveLength(2);

  await deviceA.go(`#/record/${id}`);
  await expect(page.locator('#photos .photo.has-img')).toHaveCount(2);
  expect(await blobs()).toEqual([true, true]);
});

test('G10 at runtime the app only talks to its own origin and the Supabase project', async ({ deviceA }) => {
  await deviceA.open();
  await deviceA.createRecord({ title: uniq('G10 soil'), fields: { ph: 6.2 }, photos: 1 });
  await deviceA.idle();
  for (const hash of ['#/tracks', '#/sync', '#/conflicts', '#/regions', '#/storage', '#/install', '#/styleguide', '#/records']) {
    await deviceA.go(hash);
    await deviceA.page.waitForTimeout(100);
  }
  expect(deviceA.foreign).toEqual([]);
  expect(deviceA.network.some((l) => l.includes(SUPABASE_HOST))).toBe(true);
  // Fonts are served from the app itself.
  expect(await deviceA.page.evaluate(() => document.fonts.ready.then(() => [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/"/g, ''))))).toContain('IBM Plex Sans');
});
