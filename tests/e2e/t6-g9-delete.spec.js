import { test, expect, sql, serverRecord, seed, uniq } from './helpers.js';

async function sharedRecord(deviceA, deviceB, title) {
  await deviceA.open();
  const id = await deviceA.createRecord({ title, fields: { ph: 6.1 }, notes: 'Original note', photos: 1 });
  await deviceA.idle();
  await deviceB.open();
  await expect(deviceB.row(id)).toHaveAttribute('data-status', 'synced');
  return id;
}

async function deleteOnScreen(device, id) {
  await device.go(`#/record/${id}`);
  await device.page.click('#delete-record');
  await expect(device.page.locator('.sheet')).toContainText('It disappears here now and on other devices after sync');
  await device.page.click('#confirm-delete');
  await expect(device.row(id)).toHaveCount(0);
}

test('T6 a record deleted on device A disappears from device B after both sync', async ({ deviceA, deviceB }) => {
  const id = await sharedRecord(deviceA, deviceB, uniq('T6 soil'));

  await deleteOnScreen(deviceA, id);
  await deviceA.idle();
  await deviceB.sync();

  // Screen on B.
  await deviceB.go('#/records');
  await expect(deviceB.row(id)).toHaveCount(0);
  // IndexedDB on both: kept as a soft delete.
  expect((await deviceA.localRecord(id)).deleted).toBe(1);
  expect((await deviceB.localRecord(id)).deleted).toBe(1);
  // Server: flag set, row still there.
  const row = await serverRecord(id);
  expect(row.deleted).toBe(true);
  expect(row.version).toBe(2);
  expect(row.fields.notes).toBe('Original note');
});

test('G9 editing a record that another device deleted: the delete wins and the edit is in conflict_log', async ({ deviceA, deviceB }) => {
  const id = await sharedRecord(deviceA, deviceB, uniq('G9 soil'));

  await deviceB.offline();
  await deviceB.editRecord(id, { notes: 'Roots exposed on the east bank, resample.' });

  await deleteOnScreen(deviceA, id);
  await deviceA.idle();

  await deviceB.online();
  await deviceB.idle();

  // Server: still deleted, the edit did not change the record.
  const row = await serverRecord(id);
  expect(row.deleted).toBe(true);
  expect(row.fields.notes).toBe('Original note');
  const log = await sql('select * from public.conflict_log where record_id = $1', [id]);
  expect(log).toHaveLength(1);
  expect(log[0]).toMatchObject({
    kind: 'edit_vs_delete', field: 'notes', lost_value: 'Roots exposed on the east bank, resample.',
    lost_by: seed.users.researcherB.id, kept_by: seed.users.researcherA.id,
  });

  // Device B: the record is gone, nothing is waiting, and the edit is in the log.
  await deviceB.go('#/records');
  await expect(deviceB.row(id)).toHaveCount(0);
  expect((await deviceB.localRecord(id)).deleted).toBe(1);
  expect(await deviceB.outbox()).toHaveLength(0);
  await deviceB.go('#/conflicts');
  const entry = deviceB.page.locator(`#conflict-list [data-kind="edit_vs_delete"][data-record-id="${id}"]`);
  await expect(entry).toContainText('Roots exposed on the east bank, resample.');
  await expect(entry).toContainText('The delete wins');
  await expect(entry).toContainText('Your edit');

  // The edit can be restored from the log (it comes back with the lost value).
  await entry.getByRole('button', { name: 'Restore record' }).click();
  await expect(entry).toContainText('Restored.');
  await deviceB.idle();
  const restored = await serverRecord(id);
  expect(restored.deleted).toBe(false);
  expect(restored.fields.notes).toBe('Roots exposed on the east bank, resample.');
  expect((await sql('select resolved from public.conflict_log where record_id = $1', [id]))[0].resolved).toBe(true);
  await deviceA.sync();
  await deviceA.go('#/records');
  await expect(deviceA.row(id)).toHaveAttribute('data-status', 'synced');
});
