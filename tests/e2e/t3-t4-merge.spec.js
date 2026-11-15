import { test, expect, sql, serverRecord, seed, uniq } from './helpers.js';

// Researcher A creates a record, both devices have it, both go offline.
async function sharedRecord(deviceA, deviceB, title) {
  await deviceA.open();
  const id = await deviceA.createRecord({ title, fields: { ph: 6.4, moisture: 22 }, notes: 'Dark loam' });
  await deviceA.idle();
  await deviceB.open();
  await expect(deviceB.row(id)).toHaveAttribute('data-status', 'synced');
  expect((await deviceB.localRecord(id)).version).toBe(1);
  await deviceA.offline();
  await deviceB.offline();
  return id;
}

test('T3 device A edits pH and device B edits notes offline, both changes are kept everywhere', async ({ deviceA, deviceB }) => {
  const id = await sharedRecord(deviceA, deviceB, uniq('T3 soil'));

  await deviceA.editRecord(id, { ph: 6.8 });
  await deviceB.editRecord(id, { notes: 'Roots exposed on the east bank' });

  // Only the changed field is queued on each device.
  expect((await deviceA.outbox()).map((e) => e.changedFields)).toEqual([{ ph: 6.8 }]);
  expect((await deviceB.outbox()).map((e) => e.changedFields)).toEqual([{ notes: 'Roots exposed on the east bank' }]);

  await deviceA.online();
  await deviceA.idle();
  await deviceB.online();
  await deviceB.idle();
  await deviceA.sync(); // A picks up B's change on its next pull

  // Server: both changes, no conflict logged.
  const row = await serverRecord(id);
  expect(row.fields).toMatchObject({ ph: 6.8, notes: 'Roots exposed on the east bank', moisture: 22 });
  expect(row.version).toBe(3);
  expect(await sql('select id from public.conflict_log where record_id = $1', [id])).toHaveLength(0);

  // Both devices: IndexedDB and screen.
  for (const device of [deviceA, deviceB]) {
    const local = await device.localRecord(id);
    expect(local.fields).toMatchObject({ ph: 6.8, notes: 'Roots exposed on the east bank' });
    expect(local.version).toBe(3);
    expect(await device.outbox()).toHaveLength(0);
    await device.go(`#/record/${id}`);
    await expect(device.page.locator('.reading[data-field="ph"]')).toHaveText('6.8');
    await expect(device.page.locator('[data-field="notes"]')).toHaveText('Roots exposed on the east bank');
    await expect(device.page.locator('#record-status')).toHaveText('Synced');
  }
});

test('T4 both devices edit pH, the edit the server receives later wins and the other is in conflict_log', async ({ deviceA, deviceB }) => {
  const id = await sharedRecord(deviceA, deviceB, uniq('T4 soil'));

  // Device B's clock is a full day behind. It must still win, because the
  // rule uses the server's receive time and never the device's time.
  await deviceB.page.clock.setFixedTime(new Date(Date.now() - 24 * 3600 * 1000));

  await deviceA.editRecord(id, { ph: 6.1 });
  await deviceB.editRecord(id, { ph: 6.9 });

  await deviceA.online();
  await deviceA.idle();
  expect((await serverRecord(id)).fields.ph).toBe(6.1);

  await deviceB.page.clock.setFixedTime(new Date()); // back to real time so the session is valid
  await deviceB.online();
  await expect(deviceB.page.locator('#statusbar')).toHaveAttribute('data-online', '1');
  await deviceB.page.waitForFunction(async () => {
    const { db } = await import('./js/db.js');
    return (await db.outbox.count()) === 0;
  }, null, { timeout: 30_000 });
  await deviceB.sync();
  await deviceA.sync();

  // Server: later-received edit (B) is the value, A's value is in the log.
  const row = await serverRecord(id);
  expect(row.fields.ph).toBe(6.9);
  expect(row.updated_by).toBe(seed.users.researcherB.id);
  const log = await sql('select * from public.conflict_log where record_id = $1', [id]);
  expect(log).toHaveLength(1);
  expect(log[0]).toMatchObject({
    kind: 'same_field', field: 'ph', lost_value: 6.1, kept_value: 6.9,
    lost_by: seed.users.researcherA.id, kept_by: seed.users.researcherB.id, resolved: false,
  });

  // Both devices show the winning value and list the conflict.
  for (const device of [deviceA, deviceB]) {
    expect((await device.localRecord(id)).fields.ph).toBe(6.9);
    await device.go(`#/record/${id}`);
    await expect(device.page.locator('.reading[data-field="ph"]')).toHaveText('6.9');
    await device.go('#/conflicts');
    const entry = device.page.locator(`#conflict-list [data-conflict="${log[0].id}"]`);
    await expect(entry.locator('[data-kept]')).toHaveText('6.9');
    await expect(entry.locator('[data-lost]')).toHaveText('6.1');
    await expect(entry).toContainText('Later server time wins');
  }
  // Researcher A (who lost) is told on the record itself.
  await deviceA.go(`#/record/${id}`);
  await expect(deviceA.page.locator('.notice.warn')).toContainText('Conflict on pH');
  await expect(deviceA.page.locator('.notice.warn')).toContainText('6.1 is saved in the log');
});
